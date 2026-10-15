import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VerifiedJournalReader, appendEvent, readEvents, decodeEvents } from '../core/workflow-events.mjs';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-verified-journal-'));
  t.after(() => rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  const store = await new WorkflowRunStore(root).initialize();
  const blob = Buffer.from('alpha'), sha256 = digest(blob), pins = { resources: [{ path: 'fixture.txt', bytes: blob.length, sha256 }] };
  await store.create('fixture', pins, new Map([[sha256, blob]]), { run_id: 'fixture', workflow_id: 'example', status: 'running', pins_hash: digest(canonicalJSON(pins)), nodes: {}, edges: {}, approvals: {} });
  return { root, store, path: join(store.directory('fixture'), 'events.jsonl'), blobPath: join(store.directory('fixture'), 'objects', sha256) };
}

test('verified journal reuse proves actual prefix bytes and validates each appended event', async t => {
  const f = await fixture(t), reader = new VerifiedJournalReader();
  const first = await reader.read(f.path), prefix = await readFile(f.path);
  assert.equal(first.reused_prefix_bytes, 0);
  const patch = { fields: { status: 'paused' }, nodes: {}, edges: {}, approvals: {} };
  await appendEvent(f.path, first.events, 'pause', { patch });
  const next = await reader.read(f.path);
  assert.equal(next.reused_prefix_bytes, prefix.length);
  assert.deepEqual(next.events, decodeEvents(await readFile(f.path)).events);
  assert.equal((await reader.read(f.path)).reused_prefix_bytes, (await readFile(f.path)).length);
  assert.throws(() => { next.events[1].payload.patch.fields.status = 'running'; }, TypeError);
  patch.fields.status = 'cancelled';
  assert.equal((await reader.read(f.path)).events[1].payload.patch.fields.status, 'paused');
});

test('same-length historical edits with unchanged timestamps never reuse stale proof', async t => {
  const f = await fixture(t), reader = new VerifiedJournalReader();
  await reader.read(f.path); const before = await stat(f.path), original = await readFile(f.path, 'utf8');
  await writeFile(f.path, original.replace('running', 'stopped')); await utimes(f.path, before.atime, before.mtime);
  await assert.rejects(reader.read(f.path), { code: 'RUN_JOURNAL_CORRUPT' });
});

test('strict cached reads reject torn tails, bad suffix chains and repeated start events', async t => {
  const f = await fixture(t), reader = new VerifiedJournalReader(), original = await readFile(f.path);
  const first = await reader.read(f.path);
  await writeFile(f.path, Buffer.concat([original, Buffer.from('{"unfinished":')]));
  assert.equal((await readEvents(f.path, { allowTornTail: true })).events.length, 1);
  await assert.rejects(reader.read(f.path), { code: 'RUN_JOURNAL_TORN' });
  await writeFile(f.path, original);
  await appendEvent(f.path, first.events, 'started', { state: {} });
  await assert.rejects(reader.read(f.path), { code: 'RUN_EVENT_KIND' });
  const malformed = (await readFile(f.path, 'utf8')).replace('"sequence":2', '"sequence":9');
  await writeFile(f.path, malformed);
  await assert.rejects(reader.read(f.path), { code: 'RUN_JOURNAL_CORRUPT' });
  await writeFile(f.path, original); // Complete valid truncation retains original decoder semantics.
  assert.deepEqual((await reader.read(f.path)).events, decodeEvents(original).events);
});

test('Run state stays mutable and isolated, and whole-resource verification belongs to explicit audit', async t => {
  const f = await fixture(t);
  await f.store.mutate('fixture', 'pause', state => { state.status = 'paused'; state.nodes.work = { output: { text: 'original' } }; });
  const first = await f.store.read('fixture'); first.state.nodes.work.output.text = 'caller mutation';
  assert.equal((await f.store.read('fixture')).state.nodes.work.output.text, 'original');
  await writeFile(f.blobPath, 'omega');
  assert.equal((await f.store.read('fixture')).state.nodes.work.output.text,'original');
  await assert.rejects(f.store.audit('fixture'), { code: 'RUN_RESOURCE_CORRUPT' });
});

test('verified reuse budgets evict proofs and never substitute metadata for actual bytes', async t => {
  const f = await fixture(t), reader = new VerifiedJournalReader({ maxBytes: 1, maxEntries: 1 });
  await reader.read(f.path);
  assert.equal((await reader.read(f.path)).reused_prefix_bytes, 0);
  await writeFile(f.path, '');
  assert.deepEqual((await reader.read(f.path)).events, []);
});

test('owned hot reads consume only appended bytes and detect an in-place rewrite or replacement', async t => {
  const f = await fixture(t), reader = new VerifiedJournalReader();
  const first = await reader.read(f.path, {incremental:true});
  assert.equal((await reader.read(f.path, {incremental:true})).bytes_read, 0);
  await appendEvent(f.path, first.events, 'pause', {patch:{fields:{status:'paused'},nodes:{},edges:{},approvals:{}}});
  const next = await reader.read(f.path, {incremental:true});
  assert.equal(next.bytes_read, next.completeLength - first.completeLength);
  assert(next.reused_prefix_bytes > 0);
  await writeFile(f.path, (await readFile(f.path,'utf8')).replace('"paused"','"broken"'));
  await assert.rejects(reader.read(f.path, {incremental:true}), {code:'RUN_JOURNAL_CORRUPT'});
});

test('hot pins are caller-isolated and remain paired to the current journal hash', async t => {
  const f = await fixture(t), first = await f.store.readActive('fixture');
  first.pins.resources.length = 0;
  assert.equal((await f.store.readActive('fixture')).pins.resources.length,1);
  const pinPath=join(f.store.directory('fixture'),'pins.json');
  await writeFile(pinPath,(await readFile(pinPath,'utf8')).replace('fixture.txt','changed.txt'));
  await assert.rejects(f.store.readActive('fixture'),{code:'RUN_PINS_CORRUPT'});
});
