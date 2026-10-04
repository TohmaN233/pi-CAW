import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workflow, agent, settle } from './fixtures.mjs';
import { readFile } from 'node:fs/promises';
test('native Pi child runs are journaled and final completion waits for human acceptance', async t => {
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: workflow() });
  const run = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'test' } });
  assert.equal(run.control_token, undefined);
  const snapshot = await settle(f.service, run.run_id);
  assert.equal(snapshot.state.nodes.work.status, 'succeeded');
  assert.equal(snapshot.state.nodes.final.status, 'running');
  assert.equal(f.notifications.at(-1).status, 'awaiting_acceptance');
  const record = await f.service.runtime.runs.read(run.run_id);
  const attempt = record.state.nodes.final.attempts.at(-1);
  assert.equal(attempt.dispatch.receipt.executor, 'pi-isolated-main');
  assert.equal(attempt.dispatch.receipt.main_mode, 'worker');
  assert.equal(attempt.dispatch.receipt.session_id, f.mainSession);
  assert.equal(record.state.main_actor, f.mainSession);
  assert.equal(f.requests.length, 1); assert.equal(f.mainRequests.length, 1);
  assert.equal(f.mainRequests[0].binding, null);
  assert.equal(record.state.nodes.work.attempts[0].completion.evidence[0].kind, 'pi_session');
  await assert.rejects(f.service.call('accept_final', { run_id: run.run_id, accepted: true }), { code: 'FINAL_ACCEPTANCE_REQUIRED' });
  await f.service.call('accept_final', { run_id: run.run_id, accepted: true, proposal_sha256: attempt.result_proposal.sha256 }, { human: true });
  assert.equal((await settle(f.service, run.run_id)).state.status, 'succeeded');
});
test('thread continuation uses the exact upstream Pi session, not a new task', async t => {
  const workers = [agent('first', { kind: 'thread', provider_id: 'worker', lifecycle: 'start' }), agent('next', { kind: 'thread', provider_id: 'worker', lifecycle: 'continue', source_node: 'first' })];
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: workflow(workers) });
  const run = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'test' } });
  const snapshot = await settle(f.service, run.run_id);
  assert.equal(snapshot.state.nodes.next.status, 'succeeded');
  const record = await f.service.runtime.runs.read(run.run_id);
  assert.equal(record.state.nodes.first.attempts[0].dispatch.receipt.thread_id, record.state.nodes.next.attempts[0].dispatch.receipt.thread_id);
  assert.equal(f.requests[1].session_id, record.state.nodes.first.attempts[0].dispatch.receipt.thread_id);
});

test('unconfirmed executor shutdown retains the exact interrupted attempt and cannot release final Main', async t => {
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: workflow() });
  f.host.releaseTask = async () => { throw Object.assign(new Error('Disconnected exact executor'), { code: 'PI_PARENT_MAIN_DISCONNECTED' }); };
  const started = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'test shutdown' } });
  const snapshot = await settle(f.service, started.run_id);
  assert.equal(snapshot.state.status, 'interrupted', JSON.stringify({ worker: snapshot.host_worker, notices: f.notifications, attempts: snapshot.state.nodes.work.attempts }));
  assert.equal(snapshot.state.nodes.work.status, 'interrupted');
  assert.equal(snapshot.state.nodes.final.status, 'pending');
  assert.equal(f.requests.length, 1); assert.equal(f.mainRequests.length, 0);
  const attempt = snapshot.state.nodes.work.attempts[0];
  assert.ok(attempt.dispatch.receipt); assert.ok(attempt.result_proposal);
  assert.equal(attempt.executor_events.some(event => event.kind === 'session_state' && event.metadata.status === 'closed'), false);
  await assert.rejects(f.service.call('continue', { run_id: started.run_id }), { code: 'PI_DISPATCH_UNRESOLVED' });
});
test('missing active Main context blocks before a Run or model effect', async t => {
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: workflow() });
  f.host.mainIdentity = () => { throw Object.assign(new Error('No current chat'), { code: 'PI_MAIN_SESSION_REQUIRED' }); };
  await assert.rejects(f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'test' } }), { code: 'PI_MAIN_SESSION_REQUIRED' });
  assert.equal(f.requests.length, 0); assert.equal((await f.service.call('runs')).length, 0);
});
test('Workflow package exports retain exact resources and use a distinct Pi identity', async t => {
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: workflow(), resources: { 'instructions/test.md': 'exact bytes' } });
  const bundle = await f.service.call('export_workflow_package', { workflow_id: 'example' });
  assert.equal(bundle.format, 'pi-caw.workflow.package'); assert.equal(bundle.compatibility.plugin, 'pi-CAW');
  assert.equal(Buffer.from(bundle.objects[0].content_base64, 'base64').toString(), 'exact bytes');
});
test('a Host without isolated Main support fails before Run creation rather than weakening Strict', async t => {
  const f = await fixture(t), graph = workflow();
  f.host.capabilities.isolated_main = false;
  graph.skill_policy = { mode: 'strict', implicit: 'deny', ambient_allow: [], shadowed_skill_paths: [] };
  await f.service.call('create_workflow', { workflow: graph });
  await assert.rejects(f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'test' } }), { code: 'PI_MAIN_ISOLATION_UNAVAILABLE' });
  assert.equal(f.requests.length, 0); assert.equal((await f.service.call('runs')).length, 0);
});
test('the shipped example imports and runs only with an explicitly configured reviewer', async t => {
  const f = await fixture(t), bundle = JSON.parse(await readFile(new URL('../examples/review-task.pi-caw.json', import.meta.url), 'utf8'));
  await assert.rejects(f.service.call('install', { package: bundle }), { code: 'WORKFLOW_NOT_READY' });
  const config = await f.service.call('settings');
  config.settings.providers.push({ ...config.settings.providers[0], id: 'reviewer', name: 'Reviewer', binding: null });
  await f.service.call('save_settings', { settings: config.settings, expected_revision: config.revision }, { human: true });
  await f.service.call('install', { package: bundle });
  await assert.rejects(f.service.call('run', { workflow_id: 'review-task', workspace: f.workspace, access: 'read_only', inputs: { task: 'review' } }), { code: 'PI_MODEL_BINDING_REQUIRED' });
  const bound = await f.service.call('settings'); bound.settings.providers[1].binding = bound.settings.providers[0].binding;
  await f.service.call('save_settings', { settings: bound.settings, expected_revision: bound.revision }, { human: true });
  const run = await f.service.call('run', { workflow_id: 'review-task', workspace: f.workspace, access: 'read_only', inputs: { task: 'review' } });
  assert.equal((await settle(f.service, run.run_id)).state.nodes.review.status, 'succeeded');
});
