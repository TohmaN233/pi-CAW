import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, validateWorkflowShape } from '../core/workflow-schema.mjs';

test('unsupported shared Host workspace policy fails visibly instead of losing immutable source semantics', () => {
  const workflow = createDraft('overlap-import', 'Overlap source');
  const policy = { kind: 'host_tool_overlap', tool_node_id: 'render', main_node_id: 'review', read_inputs: ['source'] };
  workflow.nodes = [{ id: 'parallel', type: 'parallel', workspace_policy: policy }];
  assert.throws(() => validateWorkflowShape(workflow), { code: 'PI_WORKSPACE_POLICY_UNSUPPORTED' });
  assert.deepEqual(workflow.nodes[0].workspace_policy, policy);
});
