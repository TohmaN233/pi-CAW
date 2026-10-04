import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-run-store-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  });
  const store = await new WorkflowRunStore(root).initialize();
  const pins = { resources: [] };
  const state = { run_id: 'example', workflow_id: 'example', status: 'running', pins_hash: digest(canonicalJSON(pins)) };
  const create = () => store.create('example', pins, new Map(), state);
  return { root, store, state, pins, create, directory: store.directory('example') };
}

test('Run creation writes directly to its final directory and reclaims only unpublished initialization', async t => {
  const f = await fixture(t);
  await mkdir(f.directory);
  await writeFile(join(f.directory, 'pins.json'), 'unfinished');
  assert.deepEqual(await f.store.list(), []);
  await f.create();
  assert.equal((await f.store.read('example')).state.run_id, 'example');
  assert.equal((await f.store.list()).length, 1);
  assert.deepEqual(await readdir(join(f.root, '.pending')), []);
  await assert.rejects(f.create(), { code: 'RUN_EXISTS' });
});

test('a started Run with missing pins remains visible as corruption and cannot be replaced', async t => {
  const f = await fixture(t);
  await f.create();
  const journal = await readFile(join(f.directory, 'events.jsonl'), 'utf8');
  await rm(join(f.directory, 'pins.json'));
  await assert.rejects(f.store.list(), { code: 'ENOENT' });
  await assert.rejects(f.create(), { code: 'RUN_EXISTS' });
  assert.equal(await readFile(join(f.directory, 'events.jsonl'), 'utf8'), journal);
});

test('a retained terminal Run cannot be recreated or lose its deliverables', async t => {
  const f = await fixture(t);
  await mkdir(f.directory);
  const retained = JSON.stringify({ schema_version: 1, state: { ...f.state, status: 'succeeded' } });
  await writeFile(join(f.directory, 'retained.json'), retained);
  await writeFile(join(f.directory, 'delivered.tex'), 'accepted source');
  await assert.rejects(f.create(), { code: 'RUN_EXISTS' });
  assert.equal(await readFile(join(f.directory, 'retained.json'), 'utf8'), retained);
  assert.equal(await readFile(join(f.directory, 'delivered.tex'), 'utf8'), 'accepted source');
});
