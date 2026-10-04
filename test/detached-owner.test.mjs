import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DetachedOwnerRegistry, createOwnerRpcServer, ownerRpc, assertOwnerDescriptor } from '../lib/detached-owner.mjs';
import { appendEvent, readEvents } from '../core/workflow-events.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const secret = 'private-bootstrap-credential-never-on-disk';
const runtimeSource = `
import { appendFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ownerRpc } from ${JSON.stringify(new URL('../lib/detached-owner.mjs', import.meta.url).href)};
export async function createOwnerRuntime(context) {
  if(context.boot.startup_mode==='quiescent_failure')throw Object.assign(new Error('Confirmed fixture bootstrap cleanup'),{code:'FIXTURE_BOOTSTRAP',quiescent:true});
  if(context.boot.startup_mode==='delayed')await new Promise((resolve,reject)=>{
    const timer=setTimeout(resolve,500);
    context.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(new Error('Confirmed fixture aborted before effects'),{code:'FIXTURE_BOOTSTRAP_ABORTED',quiescent:true}));},{once:true});
  });
  if(context.boot.startup_mode==='blocked'){
    await writeFile(join(context.boot.owned_directory,'startup-ready.txt'),context.run_id);
    await new Promise((resolve,reject)=>{
      const abort=()=>reject(Object.assign(new Error('Confirmed fixture aborted before effects'),{code:'FIXTURE_BOOTSTRAP_ABORTED',quiescent:true}));
      if(context.signal.aborted)abort();else context.signal.addEventListener('abort',abort,{once:true});
    });
  }
  let count=0, stops=0, parentSeen=false, finished;
  let tail=Promise.resolve();
  const completion=new Promise(resolve=>{finished=resolve;});
  const terminalEvent={run_id:context.run_id,status:'succeeded',sequence:42,summary:'original fixture notification'};
  const terminalEvents=context.boot.include_nested_notifications?[terminalEvent,{run_id:'nested-exact',status:'failed'},{role_run_id:'role-exact',status:'failed'}]:[terminalEvent];
  let driver=Promise.resolve();
  if(context.boot.driver_notify_cycle)driver=new Promise((resolve,reject)=>setTimeout(async()=>{
    try {
      await context.report({status:'succeeded',sequence:42,parent_notification:{status:'queued',events:[terminalEvent],queued_count:1}});
      await context.report({status:'succeeded',parent_notification:{status:'delivered',events:[],queued_count:0}});
      finished({status:'succeeded'});resolve();
    }catch(error){reject(error);}
  },40));
  const timer=setInterval(()=>{
    tail=tail.then(async()=>{await context.assertAuthority();count++;await appendFile(join(context.boot.owned_directory,'effects.txt'),count+'\\n');})
      .catch(error=>{if(!context.signal.aborted)throw error;});
  },20);
  return {completion,
    async call(operation,args) {
      if(operation==='facts')return {count,parentSeen,pid:process.pid,run_id:context.run_id};
      if(operation==='service_call' && args.operation==='echo')return {echo:args.args.value};
      if(operation==='service_call' && args.operation==='queue_terminal_notification') {
        await context.report({status:'succeeded',sequence:42,parent_notification:{status:'queued',events:terminalEvents,queued_count:terminalEvents.length}});
        await context.report({status:'succeeded'});
        return {queued:true,event:terminalEvent};
      }
      if(operation==='service_call' && args.operation==='publish_and_purge') {
        await context.report({status:'succeeded'});
        await rm(context.boot.controller_journal);
        await new Promise(resolve=>setTimeout(resolve,60));
        return {accepted:true};
      }
      throw Object.assign(new Error('Unknown fixture operation'),{code:'FIXTURE_OPERATION'});
    },
    async reattach(bridge){parentSeen=(await ownerRpc(bridge,'parent_probe',{})).same_chat===true;},
    async stop(reason) {
      clearInterval(timer);try{await tail;}catch(error){if(!context.signal.aborted || error.code!=='OWNER_AUTHORITY_REVOKED')throw error;}await driver;stops++;
      await writeFile(join(context.boot.owned_directory,'stop.json'),JSON.stringify({reason,count,stops}));
      if(context.boot.fail_first_stop && stops===1)return {quiescent:false};
      finished({status:'cancelled'});return {quiescent:true};
    }
  };
}
`;

async function fixture(t, run_id = 'owner-fixture') {
  const root = await mkdtemp(join(tmpdir(), 'pi-detached-owner-')), owned_directory = join(root, 'effects'); await mkdir(owned_directory);
  const controller_journal = join(root, 'events.jsonl'), runtime_entry = join(root, 'fixture-runtime.mjs');
  await writeFile(runtime_entry, runtimeSource);
  const controller_hash = digest('exact-original-controller'), main_actor = 'original-pi-chat';
  await appendEvent(controller_journal, [], 'started', { state: { run_id, control_hash: controller_hash, main_actor, status: 'running', nodes: {}, edges: {}, approvals: {} } });
  const registry = new DetachedOwnerRegistry({ directory: root, heartbeatMs: 30, handshakeMs: 5000 });
  const options = { run_id, controller_hash, main_actor, controller_journal, runtime_entry,
    boot: { owned_directory, controller_journal, api_key: secret } };
  t.after(async () => {
    const state = await registry.read(run_id);
    if (state && !state.termination?.confirmed) await registry.stop(run_id, 'fixture_cleanup');
    await delay(100);
    assert(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  });
  return { root, owned_directory, registry, options };
}

async function until(registry, runId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const state = await registry.read(runId); if (predicate(state)) return state; await delay(10); }
  throw new Error(`Timed out waiting for exact detached owner ${runId}: ${JSON.stringify(await registry.read(runId))}; ${(await readFile(join(registry.paths(runId).directory, 'owner.log'), 'utf8')).slice(-2000)}`);
}

async function effects(f) { try { return await readFile(join(f.owned_directory, 'effects.txt'), 'utf8'); } catch (cause) { if (cause.code === 'ENOENT') return ''; throw cause; } }

async function launchFromExitingParent(options, directory) {
  const script = `import {DetachedOwnerRegistry} from ${JSON.stringify(new URL('../lib/detached-owner.mjs', import.meta.url).href)};
    const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks));
    const registry=new DetachedOwnerRegistry({directory:input.directory,heartbeatMs:30,handshakeMs:5000});
    process.stdout.write(JSON.stringify(await registry.launch(input.options)));`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; parent.stdout.on('data', chunk => { stdout += chunk; }); parent.stderr.on('data', chunk => { stderr += chunk; });
  parent.stdin.end(JSON.stringify({ options, directory }));
  const code = await new Promise((resolveExit, reject) => { parent.on('error', reject); parent.on('exit', resolveExit); });
  assert.equal(code, 0, stderr); return { parent_pid: parent.pid, owner: JSON.parse(stdout) };
}

test('owner RPC authenticates loopback identity and closes pending requests explicitly', async () => {
  const server = await createOwnerRpcServer({ run_id: 'rpc-run', handle: async (operation, args) => operation === 'pending' ? new Promise(() => {}) : { operation, value: args.value } });
  assert.deepEqual(await ownerRpc(server.descriptor, 'echo', { value: 3 }), { operation: 'echo', value: 3 });
  await assert.rejects(ownerRpc({ ...server.descriptor, token: '0'.repeat(64) }, 'echo', {}), { code: 'OWNER_RPC_AUTH' });
  await assert.rejects(ownerRpc({ ...server.descriptor, owner_id: 'another-owner' }, 'echo', {}), { code: 'OWNER_RPC_IDENTITY' });
  assert.throws(() => assertOwnerDescriptor({ ...server.descriptor, url: 'http://example.com:123/owner-rpc' }), { code: 'OWNER_ENDPOINT' });
  const pending = ownerRpc(server.descriptor, 'pending', {}, { timeoutMs: 0 });
  const rejected = assert.rejects(pending); await delay(20); await server.close(); await rejected;
});

test('actual detached Node owner survives parent exit, reattaches exact chat, and stops only after quiescence', async t => {
  const f = await fixture(t), launched = await launchFromExitingParent(f.options, f.root);
  assert.notEqual(launched.owner.pid, launched.parent_pid); assert.equal(launched.owner.phase, 'running');
  assert.equal(launched.owner.url, undefined); assert.equal(launched.owner.token, undefined);
  const first = await f.registry.read(f.options.run_id);
  const heartbeat = await f.registry.wait(f.options.run_id, { after_revision: first.revision, timeoutMs: 1000 });
  assert(heartbeat.revision > first.revision); assert.equal(await f.registry.isAlive(f.options.run_id), true);
  await delay(70); const before = await effects(f); assert(before.length > 0);
  assert.deepEqual(await f.registry.call(f.options.run_id, 'service_call', { operation: 'echo', args: { value: 'still owned' } }), { echo: 'still owned' });
  const bridge = await createOwnerRpcServer({ run_id: f.options.run_id, handle: async () => ({ same_chat: true }) });
  t.after(() => bridge.close());
  const reattach = { parent_bridge: { ...bridge.descriptor, main_actor: f.options.main_actor }, main_actor: f.options.main_actor, controller_hash: f.options.controller_hash };
  await assert.rejects(f.registry.reattach(f.options.run_id, { ...reattach, main_actor: 'another-chat' }), { code: 'OWNER_REATTACH_IDENTITY' });
  await assert.rejects(f.registry.reattach(f.options.run_id, { ...reattach, parent_bridge: { ...reattach.parent_bridge, main_actor: 'another-chat' } }), { code: 'OWNER_REATTACH_IDENTITY' });
  await assert.rejects(f.registry.reattach(f.options.run_id, { ...reattach, parent_bridge: { ...reattach.parent_bridge, run_id: 'another-run' } }), { code: 'OWNER_REATTACH_IDENTITY' });
  const restored = await f.registry.reattach(f.options.run_id, reattach);
  assert.equal(restored.owner_id, first.owner_id); assert.equal(restored.pid, first.pid);
  assert.equal((await f.registry.call(f.options.run_id, 'facts')).parentSeen, true);
  const paths = f.registry.paths(f.options.run_id), privateDescriptor = await f.registry.private(f.options.run_id);
  const publicBytes = await readFile(paths.status, 'utf8'); assert.equal(publicBytes.includes(privateDescriptor.token), false);
  for (const path of [paths.status, paths.private, join(paths.directory, 'owner.log')]) assert.equal((await readFile(path, 'utf8')).includes(secret), false);
  const stopped = await f.registry.stop(f.options.run_id, 'human_stop');
  assert.equal(stopped.phase, 'stopped'); assert.deepEqual(stopped.termination, { confirmed: true, reason: 'human_stop' });
  const settledEffects = await effects(f); await delay(80); assert.equal(await effects(f), settledEffects);
  assert.equal(JSON.parse(await readFile(join(f.owned_directory, 'stop.json'), 'utf8')).reason, 'human_stop');
  assert.equal(await f.registry.isAlive(f.options.run_id), false);
  await assert.rejects(f.registry.launch(f.options), { code: 'OWNER_EXISTS' });
});

for (const cancelled of [false, true]) test(`journal ${cancelled ? 'cancellation' : 'controller rotation'} revokes detached effects before its stop receipt`, async t => {
  const f = await fixture(t, cancelled ? 'owner-cancelled' : 'owner-rotated'); await f.registry.launch(f.options); await delay(50);
  const events = (await readEvents(f.options.controller_journal)).events;
  await appendEvent(f.options.controller_journal, events, cancelled ? 'cancel' : 'control_recovery', {
    patch: { fields: cancelled ? { status: 'cancelled' } : { control_hash: digest('rotated-controller') }, nodes: {}, edges: {}, approvals: {} } });
  const stopped = await until(f.registry, f.options.run_id, value => value?.termination?.confirmed === true);
  assert.equal(stopped.phase, cancelled ? 'cancelled' : 'stopped');
  assert.equal(stopped.termination.reason, cancelled ? 'cancelled' : 'authority_revoked');
  const settled = await effects(f); await delay(80); assert.equal(await effects(f), settled);
});

test('failed quiescence remains explicit and retries only the same owner stop hook', async t => {
  const f = await fixture(t, 'owner-stop-retry'); f.options.boot.fail_first_stop = true; await f.registry.launch(f.options);
  await assert.rejects(f.registry.stop(f.options.run_id, 'requested'), { code: 'OWNER_STOP_UNCONFIRMED' });
  const failed = await f.registry.read(f.options.run_id); assert.equal(failed.phase, 'failed'); assert.equal(failed.termination.confirmed, false);
  await assert.rejects(f.registry.pendingNotifications(f.options.run_id), { code: 'OWNER_NOTIFICATION_STATE' });
  const events = (await readEvents(f.options.controller_journal)).events;
  const nextHash = digest('stop-retry-controller');
  await appendEvent(f.options.controller_journal, events, 'control_recovery', { patch: { fields: { control_hash: nextHash }, nodes: {}, edges: {}, approvals: {} } });
  await assert.rejects(f.registry.launch({ ...f.options, controller_hash: nextHash }), { code: 'OWNER_EXISTS' });
  const stopped = await f.registry.stop(f.options.run_id, 'requested');
  assert.equal(stopped.owner_id, failed.owner_id); assert.equal(stopped.pid, failed.pid); assert.equal(stopped.termination.confirmed, true);
  assert.equal(JSON.parse(await readFile(join(f.owned_directory, 'stop.json'), 'utf8')).stops, 2);
});

test('a confirmed authority stop resumes the same reconciled controller and archives its exact generation', async t => {
  const f = await fixture(t, 'owner-same-controller'), first = await f.registry.launch(f.options);
  let events = (await readEvents(f.options.controller_journal)).events;
  await appendEvent(f.options.controller_journal, events, 'pause', { patch: { fields: { status: 'interrupted' }, nodes: {}, edges: {}, approvals: {} } });
  const stopped = await until(f.registry, f.options.run_id, state => state?.termination?.confirmed === true);
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.termination.reason, 'authority_revoked');
  await assert.rejects(f.registry.launch(f.options), { code: 'OWNER_AUTHORITY' });
  events = (await readEvents(f.options.controller_journal)).events;
  await appendEvent(f.options.controller_journal, events, 'recover', { patch: { fields: { status: 'running' }, nodes: {}, edges: {}, approvals: {} } });
  const resumed = await f.registry.launch(f.options);
  assert.equal(resumed.generation, 2); assert.notEqual(resumed.owner_id, first.owner_id);
  assert.equal(resumed.controller_hash, first.controller_hash);
  const history = await f.registry.history(f.options.run_id); assert.equal(history[0].owner_id, first.owner_id);
  const listed = await f.registry.list(); assert.equal(listed.length, 1); assert.equal(listed[0].owner_id, resumed.owner_id);
  assert.equal(listed[0].url, undefined); assert.equal(listed[0].token, undefined);
});

test('a confirmed stopped generation permits exact controller recovery and retains prior ownership evidence', async t => {
  const f = await fixture(t, 'owner-generations'), first = await f.registry.launch(f.options);
  const oldEndpoint = await f.registry.private(f.options.run_id);
  await f.registry.stop(f.options.run_id, 'recovery_requested');
  const events = (await readEvents(f.options.controller_journal)).events, controller_hash = digest('explicit-next-controller');
  await appendEvent(f.options.controller_journal, events, 'control_recovery', { patch: { fields: { control_hash: controller_hash }, nodes: {}, edges: {}, approvals: {} } });
  await assert.rejects(f.registry.launch(f.options), { code: 'OWNER_AUTHORITY' });
  const second = await f.registry.launch({ ...f.options, controller_hash });
  assert.equal(second.generation, 2); assert.notEqual(second.owner_id, first.owner_id);
  assert.equal(second.controller_hash, controller_hash); assert.equal(second.main_actor, f.options.main_actor);
  const history = await f.registry.history(f.options.run_id);
  assert.equal(history.length, 1); assert.equal(history[0].owner_id, first.owner_id);
  assert.equal(history[0].controller_hash, f.options.controller_hash); assert.equal(history[0].termination.confirmed, true);
  await delay(40); await assert.rejects(ownerRpc(oldEndpoint, 'facts'));
  const newEndpoint = await f.registry.private(f.options.run_id);
  assert.equal(newEndpoint.owner_id, second.owner_id);
  await assert.rejects(ownerRpc({ ...newEndpoint, owner_id: oldEndpoint.owner_id }, 'facts'), { code: 'OWNER_RPC_IDENTITY' });
  assert.equal((await f.registry.call(f.options.run_id, 'facts')).pid, second.pid);
});

test('startup failure closes ownership only with the runtime explicit bootstrap quiescence attestation', async t => {
  const f = await fixture(t, 'owner-bootstrap-cleanup'); f.options.boot.startup_mode = 'quiescent_failure';
  await assert.rejects(f.registry.launch(f.options), { code: 'FIXTURE_BOOTSTRAP' });
  const failed = await f.registry.read(f.options.run_id);
  assert.equal(failed.phase, 'failed'); assert.equal(failed.termination.confirmed, true);
  assert.equal(failed.termination.reason, 'startup_cleanup_confirmed');
  await assert.rejects(f.registry.launch(f.options), { code: 'OWNER_EXISTS' });
  await assert.rejects(f.registry.call(f.options.run_id, 'facts'));
  assert.equal(await effects(f), '');
});

test('handshake timeout preserves uncertain ownership until exact runtime cleanup is confirmed', async t => {
  const f = await fixture(t, 'owner-start-timeout'); f.options.boot.startup_mode = 'blocked'; f.registry.handshakeMs = 100;
  await assert.rejects(f.registry.launch(f.options), { code: 'OWNER_START_TIMEOUT' });
  // The handshake can expire before the OS starts the child. Wait for the
  // actual blocked runtime boundary rather than assuming its endpoint already
  // exists after an arbitrary 100ms on a busy machine.
  const readyPath=join(f.owned_directory,'startup-ready.txt'),deadline=Date.now()+5000;
  for(;;){
    try{assert.equal(await readFile(readyPath,'utf8'),f.options.run_id);break;}
    catch(error){if(error.code!=='ENOENT'||Date.now()>=deadline)throw error;await delay(10);}
  }
  const uncertain = await f.registry.read(f.options.run_id);
  assert.notEqual(uncertain.termination?.confirmed, true);
  assert.equal((await f.registry.private(f.options.run_id)).owner_id, uncertain.owner_id);
  await assert.rejects(f.registry.stop(f.options.run_id, 'abort_startup'), { code: 'OWNER_STOP_UNCONFIRMED' });
  const stopped = await until(f.registry, f.options.run_id, state => state?.termination?.confirmed === true);
  assert.equal(stopped.termination.reason, 'startup_cleanup_confirmed');
  assert.equal(await effects(f), '');
});

test('accepted authoring-style journal purge retains external owner evidence and its exact RPC response', async t => {
  const f = await fixture(t, 'owner-purge'); await f.registry.launch(f.options);
  assert.deepEqual(await f.registry.call(f.options.run_id, 'service_call', { operation: 'publish_and_purge', args: {} }), { accepted: true });
  const succeeded = await until(f.registry, f.options.run_id, value => value?.phase === 'succeeded' && value.termination?.confirmed);
  assert.equal(succeeded.termination.reason, 'execution_settled');
  await assert.rejects(readFile(f.options.controller_journal), { code: 'ENOENT' });
  const privateRecord = await f.registry.private(f.options.run_id); assert.equal(privateRecord.owner_id, succeeded.owner_id);
  assert.deepEqual(await f.registry.pendingNotifications(f.options.run_id), []);
});

test('terminal original notifications survive owner exit and acknowledgments retain exact separate evidence', async t => {
  const f = await fixture(t, 'owner-terminal-delivery'); f.options.boot.include_nested_notifications = true; await f.registry.launch(f.options);
  await assert.rejects(f.registry.pendingNotifications(f.options.run_id), { code: 'OWNER_NOTIFICATION_STATE' });
  const outcome = await f.registry.call(f.options.run_id, 'service_call', { operation: 'queue_terminal_notification', args: {} });
  const settled = await until(f.registry, f.options.run_id, state => state?.phase === 'succeeded' && state.termination?.confirmed);
  const pending = await f.registry.pendingNotifications(f.options.run_id);
  assert.equal(pending.length, 3); assert.deepEqual(pending[0].event, outcome.event);
  assert.equal(pending[1].event.run_id, 'nested-exact'); assert.equal(pending[2].event.role_run_id, 'role-exact');
  assert.equal(pending[0].main_actor, f.options.main_actor);
  assert.equal(pending[0].hash, digest(canonicalJSON({ owner_id: settled.owner_id, event: outcome.event })));
  const statusBefore = await readFile(f.registry.paths(f.options.run_id).status, 'utf8');
  await assert.rejects(f.registry.ackNotifications(f.options.run_id, { owner_id: 'another-owner', hash: pending[0].hash }), { code: 'OWNER_NOTIFICATION_OWNER' });
  await assert.rejects(f.registry.ackNotifications(f.options.run_id, { owner_id: settled.owner_id, hash: '0'.repeat(64) }), { code: 'OWNER_NOTIFICATION_HASH' });
  const accepted = await f.registry.ackNotifications(f.options.run_id, pending[0]); assert.equal(accepted.already_acknowledged, false);
  const repeated = await f.registry.ackNotifications(f.options.run_id, pending[0]); assert.equal(repeated.already_acknowledged, true);
  for (const entry of pending.slice(1)) await f.registry.ackNotifications(f.options.run_id, entry);
  assert.deepEqual(await f.registry.pendingNotifications(f.options.run_id), []);
  assert.equal(await readFile(f.registry.paths(f.options.run_id).status, 'utf8'), statusBefore);
  const log = (await readFile(join(f.registry.paths(f.options.run_id).directory, 'notifications.private.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 3); assert.deepEqual(log[0].event, outcome.event); assert.equal(log[0].hash, pending[0].hash);
});

test('driver delivery metadata can publish while its confirmed stop awaits that same driver', async t => {
  const f = await fixture(t, 'owner-notify-stop-cycle'); f.options.boot.driver_notify_cycle = true;
  await f.registry.launch(f.options);
  const settled = await until(f.registry, f.options.run_id, state => state?.phase === 'succeeded' && state.termination?.confirmed);
  assert.equal(settled.status, 'succeeded'); assert.equal(settled.outcome.status, 'succeeded');
  assert.equal(settled.outcome.parent_notification.status, 'delivered');
  assert.deepEqual(await f.registry.pendingNotifications(f.options.run_id), []);
});

test('owner listing accepts an absent store without exposing private or history entries', async t => {
  const f = await fixture(t, 'owner-empty-list'); assert.deepEqual(await f.registry.list(), []);
});
