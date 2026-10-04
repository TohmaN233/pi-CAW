import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { PiCawService } from '../lib/service.mjs';
import { resolveBinding } from '../lib/models.mjs';
import { createParentMainBridge } from '../lib/parent-main-bridge.mjs';
import { createOwnerRpcServer, ownerRpc } from '../lib/detached-owner.mjs';
import { createWorkerObserver } from '../lib/pi-worker.mjs';
import { agent, workflow } from './fixtures.mjs';
import { DEFAULT_PROVIDER_SLOTS, BUILTIN_ROLE_DEFAULTS, DEFAULT_ROUTING } from '../lib/defaults.mjs';
import { SEMANTIC_BLUEPRINT_CONTRACT } from '../core/authoring/blueprint-contract.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';
import { reviewIds } from '../core/skill-import/review-checklist.mjs';
import { sourceRuntimeFixture } from './sdk-runtime-fixtures.mjs';

async function until(read, accepts, ms = 15000) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) { last = await read(); if (accepts(last)) return last; await new Promise(resolveWait => setTimeout(resolveWait, 25)); }
  assert.fail(`Timed out waiting for exact detached evidence: ${JSON.stringify(last)}`);
}

test('parent Main RPC keeps the original actor, exact results, operation callbacks and single dispatch', async t => {
  const operations = [], authorizations = [], main_actor = 'exact-parent', run_id = 'bridge-test';
  let actor = main_actor, calls = 0, closes = 0, aborts = 0;
  const owner = await createOwnerRpcServer({ run_id, handle: async (operation, args) => {
    if (operation === 'main_authorize') { authorizations.push(args); return { authorized: true }; }
    assert.equal(operation, 'main_operation'); operations.push(args); return { recorded: true };
  } });
  const exactResult = { session_id: main_actor, turn_id: 'actual-pi-turn', user_entry_id: 'actual-pi-user',
    result: { text: 'done' }, evidence: { kind: 'pi_session', observed: 'completed' }, changed_paths: [] };
  const host = { mainIdentity: () => ({ session_id: actor, session_file: 'parent.jsonl' }),
    async createMainTask(request) { return { session_id: actor, session_file: 'parent.jsonl',
      async run() { calls++; await request.authorize(); await request.onOperation({ phase: 'completed', tool: 'read_workspace' }); return exactResult; },
      async abort() { aborts++; }, async close() { closes++; } }; },
  };
  const bridge = await createParentMainBridge({ host, run_id, main_actor });
  t.after(async () => { await bridge.close(); await owner.close(); });
  const task_handle = randomUUID(), operation_id = randomUUID();
  const request = { task_handle, operation_id, main_actor, owner_descriptor: owner.descriptor, request: { kind: 'main', run_id } };
  const created = await ownerRpc(bridge.descriptor, 'create_main_task', request);
  assert.equal(created.session_id, main_actor);
  assert.deepEqual(await ownerRpc(bridge.descriptor, 'create_main_task', request), created);
  assert.deepEqual(await ownerRpc(bridge.descriptor, 'run_main_task', { task_handle, prompt: 'Exact prompt', schema: {} }), exactResult);
  assert.deepEqual(operations, [{ operation_id, metadata: { phase: 'completed', tool: 'read_workspace' } }]);
  assert.deepEqual(authorizations, [{ operation_id }]);
  await assert.rejects(ownerRpc(bridge.descriptor, 'run_main_task', { task_handle, prompt: 'Replay', schema: {} }), { code: 'PI_PARENT_MAIN_REPLAY' });
  assert.equal(calls, 1);
  actor = 'another-chat';
  await assert.rejects(ownerRpc(bridge.descriptor, 'main_identity'), { code: 'PI_MAIN_SESSION_CHANGED' });
  await assert.rejects(ownerRpc(bridge.descriptor, 'create_main_task', request), { code: 'PI_MAIN_SESSION_CHANGED' });
  await assert.rejects(ownerRpc(bridge.descriptor, 'run_main_task', { task_handle, prompt: 'New chat', schema: {} }), { code: 'PI_MAIN_SESSION_CHANGED' });
  assert.deepEqual(await ownerRpc(bridge.descriptor, 'abort_main_task', { task_handle }), { abort_requested: true });
  assert.equal(aborts, 1, 'Teardown must address the original acquired task');
  assert.deepEqual(await ownerRpc(bridge.descriptor, 'close_main_task', { task_handle }), { quiescent: true });
  assert.deepEqual(await ownerRpc(bridge.descriptor, 'close_main_task', { task_handle }), { quiescent: true });
  await bridge.close(); assert.equal(closes, 1); assert.equal(calls, 1);
});

test('nested Run and Role notifications never terminate the root owner, and queued events retain their exact identities', async () => {
  const reported = [], delivered = [], settled = []; let offline = false;
  const observer = createWorkerObserver({ run_id: 'root-run', report: async value => reported.push(value),
    send: async event => { if (offline) throw Object.assign(new Error('Original parent detached'), { code: 'ECONNREFUSED' }); delivered.push(event); },
    settle: async value => settled.push(value) });
  await observer.record({ run_id: 'root-run', status: 'awaiting_acceptance' });
  await observer.observe({ run_id: 'child-run', status: 'succeeded', result_hash: 'exact-child-artifact' });
  assert.deepEqual(settled, []); assert.equal(observer.current().status, 'awaiting_acceptance');
  assert.equal(reported.at(-1).status, 'awaiting_acceptance'); assert.equal(reported.at(-1).child_event.run_id, 'child-run');
  assert.deepEqual(delivered, [{ run_id: 'child-run', status: 'succeeded', result_hash: 'exact-child-artifact' }]);
  offline = true;
  const nestedFailure = { run_id: 'child-other', status: 'failed', error: { code: 'EXACT_CHILD_ERROR', message: 'Child needs attention' } };
  await observer.observe(nestedFailure);
  assert.deepEqual(settled, []); assert.equal(reported.at(-1).status, 'awaiting_acceptance');
  assert.deepEqual(reported.at(-1).parent_notification.events, [nestedFailure]);
  await observer.observe({ role_run_id: 'role-exact', status: 'failed' });
  assert.deepEqual(settled, []); assert.equal(observer.current().run_id, 'root-run');
  offline = false; await observer.flush();
  assert.deepEqual(delivered.slice(1), [nestedFailure, { role_run_id: 'role-exact', status: 'failed' }]);
  assert.equal(reported.at(-1).parent_notification.queued_count, 0);
  await observer.observe({ status: 'succeeded', sequence: 42 }, { defaultRoot: true });
  assert.deepEqual(settled, [{ run_id: 'root-run', status: 'succeeded', sequence: 42 }]);
  await observer.observe({ run_id: 'root-run', status: 'succeeded', revision_hash: 'published-pack', authoring_cleanup: { private_authoring_artifacts_purged: true } });
  assert.equal(settled.length, 1); assert.equal(reported.at(-1).revision_hash, 'published-pack');
  assert.deepEqual(reported.at(-1).parent_notification, { status: 'delivered', queued_count: 0, events: [] });
});

test('a synchronous original Main dispatch failure cannot replay the same private handle', async t => {
  const run_id = 'synchronous-main', main_actor = 'original-parent'; let calls = 0, closes = 0;
  const host = { mainIdentity: () => ({ session_id: main_actor }), createMainTask: () => ({ session_id: main_actor,
    run() { calls++; throw Object.assign(new Error('Exact synchronous Main failure'), { code: 'TEST_MAIN_FAILURE' }); },
    async abort() {}, async close() { closes++; } }) };
  const bridge = await createParentMainBridge({ host, run_id, main_actor });
  t.after(() => bridge.close());
  const task_handle = randomUUID();
  await ownerRpc(bridge.descriptor, 'create_main_task', { task_handle, operation_id: randomUUID(), main_actor,
    owner_descriptor: bridge.descriptor, request: { kind: 'main', run_id } });
  await assert.rejects(ownerRpc(bridge.descriptor, 'run_main_task', { task_handle, prompt: 'Exact Main', schema: {} }), { code: 'TEST_MAIN_FAILURE' });
  await assert.rejects(ownerRpc(bridge.descriptor, 'run_main_task', { task_handle, prompt: 'Replay', schema: {} }), { code: 'PI_PARENT_MAIN_REPLAY' });
  assert.equal(calls, 1);
  await ownerRpc(bridge.descriptor, 'close_main_task', { task_handle }); await bridge.close(); assert.equal(closes, 1);
});

test('the exact terminal notification is queued before revocation and its delivery acknowledgment survives stop', async () => {
  for (const disconnected of [false, true]) {
    const reported = [], settled = []; let active = true;
    const event = { run_id: 'root-exact', status: 'succeeded', revision_hash: 'accepted-pack' };
    const observer = createWorkerObserver({ run_id: event.run_id, active: () => active,
      report: async outcome => { reported.push(outcome); active = false; },
      send: async actual => { assert.deepEqual(actual, event); if (disconnected) throw Object.assign(new Error('Parent disconnected'), { code: 'ECONNREFUSED' }); },
      settle: async outcome => settled.push(outcome) });
    await observer.observe(event);
    assert.deepEqual(reported[0].parent_notification.events, [event]);
    assert.equal(reported[0].parent_notification.status, 'queued');
    assert.equal(reported[1].parent_notification.status, disconnected ? 'queued' : 'delivered');
    assert.deepEqual(reported[1].parent_notification.events, disconnected ? [event] : []);
    assert.deepEqual(settled, [event]);
    if (disconnected) assert.equal(reported[1].parent_notification.error.code, 'ECONNREFUSED');
  }
});

for (const sourceOnly of [false, true]) test(`actual detached Pi worker (${sourceOnly ? 'source tree with stale dist' : 'distribution'}) completes a child and original-chat Main, preserves evidence and awaits human acceptance`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-detached-pi-'));
  const activeSdk = sourceOnly ? (await sourceRuntimeFixture(root, { sdk, aiEntry: import.meta.resolve('@earendil-works/pi-ai/compat'), stale: true })).sdk : sdk;
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace'), directory = join(root, 'state');
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false } }));
  const workerProvider = `detached-worker-${randomUUID()}`;
  const fixtureModule = join(root, 'native-provider.mjs');
  const releaseChild = join(root, 'release-child');
  const aiUrl = pathToFileURL(join(dirname(sdk.getPackageDir()), 'pi-ai/dist/compat.js')).href;
  await writeFile(fixtureModule, `import * as ai from ${JSON.stringify(aiUrl)}; import {existsSync} from 'node:fs';
export const fixture = ai.fauxProvider({api:${JSON.stringify(workerProvider + '-api')},provider:${JSON.stringify(workerProvider)},models:[{id:'worker',reasoning:false}],tokensPerSecond:0});
fixture.setResponses([async (_context,options)=>{const deadline=Date.now()+15000;while(!existsSync(${JSON.stringify(releaseChild)})){if(options.signal?.aborted||Date.now()>deadline)throw new Error('Offline child gate cancelled or expired');await new Promise(resolve=>setTimeout(resolve,25));}return ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{result:{text:'Detached child completed'},summary:'Offline child complete'}),{stopReason:'toolUse'});},ai.fauxAssistantMessage('Child done.')]);
export const provider=fixture.provider;
`);
  const worker = await import(pathToFileURL(fixtureModule).href);
  const parentFaux = ai.fauxProvider({ provider: `detached-parent-${randomUUID()}`, models: [{ id: 'parent', reasoning: false }], tokensPerSecond: 0 });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(worker.provider); modelRuntime.registerNativeProvider(parentFaux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const manager = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  const registry = new sdk.ModelRegistry(modelRuntime), errors = [], notifications = [];
  let session, service, runId;
  const context = { cwd, modelRegistry: registry, scopedModels: [], sessionManager: manager, model: parentFaux.getModel(),
    thinkingLevel: 'off', isProjectTrusted: () => false, abort: () => { void session.abort(); } };
  const host = new PiSdkHost({ sdk: activeSdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, agentDir,
    getContext: () => context, detachedNativeProviderModules: [pathToFileURL(fixtureModule).href],
    deliverMain: prompt => { void session.prompt(prompt).catch(error => errors.push({ message: error.message })); } });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'offline-current-chat-fixture', factory: pi => {
      pi.on('before_agent_start', event => { host.main.begin(event.prompt); });
      pi.on('agent_end', async () => { await host.main.end(); });
      pi.on('tool_call', event => host.main.guard(event));
      pi.registerTool({ name: 'caw', label: 'Offline parent fixture', description: 'Exercise original-chat Main only',
        parameters: ai.Type.Object({ action: ai.Type.String(), args: ai.Type.Optional(ai.Type.Unknown()) }),
        async execute(id, params) {
          const result = params.action === 'main_task' ? host.main.packet() : params.action === 'main_tool'
            ? await host.main.tool(params.args, id) : await host.main.submit(params.args, id);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } });
    } }] });
  await loader.reload();
  session = (await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model: parentFaux.getModel(), thinkingLevel: 'off',
    sessionManager: manager, resourceLoader: loader, tools: ['caw'], noTools: 'all' })).session;
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error), abortHandler: () => { void session.abort(); } });
  parentFaux.setResponses([ai.fauxAssistantMessage('Offline parent initialized.')]);
  await session.prompt('Initialize the offline parent session.');
  service = await new PiCawService({ directory, host, notify: event => notifications.push(event) }).initialize();
  t.after(async () => {
    if (runId) await service.detachedOwners.stop(runId, 'test_cleanup');
    await service.close(); await session.abort(); session.dispose();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const binding = resolveBinding({ provider: workerProvider, model_id: 'worker', thinking: 'off' }, host.catalog());
  const configuration = await service.call('settings');
  await service.call('save_settings', { expected_revision: configuration.revision,
    settings: { schema_version: 1, providers: [{ id: 'worker', name: 'Offline worker', enabled: true, binding }], roles: [], routing: {} } }, { human: true });
  await service.refreshContext();
  const graph=workflow([agent('work')]);graph.nodes.find(node=>node.id==='final').executor.mode='orchestration';
  await service.store.create(graph);
  const tool = (action, args) => ai.fauxAssistantMessage(ai.fauxToolCall('caw', { action, ...(args ? { args } : {}) }), { stopReason: 'toolUse' });
  parentFaux.setResponses([tool('main_task'), tool('main_tool', { name: 'run_task_program', args: { program: 'node', args: ['-e', 'process.stdout.write("detached Main operation")'], cwd: 'workspace' } }),
    tool('main_result', { result: { text: 'Original Pi chat Main completed' }, summary: 'Exact detached Main result' }), ai.fauxAssistantMessage('Main done.')]);
  const started = await service.call('run', { workflow_id: 'example', workspace: cwd, access: 'read_only', inputs: { task: 'Offline detached test' } });
  runId = started.run_id;
  const owner = await service.detachedOwners.read(runId);
  assert.notEqual(owner.pid, process.pid); assert.equal(owner.detached ?? true, true);
  const beforeDetach = await until(() => service.runtime.runs.read(runId), value => value.state.nodes.work.status === 'running' && !!value.state.nodes.work.attempts.at(-1)?.dispatch?.receipt);
  const exactChildAttempt = beforeDetach.state.nodes.work.attempts.at(-1).id;
  const registryBeforeDetach = service.detachedOwners;
  await service.close();
  assert.equal(await registryBeforeDetach.isAlive(runId), true, 'Independent child must outlive its parent service');
  await writeFile(releaseChild, 'Release the exact offline child after parent shutdown.');
  await until(() => registryBeforeDetach.read(runId), value => value.status === 'waiting_parent');
  const waitingBeforeMain = await service.runtime.runs.read(runId);
  assert.equal(waitingBeforeMain.state.nodes.work.status, 'succeeded');
  assert.equal(waitingBeforeMain.state.nodes.work.attempts.length, 1);
  assert.equal(waitingBeforeMain.state.nodes.work.attempts[0].id, exactChildAttempt);
  assert.equal(waitingBeforeMain.state.nodes.final.attempts.length, 1);
  assert.equal(waitingBeforeMain.state.nodes.final.attempts[0].dispatch.receipt, null);
  assert.equal(parentFaux.state.callCount, 1, 'Main must not call a substitute parent while detached');
  await assert.rejects(registryBeforeDetach.reattach(runId, { main_actor: 'substitute-parent',
    controller_hash: waitingBeforeMain.state.control_hash, parent_bridge: { url: 'http://127.0.0.1:1/owner-rpc', token: 'a'.repeat(64), owner_id: randomUUID(), run_id: runId, main_actor: 'substitute-parent' } }), { code: 'OWNER_REATTACH_IDENTITY' });
  service = await new PiCawService({ directory, host, notify: event => notifications.push(event) }).initialize();
  await service.call('run_snapshot', { run_id: runId });
  const record = await until(() => service.runtime.runs.read(runId), value => !!value.state.nodes.final.attempts.at(-1)?.result_proposal);
  assert.equal(record.state.main_actor, manager.getSessionId());
  assert.equal(record.state.nodes.work.status, 'succeeded');
  assert.equal(record.state.nodes.work.attempts.length, 1); assert.equal(record.state.nodes.work.attempts[0].id, exactChildAttempt);
  assert.equal(record.state.nodes.final.attempts.length, 1);
  const child = record.state.nodes.work.attempts.at(-1), final = record.state.nodes.final.attempts.at(-1);
  assert.notEqual(child.dispatch.receipt.thread_id, manager.getSessionId());
  assert.equal(final.dispatch.receipt.session_id, manager.getSessionId());
  assert.equal(final.dispatch.receipt.executor, 'pi-current-chat-main');
  assert.ok(final.executor_events.some(event => event.kind === 'tool_operation' && event.metadata.phase === 'completed' && event.metadata.tool === 'run_task_program'));
  const proposed = await service.runtime.runs.readExecutorResult(runId, final.id, final.result_proposal.sha256);
  assert.equal(proposed.structured_output.text, 'Original Pi chat Main completed');
  assert.ok(manager.getEntries().some(entry => entry.id === proposed.evidence[0].turn_id && entry.message?.role === 'assistant'));
  assert.deepEqual(proposed.changed_paths, []); assert.deepEqual(errors, []);
  const waiting = await until(() => service.detachedOwners.read(runId), value => value.outcome?.status === 'awaiting_acceptance');
  assert.equal(waiting.phase, 'running'); assert.equal(await service.detachedOwners.isAlive(runId), true);
  const accepted = await service.call('accept_final', { run_id: runId, accepted: true, proposal_sha256: final.result_proposal.sha256 }, { human: true });
  assert.equal(accepted.status, 'running');
  const settled = await until(() => service.detachedOwners.read(runId), value => value.termination?.confirmed === true);
  assert.equal(settled.phase, 'succeeded');
  assert.ok(notifications.some(event => event.status === 'awaiting_acceptance'));
  const childEntries = (await readFile(child.dispatch.receipt.session_file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(childEntries.some(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'caw_submit_result' && !entry.message.isError));
});

test('actual detached authoring owner publishes the exact reviewed Pack and terminates after its private Run is purged', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-detached-authoring-'));
  const agentDir = join(root, 'agent'), cwd = join(root, 'workspace'), directory = join(root, 'state');
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false } }));
  const workerProvider = `authoring-worker-${randomUUID()}`, semanticFile = join(root, 'semantic-results.json');
  const fixtureModule = join(root, 'native-authoring-provider.mjs');
  const cleanupGate = join(root, 'release-cleanup'), cleanupWaiting = join(root, 'cleanup-waiting');
  const aiUrl = pathToFileURL(join(dirname(sdk.getPackageDir()), 'pi-ai/dist/compat.js')).href;
  const authoringUrl = new URL('../lib/authoring.mjs', import.meta.url).href;
  await writeFile(fixtureModule, `import * as ai from ${JSON.stringify(aiUrl)}; import {readFileSync,writeFileSync,existsSync} from 'node:fs'; import {PiAuthoring} from ${JSON.stringify(authoringUrl)};
const cleanup=PiAuthoring.prototype.beginCleanup;
PiAuthoring.prototype.beginCleanup=async function(...args){writeFileSync(${JSON.stringify(cleanupWaiting)},'Accepted exact Run; private cleanup is deliberately paused.');const deadline=Date.now()+15000;while(!existsSync(${JSON.stringify(cleanupGate)})){if(Date.now()>deadline)throw new Error('Offline cleanup gate expired');await new Promise(resolve=>setTimeout(resolve,25));}return cleanup.apply(this,args);};
export const restore=()=>{PiAuthoring.prototype.beginCleanup=cleanup;};
export const fixture=ai.fauxProvider({api:${JSON.stringify(workerProvider + '-api')},provider:${JSON.stringify(workerProvider)},models:[{id:'worker',reasoning:false}],tokensPerSecond:0});
const result=key=>()=>ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{result:JSON.parse(readFileSync(${JSON.stringify(semanticFile)},'utf8'))[key],summary:'Offline semantic '+key}),{stopReason:'toolUse'});
fixture.setResponses([
  ()=>{const invalid=JSON.parse(readFileSync(${JSON.stringify(semanticFile)},'utf8')).planner;invalid.proposal.activities[0].inputs[0].from='missing.answer';return ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{result:invalid,summary:'Invalid semantic handoff'}),{stopReason:'toolUse'});},
  context=>{if(!JSON.stringify(context).includes('Host findings:'))throw new Error('Shared semantic diagnostic did not reach this same native node turn');return result('planner')();},
  ai.fauxAssistantMessage('Planner done.'),result('reviewer'),ai.fauxAssistantMessage('Reviewer done.')]);
export const provider=fixture.provider;
`);
  const worker = await import(pathToFileURL(fixtureModule).href);
  const parentFaux = ai.fauxProvider({ provider: `authoring-parent-${randomUUID()}`, models: [{ id: 'parent', reasoning: false }], tokensPerSecond: 0 });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(worker.provider); modelRuntime.registerNativeProvider(parentFaux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const manager = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  const registry = new sdk.ModelRegistry(modelRuntime), notifications = [], failedNotifications = [];
  const context = { cwd, modelRegistry: registry, scopedModels: [], sessionManager: manager, model: parentFaux.getModel(),
    thinkingLevel: 'off', isProjectTrusted: () => false };
  const host = new PiSdkHost({ sdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, agentDir,
    getContext: () => context, detachedNativeProviderModules: [pathToFileURL(fixtureModule).href],
    deliverMain: () => { throw new Error('Authoring must use an independent reviewer, never parent Main'); } });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const session = (await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model: parentFaux.getModel(), thinkingLevel: 'off',
    sessionManager: manager, resourceLoader: loader, tools: [], noTools: 'all' })).session;
  await session.bindExtensions({ mode: 'rpc', onError: error => { throw error; }, abortHandler: () => { void session.abort(); } });
  parentFaux.setResponses([ai.fauxAssistantMessage('Offline authoring parent initialized.')]);
  await session.prompt('Initialize the original offline Pi parent.');
  let service = await new PiCawService({ directory, host, notify: event => {
    if (event.status === 'succeeded') { failedNotifications.push(event); throw Object.assign(new Error('Offline original parent notification delivery failed'), { code: 'TEST_PARENT_NOTIFY_FAILURE' }); }
    notifications.push(event);
  } }).initialize();
  let runId;
  t.after(async () => {
    await writeFile(cleanupGate, 'Release fixture cleanup before exact owner teardown.');
    if (runId) await service.detachedOwners.stop(runId, 'test_cleanup');
    await service.close(); await session.abort(); session.dispose();
    worker.restore();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const binding = resolveBinding({ provider: workerProvider, model_id: 'worker', thinking: 'off' }, host.catalog());
  const configuration = await service.call('settings');
  await service.call('save_settings', { expected_revision: configuration.revision, settings: {
    schema_version: 1, providers: DEFAULT_PROVIDER_SLOTS.map(provider => ({ ...provider, binding: { ...binding } })),
    roles: structuredClone(BUILTIN_ROLE_DEFAULTS), routing: structuredClone(DEFAULT_ROUTING),
  } }, { human: true });
  await service.refreshContext();
  const pack = await service.call('build_workflow', { workflow_id: 'authoring-source', name: 'Answer workflow',
    brief: '# Workflow\n\n## Process\n\nRead the supplied task and return a concise supported answer.', provider_id: 'pi-worker' }, { human: true });
  const resources = await service.store.resources(pack.workflow.id, pack.revision_hash);
  const sections = sourceSectionInventory(resources).map(section => section.section_id);
  const plan = { contract: SEMANTIC_BLUEPRINT_CONTRACT, purpose: 'Answer the supplied task from supported evidence.',
    source_dispositions: sections.map(section_id => ({ section_id, disposition: 'workflow', activity_keys: ['answer'], note: 'The source process is implemented by the answer activity.' })),
    requirement_assignments: [], runtime_dependencies: [], records: [], lists: [], enums: [],
    activities: [{ key: 'answer', instructions: 'Read the supplied task and return a concise supported answer.', profile: 'worker_read',
      source_sections: sections, inputs: [{ name: 'task', from: 'input:task' }], outputs: [{ name: 'answer', kind: 'text', values: [], type_ref: '' }], tool: '' }],
    approvals: [], sequences: [], parallels: [], choices: [] };
  await writeFile(semanticFile, JSON.stringify({ planner: { proposal: plan }, reviewer: {
    checks: reviewIds().map(() => ({ status: 'pass', evidence: 'The compiled activity preserves the pinned source instructions and declared answer handoff.' })) } }));
  const started = await service.call('start_authoring', { workflow_id: pack.workflow.id, revision_hash: pack.revision_hash,
    run_id: `authoring-${randomUUID()}` }, { human: true });
  runId = started.run_id;
  const reviewed = await until(() => service.runtime.runs.read(runId), value => !!value.state.nodes.final.attempts.at(-1)?.result_proposal);
  for (const stage of ['expand', 'graph_assembly', 'execution_binding', 'deterministic_validation']) assert.equal(reviewed.state.nodes[stage].status, 'succeeded');
  const final = reviewed.state.nodes.final.attempts.at(-1);
  assert.equal(final.dispatch.receipt.executor, 'pi-sdk-authoring-review');
  assert.notEqual(final.dispatch.receipt.session_id, manager.getSessionId());
  assert.equal(parentFaux.state.callCount, 1);
  const progress = await service.call('advance_authoring', { run_id: runId });
  assert.equal(progress.phase, 'review_required'); assert.equal(progress.proposal_sha256, final.result_proposal.sha256);
  await until(() => service.detachedOwners.read(runId), value => value.status === 'awaiting_acceptance');
  const publication = service.call('accept_final', { run_id: runId, workflow_id: pack.workflow.id,
    expected_revision: pack.revision_hash, accepted: true, proposal_sha256: progress.proposal_sha256 }, { human: true });
  void publication.catch(() => {});
  await until(async () => { try { await access(cleanupWaiting); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, value => value);
  await new Promise(resolveWait => setTimeout(resolveWait, 650));
  assert.equal((await service.runtime.runs.read(runId)).state.status, 'succeeded');
  assert.equal((await service.detachedOwners.read(runId)).outcome.status, 'awaiting_acceptance', 'Publication RPC must retain lifecycle ownership until cleanup returns');
  await writeFile(cleanupGate, 'Release the exact accepted offline publication cleanup.');
  const deployed = await publication;
  assert.equal(deployed.provenance.kind, 'workflow_conversion');
  assert.equal(deployed.workflow.import_status.source_independent, true);
  assert.equal(deployed.authoring_cleanup.private_authoring_artifacts_purged, true);
  assert.deepEqual(deployed.authoring_cleanup.cleanup_transaction.steps, { library: true, workspace: true, job: true, run: true });
  await assert.rejects(service.runtime.runs.read(runId), { code: 'ENOENT' });
  await assert.rejects(access(join(directory, 'authoring-workspaces', runId)), { code: 'ENOENT' });
  assert.equal((await service.store.revisions(pack.workflow.id)).length, 1);
  const settled = await until(() => service.detachedOwners.read(runId), value => value.termination?.confirmed === true);
  assert.equal(settled.phase, 'succeeded'); assert.equal(settled.run_id, runId);
  assert.equal(settled.outcome.run_id, runId); assert.equal(settled.outcome.status, 'succeeded');
  assert.equal(settled.outcome.revision_hash, deployed.revision_hash);
  assert.equal(settled.outcome.authoring_cleanup.private_authoring_artifacts_purged, true);
  assert.equal(failedNotifications.length, 1);
  assert.deepEqual(settled.outcome.parent_notification.events, failedNotifications);
  assert.equal(settled.outcome.parent_notification.error.code, 'TEST_PARENT_NOTIFY_FAILURE');
  const pending = await service.detachedOwners.pendingNotifications(runId);
  assert.equal(pending.length, 1); assert.deepEqual(pending[0].event, failedNotifications[0]);
  await service.close();
  const wrongNotifications = [], wrongManager = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  context.sessionManager = wrongManager;
  service = await new PiCawService({ directory, host, notify: event => wrongNotifications.push(event) }).initialize();
  assert.deepEqual(wrongNotifications, []);
  assert.equal((await service.detachedOwners.pendingNotifications(runId)).length, 1, 'A different actual Pi actor cannot acknowledge this notification');
  await service.close(); context.sessionManager = manager;
  service = await new PiCawService({ directory, host, notify: event => notifications.push(event) }).initialize();
  const delivered = notifications.filter(event => event.status === 'succeeded');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].delivery_id, pending[0].hash);
  const { delivery_id, ...actualEvent } = delivered[0]; assert.deepEqual(actualEvent, failedNotifications[0]);
  assert.deepEqual(await service.detachedOwners.pendingNotifications(runId), []);
  await service.call('settings'); await service.call('models'); await service.call('runs');
  assert.equal(notifications.filter(event => event.status === 'succeeded').length, 1);
  const originalOwner = await service.detachedOwners.read(runId);
  assert.equal(originalOwner.owner_id, settled.owner_id); assert.equal(originalOwner.pid, settled.pid);
  assert.equal(parentFaux.state.callCount, 1); assert.equal(worker.fixture.state.callCount, 0);
  assert.equal(service.active.size, 0); assert.equal(host.tasks.size, 0);
});
