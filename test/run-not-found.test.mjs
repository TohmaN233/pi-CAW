import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workflow, settle } from './fixtures.mjs';

for (const operation of ['get', 'run_snapshot']) test(`${operation} reports only the exact absent Run directory`, async t => {
  const f = await fixture(t), runId = 'intended-run';
  const expected = { run_id: runId, observation: 'run_directory_absent' };
  // The private Extension bus passes this same error to the Host Promise reject
  // callback; code/details must remain own enumerable properties.
  await assert.rejects(new Promise((resolve, reject) => {
    void f.service.call(operation, { run_id: runId }).then(resolve, reject);
  }), cause => {
    assert.equal(cause.code, 'RUN_NOT_FOUND');
    assert.deepEqual(cause.details, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(cause)).details, expected);
    return true;
  });
  await assert.rejects(f.service.call(operation, { run_id: '../outside' }), { code: 'INVALID_WORKFLOW_ID' });
  assert.deepEqual(await f.service.call('runs'), []);
  assert.equal(f.requests.length, 0);
});

test('a missing store and an existing Run with a missing journal are not RUN_NOT_FOUND', async t => {
  const f = await fixture(t), root = f.service.runtime.runs.root;
  const saved = root + '.retained';
  await rename(root, saved);
  try { await assert.rejects(f.service.call('get', { run_id: 'intended-run' }), { code: 'ENOENT' }); }
  finally { await rename(saved, root); }
  const directory = f.service.runtime.runs.directory('incomplete-run'); await mkdir(directory);
  await assert.rejects(f.service.call('get', { run_id: 'incomplete-run' }), cause => {
    assert.equal(cause.code, 'ENOENT'); assert.equal(cause.path, join(directory, 'events.jsonl')); return true;
  });
  await writeFile(join(directory, 'events.jsonl'), 'corrupt journal\n');
  await assert.rejects(f.service.call('get', { run_id: 'incomplete-run' }), cause => cause.code !== 'RUN_NOT_FOUND');
});

test('existing Run pins/resources corruption and controller authorization remain errors', async t => {
  const f = await fixture(t);
  await f.service.call('create_workflow', { workflow: workflow(), resources: { 'instructions/test.md': 'pinned bytes' } });
  const started = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'read evidence' } });
  await settle(f.service, started.run_id);
  const directory = f.service.runtime.runs.directory(started.run_id), pinsPath = join(directory, 'pins.json');
  const bytes = await readFile(pinsPath), pins = JSON.parse(bytes);
  for (const path of [pinsPath, join(directory, 'objects', pins.resources[0].sha256)]) {
    const original = await readFile(path); await unlink(path);
    try { await assert.rejects(f.service.call('get', { run_id: started.run_id }), { code: 'ENOENT' }); }
    finally { await writeFile(path, original); }
  }
  await assert.rejects(f.service.call('run_snapshot', { run_id: started.run_id, control_token: 'wrong-token' }), cause => {
    assert.notEqual(cause.code, 'RUN_NOT_FOUND'); assert.match(cause.message, /control|authority/i); return true;
  });
  const sentinel = Object.assign(new Error('read permission denied'), { code: 'EACCES' });
  const snapshot = f.service.runtime.snapshot;
  f.service.runtime.snapshot = async () => { throw sentinel; };
  try { await assert.rejects(f.service.call('get', { run_id: started.run_id }), cause => cause === sentinel); }
  finally { f.service.runtime.snapshot = snapshot; }
});

test('a linked Run path cannot become missing-Run evidence', async t => {
  const f = await fixture(t), destination = join(f.root, 'untrusted-run'); await mkdir(destination);
  const directory = f.service.runtime.runs.directory('linked-run');
  await symlink(destination, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.call('get', { run_id: 'linked-run' }), { code: 'WORKFLOW_SYMLINK' });
});
