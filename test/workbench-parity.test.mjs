import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, workflow, binding, settle } from './fixtures.mjs';
import { createDraft } from '../core/workflow-schema.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { BUILTIN_ROLE_DEFAULTS, DEFAULT_ROUTING } from '../lib/defaults.mjs';
import { AUTHORING_WORKFLOWS } from '../core/authoring/authoring-workflows.mjs';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { validatePortableWorkflowPackage } from '../lib/workbench-api.mjs';
import { exportWorkflowPackage } from '../core/workflow-package.mjs';

async function configureRole(f) {
  const current = await f.service.call('settings'), role = { ...structuredClone(BUILTIN_ROLE_DEFAULTS[0]), provider_id: 'worker' };
  await f.service.call('save_settings', { settings: { ...current.settings, roles: [role] }, expected_revision: current.revision }, { human: true });
  return role;
}

test('built-in customization is idempotent, retains one Role identity and activates only after publication', async t => {
  const f = await fixture(t), role = await configureRole(f);
  const before = (await f.service.call('role_templates'))[0];
  const draft = await f.service.call('customize_role', { workflow_id: role.id }, { human: true });
  assert.equal(draft.workflow.id, `role-${role.source_metadata.task_type_id}`);
  assert.equal(draft.provenance.builtin_role_id, role.id);
  assert.equal(draft.provenance.builtin_role_revision, before.revision_hash);
  assert.equal(draft.workflow.description, role.description);
  assert.deepEqual(draft.workflow.tags, [...new Set([...role.tags, 'role'])]);
  assert.equal(draft.workflow.nodes.find(node => node.id === 'role').prompt_template, role.role_instructions);
  assert.equal((await f.service.call('customize_role', { workflow_id: role.id }, { human: true })).revision_hash, draft.revision_hash);
  const unpublished = await f.service.call('role_templates');
  assert.equal(unpublished.length, 1); assert.equal(unpublished[0].revision_hash, before.revision_hash);
  assert.equal(unpublished[0].customization.status, 'draft');
  const changed = await f.service.call('save', { workflow_id: draft.workflow.id, expected_revision: draft.revision_hash,
    workflow: { ...draft.workflow, name: 'Customized worker', nodes: draft.workflow.nodes.map(node => node.id === 'role' ? { ...node, prompt_template: 'Custom instructions' } : node) } });
  const published = await f.service.call('publish', { workflow_id: draft.workflow.id, expected_revision: changed.revision_hash });
  const active = await f.service.call('role_templates');
  assert.equal(active.length, 1); assert.equal(active[0].id, role.id); assert.equal(active[0].name, 'Customized worker');
  assert.equal(active[0].revision_hash, published.revision_hash);
  const profile = await f.service.call('role_template', { workflow_id: role.id, revision_hash: published.revision_hash, task: 'Implement the change', constraints: 'Own file A' });
  assert.equal(profile.source_workflow_id, draft.workflow.id); assert.match(profile.instructions, /^Custom instructions\n\nTASK/);
  assert.match(profile.instructions, /Own file A/);
  await assert.rejects(f.service.call('role_template', { workflow_id: role.id, revision_hash: before.revision_hash, task: 'stale' }), { code: 'ROLE_REVISION' });
  assert.equal((await f.service.call('list')).find(item => item.id === draft.workflow.id).role_builtin_id, role.id);
  assert.equal(f.requests.length, 0);
});

test('unchanged full built-in template compiles the original direct Role instructions, and disabled customizations block use', async t => {
  const f = await fixture(t), role = await configureRole(f);
  const draft = await f.service.call('customize_role', { workflow_id: role.id }, { human: true });
  const edited = await f.service.call('save', { workflow_id: draft.workflow.id, expected_revision: draft.revision_hash,
    workflow: { ...draft.workflow, nodes: draft.workflow.nodes.map(node => node.id === 'role' ? { ...node, prompt_template: role.prompt } : node) } });
  const ready = await f.service.call('publish', { workflow_id: draft.workflow.id, expected_revision: edited.revision_hash });
  const profile = await f.service.call('role_template', { workflow_id: role.id, task: 'Task' });
  assert.ok(profile.instructions.startsWith(role.role_instructions + '\n\nTASK\nTask'));
  await f.service.call('save', { workflow_id: ready.workflow.id, expected_revision: ready.revision_hash, workflow: { ...ready.workflow, enabled: false } });
  await assert.rejects(f.service.call('role_template', { workflow_id: role.id, task: 'Task' }), { code: 'ROLE_NOT_READY' });
  await assert.rejects(f.service.call('role_template', { workflow_id: role.id, task: '' }), { code: 'ROLE_TASK' });
});

test('duplicate built-in customization fails visibly instead of selecting an arbitrary Pack', async t => {
  const f = await fixture(t), role = await configureRole(f);
  const draft = await f.service.call('customize_role', { workflow_id: role.id }, { human: true });
  await f.service.store.duplicate(draft.workflow.id, 'second-customization', 'Conflicting customization');
  await assert.rejects(f.service.call('role_templates'), { code: 'ROLE_CUSTOMIZATION_DUPLICATE' });
});

test('routing saves compare fresh persisted rules and preserve stored authoring bindings and budgets', async t => {
  const f = await fixture(t), current = await f.service.call('settings');
  const rules = structuredClone(DEFAULT_ROUTING);
  for (const route of Object.values(rules.routes)) route.provider_id = 'worker';
  rules.generation = { planner_provider_id: 'worker', review_provider_id: 'worker', max_rounds: 2 };
  const definitions = await Promise.all(AUTHORING_WORKFLOWS.map(item => f.service.store.snapshot(item.id)));
  const saved = await f.service.call('save_routing_rules', { expected_rules: current.settings.routing, routing_rules: rules }, { human: true });
  assert.deepEqual(saved, rules); assert.deepEqual(f.service.currentSettings.routing, rules);
  for (const before of definitions) assert.deepEqual(await f.service.store.snapshot(before.workflow.id), before);
  const fresh = await f.service.settings.read(), changed = { ...rules, instructions: rules.instructions + ' Changed.' };
  await f.service.settings.save({ ...fresh.settings, routing: changed }, fresh.revision);
  await assert.rejects(f.service.workbench.call('save_routing_rules', { expected_rules: rules, routing_rules: rules }, { human: true }), { code: 'ROUTING_SETTINGS_CONFLICT' });
});

test('cache plans keep transitive source and Run pins and delete only previewed revisions and orphan objects', async t => {
  const f = await fixture(t), store = f.service.store;
  const old = await store.create(createDraft('cache-source', 'Old'), { resources: { 'a.txt': 'unused bytes' } });
  const pinned = await store.save(old.workflow.id, { ...old.workflow, name: 'Pinned' }, { expected_revision: old.revision_hash, resources: { 'a.txt': 'pinned bytes' } });
  const latest = await store.save(old.workflow.id, { ...old.workflow, name: 'Current' }, { expected_revision: pinned.revision_hash, resources: { 'a.txt': 'current bytes' } });
  const middle = await store.create(createDraft('cache-middle', 'Middle'), { provenance: { source_revision: pinned.revision_hash } });
  await store.save(middle.workflow.id, { ...middle.workflow, name: 'New middle' }, { expected_revision: middle.revision_hash, provenance: {} });
  await store.create(createDraft('cache-parent', 'Parent'), { provenance: { source_revision: middle.revision_hash } });
  const runPinned = await store.create(createDraft('run-pinned', 'Run pinned'), { resources: { 'run.txt': 'run resource' } });
  await store.save(runPinned.workflow.id, { ...runPinned.workflow, name: 'New Run source' }, { expected_revision: runPinned.revision_hash, resources: {} });
  const originalRuns = f.service.runtime.runs;
  f.service.runtime.runs = { list: async () => [{ run_id: 'retained-run' }], read: async () => ({ pins: { root: runPinned } }), writer: originalRuns.writer };
  t.after(() => { f.service.runtime.runs = originalRuns; });
  const objects = join(store.root, 'wf-cache-source.pack', 'objects'), orphan = digest('orphan object');
  await writeFile(join(objects, orphan), 'orphan object');
  const preview = await f.service.call('cache_cleanup_preview', {}, { human: true });
  assert.equal(preview.workflow_revisions, 1); assert.equal(preview.workflow_resources, 2);
  assert.ok(preview.files.some(file => file.path.endsWith(orphan)));
  await store.snapshot(old.workflow.id, old.revision_hash);
  await assert.rejects(f.service.call('cleanup_caches', { expected_plan_hash: '0'.repeat(64) }, { human: true }), { code: 'CACHE_PLAN_CHANGED' });
  const cleanup = await f.service.call('cleanup_caches', { expected_plan_hash: preview.plan_hash }, { human: true });
  assert.equal(cleanup.deleted.length, 3); assert.equal(cleanup.bytes, preview.bytes);
  const audit = JSON.parse(await readFile(cleanup.audit_file, 'utf8'));
  assert.equal(audit.status, 'complete'); assert.equal(audit.plan_hash, preview.plan_hash); assert.equal(audit.deleted.length, 3);
  await assert.rejects(store.snapshot(old.workflow.id, old.revision_hash), { code: 'ENOENT' });
  assert.equal((await store.snapshot(old.workflow.id)).revision_hash, latest.revision_hash);
  assert.equal((await store.resources(old.workflow.id, pinned.revision_hash))['a.txt'].toString(), 'pinned bytes');
  await store.snapshot(middle.workflow.id, middle.revision_hash); await store.snapshot(runPinned.workflow.id, runPinned.revision_hash);
  assert.equal((await f.service.call('cache_cleanup_preview', {}, { human: true })).files.length, 0);
});

test('portable source packages preserve immutable revision and original digest while rejecting tampering', async t => {
  const f = await fixture(t), source = await f.service.store.create(createDraft('package-source', 'Package source'), { resources: { 'instructions.txt': 'Pinned source content' } });
  const native = exportWorkflowPackage(source, await f.service.store.resources(source.workflow.id));
  const { package_sha256: ignored, ...payload } = native;
  payload.format = 'codex.workflow.package'; payload.compatibility.plugin = 'codex-agents-workflow';
  const original = { ...payload, package_sha256: digest(canonicalJSON(payload)) };
  assert.equal(validatePortableWorkflowPackage(original).snapshot.revision_hash, source.revision_hash);
  const packagePath = join(f.root, 'original-package.json'); await writeFile(packagePath, canonicalJSON(original));
  await f.service.store.delete(source.workflow.id, source.revision_hash);
  await assert.rejects(f.service.call('install_workflow_package', { package_path: 'original-package.json' }), { code: 'WORKFLOW_PACKAGE_WORKSPACE' });
  await assert.rejects(f.service.call('install_workflow_package', { package_path: 'original-package.json', workspace: f.root, expected_sha256: '0'.repeat(64) }), { code: 'WORKFLOW_PACKAGE_FETCH_INTEGRITY' });
  const installed = await f.service.call('install_workflow_package', { package_path: 'original-package.json', workspace: f.root, expected_sha256: digest(canonicalJSON(original)) });
  assert.equal(installed.revision_hash, source.revision_hash); assert.equal(installed.installation.package_sha256, original.package_sha256);
  assert.equal((await f.service.store.resources(source.workflow.id))['instructions.txt'].toString(), 'Pinned source content');
  const corrupt = structuredClone(original); corrupt.objects[0].content_base64 = Buffer.from('tampered').toString('base64');
  assert.throws(() => validatePortableWorkflowPackage(corrupt), { code: 'WORKFLOW_PACKAGE_INTEGRITY' });
  const { package_sha256: corruptHash, ...corruptPayload } = corrupt;
  corrupt.package_sha256 = digest(canonicalJSON(corruptPayload));
  assert.throws(() => validatePortableWorkflowPackage(corrupt), { code: 'WORKFLOW_PACKAGE_OBJECTS' });
  const wrongPins = structuredClone(original); wrongPins.snapshot.revision_hash = '0'.repeat(64);
  const { package_sha256: previousHash, ...wrongPinPayload } = wrongPins; wrongPins.package_sha256 = digest(canonicalJSON(wrongPinPayload));
  assert.throws(() => validatePortableWorkflowPackage(wrongPins), { code: 'WORKFLOW_PACKAGE_REVISION' });
});

test('local client metadata reports observed SDK version and admits unknown version truthfully', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.call('local_clients')).pi.version, null);
  f.host.runtimeMetadata = () => ({ sdk_version: '7.4.2', source: 'active-pi-sdk' });
  const clients = await f.service.call('local_clients');
  assert.equal(clients.pi.version, '7.4.2'); assert.equal(clients.pi.source, 'active-pi-sdk');
});

test('task description generation accepts the unsaved graph and invokes only its explicit Provider', async t => {
  const f = await fixture(t, { resultFor: (_request, input) => { assert.match(input.prompt, /Unsaved Workflow/); return { task: 'Editable task' }; } });
  f.host.getContext = () => ({ cwd: f.workspace });
  const settings = await f.service.call('settings'), routing = structuredClone(DEFAULT_ROUTING);
  for (const item of Object.values(routing.routes)) item.provider_id = 'worker';
  routing.generation = { planner_provider_id: 'worker', review_provider_id: 'worker', max_rounds: 4 };
  await f.service.call('save_settings', { settings: { ...settings.settings, routing }, expected_revision: settings.revision }, { human: true });
  const result = await f.service.call('generate_task_brief', { workflow: { ...createDraft('unsaved', 'Unsaved Workflow'), description: 'Supplied facts' }, existing: 'Existing text' }, { human: true });
  assert.deepEqual(result, { task: 'Editable task' }); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].binding, { ...binding, fingerprint: 'a'.repeat(64) });
});

async function interruptedAttempt(f, { withResult = false } = {}) {
  const pack = await f.service.store.create(workflow());
  const run = await f.service.runtime.start({ workflow_id: pack.workflow.id, revision_hash: pack.revision_hash, run_id: `recovery-${randomUUID()}`,
    workspace: f.workspace, main_actor: f.mainSession, access: 'read_only', inputs: { task: 'Recover the exact attempt' } });
  await writeDurableJSON(join(f.service.runtime.runs.directory(run.run_id), 'pi-controller.json'), { control_token: run.control_token });
  const envelope = await f.service.runtime.claimNode(run.run_id, { control_token: run.control_token, node_id: 'work', owner: 'pi-sdk-host', request_id: 'original-claim' });
  const args = { control_token: run.control_token, node_id: 'work', attempt_id: envelope.attempt_id, lease_token: envelope.lease_token };
  if (withResult) {
    const request_id = 'original-dispatch';
    await f.service.runtime.recordDispatchIntent(run.run_id, { ...args, request_id, envelope_hash: digest(canonicalJSON(envelope)) });
    await f.service.runtime.recordDispatchReceipt(run.run_id, { ...args, request_id, receipt: { executor: 'pi-sdk-subagent', invocation_id: request_id,
      session_id: 'original-session', session_file: join(f.root, 'original-session.jsonl') } });
    const completion = { status: 'succeeded', summary: 'Original result', structured_output: { text: 'original' }, artifacts: [],
      evidence: [{ kind: 'pi_session', thread_id: 'original-session', turn_id: 'original-turn', observed: 'completed' }], changed_paths: [], outside_paths: [] };
    const durable = await f.service.runtime.runs.saveExecutorResult(run.run_id, envelope.attempt_id, completion);
    await f.service.runtime.recordExecutorEvent(run.run_id, { ...args, event: { kind: 'result_proposed', metadata: durable } });
    await f.service.runtime.recordExecutorEvent(run.run_id, { ...args, event: { kind: 'session_state', metadata: { status: 'closed' } } });
  }
  await f.service.runtime.resume(run.run_id, { control_token: run.control_token, after_restart: true });
  return { run_id: run.run_id, node_id: 'work', attempt_id: envelope.attempt_id };
}

test('unsubmitted claim recovery passes its rotated exact lease to the service adapter without charging a retry', async t => {
  const f = await fixture(t), args = await interruptedAttempt(f), resumed = [];
  f.service.resumeRecoveredAttempt = async (runId, lease, attached) => {
    resumed.push({ runId, lease, attached }); return attached;
  };
  const result = await f.service.call('recover_claim', args, { human: true });
  assert.equal(result.reattached, true); assert.equal(result.retry_charged, false); assert.equal(resumed.length, 1);
  assert.equal(resumed[0].lease.attempt_id, args.attempt_id); assert.equal(resumed[0].lease.lease_token, result.envelope.lease_token);
  const record = await f.service.runtime.runs.read(args.run_id);
  assert.equal(record.state.nodes.work.attempts.length, 1); assert.equal(record.state.nodes.work.status, 'claimed');
  assert.equal(record.state.nodes.work.attempts[0].reconciliation.kind, 'unsubmitted_claim'); assert.equal(f.requests.length, 0);
});

test('durable result recovery passes the original successful completion identity without redispatch', async t => {
  const f = await fixture(t), args = await interruptedAttempt(f, { withResult: true });
  f.service.resumeRecoveredAttempt = async (runId, lease, attached) => {
    const record = await f.service.runtime.runs.read(runId), attempt = record.state.nodes.work.attempts[0];
    const completion = await f.service.runtime.runs.readExecutorResult(runId, lease.attempt_id, attempt.result_proposal.sha256);
    await f.service.runtime.completeNode(runId, { ...lease, completion });
    return { ...attached, state: await f.service.runtime.get(runId), consumed: true };
  };
  const result = await f.service.call('recover_result', args, { human: true });
  assert.equal(result.consumed, true); assert.equal(result.state.nodes.work.status, 'succeeded');
  assert.equal(result.state.nodes.work.attempts.length, 1); assert.equal(f.requests.length, 0);
});

test('real service dispatches the recovered unsubmitted claim on its original attempt', async t => {
  const f = await fixture(t), args = await interruptedAttempt(f);
  await f.service.call('recover_claim', args, { human: true });
  const after = await settle(f.service, args.run_id), node = after.state.nodes.work;
  assert.equal(node.status, 'succeeded'); assert.equal(node.attempts.length, 1); assert.equal(node.attempts[0].id, args.attempt_id);
  assert.equal(node.attempts[0].lease_generation, 1); assert.equal(f.requests.length, 1); assert.equal(f.mainRequests.length, 1);
  assert.equal(after.state.nodes.final.status, 'running'); assert.equal(f.notifications.at(-1).status, 'awaiting_acceptance');
});

test('real service consumes the closed durable worker result without invoking that worker again', async t => {
  const f = await fixture(t), args = await interruptedAttempt(f, { withResult: true });
  await f.service.call('recover_strict_result', args, { human: true });
  const after = await settle(f.service, args.run_id), node = after.state.nodes.work;
  assert.equal(node.status, 'succeeded'); assert.equal(node.attempts.length, 1);
  assert.equal(node.attempts[0].id, args.attempt_id); assert.deepEqual(node.attempts[0].completion.structured_output, { text: 'original' });
  assert.equal(node.attempts[0].dispatch.request_id, 'original-dispatch'); assert.equal(f.requests.length, 0); assert.equal(f.mainRequests.length, 1);
});

test('conversational controller recovery requires exact user-message authorization and persists its audit', async t => {
  const f = await fixture(t), args = await interruptedAttempt(f), before = await f.service.runtime.runs.read(args.run_id);
  const request = { run_id: args.run_id, expected_sequence: before.sequence, main_actor: f.mainSession,
    reason: 'User requested recovery of this interrupted Run', authorization: { confirmed: true, source: 'user_message', statement: 'Recover this exact Run' } };
  await assert.rejects(f.service.call('recover_control', { ...request, authorization: { ...request.authorization, confirmed: false } }), { code: 'CONTROL_RECOVERY_AUTHORIZATION' });
  await assert.rejects(f.service.call('recover_control', { ...request, extra: true }), { code: 'CONTROL_RECOVERY_SCHEMA' });
  const recovered = await f.service.call('recover_control', request);
  const after = await f.service.runtime.runs.read(args.run_id), authority = await f.service.authority(args.run_id);
  assert.equal(recovered.status, 'paused'); assert.notEqual(after.state.control_hash, before.state.control_hash);
  assert.equal(digest(authority.control_token), after.state.control_hash);
  assert.equal(after.state.control_recovery.channel, 'conversation_mcp'); assert.equal(after.state.control_recovery.authorization_source, 'user_message');
  assert.equal(after.state.nodes.work.attempts.length, 1); assert.equal(f.requests.length, 0);
});

test('plain configured Role prompts append the complete task boundary', async t => {
  const f = await fixture(t), settings = await f.service.call('settings');
  const role = { id: 'plain-role', name: 'Plain Role', enabled: true, prompt: 'Review carefully.', access: 'read_only', provider_id: 'worker' };
  await f.service.call('save_settings', { settings: { ...settings.settings, roles: [role] }, expected_revision: settings.revision }, { human: true });
  const profile = await f.service.call('role_template', { workflow_id: role.id, task: 'Review API', context: 'Source A', constraints: 'Read only', verification: 'Inspect diff' });
  assert.match(profile.instructions, /^Review carefully\.\n\nTASK\nReview API/);
  assert.match(profile.instructions, /CONTEXT\nSource A/); assert.match(profile.instructions, /CONSTRAINTS AND OWNERSHIP\nRead only/); assert.match(profile.instructions, /VERIFICATION\nInspect diff/);
});

test('Agent brief creation and expansion produce pinned source packets with zero model calls', async t => {
  const f = await fixture(t), settings = await f.service.call('settings'), rules = structuredClone(DEFAULT_ROUTING);
  for (const route of Object.values(rules.routes)) route.provider_id = 'worker';
  rules.generation = { planner_provider_id: 'worker', review_provider_id: 'worker', max_rounds: 4 };
  await f.service.call('save_settings', { settings: { ...settings.settings, routing: rules }, expected_revision: settings.revision }, { human: true });
  const draft = await f.service.call('build_workflow', { workflow_id: 'chat-built', name: 'Chat draft', brief: 'Read the supplied file, analyze its contents, and return a concise summary.', provider_id: 'worker' });
  const packet = await f.service.call('prepare_expansion', { workflow_id: draft.workflow.id, revision_hash: draft.revision_hash, provider_id: 'worker' });
  assert.equal(packet.invoked, false); assert.equal(packet.provider_id, 'worker'); assert.equal(packet.source_revision, draft.revision_hash);
  assert.equal(packet.access, 'read_only'); assert.equal(packet.adapter.execution, 'pi_sdk'); assert.match(packet.prompt, /Read the supplied file/);
  assert.equal(f.requests.length, 0);
});

test('Run event/next views and Host wait preserve journal cursors without exposing authority or polling models', async t => {
  const f = await fixture(t), pack = await f.service.store.create(workflow());
  const run = await f.service.runtime.start({ workflow_id: pack.workflow.id, revision_hash: pack.revision_hash, run_id: `wait-${randomUUID()}`,
    workspace: f.workspace, main_actor: f.mainSession, access: 'read_only', inputs: { task: 'Wait for observed events' } });
  await writeDurableJSON(join(f.service.runtime.runs.directory(run.run_id), 'pi-controller.json'), { control_token: run.control_token });
  const next = await f.service.call('next', { run_id: run.run_id });
  assert.deepEqual(next.ready, ['work']);
  const events = await f.service.call('events', { run_id: run.run_id });
  assert.equal(events[0].kind, 'started'); assert.equal(events[0].sequence, 1);
  assert.equal((await f.service.call('events', { run_id: run.run_id, after_sequence: 1 })).length, 0);
  const waiting = await f.service.call('wait', { run_id: run.run_id, after_sequence: 1, timeout_ms: 20 });
  assert.equal(waiting.wake_reason, 'timeout'); assert.equal(waiting.next_action, 'caw');
  assert.deepEqual(waiting.next_action_args, { action: 'wait', run_id: run.run_id, after_sequence: 1, timeout_ms: 20 });
  assert.equal(JSON.stringify(waiting).includes(run.control_token), false);
  await writeDurableJSON(join(f.service.runtime.runs.directory(run.run_id), 'pi-worker.json'), { run_id: run.run_id, status: 'awaiting_acceptance' });
  assert.equal((await f.service.call('wait', { run_id: run.run_id, timeout_ms: 100 })).wake_reason, 'needs_attention');
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.service.call('record_usage', { run_id: run.run_id }), { code: 'HUMAN_USAGE_REQUIRED' });
});
