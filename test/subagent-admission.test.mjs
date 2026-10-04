import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workflow, agent, settle } from './fixtures.mjs';
import { resolvedSubagentPlan } from '../core/workflow-runtime.mjs';

test('auto without fan-out starts one native Pi child and retains its configured count', async t => {
  const f = await fixture(t), graph = workflow([{ ...agent('work'), subagent_count: 'auto' }]);
  await f.service.call('create_workflow', { workflow: graph });
  const run = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'single writer' } });
  const snapshot = await settle(f.service, run.run_id);
  assert.equal(snapshot.state.nodes.work.status, 'succeeded');
  assert.equal(f.requests.length, 1);
  const record = await f.service.runtime.runs.read(run.run_id);
  const pinned = record.pins.root.workflow.nodes.find(node => node.id === 'work');
  assert.equal(pinned.subagent_count, 'auto');
  assert.equal(pinned.fanout, undefined);
  assert.equal(resolvedSubagentPlan(pinned, record.state).count, 1);
  assert.equal(f.mainRequests.length, 1);
  assert.equal(snapshot.state.status, 'running'); // Existing human final acceptance remains required.
});

for (const mode of ['fixed multiple', 'Main auto']) test(`${mode} is rejected on startup before any Run or model effect`, async t => {
  const f = await fixture(t);
  await f.service.call('create_workflow', { workflow: workflow() });
  // Simulate an invalid pinned definition at the startup boundary. Normal
  // publication already rejects this graph, so do not bypass it on disk.
  const snapshot = f.service.store.snapshot.bind(f.service.store);
  f.service.store.snapshot = async (...args) => {
    const pack = await snapshot(...args);
    pack.workflow.nodes.find(node => node.id === (mode === 'Main auto' ? 'final' : 'work')).subagent_count = mode === 'Main auto' ? 'auto' : 2;
    return pack;
  };
  await assert.rejects(f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'invalid count' } }), error => {
    assert.equal(error.code, 'WORKFLOW_LAUNCH_BLOCKED');
    assert.match(JSON.stringify(error.validation), new RegExp(mode === 'Main auto' ? 'SUBAGENT_COUNT' : 'SUBAGENT_FANOUT'));
    return true;
  });
  assert.equal(f.requests.length, 0);
  assert.equal(f.mainRequests.length, 0);
  assert.deepEqual(await f.service.call('runs'), []);
});

test('Pi preflight independently enforces fixed fan-out and Main count prohibitions', async t => {
  const f = await fixture(t);
  const check = node => f.service.preflight({ provider_ids: [], packs: [{ workflow: { ...workflow(), nodes: [node] } }] });
  assert.throws(() => check({ ...agent('work'), subagent_count: 2 }), { code: 'PI_POOL_JOIN_REQUIRED' });
  assert.throws(() => check({ ...agent('final', { kind: 'main' }), subagent_count: 'auto' }), { code: 'SUBAGENT_COUNT' });
  assert.throws(() => check({ ...agent('final', { kind: 'main' }), subagent_count: 1 }), { code: 'SUBAGENT_COUNT' });
});
