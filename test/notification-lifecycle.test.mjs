import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiCawService } from '../lib/service.mjs';
import {canonicalJSON,digest} from '../core/workflow-revisions.mjs';

function fixture(record) {
  const events = [], notified = [];
  const service = new PiCawService({ directory: join(tmpdir(), 'pi-notification-fixture'),
    host: { mainIdentity: () => ({ session_id: 'latest-unrelated-chat' }), emit: async (name, event) => events.push({ name, event }) },
    notify: async event => { assert.deepEqual(events.at(-1)?.event, event); notified.push(event); } });
  service.runtime = { runs: { read: async () => record, retained: async()=>null } };
  return { service, events, notified };
}
function record(attempts = [], provenance = {}) { return { state: { run_id: 'exact-run', main_actor: 'original-chat',status:'running',inputs:{},nodes: { task: { status:'running',attempts } } },
  pins: { root: { workflow: {name:'Fixture',nodes:[{id:'task'}],host_tools: [{ id: 'course_artifact_compile' }] }, provenance } } }; }

test('terminal lifecycle carries immutable domain classification and the original actor before notification', async () => {
  const f = fixture(record([{ host_tool: { phase: 'observed', receipt: { status: 'succeeded' } } }]));
  await f.service.notify({ run_id: 'exact-run', status: 'succeeded' });
  const event = f.notified[0];
  assert.equal(event.main_actor, 'original-chat'); assert.deepEqual(event.host_tool_ids, ['course_artifact_compile']);
  assert.equal(event.quiescent, true); assert.equal(event.ownership_released, true);
  const restart = fixture(record([{ host_tool: { phase: 'observed', receipt: { status: 'succeeded' } } }]));
  await restart.service.notify({ ...event, delivery_id: 'exact-original-delivery' });
  assert.deepEqual(restart.notified[0].notification_context, event.notification_context);
  assert.equal(restart.events.find(item=>item.name==='pi-caw:run-lifecycle').event.ownership_released, true);
});

test('attention retains ownership, and unresolved tool/SDK shutdown cannot release cancelled or failed ownership', async () => {
  for (const attempt of [{ host_tool: { phase: 'intent', receipt: null } }, { dispatch: { phase: 'acknowledged', receipt: {} }, executor_events: [] },
    { host_tool: { receipt: { status: 'cancelled', reconciliation: { termination_confirmed: false } } } }]) {
    const f = fixture(record([attempt]));
    for (const status of ['attention', 'cancelled', 'failed']) {
      const event = await f.service.enrichNotification({ run_id: 'exact-run', status });
      assert.equal(event.quiescent, false); assert.equal(event.ownership_released, false);
    }
  }
  const closed = fixture(record([{ dispatch: {}, executor_events: [{ kind: 'session_state', metadata: { status: 'closed' } }] }]));
  assert.equal((await closed.service.enrichNotification({ run_id: 'exact-run', status: 'cancelled' })).ownership_released, true);
  assert.equal((await closed.service.enrichNotification({ run_id: 'exact-run', status: 'attention' })).ownership_released, false);
});

test('service cancellation drains active owners and requires exact termination evidence before fencing or releasing', async () => {
  const attempt = { host_tool: { phase: 'intent', receipt: null } }, f = fixture(record([attempt]));
  f.service.flushTerminalNotifications = async () => {}; f.service.refreshContext = async () => {};
  f.service.descendants = async () => ['exact-run']; f.service.authority = async () => ({ control_token: 'fixture' });
  let drained = false, fenced = 0, release;
  const controller = new AbortController(), aborted = new Promise(done => controller.signal.addEventListener('abort', done, { once: true }));
  f.service.active.set('exact-run', { controller, completion: new Promise(done => { release = () => { drained = true; done(); }; }) });
  f.service.runtime.cancelTree = async () => { assert.equal(drained, true); fenced++; return ['exact-run']; };
  const cancellation = f.service.call('cancel', { run_id: 'exact-run' }, { human: true });
  await aborted; assert.equal(fenced, 0); assert.equal(f.notified.length, 0);
  attempt.host_tool.receipt = { status: 'cancelled', reconciliation: { termination_confirmed: true } };
  release(); assert.deepEqual(await cancellation, ['exact-run']);
  assert.equal(f.notified.at(-1).ownership_released, true); assert.equal(f.notified.at(-1).quiescent, true);
  f.service.active.clear(); attempt.host_tool.receipt = null;
  await assert.rejects(f.service.call('cancel', { run_id: 'exact-run' }, { human: true }), { code: 'PI_CANCEL_SHUTDOWN_UNCONFIRMED' });
  assert.equal(fenced, 1, 'An unresolved prior effect cannot be fenced into successful cancellation');
});

test('a superseded paused authoring Run cancels with committed Host replay evidence and closed exact Pi session', async () => {
  const structured_output={proposal:{contract:'offline-fixture',meaning:'retained unchanged'}},materialized_sha256=digest(canonicalJSON(structured_output));
  const completion={status:'succeeded',summary:'Immutable offline replay',structured_output,artifacts:[],changed_paths:[],outside_paths:[],
    evidence:[{kind:'host_generation_recheck',source_run_id:'original-run',source_attempt_id:'original-attempt',result_sha256:'a'.repeat(64),materialized_sha256}]};
  const completion_hash=digest(canonicalJSON(completion));
  const replay={status:'succeeded',completion,completion_hash,result_proposal:{sha256:completion_hash},executor_events:[],
    dispatch:{phase:'acknowledged',cancellation_pending:false,receipt:{executor:'host-generation-replay',task_id:'original-run',invocation_id:'original-attempt',source_result_sha256:'a'.repeat(64),result_sha256:materialized_sha256}}};
  const closed={status:'succeeded',dispatch:{phase:'acknowledged',receipt:{executor:'pi-sdk-subagent'}},executor_events:[{kind:'session_state',metadata:{status:'closed'}}]};
  const saved=record([replay,closed],{kind:'authoring_workflow_run'});saved.state.status='paused';saved.state.control_recovery={errors:[]};
  const f=fixture(saved);f.service.flushTerminalNotifications=async()=>{};f.service.refreshContext=async()=>{};
  f.service.descendants=async()=>['exact-run'];f.service.authority=async()=>({control_token:'offline-control'});
  let cancelled=0;f.service.runtime.cancelTree=async()=>{cancelled++;saved.state.status='cancelled';return['exact-run'];};
  assert.equal(await f.service.runQuiescent(saved),true);
  assert.deepEqual(await f.service.call('cancel',{run_id:'exact-run'},{human:true}),['exact-run']);
  assert.equal(cancelled,1);assert.equal(f.notified.at(-1).ownership_released,true);
  for(const change of [
    attempt=>{attempt.status='running';},attempt=>{attempt.dispatch.phase='intent';},attempt=>{attempt.dispatch.cancellation_pending=true;},
    attempt=>{delete attempt.result_proposal;},attempt=>{attempt.dispatch.receipt.result_sha256='b'.repeat(64);},
    attempt=>{attempt.completion.structured_output.proposal.meaning='changed';},attempt=>{attempt.dispatch.receipt.executor='unknown-executor';},
  ]){
    const incomplete=structuredClone(replay);change(incomplete);saved.state.nodes.task.attempts=[incomplete,closed];
    await assert.rejects(f.service.call('cancel',{run_id:'exact-run'},{human:true}),{code:'PI_CANCEL_SHUTDOWN_UNCONFIRMED'});
    assert.equal(cancelled,1,'Incomplete replay never gets successful cancellation or ownership release');
  }
  saved.state.nodes.task.attempts=[replay,{...closed,executor_events:[]}];
  assert.equal(await f.service.runQuiescent(saved),false,'Another unresolved SDK producer is still live');
});

test('only explicit accepted authoring cleanup can use retained classification after intentional Run purge', async () => {
  const f = fixture(record([], { kind: 'authoring_workflow_run' }));
  const retained = await f.service.enrichNotification({ run_id: 'exact-run', status: 'succeeded', publication: 'accepted_cleanup_pending',
    deployed_workflow_id: 'published', deployed_revision: 'a'.repeat(64) });
  f.service.runtime.runs.read = async () => { throw Object.assign(new Error('Private Run intentionally purged'), { code: 'ENOENT' }); };
  const replay = { ...retained, authoring_cleanup: { cleanup_transaction: { run_id: 'exact-run' }, private_authoring_artifacts_purged: true } };
  assert.equal((await f.service.enrichNotification(replay)).ownership_released, true);
  const restarted = fixture(undefined); restarted.service.runtime.runs.read = f.service.runtime.runs.read;
  assert.equal((await restarted.service.enrichNotification(replay)).ownership_released, true);
  await assert.rejects(restarted.service.enrichNotification({ run_id: 'exact-run', status: 'succeeded' }), { code: 'PI_NOTIFICATION_CONTEXT_MISSING' });
  await assert.rejects(restarted.service.enrichNotification({ ...replay, notification_context: { ...replay.notification_context, authoring: false } }), { code: 'PI_NOTIFICATION_CONTEXT_MISSING' });
  restarted.service.runtime.runs.read = async () => { throw Object.assign(new Error('Unreadable real Run'), { code: 'EACCES' }); };
  await assert.rejects(restarted.service.enrichNotification(replay), { code: 'EACCES', message: 'Unreadable real Run' });
});
