import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowStore, admissionTrace } from '../core/workflow-store.mjs';
import { WorkflowRunStore, withRunStoreOperation, withRunStoreForegroundActivity, runStoreForegroundActivity,
  readRunStoreForegroundActivity, onRunStoreForegroundChange, recoverRunStoreForegroundActivity } from '../core/workflow-run-store.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';

const moduleURL = new URL('../core/workflow-run-store.mjs', import.meta.url).href;
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-run-admission-'));
  t.after(() => rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }));
  const store = await new WorkflowRunStore(root).initialize(), pins = { resources: [] };
  for (const id of ['first', 'second']) await store.create(id, pins, new Map(), {
    run_id: id, workflow_id: 'example', status: 'running', pins_hash: digest(canonicalJSON(pins)),
  });
  return { root, store };
}

test('same Run journal reads and mutations reenter across independently loaded modules without changing pins', async t => {
  const { root, store } = await fixture(t), original = await readFile(join(store.directory('first'), 'pins.json'));
  const OtherStore = (await import(`${moduleURL}?independent-run-store`)).WorkflowRunStore;
  const other = new OtherStore(root);
  await store.withRunWriter('first', async () => {
    assert.equal((await other.read('first')).sequence, 1);
    const value = await other.mutate('first', 'pause', state => { state.status = 'paused'; });
    assert.equal(value.sequence, 2);
  });
  assert.equal((await store.read('first')).state.status, 'paused');
  assert.deepEqual(await readFile(join(store.directory('first'), 'pins.json')), original);
});

test('distinct Run journals progress independently and nested mutations/root admission fail without waiting', async t => {
  const { root, store } = await fixture(t), entered = gate(), release = gate();
  const first = store.withRunWriter('first', async () => { entered.release(); await release.promise; });
  await entered.promise;
  try { assert.equal(await store.withRunWriter('second', () => 'independent'), 'independent'); }
  finally { release.release(); await first; }
  await store.withRunWriter('first', async () => {
    await assert.rejects(store.withRunWriter('second', () => assert.fail('nested callback')), { code: 'RUN_STORE_LOCK_ORDER' });
    await assert.rejects(withRunStoreOperation(root, 'census', () => assert.fail('ancestor callback')), { code: 'RUN_STORE_LOCK_ORDER' });
    // Strict evidence reads of an ancestor do not acquire another writer.
    assert.equal((await store.read('second')).sequence, 1);
    assert.equal((await store.readActive('second')).sequence, 1, 'Ancestor authority evidence never acquires a second Run writer');
  });
});

test('store operation reenters its exact scope and supports ordered store to Run lock direction', async t => {
  const { root, store } = await fixture(t);
  const value = await withRunStoreOperation(root, 'census', () => withRunStoreOperation(root, 'census',
    () => store.withRunWriter('first', () => store.read('first'))));
  assert.equal(value.sequence, 1);
});

test('a bounded admission expires while queued, never invokes its callback later, and never times out callback work', async t => {
  const { store } = await fixture(t), writer = new WorkflowStore(store.directory('first')), entered = gate(), release = gate();
  const first = writer.withWriter(async () => { entered.release(); await release.promise; });
  await entered.promise; let callbacks = 0;
  try { await assert.rejects(writer.withRunAdmission(() => callbacks++, { timeoutMs: 30, onWait: () => {} }), { code: 'RUN_STORE_ADMISSION_TIMEOUT' }); }
  finally { release.release(); await first; }
  await writer.withWriter(() => {});
  assert.equal(callbacks, 0);
  assert.equal(await writer.withRunAdmission(async () => { await delay(80); return 'once'; }, { timeoutMs: 30 }), 'once');
});

test('foreground activity is one durable cross-process claim through nested operations and publishes idle on error', async t => {
  const { root } = await fixture(t), seen = [], unsubscribe = onRunStoreForegroundChange(root, value => seen.push(value.active));
  t.after(unsubscribe);
  const [outcome] = await Promise.allSettled([withRunStoreForegroundActivity(root, async () => {
    assert.equal(runStoreForegroundActivity(root).active, 1);
    assert.deepEqual(await readRunStoreForegroundActivity(root), { active: 1, orphaned: 0, unverified: 0 });
    await withRunStoreForegroundActivity(root, async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
        `import {readRunStoreForegroundActivity} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(await readRunStoreForegroundActivity(process.argv[1])));`, root], { windowsHide: true });
      assert.deepEqual(JSON.parse(stdout), { active: 1, orphaned: 0, unverified: 0 });
    });
    throw null;
  })]);
  assert.deepEqual(outcome, { status: 'rejected', reason: null });
  assert.deepEqual(seen, [1, 0]);
  assert.equal(runStoreForegroundActivity(root).active, 0);
  assert.deepEqual(await readRunStoreForegroundActivity(root), { active: 0, orphaned: 0, unverified: 0 });
});

test('foreground action plus tampered claim cleanup retains falsy error and exact ownership evidence', async t => {
  const { root } = await fixture(t), directory = join(root, '.run-locks', '.foreground-activity');
  const [outcome] = await Promise.allSettled([withRunStoreForegroundActivity(root, async () => {
    const [name] = (await readdir(directory)).filter(name => name !== '.pending');
    const path = join(directory, name), owner = JSON.parse(await readFile(path));
    await writeFile(path, canonicalJSON({ ...owner, token: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }));
    throw false;
  })]);
  assert.equal(outcome.status, 'rejected'); assert(outcome.reason instanceof AggregateError);
  assert.equal(outcome.reason.errors[0], false);
  assert.equal(outcome.reason.errors[1].code, 'RUN_STORE_FOREGROUND_IDENTITY');
  assert.equal(runStoreForegroundActivity(root).active, 0);
  assert.equal((await readRunStoreForegroundActivity(root)).active, 1);
  const [name] = (await readdir(directory)).filter(name => name !== '.pending');
  await assert.rejects(recoverRunStoreForegroundActivity(root, name.slice(9, -5), 'wrong'), { code: 'RUN_STORE_FOREGROUND_IDENTITY' });
  await assert.rejects(recoverRunStoreForegroundActivity(root, name.slice(9, -5), 'ffffffff-ffff-ffff-ffff-ffffffffffff'), { code: 'RUN_STORE_FOREGROUND_ACTIVE' });
});

test('observing a missing Run fails without recreating its identity', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.read('missing'), { code: 'ENOENT' });
  await assert.rejects(lstat(store.directory('missing')), { code: 'ENOENT' });
});

test('default admission diagnostics coalesce repeated polling but retain owner changes, slow acquisition and errors', async t => {
  const { root } = await fixture(t), original = console.error, logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const trace = { phase: 'process_queued', lock_path: join(root, '.writer.lock'), owner_pid: process.pid };
    for (let index = 0; index < 20; index++) admissionTrace(trace);
    assert.equal(logs.length, 1);
    admissionTrace({ ...trace, owner_pid: process.pid + 1 });
    admissionTrace({ ...trace, phase: 'process_acquired', waited_ms: 150 });
    admissionTrace({ ...trace, phase: 'process_acquired', waited_ms: 160 });
    admissionTrace({ ...trace, phase: 'open_failed', open_error_code: 'EPERM' });
    admissionTrace({ ...trace, phase: 'open_failed', open_error_code: 'EPERM' });
    assert.equal(logs.length, 6);
  } finally { console.error = original; }
});

test('interrupted Run purge ownership prevents unpublished initialization reclamation', async t => {
  const { store } = await fixture(t), id = 'purging', directory = store.directory(id);
  await mkdir(directory); await mkdir(join(directory, '.recovery.lock'));
  const pins = { resources: [] }, state = { run_id: id, status: 'running', pins_hash: digest(canonicalJSON(pins)) };
  await assert.rejects(store.create(id, pins, new Map(), state), { code: 'RUN_INITIALIZATION_RECOVERY_REQUIRED' });
  assert.equal((await lstat(join(directory, '.recovery.lock'))).isDirectory(), true);
});

test('authoring purge cannot cross an active exact Run writer and removes only after its fence settles', async t => {
  const { store } = await fixture(t), id = 'authoring';
  const pins = { resources: [], root: { workflow: { id: 'job' }, revision_hash: 'job-revision',
    provenance: { kind: 'authoring_workflow_run', source_workflow_id: 'source', source_revision: 'source-revision' } } };
  await store.create(id, pins, new Map(), { run_id: id, status: 'succeeded', pins_hash: digest(canonicalJSON(pins)) });
  const options = { expected_workflow_id: 'job', expected_revision: 'job-revision', expected_source_workflow_id: 'source', expected_source_revision: 'source-revision' };
  const entered = gate(), release = gate();
  const holding = store.withRunWriter(id, async () => { entered.release(); await release.promise; });
  await entered.promise;
  try { await assert.rejects(store.purge(id, options), { code: 'WORKFLOW_STORE_BUSY' }); }
  finally { release.release(); await holding; }
  assert.equal((await store.read(id)).sequence, 1);
  assert.deepEqual(await store.purge(id, options), { run_id: id, purged: true, sequence: 1 });
  await assert.rejects(lstat(store.directory(id)), { code: 'ENOENT' });
});
