import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SettingsStore } from '../lib/settings.mjs';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { validateStoredAuthoringWorkflow } from '../core/authoring/authoring-workflows.mjs';
import { coreProvider } from '../lib/models.mjs';
import {
  BUILTIN_ROLE_DEFAULTS,
  DEFAULT_PROVIDER_SLOTS,
  DEFAULT_ROLE_TASK_TYPES,
  DEFAULT_ROUTING,
  DEFAULT_WORKFLOW_PACKS,
  seedDefaults,
} from '../lib/defaults.mjs';

const roleTasks = new Map(DEFAULT_ROLE_TASK_TYPES.map(item => [item.id, item]));

test('shipped defaults preserve upstream Roles and authoring graphs without resurrecting the removed fixed composite', () => {
  const roleTaskTypes = [...roleTasks.values()];
  const expectedRoles = roleTaskTypes.filter(item => item.stages.length === 1);
  assert.equal(roleTaskTypes.length, 7);
  assert.equal(roleTasks.has('implementation-with-review'), false);
  assert.deepEqual(BUILTIN_ROLE_DEFAULTS.map(role => role.source_metadata.task_type_id).sort(),
    expectedRoles.map(item => item.id).sort());

  for (const item of expectedRoles) {
    const role = BUILTIN_ROLE_DEFAULTS.find(candidate => candidate.source_metadata.task_type_id === item.id);
    const stage = item.stages[0];
    assert.equal(role.prompt, stage.template, `${item.id} keeps the complete stage prompt`);
    assert.ok(role.prompt.length > 100, `${item.id} prompt is retained in full`);
    assert.equal(role.name, item.name);
    assert.equal(role.enabled, item.enabled);
    assert.equal(role.access, stage.access);
    assert.equal(role.description, item.description);
    assert.equal(role.role_instructions, item.role_instructions);
    assert.deepEqual(role.tags, item.tags);
    assert.equal(role.route, item.route);
    assert.equal(role.source_metadata.stage_id, stage.id);
    assert.equal(role.source_metadata.stage_role, stage.role);
    assert.equal(role.source_metadata.requires_user_approval, stage.requires_user_approval === true);
    assert.ok(role.provider_id.startsWith('pi-'));
  }

  assert.deepEqual(DEFAULT_PROVIDER_SLOTS.map(provider => provider.id), [
    'pi-worker', 'pi-reviewer', 'pi-specialist', 'pi-cross-review',
  ]);
  assert.ok(DEFAULT_PROVIDER_SLOTS.every(provider => provider.enabled && provider.binding === null));
  assert.ok(DEFAULT_PROVIDER_SLOTS.every(provider => !('model' in provider) && !('thinking' in provider)));
  assert.deepEqual(DEFAULT_ROUTING, {
    version: 1,
    instructions: DEFAULT_ROUTING.instructions,
    selection_mode: 'automatic',
    routes: {
      implementation: { provider_id: 'pi-worker', role: 'implementer' },
      complex_implementation: { provider_id: 'pi-specialist', role: 'implementer' },
      review: { provider_id: 'pi-reviewer', role: 'reviewer' },
      planning: { provider_id: 'pi-specialist', role: 'implementer' },
    },
    generation: { planner_provider_id: 'pi-specialist', review_provider_id: 'pi-reviewer', max_rounds: 4 },
  });

  assert.deepEqual(DEFAULT_WORKFLOW_PACKS.map(pack => pack.workflow.id).sort(), [
    'system.build-workflow', 'system.skill2workflow',
  ]);
  for (const pack of DEFAULT_WORKFLOW_PACKS.filter(item => item.workflow.id.startsWith('system.'))) {
    validateStoredAuthoringWorkflow(pack.workflow, DEFAULT_PROVIDER_SLOTS.map(coreProvider));
    assert.equal(pack.workflow.nodes.length, 7);
    assert.equal(pack.workflow.edges.length, 6);
    assert.equal(pack.workflow.status, 'ready');
    assert.equal(pack.resources && Object.keys(pack.resources).length, 0);
    assert.ok(pack.workflow.nodes.find(node => node.id === 'expand').prompt_template.length > 1000);
    assert.ok(pack.workflow.nodes.find(node => node.id === 'final').prompt_template.length > 1000);
    assert.ok(pack.workflow.nodes.filter(node => node.executor?.provider_id)
      .every(node => node.executor.provider_id.startsWith('pi-')));
  }

  assert.equal(DEFAULT_WORKFLOW_PACKS.some(pack => pack.workflow.id === 'implementation-with-review'), false);
});

test('first seed upgrades empty installations, preserves custom edits and never restores deleted defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-defaults-'));
  t.after(async () => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('Unsafe defaults test cleanup target');
    }
    await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  });
  const settingsStore = new SettingsStore(root);
  const workflowStore = await new WorkflowStore(join(root, 'workflows')).initialize();

  const empty = await settingsStore.read();
  await settingsStore.save({
    ...empty.settings,
    providers: [{ id: 'custom-provider', name: 'Custom Pi model', enabled: true, binding: null }],
    roles: [{ id: 'custom-role', name: 'Custom', prompt: 'Keep this prompt.', enabled: false, access: 'read_only', provider_id: 'custom-provider' }],
    routing: { implementation: 'custom-provider', review: 'custom-provider' },
  }, empty.revision);

  const seeded = await seedDefaults({ settingsStore, workflowStore });
  assert.equal(seeded.already_seeded, false);
  assert.equal(seeded.roles_added, 7);
  assert.equal(seeded.providers_added, 4);
  assert.equal(seeded.workflows_added, 2);
  const firstSettings = await settingsStore.read();
  assert.equal(firstSettings.settings.defaults_version, 2);
  assert.equal(firstSettings.settings.roles.find(role => role.id === 'custom-role').prompt, 'Keep this prompt.');
  assert.equal(firstSettings.settings.roles.find(role => role.id === 'builtin-role-bounded-code-change').prompt,
    BUILTIN_ROLE_DEFAULTS.find(role => role.id === 'builtin-role-bounded-code-change').prompt);
  assert.equal(firstSettings.settings.routing.routes.implementation.provider_id, 'custom-provider');
  assert.equal(firstSettings.settings.routing.routes.review.provider_id, 'custom-provider');
  assert.equal(firstSettings.settings.routing.generation.planner_provider_id, 'pi-specialist');
  assert.deepEqual((await workflowStore.list()).map(pack => pack.workflow.id).sort(),
    ['system.build-workflow', 'system.skill2workflow']);
  workflowStore.validationContext = {
    providers: DEFAULT_PROVIDER_SLOTS.map(provider => ({
      id: provider.id, name: provider.name, enabled: provider.enabled, kind: 'native_agent',
      capabilities: { read: true, write: true, background: true }, config: { role: 'advisor', agent_type: 'default' },
    })),
    host_tools: [],
  };

  const editedRole = firstSettings.settings.roles.find(role => role.id === 'builtin-role-bounded-code-change');
  editedRole.prompt = 'User-authored Role prompt';
  const savedSettings = await settingsStore.save(firstSettings.settings, firstSettings.revision);
  const pack = await workflowStore.snapshot('system.build-workflow');
  await workflowStore.save('system.build-workflow', { ...pack.workflow, name: 'User-edited workflow template' }, { expected_revision: pack.revision_hash });

  const reseed = await seedDefaults({ settingsStore, workflowStore });
  assert.equal(reseed.already_seeded, true);
  const afterReseed = await settingsStore.read();
  assert.equal(afterReseed.settings.roles.find(role => role.id === 'builtin-role-bounded-code-change').prompt, 'User-authored Role prompt');
  assert.equal((await workflowStore.snapshot('system.build-workflow')).workflow.name, 'User-edited workflow template');

  const removed = await workflowStore.snapshot('system.skill2workflow');
  await workflowStore.delete(removed.workflow.id, removed.revision_hash);
  await seedDefaults({ settingsStore, workflowStore });
  await assert.rejects(workflowStore.snapshot('system.skill2workflow'), { code: 'ENOENT' });
  assert.equal((await settingsStore.read()).revision, afterReseed.revision);
  assert.equal(savedSettings.settings.defaults_installed.workflow_ids.length, 2);
});

test('version 1 upgrade removes GPT-only defaults without rebinding portable or custom Roles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-retired-defaults-'));
  t.after(async () => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe retired-defaults cleanup target');
    await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  });
  const settingsStore = new SettingsStore(root);
  const workflowStore = await new WorkflowStore(join(root, 'workflows')).initialize();
  await seedDefaults({ settingsStore, workflowStore });
  const seeded = await settingsStore.read();
  const keptBinding = { provider: 'xai', model_id: 'selected-model', thinking: 'medium' };
  seeded.settings.providers[0].binding = keptBinding;
  seeded.settings.defaults_version = 1;
  seeded.settings.providers.push({ id: 'pi-web-review', name: 'Pi Agent · web-review slot', enabled: true, binding: null });
  seeded.settings.roles.push({ id: 'builtin-role-hard-path-web-advice', name: 'GPT reviewer', prompt: 'Retired GPT path', enabled: false, access: 'read_only', provider_id: 'pi-web-review' },
    { id: 'custom-review', name: 'Custom review', prompt: 'Keep user instructions.', enabled: true, access: 'read_only', provider_id: 'pi-web-review' });
  seeded.settings.defaults_installed.provider_ids.push('pi-web-review');
  seeded.settings.defaults_installed.role_ids.push('builtin-role-hard-path-web-advice');
  await settingsStore.save(seeded.settings, seeded.revision);
  const upgrade = await seedDefaults({ settingsStore, workflowStore });
  assert.deepEqual(upgrade.providers_removed, ['pi-web-review']);
  assert.deepEqual(upgrade.roles_removed, ['builtin-role-hard-path-web-advice']);
  assert.deepEqual(upgrade.roles_unbound, ['custom-review']);
  const after = await settingsStore.read();
  assert.equal(after.settings.defaults_version, 2);
  assert.ok(!after.settings.providers.some(item => item.id === 'pi-web-review'));
  assert.ok(!after.settings.roles.some(item => item.id === 'builtin-role-hard-path-web-advice'));
  assert.deepEqual(after.settings.providers[0].binding, keptBinding);
  const custom = after.settings.roles.find(item => item.id === 'custom-review');
  assert.equal(custom.prompt, 'Keep user instructions.');
  assert.equal(custom.provider_id, null, 'retiring a transport must not silently choose another model');
  assert.equal((await seedDefaults({ settingsStore, workflowStore })).already_seeded, true);
});
