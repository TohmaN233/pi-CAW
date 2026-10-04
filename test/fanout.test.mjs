import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workflow, agent, settle } from './fixtures.mjs';

for (const incremental of [false, true]) test(`Pi per-item fan-out joins deterministic results${incremental ? ' across turns in each persistent child' : ''}`, async t => {
  const prompts = [];
  const worker = { ...agent('pool'), subagent_count: 'auto', input_bindings: { records: '/inputs/records' },
    prompt_template: 'Inspect only the supplied records.',
    fanout: { input: 'records', item_name: 'record', result_output: 'results', distribution: 'partition', batch_size: 2,
      scheduling: 'parallel', max_concurrency: 2, join: 'all_required', result_mode: 'per_item', ...(incremental ? { item_delivery: 'incremental' } : {}) },
    outputs_schema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } }, required: ['results'], additionalProperties: false } };
  const graph = workflow([worker]); graph.inputs_schema.properties.records = { type: 'array', items: { type: 'integer' }, minItems: 1 }; graph.inputs_schema.required.push('records');
  const f = await fixture(t, { resultFor: (request, input) => {
    if (request.kind === 'main') return { text: 'All results reviewed' };
    const records = JSON.parse(input.prompt.split('Declared inputs:\n')[1].split('\n\nAccess:')[0]).records;
    prompts.push({ records, session: request.session_id });
    return { items: records.map(value => ({ outcome: 'completed', result: { value: value * 2 } })) };
  } });
  await f.service.call('create_workflow', { workflow: graph });
  const run = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'Process', records: [1, 2, 3, 4, 5] } });
  const state = (await settle(f.service, run.run_id)).state;
  assert.equal(state.nodes.pool.status, 'succeeded', JSON.stringify(f.notifications));
  assert.deepEqual(state.nodes.pool.output.results, [2, 4, 6, 8, 10].map(value => ({ value })));
  assert.equal(f.requests.length, 3); assert.equal(prompts.length, incremental ? 5 : 3);
  assert(prompts.every(item => item.records.length <= (incremental ? 1 : 2)));
  assert.equal(Object.keys(state.nodes.pool.attempts[0].native_item_results).length, 5);
});

test('final accepted flag is supplied by the human Host, never requested from Main', async t => {
  const graph = workflow(); const final = graph.nodes.find(node => node.id === 'final');
  final.outputs_schema.properties.accepted = { type: 'boolean' }; final.outputs_schema.required.push('accepted');
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: graph });
  const run = await f.service.call('run', { workflow_id: 'example', workspace: f.workspace, access: 'read_only', inputs: { task: 'test' } });
  await settle(f.service, run.run_id);
  assert(!f.mainRequests[0].schema.required.includes('accepted'));
  const proposal = await f.service.call('final_proposal', { run_id: run.run_id });
  assert.equal(proposal.completion.structured_output.accepted, undefined);
  await f.service.call('accept_final', { run_id: run.run_id, accepted: true, proposal_sha256: proposal.proposal_sha256 }, { human: true });
  assert.equal((await settle(f.service, run.run_id)).state.nodes.final.output.accepted, true);
});
