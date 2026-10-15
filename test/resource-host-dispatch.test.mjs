import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workflow } from './fixtures.mjs';
import { digest } from '../core/workflow-revisions.mjs';
import { resolveHostToolDispatch } from '../lib/external-host-tools.mjs';
import { resolveHostToolImplementation } from '../core/execution/host-tool-runner.mjs';

const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const program = `import {readFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
process.stdout.write(JSON.stringify({text:input.task}));\n`;

test('dispatch uses core ID/name precedence and reports an absent exact implementation', () => {
  const identity = { name: 'resource_protocol', version: '1', sha256: digest('dispatch fixture') };
  const builtin = { identity }, contract = { id: 'route_alias', identity };
  assert.equal(resolveHostToolDispatch({ resource_protocol: builtin }, { resource_protocol: builtin }, contract).external, false);
  assert.equal(resolveHostToolImplementation(new Map([['resource_protocol', builtin]]), contract), builtin);
  const externalIdentity = { name: 'external_route', version: '1', sha256: digest('external dispatch fixture') };
  const external = { identity: externalIdentity, execute() {}, cancel() {}, attestation: {
    qualified: true, cancellable: true, effect_observation: true, tool_identity: externalIdentity,
    broker_id: 'fixture', evidence_sha256: digest('fixture qualification'),
  } };
  const registry = { resource_protocol: builtin, route_alias: external };
  assert.equal(resolveHostToolImplementation(registry, contract), external, 'exact ID wins over an implementation-name alias');
  assert.equal(resolveHostToolDispatch({ resource_protocol: builtin }, registry, contract).external, true,
    'an ID-selected external registration cannot borrow the built-in name to skip external authority');
  assert.throws(() => resolveHostToolDispatch({}, {}, contract), error => error.code === 'HOST_TOOL_UNAVAILABLE'
    && error.message.includes(contract.id) && error.message.includes(identity.name));
});

for (const workerMode of [false, true]) test(`resource-program tool ID resolves its built-in implementation in ${workerMode ? 'worker' : 'parent'} service`, async t => {
  const f = await fixture(t);
  f.service.workerMode = workerMode;
  const contract = {
    id: 'am_declared_page_route',
    identity: { name: 'workflow-resource-program', version: '1', sha256: digest('immutable upstream adapter build') },
    argv: ['node', 'adapter/route.mjs', '.workflow-host-scratch', '@INPUT@'], env_allow: [],
    input_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
    output_schema: schema, permissions: { network: false, read_paths: ['.'], write_paths: ['.'] },
    output_cap_bytes: 4096, deadline_ms: 10_000, idempotency: { mode: 'safe' },
  };
  const node = { id: 'declared_page_route', type: 'tool', executor: { kind: 'tool', tool: contract.id },
    access: 'bounded_write', path_scope: { binding: 'run.allowed_paths' },
    resources: ['adapter/route.mjs'], input_bindings: { task: '/inputs/task' }, outputs_schema: schema,
    retry: { max_attempts: 1 }, approval: { required: false } };
  const graph = workflow([node]); graph.host_tools = [contract];
  graph.requirements.executables = [{ name: 'node', version: '>=20.0.0' }];
  await f.service.call('create_workflow', { workflow: graph, resources: { 'adapter/route.mjs': program } });
  const run = await f.service.runtime.start({ workflow_id: graph.id, workspace: f.workspace,
    access: 'bounded_write', allowed_paths: ['.'], main_actor: f.mainSession, inputs: { task: 'original declared task' } });
  await f.service.executeNode(run.run_id, node.id, { control_token: run.control_token }, new AbortController().signal);
  const record = await f.service.runtime.runs.read(run.run_id), result = record.state.nodes[node.id];
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { text: 'original declared task' });
  assert.equal(result.attempts[0].host_tool.receipt.tool, contract.id);
  assert.equal(result.attempts[0].host_tool.receipt.broker.implementation_identity.name, contract.identity.name);
  assert.equal(result.attempts[0].host_tool.receipt.status, 'succeeded');
  assert.equal(f.requests.length + f.mainRequests.length, 0, 'routing does not call a model');
});
