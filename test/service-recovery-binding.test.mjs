import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PiCawService } from '../lib/service.mjs';
import { qualifiedExecutionBinding } from '../core/execution/program-broker.mjs';
import { authoringHostToolContracts } from '../core/execution/authoring-host-tools.mjs';
import { fixture, workflow, agent, settle, binding } from './fixtures.mjs';

function executionBinding() {
  // Metadata-only fixtures never start this launcher or install an OS runtime.
  return { kind: 'wsl', launcher: join(process.platform === 'win32' ? 'C:\\Windows' : '/Windows', 'System32', 'wsl.exe'),
    distribution: 'Fixture', sandbox: '/usr/bin/bwrap', programs: { python: '/usr/bin/python3' } };
}

function recoveryFixture(reviewed) {
  const attempt = { id: 'saved-review', status: 'running', result_proposal: { sha256: 'a'.repeat(64) },
    reconciliation: { kind: 'strict_durable_result' } };
  const record = { pins: { root: { provenance: { kind: 'authoring_workflow_run' }, workflow: {
    finalization: { node_id: 'final' }, nodes: [{ id: 'final', executor: { kind: 'main' } }, { id: 'expand' }] } } },
    state: { status: 'running', nodes: { final: { status: 'running', attempts: [attempt] }, expand: { status: 'succeeded', attempts: [] } } } };
  const launches = [], reviews = [];
  const service = { active: new Map(), runtime: { runs: { read: async () => record },
    readExecutorResult: () => assert.fail('Recovered reviewer result must not be completed as ordinary Main'),
    completeHostMainResult: () => assert.fail('Recovery must preserve the human acceptance boundary') },
    workbench: { authoring: { afterReview: async (...args) => {
      reviews.push(args);
      if (reviewed.authoring_phase === 'repairing') { record.state.nodes.final.status = 'pending'; record.state.nodes.expand.status = 'ready'; }
      return reviewed;
    } } },
    launchDriver: (runId, options) => { launches.push({ runId, options }); return { status: 'running', background: true }; } };
  const args = { node_id: 'final', attempt_id: attempt.id, control_token: 'authority' };
  return { service, record, attempt, launches, reviews, args };
}

for (const [name, review, status, launches] of [
  ['approved', { awaiting_acceptance: true }, 'awaiting_acceptance', 0],
  ['needs user guidance', { awaiting_user_input: true, authoring_phase: 'user_input_required' }, 'user_input_required', 0],
  ['requires a semantic repair', { authoring_phase: 'repairing' }, 'running', 1],
]) test(`durable recovered authoring review ${name} preserves its exact artifact and routes the next action`, async () => {
  const f = recoveryFixture(review);
  const output = await PiCawService.prototype.resumeRecoveredAttempt.call(f.service, 'run', f.args, { reattached: true });
  assert.equal(output.status, status);
  assert.equal(output.reattached, true);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.launches.length, launches);
  assert.equal(f.attempt.id, 'saved-review');
  assert.equal(f.attempt.result_proposal.sha256, 'a'.repeat(64));
  if (launches) assert.deepEqual(f.launches[0], { runId: 'run', options: { recoveredNodes: [] } });
  else { assert.equal(output.recovered_result, true); assert.equal(output.model_calls, 0); }
});

test('unexpected recovered review outcomes fail visibly without dispatching a model', async () => {
  const f = recoveryFixture({});
  await assert.rejects(PiCawService.prototype.resumeRecoveredAttempt.call(f.service, 'run', f.args, {}), { code: 'PI_RECOVERY_REVIEW_OUTCOME' });
  assert.equal(f.launches.length, 0);
});

for (const waiting of [true, false]) test(`recovered unsubmitted review ${waiting ? 'stops for guidance' : 'continues its semantic repair'} without re-dispatching the saved attempt`, async () => {
  const attempt = { id: 'unsubmitted-review', reconciliation: { kind: 'unsubmitted_claim' } };
  const record = { state: { nodes: { final: { attempts: [attempt] } } },
    pins: { root: { workflow: { nodes: [{ id: 'expand', executor: { kind: 'provider' } }] } } } };
  const dispatched = []; let reviews = 0, nextCalls = 0;
  const service = { active: new Map(), authority: async () => ({ control_token: 'authority' }),
    runtime: { runs: { read: async () => record }, execution: async () => ({ inputs: {} }),
      next: async () => {
        nextCalls++;
        if (waiting) assert.fail('User guidance must stop the recovered loop before ready work');
        return nextCalls === 1 ? { status: 'running', ready: ['expand'] } : { status: 'running', ready: [] };
      } },
    executeNode: async (_runId, nodeId, _authority, _signal, envelope) => {
      dispatched.push({ nodeId, attempt_id: envelope?.attempt_id });
      return nodeId === 'final' ? { authoring_review: true } : {};
    },
    workbench: { authoring: { afterReview: async () => { reviews++; return waiting
      ? { awaiting_user_input: true, authoring_phase: 'user_input_required' } : { authoring_phase: 'repairing' }; } } } };
  const output = await PiCawService.prototype.drive.call(service, 'run', new AbortController().signal, { recoveredNodes: ['final'] });
  assert.equal(output.status, waiting ? 'user_input_required' : 'running');
  assert.equal(reviews, 1);
  assert.deepEqual(dispatched, [{ nodeId: 'final', attempt_id: attempt.id }, ...(!waiting ? [{ nodeId: 'expand', attempt_id: undefined }] : [])]);
});

test('explicit qualified WSL binding stays pinned and reaches Host tools, children and current-chat Main', async t => {
  const f = await fixture(t), contract = authoringHostToolContracts()[0];
  const probe = { id: 'probe', type: 'tool', executor: { kind: 'tool', tool: contract.id }, access: 'read_only',
    approval: { required: false }, retry: { max_attempts: 1 }, input_bindings: { evidence: '/inputs/evidence' }, outputs_schema: contract.output_schema };
  const graph = workflow([probe, agent('work')]); graph.host_tools = [contract];
  graph.inputs_schema.properties.evidence = contract.input_schema.properties.evidence;
  graph.inputs_schema.required.push('evidence');
  await f.service.call('create_workflow', { workflow: graph });
  const contexts = [], execute = f.service.toolRunner.execute.bind(f.service.toolRunner);
  f.service.toolRunner.execute = async (pinned, input, context, options) => {
    contexts.push({ execution_binding: structuredClone(context.execution_binding), task_root: context.task_root });
    return execute(pinned, input, context, options);
  };
  const supplied = executionBinding(), expected = qualifiedExecutionBinding(supplied);
  const run = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only',
    constraints: { execution_binding: supplied }, inputs: { task: 'Inspect', evidence: { stage: 'graph_assembly', proposal_hash: 'a'.repeat(64), result: {} } } });
  supplied.distribution = 'changed-after-start';
  const state = (await settle(f.service, run.run_id)).state;
  assert.equal(state.nodes.probe.status, 'succeeded', JSON.stringify(f.notifications));
  assert.equal(state.nodes.work.status, 'succeeded', JSON.stringify(f.notifications));
  assert.deepEqual(state.constraints.execution_binding, expected);
  assert.deepEqual(contexts, [{ execution_binding: expected, task_root: f.workspace }]);
  assert.equal(f.requests.length, 1); assert.equal(f.mainRequests.length, 1);
  for (const request of [f.requests[0], f.mainRequests[0]]) {
    assert.deepEqual(request.execution_binding, expected);
    assert.equal(request.task_root, f.workspace);
    assert.deepEqual(request.required_mcp_servers, []);
  }
});

test('invalid explicit execution binding fails before creating a Run or native task', async t => {
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: workflow() });
  for (const supplied of [null, { ...executionBinding(), programs: { python: '/opt/fixture/python' } }, { ...executionBinding(), command_timeout_ms: 999 }]) {
    await assert.rejects(f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only',
      inputs: { task: 'Inspect' }, constraints: { execution_binding: supplied } }), { code: 'PI_EXECUTION_BINDING' });
  }
  assert.equal((await f.service.call('runs')).length, 0);
  assert.equal(f.requests.length, 0); assert.equal(f.mainRequests.length, 0);
});

test('a source-Workflow Role retains its exact MCP requirements in the Pi task request', async t => {
  const f = await fixture(t);
  f.service.workbench.roleProfile = async () => ({ id: 'source-role', name: 'Source Role', status: 'ready', enabled: true,
    provider_available: true, binding, access: 'read_only', source_workflow_id: 'role-pack', revision_hash: 'a'.repeat(64), instructions: 'Inspect the supplied task.' });
  f.service.store.snapshot = async (id, revision) => {
    assert.equal(id, 'role-pack'); assert.equal(revision, 'a'.repeat(64));
    return { workflow: { requirements: { mcp_servers: ['source-mcp'] }, nodes: [{ id: 'role', type: 'agent', resources: [] }] }, resources: [] };
  };
  const output = await f.service.call('launch_role', { role_id: 'source-role', task: 'Inspect', workspace: f.workspace,
    outputs_schema: agent('schema').outputs_schema });
  await Promise.all(f.service.roleTasks.values());
  assert.equal(output.status, 'running');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].required_mcp_servers, ['source-mcp']);
});
