import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { authoringStage, toCanvas } from './graph-adapter.mjs';
import { loadAuthoringPreview } from './authoring-preview-actions.mjs';

test('authoring canvas and inspector describe independent review and human Host publication without changing Main or IR', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-caw-authoring-presentation-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true }); });
  const root = resolve(import.meta.dirname, '..');
  const bundled = await build({ absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'tsx', contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {NodeBinding} from './web-src/canvas'; import {Inspector} from './web-src/inspector'; export const binding=props=>renderToStaticMarkup(<NodeBinding {...props}/>); export const inspector=props=>renderToStaticMarkup(<Inspector {...props}/>);` } });
  const path = join(directory, 'render.cjs'); await writeFile(path, bundled.outputFiles[0].contents);
  const previous = globalThis.window;
  globalThis.window = { location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, navigator: { language: 'en' },
    localStorage: { getItem() { return 'en'; }, setItem() {} }, addEventListener() {} };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const render = createRequire(import.meta.url)(path);
  const defaults = JSON.parse(await readFile(join(root, 'defaults/workflows/defaults.json'), 'utf8'));
  const templates = defaults.map(pack => pack.workflow).filter(workflow => workflow.authoring?.pipeline);
  assert.equal(templates.length, 2);
  for (const workflow of templates) {
    const original = structuredClone(workflow), graph = toCanvas(workflow);
    const review = graph.nodes.find(node => node.id === workflow.finalization.node_id);
    const end = graph.nodes.find(node => node.data.authoringStage?.phase === 'human_publish');
    const providers = [{ id: review.data.definition.authoring_reviewer_provider_id, name: 'Configured Reviewer', config: { model: 'local-review-model', reasoning_effort: 'off' } }];
    const reviewBadge = render.binding({ node: review.data.definition, stage: review.data.authoringStage, providerLabel: 'Configured Reviewer · local-review-model / off' });
    assert.match(reviewBadge, /Independent review · Configured Reviewer · local-review-model/);
    assert.doesNotMatch(reviewBadge, /\bMain\b/);
    assert.match(render.binding({ node: end.data.definition, stage: end.data.authoringStage }), /Human publication · Host/);
    const props = { workflow, providers, change() { assert.fail('Rendering must not change the graph'); }, select() {}, inline() {} };
    const reviewProperties = render.inspector({ ...props, selection: { kind: 'node', id: review.id } });
    assert.match(reviewProperties, /Independent review · Pi child session/);
    assert.match(reviewProperties, /Independent reviewer Provider/);
    assert.match(reviewProperties, /Configured Reviewer · local-review-model \/ off/);
    assert.match(reviewProperties, /Host publishes it to the source Draft/);
    assert.doesNotMatch(reviewProperties, /Main · current Pi conversation/);
    const globalProperties = render.inspector({ ...props, selection: { kind: 'workflow', id: '' } });
    assert.match(globalProperties, /Independent review node/);
    assert.doesNotMatch(globalProperties, /Main finalization node/);
    assert.match(render.inspector({ ...props, selection: { kind: 'node', id: end.id } }), /Human publication · Host/);
    assert.deepEqual(workflow, original);
    assert.equal(review.data.definition.executor.kind, 'main', 'Presentation must preserve the core Host publication boundary');
  }
  const generic = { id: 'generic', name: 'Ordinary workflow', enabled: true, skill_policy: { mode: 'cooperative' },
    finalization: { required: true, node_id: 'final' }, nodes: [{ id: 'final', name: 'Independent authoring review', type: 'agent',
      executor: { kind: 'main' }, role: 'finalizer', prompt_template: 'Review' }], edges: [] };
  const graph = toCanvas(generic);
  assert.equal(authoringStage(generic, 'final'), null, 'A name cannot invent authoring ownership');
  assert.match(render.binding({ node: graph.nodes[0].data.definition, stage: graph.nodes[0].data.authoringStage }), />Main · worker</);
  const props = { workflow: generic, providers: [], change() {}, select() {}, inline() {} };
  assert.match(render.inspector({ ...props, selection: { kind: 'node', id: 'final' } }), /Main worker · isolated session/);
  assert.match(render.inspector({ ...props, selection: { kind: 'workflow', id: '' } }), /Main finalization node/);
});

test('retained preview reads exact source or Run without dispatching, observing, or previewing prompts', async () => {
  const calls = [], pack = { workflow: { id: 'portable-source' }, revision_hash: 'a'.repeat(64) };
  const request = async (operation, args) => { calls.push({ operation, args }); return operation === 'authoring_preview' ? { run_id: args.run_id, read_only: true } : { candidates: [{ run_id: 'existing-run' }], preview: null }; };
  await loadAuthoringPreview(request, { pack });
  await loadAuthoringPreview(request, { pack, selectedRun: 'existing-run' });
  const result = await loadAuthoringPreview(request, { runId: 'existing-run' });
  assert.deepEqual(calls, [
    { operation: 'authoring_discover', args: { workflow_id: 'portable-source', revision_hash: 'a'.repeat(64) } },
    { operation: 'authoring_discover', args: { workflow_id: 'portable-source', revision_hash: 'a'.repeat(64), run_id: 'existing-run' } },
    { operation: 'authoring_preview', args: { run_id: 'existing-run' } },
  ]);
  assert.equal(result.preview.read_only, true);
  await assert.rejects(() => loadAuthoringPreview(request, {}), /exact source Pack or Run/);
});

test('Workflow model configuration retains foreign IDs and shows explicit unbound choices with Main inheritance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-caw-local-bindings-ui-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true }); });
  const root = resolve(import.meta.dirname, '..');
  const bundled = await build({ absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'tsx', contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {WorkflowModels,workflowProviders} from './web-src/workflow-models'; import {BindingPicker} from './web-src/pi-settings'; export {workflowProviders}; export const models=props=>renderToStaticMarkup(<WorkflowModels {...props}/>); export const binding=props=>renderToStaticMarkup(<BindingPicker {...props}/>);` } });
  const path = join(directory, 'render.cjs'); await writeFile(path, bundled.outputFiles[0].contents);
  const previous = globalThis.window;
  globalThis.window = { location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} }, navigator: { language: 'en' },
    localStorage: { getItem() { return 'en'; }, setItem() {} }, addEventListener() {} };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const render = createRequire(import.meta.url)(path);
  const providers = [{ id: 'foreign-review-slot', name: 'Global reviewer', enabled: true, config: { model: 'global-model' } }, { id: 'other-slot', config: { model: 'other-model' } }];
  const descriptor = { local: true, stale: false, revision: 'local-hash', bindings: { providers: { 'foreign-review-slot': null, 'unregistered-planner': { provider: 'pi-catalog', model_id: 'chosen-model', thinking: 'off' } } }, blockers: [] };
  const before = structuredClone({ providers, descriptor });
  const effective = render.workflowProviders(providers, descriptor);
  assert.equal(effective.find(provider => provider.id === 'foreign-review-slot').config.model, undefined, 'Explicit local null must not use a global model');
  assert.equal(effective.find(provider => provider.id === 'unregistered-planner').config.model, 'chosen-model');
  assert.equal(effective.find(provider => provider.id === 'other-slot').config.model, 'other-model');
  assert.equal(render.workflowProviders(providers, { ...descriptor, local: false }).find(provider => provider.id === 'foreign-review-slot').config.model, 'global-model');
  assert.deepEqual({ providers, descriptor }, before);
  const models = [{ provider: 'pi-catalog', model_id: 'available-model', name: 'Available', thinking_levels: ['off'], fingerprint: 'new' }];
  const pack = { workflow: { id: 'portable-source' }, revision_hash: 'source-hash', model_bindings: descriptor };
  const markup = render.models({ pack, models, busy: 0, act() {}, saved() {}, onDirty() {} });
  assert.match(markup, /foreign-review-slot/); assert.match(markup, /unregistered-planner/);
  assert.match(markup, /Main inherits the initiating Pi conversation/);
  assert.match(markup, /<option value="" selected="">Unbound<\/option>/);
  assert.doesNotMatch(markup, /<option value="pi-catalog\/available-model" selected/);
  const drift = render.binding({ models, binding: { provider: 'pi-catalog', model_id: 'available-model', thinking: 'removed-level', fingerprint: 'old' }, change() {} });
  assert.match(drift, /model contract changed/);
  assert.match(drift, /selected thinking level is unavailable/);
});
