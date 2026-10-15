import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { recoverRunAdmissionTicket } from '../core/run-admission-queue.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'run-observation-admission-'));
  t.after(() => rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  const store = await new WorkflowRunStore(root).initialize(), id = 'completed';
  const pins = { resources: [] }, state = { run_id: id, workflow_id: 'course-production', status: 'failed', pins_hash: digest(canonicalJSON(pins)) };
  await store.create(id, pins, new Map(), state);
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { windowsHide: true });
  const deadPid = Number(stdout); assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  const directory = store.directory(id), queue = join(directory, '.admission-queue');
  await mkdir(join(queue, '.pending'), { recursive: true });
  const ticket = { id: randomUUID(), pid: deadPid, token: randomUUID(), created_at: new Date().toISOString(), number: 1 };
  const ticketPath = join(queue, `ticket-${ticket.id}.json`), bytes = canonicalJSON(ticket);
  await writeFile(ticketPath, bytes);
  return { store, id, directory, queue, ticketPath, bytes };
}

test('read-only Run observation and list remain available behind an orphan admission ticket without retiring it', async t => {
  const f = await fixture(t);
  const journal = await readFile(join(f.directory, 'events.jsonl'));
  assert.equal((await f.store.observe(f.id)).state.status, 'failed');
  assert.deepEqual(await f.store.list(), [{ run_id: f.id, workflow_id: 'course-production', status: 'failed', sequence: 1 }]);
  assert.equal(await readFile(f.ticketPath, 'utf8'), f.bytes);
  assert.deepEqual(await readdir(f.queue), ['.pending', f.ticketPath.split(/[\\/]/).at(-1)]);
  assert.deepEqual(await readFile(join(f.directory, 'events.jsonl')), journal);
  await assert.rejects(f.store.mutate(f.id, 'pause', state => { state.status = 'paused'; }), error => {
    assert.equal(error.code, 'RUN_ADMISSION_QUEUE_ORPHANED');
    assert.match(error.message, /Admission queue owner PID \d+ has exited; inspect_run_admission/);
    return true;
  });
  assert.deepEqual(await readFile(join(f.directory, 'events.jsonl')), journal);
});

test('read-only observation still rejects a corrupt journal, torn tail and mismatched pins', async t => {
  const f = await fixture(t), path = join(f.directory, 'events.jsonl'), bytes = await readFile(path);
  await writeFile(path, Buffer.concat([bytes, Buffer.from('{"unfinished":')]));
  await assert.rejects(f.store.observe(f.id), { code: 'RUN_JOURNAL_TORN' });
  const event = JSON.parse(bytes.toString().trim()); event.payload.state.status = 'succeeded';
  await writeFile(path, JSON.stringify(event) + '\n');
  await assert.rejects(f.store.observe(f.id), { code: 'RUN_JOURNAL_CORRUPT' });
  await writeFile(path, bytes); await writeFile(join(f.directory, 'pins.json'), JSON.stringify({ resources: [], changed: true }));
  await assert.rejects(f.store.observe(f.id), { code: 'RUN_PINS_CORRUPT' });
});

test('read-only observation preserves an active exact writer record and does not allocate another owner', async t => {
  const f = await fixture(t), path = join(f.directory, '.writer.lock');
  const bytes = canonicalJSON({ pid: process.pid, token: randomUUID(), created_at: new Date().toISOString(), operation: 'journal' });
  await writeFile(path, bytes);
  const before = await readdir(f.directory);
  assert.equal((await f.store.observe(f.id)).sequence, 1);
  assert.deepEqual(await readdir(f.directory), before);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(await readFile(f.ticketPath, 'utf8'), f.bytes);
});

test('admission evidence can read an interrupted retention while business reads remain retired', async t => {
  const f = await fixture(t), record = await f.store.observe(f.id), path = join(f.directory, 'retained.json');
  await writeFile(path, canonicalJSON({ schema_version: 1, state: record.state, cleanup_complete: false }));
  await assert.rejects(f.store.observe(f.id), { code: 'RUN_RETIRED' });
  await assert.rejects(f.store.read(f.id), { code: 'RUN_ADMISSION_QUEUE_ORPHANED' });
  assert.equal((await f.store.observeAdmission(f.id)).state.pins_hash, record.state.pins_hash);
  const ticket = JSON.parse(f.bytes);
  await recoverRunAdmissionTicket(f.directory, ticket.id, ticket.token);
  await assert.rejects(f.store.read(f.id), { code: 'RUN_RETIRED' });
  await writeFile(path, canonicalJSON({ schema_version: 1, state: record.state, cleanup_complete: true }));
  await assert.rejects(f.store.observeAdmission(f.id), { code: 'RUN_RETIRED' });
  await writeFile(path, canonicalJSON({ schema_version: 1, state: record.state, cleanup_complete: false }));
  await rm(join(f.directory, 'pins.json'));
  await assert.rejects(f.store.observeAdmission(f.id), { code: 'ENOENT' });
});
