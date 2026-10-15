import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workflow, agent, settle } from './fixtures.mjs';

test('orchestration helpers inherit the Run workspace when omitted and retain the parent scope', async t => {
  const f = await fixture(t), workspace = join(f.root, 'helper-products'); await mkdir(workspace);
  f.service.workbench.roleProfile = async () => ({ id: 'review', revision_hash: 'a'.repeat(64), name: 'Review', status: 'ready', enabled: true, provider_available: true, requires_user_approval: false, access: 'read_only', instructions: 'Review the assigned inputs', binding: { provider: 'fixture', model_id: 'worker', thinking: 'off' } });
  let authorized = 0;
  f.host.main = { pending: { active: true, request: { main_mode: 'orchestration', workspace, access: 'read_only', allowed_paths: [], authorize: async () => { authorized++; } } } };
  const args = { role_id: 'review', task: 'Inspect products', outputs_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
  await assert.rejects(f.service.launchRole({ ...args, workspace: f.workspace }), { code: 'PI_ORCHESTRATION_SCOPE' });
  assert.equal(f.requests.length, 0);
  await f.service.launchRole(args);
  await Promise.all(f.service.roleTasks.values());
  assert.equal(f.requests[0].workspace, workspace);
  assert.equal(f.requests[0].access, 'read_only');
  assert.deepEqual(f.requests[0].allowed_paths, []);
  await f.requests[0].authorize(); assert.equal(authorized, 1);
  f.host.main.pending.cancelled = true;
  await assert.rejects(f.requests[0].authorize(), { code: 'PI_TASK_ABORTED' });
});

test('a different Run workspace does not inherit a skipped Main branch directory constraint', async t => {
  const f = await fixture(t), graph = workflow([agent('review', { kind: 'main', mode: 'orchestration' })]);
  graph.nodes.splice(1, 0, { id: 'route', type: 'condition', cases: [{ label: 'video', when: { op: 'eq', args: [{ path: '/inputs/video' }, { value: true }] } }], default_label: 'page' });
  graph.inputs_schema.properties.video = { type: 'boolean' }; graph.inputs_schema.required.push('video');
  graph.edges = [{ id: 'start-route', source: 'start', target: 'route' }, { id: 'video-review', source: 'route', target: 'review', label: 'video' }, { id: 'page-final', source: 'route', target: 'final', label: 'page' }, { id: 'review-final', source: 'review', target: 'final' }, { id: 'final-end', source: 'final', target: 'end' }];
  await f.service.call('create_workflow', { workflow: graph });
  const workspace = join(f.root, 'separate-products'); await mkdir(workspace);
  const run = await f.service.call('run', { workflow_id: graph.id, workspace, access: 'read_only', inputs: { task: 'Produce pages only', video: false } });
  const snapshot = await settle(f.service, run.run_id);
  assert.equal(snapshot.state.nodes.review.status, 'skipped');
  assert.equal(snapshot.state.nodes.final.status, 'running');
  assert.equal(f.notifications.at(-1).status, 'awaiting_acceptance');
  assert(f.mainRequests.every(request => request.workspace === workspace));
  assert.equal(f.host.getContext().cwd, f.workspace);
});

test('declared Main acceptance retains its default or uses an explicit frozen worker override in another workspace', async t => {
  for (const mode of ['orchestration', 'worker']) await t.test(mode, async t => {
    let reviews = 0; const workPrompts = [], reviewPrompts = [];
    const f = await fixture(t, { resultFor: (request, input) => {
      if (request.node_id === 'work') workPrompts.push(input.prompt);
      if (request.node_id === 'review') { reviewPrompts.push(input.prompt); return { accepted: ++reviews === 2, semantic_result: reviews === 1 ? 'Revise opening' : 'Accepted' }; }
      return { text: 'product' };
    } });
    const review = { ...agent('review', { kind: 'main', mode: 'orchestration' }), outputs_schema: { type: 'object', properties: { accepted: { type: 'boolean' }, semantic_result: { type: 'string' } }, required: ['accepted', 'semantic_result'], additionalProperties: false } };
    const graph = workflow([agent('work'), review]);
    graph.loops = [{ id: 'acceptance', entry_node: 'work', exit_node: 'review', node_ids: ['work', 'review'], max_rounds: null, review_context: 'current_main', feedback_bindings: { semantic_result: '/nodes/review/output/semantic_result' }, until: { op: 'eq', args: [{ path: '/nodes/review/output/accepted' }, { value: true }] } }];
    graph.nodes.find(node => node.id === 'work').input_bindings.feedback = '/loops/acceptance/feedback';
    await f.service.call('create_workflow', { workflow: graph });
    const workspace = join(f.root, 'separate-products'); await mkdir(workspace);
    const run = await f.service.call('run', { workflow_id: graph.id, workspace, access: 'read_only', inputs: { task: 'Original request' }, ...(mode === 'worker' ? { main_modes: { review: 'worker' } } : {}) });
    const snapshot = await settle(f.service, run.run_id);
    assert.equal(snapshot.state.loops.acceptance.status, 'accepted');
    assert.equal(snapshot.state.loops.acceptance.round, 2);
    assert.equal(snapshot.state.loops.acceptance.rounds[0].feedback.semantic_result, 'Revise opening');
    assert(workPrompts[1].includes('Revise opening'), 'Repair producer receives the rejected reviewer feedback');
    assert(reviewPrompts.every(prompt => prompt.includes('Original request')), 'Every review retains the original task');
    assert.equal(snapshot.state.main_actor, f.mainSession);
    assert.equal(snapshot.state.constraints.pi_caw_main_modes[graph.id].review, mode);
    const requests = f.mainRequests.filter(request => request.node_id === 'review');
    assert.equal(requests.length, 2);
    assert(requests.every(request => request.workspace === workspace && request.access === 'read_only' && request.context_mode === (mode === 'worker' ? 'isolated' : 'current')));
    const record = await f.service.runtime.runs.read(run.run_id);
    const receipt = record.state.nodes.review.attempts.at(-1).dispatch.receipt;
    assert.equal(receipt.main_actor, f.mainSession);
    assert.equal(receipt.main_mode, mode);
    assert.equal(receipt.thread_id === f.mainSession, mode === 'orchestration');
    assert.equal(graph.nodes.find(node => node.id === 'review').executor.mode, 'orchestration');
  });
});
