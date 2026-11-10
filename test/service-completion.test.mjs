import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PiCawService } from '../lib/service.mjs';
import { fixture as workflowFixture, workflow } from './fixtures.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-completion-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entered = deferred(), release = deferred();
  let drives = 0, closed = 0;
  const service = new PiCawService({ directory, workerMode: true,
    host: { mainIdentity: () => ({ session_id: 'fictional' }), close: async () => { closed++; } } });
  service.runtime = { runs: { directory: () => directory } };
  service.assertDriverRelease = async () => {};
  service.collectParent = async () => {};
  service.notify = async () => {};
  service.drive = async () => { drives++; entered.resolve(); await release.promise; return { status: 'succeeded' }; };
  return { service, entered, release, journal: join(directory, 'pi-worker.json'), drives: () => drives, closed: () => closed };
}
function denyRename(t, journal, error) {
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => { if (to === journal) throw error; return original(from, to); };
  syncBuiltinESMExports();
  const restore = () => { fs.promises.rename = original; syncBuiltinESMExports(); };
  t.after(restore); return restore;
}
const denied = () => Object.assign(new Error('fictional rename denial'), { code: 'EPERM', syscall: 'rename' });

test('successful completion includes terminal journal and notification, retained after active deletion', async t => {
  const f = await fixture(t), notified = deferred();
  f.service.notify = async () => { await notified.promise; };
  await f.service.launchDriver('run'); await f.entered.promise;
  let settled = false;
  const completion = f.service.awaitCompletion('run').then(result => { settled = true; return result; });
  f.release.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  notified.resolve(); assert.deepEqual(await completion, { status: 'succeeded' });
  assert.equal(f.service.active.size, 0);
  assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).status, 'succeeded');
  assert.deepEqual(await f.service.awaitCompletion('run'), { status: 'succeeded' });
  await f.service.close(); await f.service.close(); assert.equal(f.closed(), 1);
});

for (const closeEarly of [false, true]) test(`terminal persistence rejects after semantic success; close ${closeEarly ? 'before' : 'after'} active deletion`, async t => {
  const f = await fixture(t), error = denied();
  await f.service.launchDriver('run'); await f.entered.promise;
  denyRename(t, f.journal, error);
  const completed = assert.rejects(f.service.awaitCompletion('run'), actual => actual === error);
  const closed = closeEarly ? assert.rejects(f.service.close(), actual => actual === error) : null;
  f.release.resolve(); await completed;
  assert.equal(f.service.active.size, 0);
  if (closed) await closed; else await assert.rejects(f.service.close(), actual => actual === error);
  assert.equal(f.closed(), 1); assert.equal(f.drives(), 1);
  await assert.rejects(f.service.awaitCompletion('run'), actual => actual === error);
});

test('initial persistence failure rejects unchanged without dispatch or attention conversion', async t => {
  const f = await fixture(t), error = denied(); denyRename(t, f.journal, error);
  await f.service.launchDriver('run');
  await assert.rejects(f.service.awaitCompletion('run'), actual => actual === error);
  await assert.rejects(f.service.close(), actual => actual === error);
  assert.equal(f.drives(), 0);
});

test('notification rejection is retained after succeeded worker journal', async t => {
  const f = await fixture(t), error = new Error('notification failed');
  f.service.notify = async () => { throw error; };
  await f.service.launchDriver('run'); f.release.resolve();
  await assert.rejects(f.service.awaitCompletion('run'), actual => actual === error);
  assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).status, 'succeeded');
  await assert.rejects(f.service.close(), actual => actual === error);
});

test('parent collection rejection is retained before any caller subscribes', async t => {
  const f = await fixture(t), error = new Error('parent collection failed'), attempted = deferred();
  f.service.collectParent = async () => { attempted.resolve(); throw error; };
  await f.service.launchDriver('run'); f.release.resolve(); await attempted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.active.size, 0);
  await assert.rejects(f.service.awaitCompletion('run'), actual => actual === error);
  await assert.rejects(f.service.close(), actual => actual === error);
});

test('public completion follows actual fixture Workflow acceptance without another dispatch', async t => {
  const f = await workflowFixture(t);
  await f.service.call('create_workflow', { workflow: workflow() });
  const run = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'fictional completion' }, detached_host: false });
  assert.equal((await f.service.awaitCompletion(run.run_id)).status, 'awaiting_acceptance');
  const record = await f.service.runtime.runs.read(run.run_id);
  const attempt = record.state.nodes.final.attempts.at(-1);
  const dispatches = f.requests.length + f.mainRequests.length;
  await f.service.call('accept_final', { run_id: run.run_id, accepted: true, proposal_sha256: attempt.result_proposal.sha256 }, { human: true });
  assert.equal((await f.service.awaitCompletion(run.run_id)).status, 'succeeded');
  assert.equal((await f.service.call('get', { run_id: run.run_id })).status, 'succeeded');
  assert.equal(f.requests.length + f.mainRequests.length, dispatches);
});

test('ordinary driver error remains attention; failed attention persistence retains both causes', async t => {
  for (const secondary of [false, true]) {
    const f = await fixture(t), original = new Error('model attention'), error = denied();
    f.service.drive = async () => { f.entered.resolve(); await f.release.promise; throw original; };
    await f.service.launchDriver('run'); await f.entered.promise;
    const restore = secondary ? denyRename(t, f.journal, error) : () => {};
    f.release.resolve();
    if (secondary) {
      await assert.rejects(f.service.awaitCompletion('run'), actual => actual instanceof AggregateError && actual.errors[0] === original && actual.errors[1] === error);
      await assert.rejects(f.service.close(), AggregateError);
    } else {
      assert.equal((await f.service.awaitCompletion('run')).status, 'attention'); await f.service.close();
    }
    restore();
  }
});

test('falsy driver rejections retain exact identity alongside secondary completion failures', async t => {
  for (const original of [0, null, undefined, false, '']) {
    const f = await fixture(t), secondary = new Error('attention notification failed');
    f.service.drive = async () => { throw original; };
    f.service.notify = async () => { throw secondary; };
    await f.service.launchDriver('run');
    const both = actual => actual instanceof AggregateError && actual.errors.length === 2
      && Object.is(actual.errors[0], original) && actual.errors[1] === secondary;
    await assert.rejects(f.service.awaitCompletion('run'), both);
    await assert.rejects(f.service.close(), both);
    assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).status, 'attention');
  }
});

test('shutdown drains completion and roles despite retention, bridge and host cleanup failures', async t => {
  const f = await fixture(t), primary = denied(), retention = new Error('retention'), bridge = new Error('bridge'), host = new Error('host'), role = new Error('role');
  await f.service.launchDriver('run'); await f.entered.promise; denyRename(t, f.journal, primary);
  f.service.retention.pending = Promise.reject(retention); f.service.retention.pending.catch(() => {});
  f.service.parentBridges.set('bridge', { close() { throw bridge; } });
  let closed = false;
  f.service.host.close = async () => { closed = true; f.release.resolve(); throw host; };
  f.service.roleTasks.set('role', Promise.reject(role)); f.service.roleTasks.get('role').catch(() => {});
  await assert.rejects(f.service.close(), error => error instanceof AggregateError && [retention, bridge, host, primary, role].every(item => error.errors.includes(item)));
  assert.equal(closed, true); assert.equal(f.service.active.size, 0); assert.equal(f.service.parentBridges.size, 0);
  await assert.rejects(f.service.launchDriver('next'), { code: 'PI_SERVICE_CLOSED' });
});

test('waiters bind the current generation; unavailable runs reject instead of inventing completion', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.awaitCompletion('unknown'), { code: 'PI_COMPLETION_UNAVAILABLE' });
  await f.service.launchDriver('run'); const first = f.service.awaitCompletion('run');
  f.release.resolve(); assert.equal((await first).status, 'succeeded');
  f.service.drive = async () => ({ status: 'paused' });
  await f.service.launchDriver('run');
  assert.equal((await f.service.awaitCompletion('run')).status, 'paused');
  assert.equal((await first).status, 'succeeded'); await f.service.close();
});

test('Windows actual no-delete-share handle rejects worker rename and reaches caller unchanged', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t); await f.service.launchDriver('run'); await f.entered.promise;
  const command = `$f=[System.IO.File]::Open('${f.journal.replaceAll("'", "''")}','Open','Read','Read'); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error(`lock holder exited ${code}: ${stderr}`)));
    child.stdout.on('data', data => { if (String(data).includes('READY')) resolve(); });
  });
  f.release.resolve(); let original;
  try { await f.service.awaitCompletion('run'); assert.fail('locked terminal write must reject'); }
  catch (error) { assert.equal(error.code, 'EPERM'); assert.equal(error.syscall, 'rename'); original = error; }
  finally { const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end('\n'); await exited; }
  await assert.rejects(f.service.close(), error => error === original);
  assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).status, 'running'); assert.equal(f.drives(), 1);
});
