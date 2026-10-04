import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { PiCawService } from '../lib/service.mjs';
import { createDraft } from '../core/workflow-schema.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { createParentMainBridge } from '../lib/parent-main-bridge.mjs';
import { createOwnerRpcServer, ownerRpc } from '../lib/detached-owner.mjs';
import { createRemoteHostTools, externalHostToolDescriptors, mergeHostTools, executeExternalHostTool } from '../lib/external-host-tools.mjs';
import { hostToolContractsCompatible, hostToolBindingIssues, validateHostToolReceipt } from '../core/execution/host-tool-runner.mjs';

const effects = () => ({ observed: true, changed_paths: [], outside_paths: [], artifacts: [] });
const identity = { name: 'fixture-domain', version: '1', sha256: digest('fixture-domain') };
const contract = { id: 'domain_read', identity, argv: ['domain_read'], env_allow: [],
  input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  output_schema: { type: 'object', properties: { done: { type: 'boolean' }, value: { type: 'string' } }, required: ['done', 'value'], additionalProperties: false },
  permissions: { network: false, read_paths: ['.'], write_paths: [] }, output_cap_bytes: 131072, deadline_ms: 5000,
  idempotency: { mode: 'reconcile_required' } };
function tool(execute) { return { contract, identity, attestation: { qualified: true, cancellable: true, effect_observation: true,
  tool_identity: identity, broker_id: 'fixture-domain-broker', evidence_sha256: digest('qualification') },
  execute: execute ?? (async request => ({ exit_code: 0, output: { done: true, value: request.input.value }, effects: effects(), diagnostic: 'Domain observed' })),
  cancel: async () => ({ termination_confirmed: true, evidence: [{ kind: 'exact-stop', sha256: digest('exact-stop') }], effects: effects() }) }; }
const executionContext = attempt_id => ({ run_id: 'domain-run', node_id: 'final', attempt_id, workspace: process.cwd(),
  permissions: { access: 'read_only', allowed_paths: ['.'] }, resources: [] });
async function until(read, accepts, ms = 15000) { const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await read(); if (accepts(value)) return value; await new Promise(done => setTimeout(done, 20)); }
  assert.fail('Exact domain execution did not settle'); }

test('trusted registries reject collisions and unqualified entries; descriptors retain contract without closures/state', () => {
  const domain = tool(); domain.private_state = { secret: 'never serialized' };
  const descriptor = externalHostToolDescriptors({ domain_read: domain })[0];
  assert.equal(descriptor.contract.output_cap_bytes, 131072);
  assert.equal(JSON.stringify(descriptor).includes('never serialized'), false);
  assert.equal(Object.hasOwn(descriptor, 'execute'), false);
  assert.throws(() => mergeHostTools({ domain_read: domain }, { domain_read: domain }), { code: 'PI_HOST_TOOL_COLLISION' });
  assert.throws(() => mergeHostTools({ builtin: domain }, { other: { ...domain, contract: undefined } }), { code: 'PI_HOST_TOOL_COLLISION' });
  assert.throws(() => externalHostToolDescriptors({ domain_read: { ...domain, cancel: undefined } }), { code: 'PI_EXTERNAL_HOST_TOOL' });
  assert.throws(() => externalHostToolDescriptors({ domain_read: { ...domain, identity: { ...identity, secret: 'forbidden' } } }), { code: 'PI_EXTERNAL_HOST_TOOL' });
});

test('Host compatibility ignores build identity and schema annotations, preserving actual input and effect contracts', async () => {
  const upgraded = { ...contract, identity: { ...identity, version: '2', sha256: digest('compatible build') },
    input_schema: { ...contract.input_schema, description: 'Updated tool documentation' } };
  assert.equal(hostToolContractsCompatible(contract, upgraded), true);
  for (const changed of [
    { ...upgraded, identity: { ...upgraded.identity, name: 'another-tool' } },
    { ...upgraded, input_schema: { ...upgraded.input_schema, properties: { value: { type: 'number' } } } },
    { ...upgraded, permissions: { ...upgraded.permissions, write_paths: ['.'] } },
    { ...upgraded, argv: ['another-operation'] },
    { ...upgraded, output_schema: { ...upgraded.output_schema, properties: { ...upgraded.output_schema.properties, description: { type: 'string' } } } },
  ]) assert.equal(hostToolContractsCompatible(contract, changed), false);
  const current = { ...tool(), identity: upgraded.identity, contract: upgraded,
    attestation: { ...tool().attestation, tool_identity: upgraded.identity } };
  assert.equal(hostToolBindingIssues({ host_tools: [contract] }, { domain_read: current }).length, 0);
  const result = await executeExternalHostTool({ domain_read: current }, contract, { value: 'artifact' }, executionContext('compatible-call'), { authorize: async () => {} });
  assert.equal(result.output.value, 'artifact');
  assert.deepEqual(result.receipt.broker.implementation_identity, upgraded.identity);
  assert.equal(result.receipt.contract_sha256, digest(canonicalJSON(contract)));
  assert.equal(hostToolBindingIssues({ host_tools: [contract] }, { domain_read: { ...current, contract: undefined } }).length, 1,
    'without an explicit registered interface, a name alone is not compatibility evidence');
});

test('private proxy binds actor/attempt/contract, reauthorizes before effects, forwards pinned resource bytes and observed database effects', async t => {
  const operations = new Map(), authorizations = []; let calls = 0, liveTool;
  liveTool = tool(async request => { calls++; await request.authorize();
    assert.equal(request.context.run_id, 'domain-run'); assert.equal(request.context.attempt_id, 'exact-attempt');
    assert.equal(request.context.resources[0].bytes.toString(), 'immutable content');
    return { exit_code: 0, output: { done: true, value: request.input.value }, effects: { ...effects(), outside_paths: ['authoritative-course.sqlite'] }, diagnostic: 'Database effect observed' }; });
  liveTool.attestation.storage_capabilities = { write_files: [resolve('authoritative-course.sqlite')], write_directories: [] };
  const owner = await createOwnerRpcServer({ run_id: 'domain-run', handle: async (operation, args) => {
    assert.equal(operation, 'host_tool_authorize'); authorizations.push(args); await operations.get(args.operation_id).authorize(args); return { authorized: true }; } });
  let actor = 'original-chat';
  const host = { mainIdentity: () => ({ session_id: actor }), createMainTask() { assert.fail('Domain tool must not create Main'); } };
  const bridge = await createParentMainBridge({ host, run_id: 'domain-run', main_actor: actor, getHostTools: () => ({ domain_read: liveTool }) });
  const remote = createRemoteHostTools({ descriptors: externalHostToolDescriptors({ domain_read: liveTool }), run_id: 'domain-run', main_actor: actor,
    owner_descriptor: owner.descriptor, operations, assertAuthority: async () => {}, waitForBridge: async () => bridge.descriptor });
  t.after(async () => { await Promise.allSettled([remote.close(), bridge.close(), owner.close()]); });
  const context = executionContext('exact-attempt'); context.resources = [{ path: 'snapshot.txt', sha256: digest('immutable content'), bytes: Buffer.from('immutable content') }];
  const result = await executeExternalHostTool(remote.registry, contract, { value: 'selected-target' }, context, { authorize: async () => {} });
  assert.deepEqual(result.receipt.effects.outside_paths, ['authoritative-course.sqlite']);
  assert.deepEqual(result.receipt.broker.storage_capabilities, liveTool.attestation.storage_capabilities);
  assert.equal(result.output.value, 'selected-target'); assert.equal(calls, 1); assert.equal(authorizations.length, 3);
  await assert.rejects(executeExternalHostTool(remote.registry, contract, { value: 'selected-target' }, context, { authorize: async () => {} }), { code: 'PI_EXTERNAL_HOST_REPLAY' });
  liveTool = { ...liveTool, attestation: { ...liveTool.attestation, evidence_sha256: digest('changed') } };
  await assert.rejects(executeExternalHostTool(remote.registry, contract, { value: 'selected-target' }, executionContext('new-attempt'), { authorize: async () => {} }), { code: 'PI_EXTERNAL_HOST_DISCONNECTED' });
  assert.equal(calls, 1);
  liveTool = { ...liveTool, attestation: { ...liveTool.attestation, evidence_sha256: digest('qualification') } };
  // Teardown remains addressed to the old attempt after the parent chat changes.
  actor = 'another-chat';
  await bridge.close();
});

test('cancellation waits for the exact parent promise and preserves shutdown/effect evidence', async t => {
  let entered; const started = new Promise(done => { entered = done; }); let finish, stopCalls = 0;
  const domain = tool(request => new Promise(done => { finish = () => done({ exit_code: 1, output: null,
    effects: { ...effects(), outside_paths: ['course.sqlite'] }, diagnostic: 'Compiler stopped' }); entered(); }));
  domain.cancel = async () => { stopCalls++; finish(); return { termination_confirmed: true,
    evidence: [{ kind: 'compiler-terminated', sha256: digest('pid-and-exit') }], effects: { ...effects(), outside_paths: ['course.sqlite'] } }; };
  const operations = new Map(), owner = await createOwnerRpcServer({ run_id: 'domain-run', handle: async (_operation, args) => {
    await operations.get(args.operation_id).authorize(args); return { authorized: true }; } });
  const host = { mainIdentity: () => ({ session_id: 'original-chat' }), createMainTask() { assert.fail('Unexpected Main'); } };
  const bridge = await createParentMainBridge({ host, run_id: 'domain-run', main_actor: 'original-chat', getHostTools: () => ({ domain_read: domain }) });
  const remote = createRemoteHostTools({ descriptors: externalHostToolDescriptors({ domain_read: domain }), run_id: 'domain-run', main_actor: 'original-chat',
    owner_descriptor: owner.descriptor, operations, assertAuthority: async () => {}, waitForBridge: async () => bridge.descriptor });
  t.after(async () => { await remote.close(); await bridge.close(); await owner.close(); });
  const controller = new AbortController();
  const completion = executeExternalHostTool(remote.registry, contract, { value: 'compile' }, executionContext('compiler-attempt'), { signal: controller.signal, authorize: async () => {} });
  await started; controller.abort(new Error('Workflow revoked'));
  const result = await completion;
  assert.equal(result.receipt.status, 'cancelled'); assert.equal(stopCalls, 1);
  assert.equal(result.receipt.reconciliation.termination_confirmed, true);
  assert.deepEqual(result.receipt.effects.outside_paths, ['course.sqlite']);
  assert.deepEqual(result.receipt.reconciliation.evidence, [{ kind: 'compiler-terminated', sha256: digest('pid-and-exit') }]);
});

test('failed parent termination remains visible and neither proxy nor bridge claims quiescence or replays', async t => {
  const operations = new Map(); let entered; const started = new Promise(done => { entered = done; }); let calls = 0;
  const domain = tool(request => { calls++; entered(); return new Promise(done => request.signal.addEventListener('abort', () =>
    done({ exit_code: 1, output: null, diagnostic: 'Termination unknown', effects: effects() }), { once: true })); });
  domain.cancel = async () => ({ termination_confirmed: false, evidence: [], effects: effects() });
  const owner = await createOwnerRpcServer({ run_id: 'domain-run', handle: async (_operation, args) => {
    await operations.get(args.operation_id).authorize(args); return { authorized: true }; } });
  const host = { mainIdentity: () => ({ session_id: 'parent' }), createMainTask() {} };
  const bridge = await createParentMainBridge({ host, run_id: 'domain-run', main_actor: 'parent', getHostTools: () => ({ domain_read: domain }) });
  const remote = createRemoteHostTools({ descriptors: externalHostToolDescriptors({ domain_read: domain }), run_id: 'domain-run', main_actor: 'parent',
    owner_descriptor: owner.descriptor, operations, assertAuthority: async () => {}, waitForBridge: async () => bridge.descriptor });
  t.after(() => owner.close());
  const controller = new AbortController(), context = executionContext('unconfirmed-compiler');
  const completion = executeExternalHostTool(remote.registry, contract, { value: 'compile' }, context, { signal: controller.signal, authorize: async () => {} });
  await started; controller.abort();
  await assert.rejects(completion, { code: 'PI_EXTERNAL_HOST_DISCONNECTED' });
  await assert.rejects(executeExternalHostTool(remote.registry, contract, { value: 'compile' }, context, { authorize: async () => {} }), { code: 'PI_EXTERNAL_HOST_REPLAY' });
  await assert.rejects(remote.close(), error => error.quiescent === false);
  await assert.rejects(bridge.close(), /shutdown is unconfirmed/);
  assert.equal(calls, 1);
});

for (const mode of ['in-process', 'detached', 'reattached', 'queued-restart', 'compatible-upgrade']) test(`registered domain-only workflow executes with no Main (${mode})`, { timeout: 30000 }, async t => {
  const detached = mode !== 'in-process';
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-domain-')), cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir); await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }));
  const manager = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  manager.appendMessage(ai.fauxAssistantMessage('Offline parent identity fixture.'));
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.refresh({ allowNetwork: false });
  const ctx = { cwd, sessionManager: manager, modelRegistry: new sdk.ModelRegistry(modelRuntime), isProjectTrusted: () => true };
  const events = [], notifications = [], classifiedRuns = new Set(); let calls = 0, failDelivery = mode === 'queued-restart';
  const domain = tool(async request => { calls++; await request.authorize(); return { exit_code: 0,
    output: { done: true, value: request.input.value }, effects: effects(), diagnostic: 'Exact domain task finished' }; });
  const host = new PiSdkHost({ sdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, agentDir,
    getContext: () => ctx, getHostTools: () => ({ domain_read: domain }), emit: (name, data) => {
      events.push({ name, data }); if (data.host_tool_ids?.includes('domain_read')) classifiedRuns.add(data.run_id);
    } });
  host.createMainTask = () => { assert.fail('Domain-only workflow cannot dispatch Main'); };
  const notify = event => {
    assert.equal(classifiedRuns.has(event.run_id), true, 'Lifecycle classification precedes completion/triggerTurn decisions');
    if (failDelivery && event.status === 'succeeded') throw Object.assign(new Error('Parent completion delivery unavailable'), { code: 'FIXTURE_DELIVERY_UNAVAILABLE' });
    notifications.push({ event, triggerTurn: !classifiedRuns.has(event.run_id) });
  };
  let service = await new PiCawService({ directory: join(root, 'state'), host, notify }).initialize();
  let runId;
  t.after(async () => { if (runId && detached && await service.detachedOwners.isAlive(runId)) await service.detachedOwners.stop(runId, 'fixture-cleanup');
    await service.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }); });
  assert.deepEqual(service.store.validationContext.host_tool_contracts, [contract]);
  const graph = { ...createDraft('domain-only', 'Domain fixture'), status: 'ready', inputs_schema: contract.input_schema,
    outputs_schema: contract.output_schema, output_bindings: { done: '/nodes/final/output/done', value: '/nodes/final/output/value' },
    host_tools: [contract], finalization: { required: true, node_id: 'final' },
    nodes: [{ id: 'start', type: 'start' }, { id: 'final', type: 'tool', executor: { kind: 'tool', tool: 'domain_read' },
      access: 'read_only', retry: { max_attempts: 1 }, approval: { required: mode === 'reattached' }, input_bindings: { value: '/inputs/value' },
      outputs_schema: contract.output_schema, completion_contract: { on_missing: 'block', outcome: 'decision', fail_on_false: ['done'] } }, { id: 'end', type: 'end' }],
    edges: [{ id: 'begin', source: 'start', target: 'final' }, { id: 'finish', source: 'final', target: 'end' }] };
  try { await service.call('create_workflow', { workflow: graph }); }
  catch (error) { assert.fail(JSON.stringify(error.validation ?? { code: error.code, message: error.message })); }
  const published = await service.store.snapshot(graph.id);
  if (mode === 'compatible-upgrade') {
    const upgradedIdentity = { ...identity, version: '1.0.1', sha256: digest('updated implementation, identical interface') };
    domain.identity = upgradedIdentity;
    domain.contract = { ...contract, identity: upgradedIdentity };
    domain.attestation = { ...domain.attestation, tool_identity: upgradedIdentity, evidence_sha256: digest('updated qualification') };
  }
  const started = await service.call('run', { workflow_id: graph.id, workspace: cwd, access: 'read_only', inputs: { value: 'one selected artifact' }, detached_host: detached });
  runId = started.run_id;
  if (mode === 'reattached') {
    const waiting = await until(() => service.runtime.runs.read(runId), record => Object.values(record.state.approvals).some(approval => approval.status === 'pending'));
    const approval_id = Object.values(waiting.state.approvals).find(approval => approval.status === 'pending').id;
    const owner_id = (await service.detachedOwners.read(runId)).owner_id;
    await service.close();
    service = await new PiCawService({ directory: join(root, 'state'), host, notify }).initialize();
    await service.call('run_snapshot', { run_id: runId });
    assert.equal((await service.detachedOwners.read(runId)).owner_id, owner_id, 'Reattachment retains the same live detached owner');
    assert.equal(calls, 0, 'Parent teardown cannot release a domain effect before exact approval');
    await service.call('approve', { run_id: runId, approval_id, decision: true }, { human: true });
  }
  const record = await until(() => service.runtime.runs.read(runId), record => record.state.status === 'succeeded');
  assert.equal(calls, 1); assert.equal(record.state.nodes.final.attempts.length, 1);
  assert.equal(record.state.nodes.final.attempts[0].host_tool.receipt.status, 'succeeded');
  if (mode === 'compatible-upgrade') {
    assert.deepEqual(record.pins.root.workflow.host_tools[0].identity, identity, 'published Workflow and Run pins stay unchanged');
    assert.equal((await service.store.snapshot(graph.id)).revision_hash, published.revision_hash, 'a program fix does not require republication');
    assert.deepEqual(validateHostToolReceipt(record.state.nodes.final.attempts[0].host_tool.receipt).broker.implementation_identity, domain.identity, 'the receipt names the actual implementation');
  }
  if (detached) { const owner = await until(() => service.detachedOwners.read(runId), owner => owner.termination?.confirmed === true); assert.notEqual(owner.pid, process.pid); }
  else if (service.active.has(runId)) await service.active.get(runId).completion;
  assert.equal(events[0].name, 'pi-caw:run-lifecycle'); assert.equal(events[0].data.status, 'started');
  assert.deepEqual(events[0].data.host_tool_ids, ['domain_read']);
  assert.ok(events.some(event => event.data.status === 'succeeded'), JSON.stringify({ events, owner: detached ? await service.detachedOwners.read(runId) : null }));
  assert.ok(events.some(event => event.data.status === 'succeeded' && event.data.ownership_released === true && event.data.quiescent === true));
  if (mode === 'queued-restart') {
    const queued = await service.detachedOwners.pendingNotifications(runId);
    assert.equal(queued.length, 1); assert.deepEqual(queued[0].event.host_tool_ids, ['domain_read']);
    await service.close(); classifiedRuns.clear(); failDelivery = false;
    service = await new PiCawService({ directory: join(root, 'state'), host, notify }).initialize();
    const replayed = notifications.filter(item => item.event.status === 'succeeded');
    assert.equal(replayed.length, 1); assert.equal(replayed[0].triggerTurn, false, 'Restarted parent does not pay for a notification turn');
    assert.equal(replayed[0].event.delivery_id, queued[0].hash);
    assert.equal(replayed[0].event.main_actor, manager.getSessionId()); assert.equal(replayed[0].event.ownership_released, true);
    assert.equal((await service.detachedOwners.pendingNotifications(runId)).length, 0); assert.equal(calls, 1);
  }
});
