import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasIssues,toCanvas,renameLoopId} from '../web-src/graph-adapter.mjs';
import {createDraft} from '../core/workflow-schema.mjs';
import {validateWorkflowGraph} from '../core/workflow-validator.mjs';
const agent=id=>({id,type:'agent',executor:{kind:'main'},access:'read_only',role:'implementer',approval:{required:false},retry:{max_attempts:3},prompt_template:'Perform assigned work.',input_bindings:{},outputs_schema:{}});
const edge=(source,target,label)=>({id:source+'-'+target,source,target,...(label?{label}:{})});
test('canvas displays a bounded loop region and round state without adding a graph back edge', () => {
  const workflow = { nodes: [
    { id: 'start', type: 'start', ui: { position: { x: 0, y: 0 } } },
    { id: 'review', type: 'agent', name: 'Review', ui: { position: { x: 100, y: 120 } } },
    { id: 'repair', type: 'agent', name: 'Repair', ui: { position: { x: 410, y: 220 } } },
    { id: 'end', type: 'end', ui: { position: { x: 720, y: 0 } } },
  ], edges: [
    { id: 'a', source: 'start', target: 'review' },
    { id: 'b', source: 'review', target: 'repair' },
    { id: 'c', source: 'repair', target: 'end' },
  ], loops: [{ id: 'review-repair', entry_node: 'review', exit_node: 'repair', node_ids: ['review', 'repair'], max_rounds: 4,
    until: { op: 'eq', args: [{ path: '/loops/review-repair/all_accepted' }, { value: true }] } }] };
  const before = structuredClone(workflow);
  const canvas = toCanvas(workflow, { nodes: { review: { status: 'succeeded' } }, loops: { 'review-repair': { round: 2, status: 'running' } } });
  const region = canvas.nodes.find(node => node.type === 'loopRegion');
  const review = canvas.nodes.find(node => node.id === 'review');
  assert.equal(canvas.edges.length, workflow.edges.length);
  assert.equal(region.data.definition.id, 'review-repair');
  assert.equal(region.data.runtime.round, 2);
  assert.equal(region.data.runtime.status, 'running');
  assert.equal(region.draggable, false); assert.equal(region.connectable, false);
  assert(region.style.width > 500); assert(region.style.height > 200);
  assert.equal(review.data.loopMembership[0].round, 2);
  assert.equal(review.data.loopMembership[0].max_rounds, 4);
  assert.deepEqual(workflow, before);
});
test('canvas reports malformed loop region references instead of crashing during rendering', () => {
  const base = { nodes: [{ id: 'review', type: 'agent' }], edges: [] };
  assert(canvasIssues({ ...base, loops: {} }).length > 0);
  const workflow = { ...base, loops: [{ id: 'bad', node_ids: ['missing'] }] };
  assert(canvasIssues(workflow).length > 0);
  assert.throws(() => toCanvas(workflow));
});
test('loop rename rewrites only exact loop JSON Pointer tokens in binding and expression fields', () => {
  const workflow = {
    nodes: [{ id: 'worker', type: 'agent', input_bindings: {
      direct: '/loops/repair-loop/review_items/0',
      selected: { path: '/loops/repair-loop/feedback/findings', coalesce: ['/inputs/fallback', '/loops/repair-loop/all_accepted'], zip: '/loops/repair-loop/repair_items' },
      literal: { path: '/inputs/value', default: '/loops/repair-loop/all_accepted' },
    }, cases: [{ when: { op: 'and', args: [{ path: '/loops/repair-loop/round' }, { op: 'not', args: [{ path: '/loops/repair-loop/all_accepted' }] }, { value: { path: '/loops/repair-loop/all_accepted' } }] } }],
    prompt_template: 'Keep this prose: /loops/repair-loop/all_accepted and /loops/repair-loop-extra/all_accepted.' }],
    loops: [{ id: 'repair-loop', node_ids: ['worker'], until: { op: 'eq', args: [{ path: '/loops/repair-loop/all_accepted' }, { value: true }] },
      feedback_bindings: { prior: '/loops/repair-loop/review_items' }, item_scope: { items: '/loops/repair-loop/repair_items', verdicts: { path: '/loops/repair-loop/feedback/findings' }, paths_field: 'files' } },
    { id: 'repair-loop-extra', node_ids: ['worker'], until: { op: 'eq', args: [{ value: true }, { value: true }] } }],
    output_bindings: { accepted: '/loops/repair-loop/all_accepted', nested: '/loops/repair-loop-extra/all_accepted' },
  };
  const before = structuredClone(workflow);
  const renamed = renameLoopId(workflow, 'repair-loop', 'review-loop');
  assert.equal(renamed.nodes[0].input_bindings.direct, '/loops/review-loop/review_items/0');
  assert.deepEqual(renamed.nodes[0].input_bindings.selected, { path: '/loops/review-loop/feedback/findings', coalesce: ['/inputs/fallback', '/loops/review-loop/all_accepted'], zip: '/loops/review-loop/repair_items' });
  assert.equal(renamed.nodes[0].input_bindings.literal.default, '/loops/repair-loop/all_accepted');
  assert.deepEqual(renamed.nodes[0].cases[0].when.args, [{ path: '/loops/review-loop/round' }, { op: 'not', args: [{ path: '/loops/review-loop/all_accepted' }] }, { value: { path: '/loops/repair-loop/all_accepted' } }]);
  assert.equal(renamed.nodes[0].prompt_template, before.nodes[0].prompt_template);
  assert.equal(renamed.loops[0].feedback_bindings.prior, '/loops/review-loop/review_items');
  assert.equal(renamed.loops[0].item_scope.items, '/loops/review-loop/repair_items');
  assert.equal(renamed.loops[0].item_scope.verdicts.path, '/loops/review-loop/feedback/findings');
  assert.equal(renamed.loops[1].id, 'repair-loop-extra');
  assert.equal(renamed.output_bindings.accepted, '/loops/review-loop/all_accepted');
  assert.equal(renamed.output_bindings.nested, '/loops/repair-loop-extra/all_accepted');
  assert.deepEqual(workflow, before);
});
test('renaming a compiled item repair loop leaves every Workflow binding valid', () => {
  const workflow = { ...createDraft('loop-rename', 'Loop rename fixture'), status: 'ready',
    skill_policy: { mode: 'cooperative', implicit: 'allow', ambient_allow: [], shadowed_skill_paths: [] },
    finalization: { required: true, node_id: 'final' }, requirements: { providers: ['implementer', 'reviewer'], tools: [], mcp_servers: [], executables: [] },
    inputs_schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['files', 'dependencies'], properties: { files: { type: 'array', items: { type: 'string' } }, dependencies: { type: 'array', items: { type: 'string' } } } } } } } };
  const route = { id: 'route', type: 'condition', cases: [{ label: 'repair', when: { op: 'ne', args: [{ path: '/loops/repair-loop/repair_items' }, { value: [] }] } }], default_label: 'review' };
  const repair = { ...agent('repair'), role: 'implementer', executor: { kind: 'provider', provider_id: 'implementer' }, access: 'bounded_write', path_scope: { binding: 'run.allowed_paths' }, input_bindings: { items: '/loops/repair-loop/repair_items' } };
  const verdicts = { type: 'array', minItems: 1, items: { type: 'object', required: ['accepted', 'findings'], additionalProperties: false, properties: { accepted: { type: 'boolean' }, findings: { type: 'string' } } } };
  const review = { ...agent('review'), role: 'reviewer', executor: { kind: 'provider', provider_id: 'reviewer' }, input_bindings: { items: '/loops/repair-loop/review_items' }, outputs_schema: { type: 'object', required: ['verdicts'], additionalProperties: false, properties: { verdicts } } };
  const final = { ...agent('final'), role: 'finalizer', input_bindings: { feedback: '/loops/repair-loop/feedback/findings', sibling: '/loops/repair-loop-extra/all_accepted' } };
  workflow.nodes = [{ id: 'start', type: 'start' }, route, repair, review, final, { id: 'end', type: 'end' }];
  workflow.edges = [edge('start', 'route'), edge('route', 'repair', 'repair'), edge('route', 'review', 'review'), edge('repair', 'review'), edge('review', 'final'), edge('final', 'end')];
  workflow.loops = [
    { id: 'repair-loop', entry_node: 'route', exit_node: 'review', node_ids: ['route', 'repair', 'review'], max_rounds: 4,
      until: { op: 'eq', args: [{ path: '/loops/repair-loop/all_accepted' }, { value: true }] },
      feedback_bindings: { findings: '/nodes/review/output/verdicts' },
      item_scope: { items: '/inputs/items', verdicts: '/nodes/review/output/verdicts', paths_field: 'files', dependencies_field: 'dependencies' } },
    { id: 'repair-loop-extra', entry_node: 'review', exit_node: 'review', node_ids: ['review'], max_rounds: 1, until: { op: 'eq', args: [{ value: true }, { value: true }] } },
  ];
  const context = { providers: [
    { id: 'implementer', kind: 'openai_compatible', enabled: true, capabilities: { read: true, write: true }, config: { role: 'implementer' } },
    { id: 'reviewer', kind: 'openai_compatible', enabled: true, capabilities: { read: true, write: true }, config: { role: 'reviewer' } },
  ] };
  const original = validateWorkflowGraph(workflow, context);
  assert.equal(original.valid, true, JSON.stringify(original.errors));
  const renamed = renameLoopId(workflow, 'repair-loop', 'review-loop');
  assert.equal(renamed.loops[0].id, 'review-loop');
  const validation = validateWorkflowGraph(renamed, context);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(renamed.nodes.find(node => node.id === 'route').cases[0].when.args[0].path, '/loops/review-loop/repair_items');
  assert.equal(renamed.nodes.find(node => node.id === 'final').input_bindings.feedback, '/loops/review-loop/feedback/findings');
  assert.equal(renamed.nodes.find(node => node.id === 'final').input_bindings.sibling, '/loops/repair-loop-extra/all_accepted');
  assert.equal(renamed.loops[1].id, 'repair-loop-extra');
});
