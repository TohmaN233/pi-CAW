import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDraft } from '../core/workflow-schema.mjs';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { exportWorkflowPackage } from '../core/workflow-package.mjs';

const root = resolve(import.meta.dirname, '..'), schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const graph = { ...createDraft('review-task', 'Pi independent review'), status: 'ready',
  inputs_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false }, outputs_schema: schema,
  finalization: { required: true, node_id: 'main-summary' },
  nodes: [{ id: 'start', type: 'start' },
    { id: 'review', name: 'Independent Pi child review', type: 'agent', executor: { kind: 'provider', provider_id: 'reviewer' }, role: 'reviewer',
      access: 'read_only', approval: { required: false }, retry: { max_attempts: 2 }, input_bindings: { task: '/inputs/task' }, outputs_schema: schema,
      prompt_template: 'Independently inspect {{task}} in this workspace. Report concrete findings and evidence. Submit only a concise text result.' },
    { id: 'main-summary', name: 'Current Pi chat summary', type: 'agent', executor: { kind: 'main' }, role: 'finalizer',
      access: 'read_only', approval: { required: false }, retry: { max_attempts: 2 }, input_bindings: { task: '/inputs/task', context: '/nodes/review/output/text' },
      outputs_schema: schema, prompt_template: 'In this current Pi chat, evaluate the independent review below and summarize the result for the human. Task: {{task}}\nReview: {{context}}' },
    { id: 'end', type: 'end' }],
  edges: [{ id: 'begin', source: 'start', target: 'review' }, { id: 'reviewed', source: 'review', target: 'main-summary' }, { id: 'finish', source: 'main-summary', target: 'end' }] };
const store = await new WorkflowStore(join(root, '.artifacts', `example-build-${randomUUID()}`), { validationContext: {
  providers: [{ id: 'reviewer', kind: 'native_agent', name: 'Reviewer', enabled: true, capabilities: { read: true }, config: {} }] } }).initialize();
const pack = await store.create(graph);
await mkdir(join(root, 'examples'), { recursive: true });
await writeFile(join(root, 'examples', 'review-task.pi-caw.json'), JSON.stringify(exportWorkflowPackage(pack, {}, { packageVersion: '1.0.0' }), null, 2) + '\n');
console.log('Built examples/review-task.pi-caw.json without a model binding.');
