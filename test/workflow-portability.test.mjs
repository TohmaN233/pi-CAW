import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workflow, binding, catalog, settle } from './fixtures.mjs';
import { canonicalJSON, digest, prepareResources, revisionHash } from '../core/workflow-revisions.mjs';
import { exportWorkflowPackage, installWorkflowPackage } from '../core/workflow-package.mjs';

function portable(id, slot = 'native-sol', text = 'Portable source bytes') {
  const graph = workflow(); graph.id = id; graph.requirements.providers = [slot];
  graph.nodes.find(node => node.id === 'work').executor.provider_id = slot;
  const resources = { 'instructions.txt': Buffer.from(text) };
  const snapshot = { workflow: graph, resources: prepareResources(resources).manifest, provenance: {}, import_report: {} };
  const bundle = exportWorkflowPackage({ ...snapshot, revision_hash: revisionHash(snapshot) }, resources);
  const { package_sha256, ...payload } = bundle;
  payload.format = 'codex.workflow.package'; payload.compatibility.plugin = 'codex-agents-workflow';
  return { ...payload, package_sha256: digest(canonicalJSON(payload)) };
}
function revise(bundle, change) {
  change(bundle.snapshot.workflow);
  const { revision_hash, ...snapshot } = bundle.snapshot;
  bundle.snapshot.revision_hash = revisionHash(snapshot);
  bundle.dependencies.tools = [...snapshot.workflow.requirements.tools].sort();
  bundle.dependencies.executables = snapshot.workflow.requirements.executables ?? [];
  const { package_sha256, ...payload } = bundle;
  bundle.package_sha256 = digest(canonicalJSON(payload));
  return bundle;
}
const runArgs = (f, id) => ({ workflow_id: id, workspace: f.workspace, access: 'read_only', inputs: { task: 'Verify portability' } });
async function choose(f, id, selected = binding) {
  const pack = await f.service.call('read', { workflow_id: id });
  return f.service.call('save_workflow_bindings', { workflow_id: id, workflow_revision: pack.revision_hash,
    expected_revision: pack.model_bindings.revision,
    providers: Object.fromEntries(Object.keys(pack.model_bindings.bindings.providers).map(slot => [slot, selected])) }, { human: true });
}

async function legacyRecords(f, bundle) {
  const directory = join(f.service.store.root, `wf-${bundle.package.id}.pack`);
  const records = join(directory, 'installations', bundle.snapshot.revision_hash);
  for (const name of ['source-package', 'installation', 'local-bindings']) await rename(join(records, `${name}.json`), join(directory, `${name}.json`));
  await rm(records, { recursive: true });
  const head = JSON.parse(await readFile(join(directory, 'workflow.json'), 'utf8'));
  delete head.workflow_local_bindings; await writeFile(join(directory, 'workflow.json'), canonicalJSON(head));
}

async function packFiles(directory, prefix = '') {
  const result = {};
  for (const name of await readdir(directory)) {
    const path = join(directory, name), relative = prefix + name;
    if ((await lstat(path)).isDirectory()) Object.assign(result, await packFiles(path, relative + '/'));
    else result[relative] = await readFile(path, 'utf8');
  }
  return result;
}

test('foreign Ready imports retain source identity, stay unbound, and exclude incomplete setup from routing', async t => {
  const f = await fixture(t), bundle = portable('foreign-ready'), before = await f.service.call('settings');
  const installed = await f.service.call('install_workflow_package', { package: bundle }, { human: true });
  assert.equal(installed.workflow.status, 'ready'); assert.equal(installed.revision_hash, bundle.snapshot.revision_hash);
  assert.equal(installed.validation.valid, true); assert.equal(installed.validation.launch_ready, false);
  assert.deepEqual(installed.model_bindings.bindings.providers, { 'native-sol': null });
  assert.ok(installed.validation.blockers.some(item => item.code === 'PI_MODEL_BINDING_REQUIRED'));
  assert.deepEqual(await f.service.call('export_workflow_package', { workflow_id: 'foreign-ready' }), bundle);
  assert.deepEqual(await f.service.call('settings'), before);
  assert.equal(JSON.stringify(await f.service.call('route', { task: 'Pi fixture' })).includes('foreign-ready'), false);
  await assert.rejects(f.service.call('run', runArgs(f, 'foreign-ready')), { code: 'PI_MODEL_BINDING_REQUIRED' });
  assert.equal(f.requests.length, 0); assert.equal((await f.service.call('runs')).length, 0);
  const selected = await choose(f, 'foreign-ready');
  assert.equal(selected.blockers.length, 0);
  assert.equal((await f.service.call('read', { workflow_id: 'foreign-ready' })).validation.launch_ready, true);
  const started = await f.service.call('run', runArgs(f, 'foreign-ready')); await settle(f.service, started.run_id);
  assert.equal(f.requests[0].binding.provider, binding.provider);
  const record = await f.service.runtime.runs.read(started.run_id);
  assert.equal(record.pins.workflow_providers['foreign-ready'][0].id, 'native-sol');
  assert.equal(record.pins.workflow_providers['foreign-ready'][0].config.model_id, binding.model_id);
  assert.equal(record.pins.workflow_binding_revisions['foreign-ready'].bindings_revision, selected.revision);
  assert.deepEqual(await f.service.call('export_workflow_package', { workflow_id: 'foreign-ready' }), bundle);
});

test('identical foreign slot IDs stay local to each Workflow and historical Run pins stay unchanged', async t => {
  const alternate = { provider: 'fixture', model_id: 'reviewer', thinking: 'off' };
  const f = await fixture(t, { models: [...catalog, { ...alternate, name: 'Other model', thinking_levels: ['off'], fingerprint: 'b'.repeat(64) }] });
  for (const id of ['portable-a', 'portable-b']) await f.service.call('install_workflow_package', { package: portable(id) }, { human: true });
  await choose(f, 'portable-a'); await choose(f, 'portable-b', alternate);
  const first = await f.service.call('run', runArgs(f, 'portable-a')); await settle(f.service, first.run_id);
  const second = await f.service.call('run', runArgs(f, 'portable-b')); await settle(f.service, second.run_id);
  assert.deepEqual(f.requests.map(item => item.binding.model_id), ['worker', 'reviewer']);
  const pinned = (await f.service.runtime.runs.read(first.run_id)).pins;
  await choose(f, 'portable-a', alternate);
  assert.deepEqual((await f.service.runtime.runs.read(first.run_id)).pins, pinned);
  assert.equal((await f.service.call('settings')).settings.providers.length, 1);
});

test('binding writes require human exact CAS, and changed graph revisions cannot reuse prior choices', async t => {
  const f = await fixture(t), bundle = portable('binding-cas');
  const installed = await f.service.call('install', { package: bundle }, { human: true });
  const args = { workflow_id: 'binding-cas', workflow_revision: installed.revision_hash,
    expected_revision: installed.model_bindings.revision, providers: { 'native-sol': binding } };
  await assert.rejects(f.service.call('save_workflow_bindings', args), { code: 'HUMAN_CONFIGURATION_REQUIRED' });
  await f.service.call('save_workflow_bindings', args, { human: true });
  await assert.rejects(f.service.call('save_workflow_bindings', args, { human: true }), { code: 'REVISION_CONFLICT' });
  const changed = await f.service.call('save', { workflow_id: 'binding-cas', expected_revision: installed.revision_hash,
    workflow: { ...installed.workflow, name: 'Edited source' } });
  const local = await f.service.call('workflow_bindings', { workflow_id: 'binding-cas' });
  assert.equal(local.stale, true); assert.deepEqual(local.bindings.providers, { 'native-sol': null });
  await assert.rejects(f.service.call('run', runArgs(f, 'binding-cas')), { code: 'PI_WORKFLOW_BINDINGS_STALE' });
  await assert.rejects(f.service.call('save_workflow_bindings', args, { human: true }), { code: 'REVISION_CONFLICT' });
  await choose(f, 'binding-cas');
  assert.equal((await f.service.call('read', { workflow_id: 'binding-cas' })).validation.launch_ready, true);
  assert.notEqual(changed.revision_hash, bundle.snapshot.revision_hash);
  assert.equal((await f.service.call('export_workflow_package', { workflow_id: 'binding-cas' })).format, 'pi-caw.workflow.package');
});

test('core package installer preserves the source and starts empty even when global slot IDs match', async t => {
  const f = await fixture(t), bundle = portable('core-import', 'worker');
  await installWorkflowPackage(f.service.store, bundle);
  const view = await f.service.call('read', { workflow_id: 'core-import' });
  assert.equal(view.validation.launch_ready, false); assert.equal(view.model_bindings.bindings.providers.worker, null);
  await legacyRecords(f, bundle);
  const sourceFile = join(f.service.store.root, 'wf-core-import.pack', 'source-package.json');
  assert.deepEqual(JSON.parse(await readFile(sourceFile, 'utf8')), bundle);
  const corrupt = structuredClone(bundle); corrupt.objects[0].content_base64 = Buffer.from('tampered').toString('base64');
  await writeFile(sourceFile, canonicalJSON(corrupt));
  await assert.rejects(f.service.call('export_workflow_package', { workflow_id: 'core-import' }), { code: 'WORKFLOW_PACKAGE_INTEGRITY' });
});

test('package updates atomically select the exact source revision and preserve history, bindings and Run pins', async t => {
  const f = await fixture(t), id = 'portable-update', original = portable(id);
  const first = await f.service.call('install_workflow_package', { package: original }, { human: true });
  await choose(f, id);
  const oldBindings = await f.service.call('workflow_bindings', { workflow_id: id });
  const started = await f.service.call('run', runArgs(f, id)); await settle(f.service, started.run_id);
  const pins = (await f.service.runtime.runs.read(started.run_id)).pins;
  const settings = await f.service.call('settings');
  const directory = join(f.service.store.root, `wf-${id}.pack`), before = await packFiles(directory);
  const latest = revise(portable(id, 'native-sol', 'New immutable source bytes'), graph => { graph.name = 'Updated source'; graph.revision++; });
  const updated = await f.service.call('install_workflow_package', { package: latest, expected_revision: first.revision_hash }, { human: true });
  assert.equal(updated.revision_hash, latest.snapshot.revision_hash);
  assert.deepEqual(updated.workflow, latest.snapshot.workflow);
  assert.equal(updated.installation.package_sha256, latest.package_sha256);
  assert.deepEqual(updated.model_bindings.bindings.providers, { 'native-sol': null });
  assert.equal(updated.model_bindings.stale, false);
  assert.equal(updated.validation.launch_ready, false);
  assert.deepEqual(await f.service.call('settings'), settings);
  assert.deepEqual((await f.service.runtime.runs.read(started.run_id)).pins, pins);
  const after = await packFiles(directory);
  for (const [path, bytes] of Object.entries(before)) if (path !== 'workflow.json') assert.equal(after[path], bytes, path);
  assert.deepEqual(new Set((await f.service.store.revisions(id)).map(item => item.revision_hash)), new Set([original.snapshot.revision_hash, latest.snapshot.revision_hash]));
  assert.deepEqual(await f.service.call('export_workflow_package', { workflow_id: id, revision_hash: original.snapshot.revision_hash }), original);
  assert.deepEqual(await f.service.call('export_workflow_package', { workflow_id: id }), latest);
  assert.equal((await f.service.call('read', { workflow_id: id, revision_hash: original.snapshot.revision_hash })).installation.package_sha256, original.package_sha256);
  assert.deepEqual(await f.service.call('workflow_bindings', { workflow_id: id, revision_hash: original.snapshot.revision_hash }), oldBindings);
  await assert.rejects(f.service.call('run', runArgs(f, id)), { code: 'PI_MODEL_BINDING_REQUIRED' });
  assert.equal(f.requests.length, 1);
  await choose(f, id);
  const selected = await f.service.call('workflow_bindings', { workflow_id: id }), committed = await packFiles(directory);
  await assert.rejects(installWorkflowPackage(f.service.store, latest, { expected_revision: latest.snapshot.revision_hash }), { code: 'WORKFLOW_PACKAGE_REVISION_EXISTS' });
  await assert.rejects(f.service.call('install_workflow_package', { package: latest }, { human: true }), { code: 'WORKFLOW_EXISTS' });
  assert.deepEqual(await f.service.call('workflow_bindings', { workflow_id: id }), selected);
  assert.deepEqual(await packFiles(directory), committed);
});

test('legacy root installation records remain exact after a package update', async t => {
  const f = await fixture(t), id = 'legacy-update', original = portable(id, 'worker');
  const installed = await installWorkflowPackage(f.service.store, original); await legacyRecords(f, original); await choose(f, id);
  const oldView = await f.service.call('read', { workflow_id: id });
  const latest = revise(portable(id, 'worker'), graph => { graph.name = 'New legacy source'; graph.revision++; });
  await installWorkflowPackage(f.service.store, latest, { expected_revision: installed.revision_hash });
  assert.deepEqual((await f.service.call('workflow_bindings', { workflow_id: id })).bindings.providers, { worker: null });
  await choose(f, id);
  const retained = await f.service.call('read', { workflow_id: id, revision_hash: original.snapshot.revision_hash });
  assert.deepEqual(retained.model_bindings, oldView.model_bindings);
  assert.deepEqual(retained.validation, oldView.validation);
  assert.deepEqual(retained.installation, oldView.installation);
  assert.deepEqual(await f.service.call('export_workflow_package', { workflow_id: id, revision_hash: original.snapshot.revision_hash }), original);
  assert.deepEqual(await f.service.call('export_workflow_package', { workflow_id: id }), latest);
});

test('package update rejects stale CAS, corrupt source envelopes and corrupt objects before committing effects', async t => {
  const f = await fixture(t), id = 'update-integrity', original = portable(id);
  const installed = await installWorkflowPackage(f.service.store, original); await choose(f, id);
  const latest = revise(portable(id), graph => { graph.name = 'Next source'; graph.revision++; });
  const directory = join(f.service.store.root, `wf-${id}.pack`), unchanged = await packFiles(directory);
  await assert.rejects(installWorkflowPackage(f.service.store, latest, { expected_revision: 'f'.repeat(64) }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(installWorkflowPackage(f.service.store, latest, { expected_revision: null }), { code: 'INVALID_REVISION' });
  const corrupt = structuredClone(latest); corrupt.package_sha256 = 'a'.repeat(64);
  await assert.rejects(installWorkflowPackage(f.service.store, corrupt, { expected_revision: installed.revision_hash }), { code: 'WORKFLOW_PACKAGE_INTEGRITY' });
  assert.deepEqual(await packFiles(directory), unchanged);
  const source = f.service.store.installationRecordPath(id, installed.revision_hash, 'source-package');
  const originalBytes = await readFile(source); await writeFile(source, canonicalJSON(corrupt));
  const badSource = await packFiles(directory);
  await assert.rejects(installWorkflowPackage(f.service.store, latest, { expected_revision: installed.revision_hash }), { code: 'WORKFLOW_PACKAGE_INTEGRITY' });
  assert.deepEqual(await packFiles(directory), badSource); await writeFile(source, originalBytes);
  await writeFile(join(directory, 'objects', original.objects[0].sha256), 'Corrupted stored object');
  const badObject = await packFiles(directory);
  await assert.rejects(installWorkflowPackage(f.service.store, latest, { expected_revision: installed.revision_hash }), { code: 'RESOURCE_CORRUPT' });
  assert.deepEqual(await packFiles(directory), badObject);
  assert.equal(f.requests.length, 0); assert.equal((await f.service.call('runs')).length, 0);
});

test('interrupted staging leaves the previous head and binding scope usable and rejects blind retries', async t => {
  const f = await fixture(t), id = 'interrupted-import';
  const graph = workflow(); graph.id = id;
  const original = await f.service.call('create_workflow', { workflow: graph });
  const directory = join(f.service.store.root, `wf-${id}.pack`), head = await readFile(join(directory, 'workflow.json'));
  const oldView = await f.service.call('read', { workflow_id: id });
  const latest = revise(portable(id, 'worker'), graph => { graph.name = 'New portable source'; graph.revision++; });
  const persist = f.service.store.persistSnapshot;
  f.service.store.persistSnapshot = async (...args) => {
    await persist.apply(f.service.store, args);
    throw Object.assign(new Error('Fictional interruption after staging records, objects and revision'), { code: 'TEST_INTERRUPTION' });
  };
  try { await assert.rejects(installWorkflowPackage(f.service.store, latest, { expected_revision: original.revision_hash }), { code: 'TEST_INTERRUPTION' }); }
  finally { f.service.store.persistSnapshot = persist; }
  assert.deepEqual(await readFile(join(directory, 'workflow.json')), head);
  assert.deepEqual(await f.service.call('read', { workflow_id: id }), oldView);
  assert.equal(oldView.model_bindings.local, false); assert.equal(oldView.validation.launch_ready, true);
  await assert.rejects(installWorkflowPackage(f.service.store, latest, { expected_revision: original.revision_hash }), { code: 'WORKFLOW_PACKAGE_REVISION_EXISTS' });
  assert.deepEqual(await readFile(join(directory, 'workflow.json')), head);
  const started = await f.service.call('run', runArgs(f, id)); await settle(f.service, started.run_id);
  assert.equal(f.requests.length, 1);
});

test('concurrent package updates permit exactly one writer with the original head CAS', async t => {
  const f = await fixture(t), id = 'concurrent-package-update', original = portable(id);
  const installed = await installWorkflowPackage(f.service.store, original);
  const candidates = ['First new source', 'Second new source'].map(name => revise(portable(id), graph => { graph.name = name; graph.revision++; }));
  const results = await Promise.allSettled(candidates.map(bundle => installWorkflowPackage(f.service.store, bundle, { expected_revision: installed.revision_hash })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const winner = candidates[results.findIndex(result => result.status === 'fulfilled')];
  assert.deepEqual(await f.service.call('export_workflow_package', { workflow_id: id }), winner);
  assert.equal((await f.service.store.revisions(id)).length, 2);
  const retained = await readdir(join(f.service.store.root, `wf-${id}.pack`, 'installations'));
  assert.deepEqual(new Set(retained), new Set([original.snapshot.revision_hash, winner.snapshot.revision_hash]));
});

test('Workbench install responses retain the committed revision when a later update wins before response inspection', async t => {
  const f = await fixture(t), id = 'package-response-race', first = portable(id);
  const later = revise(portable(id), graph => { graph.name = 'Later source'; graph.revision++; });
  const originalCall = f.service.workbench.call.bind(f.service.workbench);
  let intercepted = false;
  f.service.workbench.call = async (operation, args, options) => {
    if (!intercepted && operation === 'read' && args.workflow_id === id) {
      intercepted = true;
      assert.equal(args.revision_hash, first.snapshot.revision_hash);
      await installWorkflowPackage(f.service.store, later, { expected_revision: first.snapshot.revision_hash });
    }
    return originalCall(operation, args, options);
  };
  const installed = await f.service.call('install_workflow_package', { package: first }, { human: true });
  assert.equal(installed.revision_hash, first.snapshot.revision_hash);
  assert.deepEqual(installed.workflow, first.snapshot.workflow);
  assert.equal((await f.service.store.metadata(id)).revision_hash, later.snapshot.revision_hash);
  assert.equal(installed.installation.package_sha256, first.package_sha256);
});

test('metadata reads do not scan objects while full reads verify each unique object once', async t => {
  const f = await fixture(t); await f.service.call('create_workflow', { workflow: workflow(), resources: { 'a.txt': 'same', 'b.txt': 'same' } });
  const observed = await f.service.store.snapshotWithResources('example');
  assert.equal(observed.resource_scan.resource_count, 2); assert.equal(observed.resource_scan.object_read_count, 1);
  await writeFile(join(f.service.store.root, 'wf-example.pack', 'objects', digest('same')), 'bad!');
  assert.equal((await f.service.store.metadata('example')).workflow.id, 'example');
  await assert.rejects(f.service.store.snapshot('example'), { code: 'RESOURCE_CORRUPT' });
});

test('unavailable tool requirements block local routing and foreign Role launch before task effects', async t => {
  const f = await fixture(t);
  for (const kind of ['workflow', 'role']) {
    const id = `unavailable-${kind}`;
    const bundle = revise(portable(id), graph => { graph.template_kind = kind; graph.requirements.tools = ['foreign.tool.missing']; });
    await f.service.call('install_workflow_package', { package: bundle }, { human: true });
    await choose(f, id);
    const view = await f.service.call('read', { workflow_id: id });
    assert.equal(view.validation.launch_ready, false);
    assert.ok(view.validation.blockers.some(item => item.code === 'REQUIREMENT_UNAVAILABLE'));
    if (kind === 'role') await assert.rejects(f.service.call('launch_role', { role_id: id, task: 'Inspect', workspace: f.workspace }), { code: 'PI_ROLE_LAUNCH_BLOCKED' });
    else {
      assert.equal(JSON.stringify(await f.service.call('route', { task: 'Pi fixture' })).includes(id), false);
      await assert.rejects(f.service.call('run', runArgs(f, id)), { code: 'WORKFLOW_LAUNCH_BLOCKED' });
    }
  }
  assert.equal(f.requests.length, 0); assert.equal((await f.service.call('runs')).length, 0);
});

test('foreign Role node executable dependencies are discovered before creating a task', async t => {
  const f = await fixture(t);
  const bundle = revise(portable('role-executables'), graph => {
    graph.template_kind = 'role';
    graph.nodes.find(node => node.id === 'work').runtime_requirements = { executables: [{ name: 'caw-test-definitely-missing-81729' }] };
  });
  await f.service.call('install_workflow_package', { package: bundle }, { human: true }); await choose(f, 'role-executables');
  await assert.rejects(f.service.call('launch_role', { role_id: 'role-executables', task: 'Inspect', workspace: f.workspace }), { code: 'ENVIRONMENT_SETUP_REQUIRED' });
  assert.equal(f.requests.length, 0);
});
