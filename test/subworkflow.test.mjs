import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workflow, settle } from './fixtures.mjs';

test('an immutable child Workflow waits for its own human acceptance before the parent collects it', async t => {
  const f = await fixture(t);
  const childGraph = { ...workflow([]), id: 'child', name: 'Child' };
  const childPack = await f.service.call('create_workflow', { workflow: childGraph });
  const childNode = { id: 'child-node', type: 'subworkflow', executor: { kind: 'subworkflow' }, access: 'read_only',
    approval: { required: false }, retry: { max_attempts: 2 }, input_bindings: { task: '/inputs/task' },
    outputs_schema: childGraph.outputs_schema,
    subworkflow: { workflow_id: 'child', revision_pin: childPack.revision_hash, output_bindings: { text: '/output/text' } } };
  await f.service.call('create_workflow', { workflow: workflow([childNode]) });
  const parent = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'test' } });
  const initial = await settle(f.service, parent.run_id);
  assert.equal(initial.state.nodes['child-node'].status, 'running', JSON.stringify(f.notifications));
  const childId = initial.state.nodes['child-node'].attempts.at(-1).child_run_id;
  const childProposal = await f.service.call('final_proposal', { run_id: childId }); assert(childProposal);
  await f.service.call('accept_final', { run_id: childId, accepted: true, proposal_sha256: childProposal.proposal_sha256 }, { human: true });
  await settle(f.service, childId); const final = await settle(f.service, parent.run_id);
  assert.equal(final.state.nodes['child-node'].status, 'succeeded');
  assert.equal(final.state.nodes.final.status, 'running');
  assert(f.notifications.some(item => item.run_id === childId && item.status === 'awaiting_acceptance'));
});
