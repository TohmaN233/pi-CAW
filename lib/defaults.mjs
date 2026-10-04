import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { requireValue } from '../core/workflow-paths.mjs';

export const DEFAULTS_VERSION = 2;
const defaultsRoot = fileURLToPath(new URL('../defaults/', import.meta.url));
function readJson(path) {
  return JSON.parse(readFileSync(join(defaultsRoot, path), 'utf8'));
}

export const DEFAULT_PROVIDER_SLOTS = readJson('providers.json');
export const BUILTIN_ROLE_DEFAULTS = readJson('roles.json');
export const DEFAULT_ROLE_TASK_TYPES = readJson('role-task-types.json');
export const DEFAULT_WORKFLOW_PACKS = readJson('workflows/defaults.json');
export const DEFAULT_ROUTING = readJson('routing.json');

const defaultProviderIds = DEFAULT_PROVIDER_SLOTS.map(item => item.id);
const defaultRoleIds = BUILTIN_ROLE_DEFAULTS.map(item => item.id);
const defaultWorkflowIds = DEFAULT_WORKFLOW_PACKS.map(item => item.workflow.id);

function mergeById(current, defaults) {
  const existing = new Map(current.map(item => [item.id, item]));
  return [...current, ...defaults.filter(item => !existing.has(item.id)).map(item => structuredClone(item))];
}

function installedDefaults(settings) {
  const installed = settings.defaults_installed ?? { provider_ids: [], role_ids: [], workflow_ids: [] };
  return {
    provider_ids: new Set(installed.provider_ids),
    role_ids: new Set(installed.role_ids),
    workflow_ids: new Set(installed.workflow_ids),
  };
}

function mergedRouting(current) {
  if (current.version === 1) {
    return {
      ...structuredClone(DEFAULT_ROUTING),
      ...structuredClone(current),
      routes: { ...structuredClone(DEFAULT_ROUTING.routes), ...structuredClone(current.routes) },
      generation: { ...structuredClone(DEFAULT_ROUTING.generation), ...structuredClone(current.generation) },
    };
  }

  const routeNames = Object.keys(DEFAULT_ROUTING.routes);
  const legacyNames = new Set([...routeNames, 'generation_planner', 'generation_reviewer']);
  const unsupported = Object.keys(current).filter(key => !legacyNames.has(key));
  requireValue(!unsupported.length, 'PI_CAW_ROUTING_MIGRATION',
    `Cannot migrate custom routing keys without losing their meaning: ${unsupported.join(', ')}`);

  const migrated = structuredClone(DEFAULT_ROUTING);
  for (const name of routeNames) {
    if (Object.hasOwn(current, name)) migrated.routes[name].provider_id = current[name] ?? '';
  }
  if (Object.hasOwn(current, 'generation_planner')) {
    requireValue(current.generation_planner !== null, 'PI_CAW_ROUTING_MIGRATION', 'Generation planner slot cannot be null in the current routing contract');
    migrated.generation.planner_provider_id = current.generation_planner;
  }
  if (Object.hasOwn(current, 'generation_reviewer')) {
    requireValue(current.generation_reviewer !== null, 'PI_CAW_ROUTING_MIGRATION', 'Generation reviewer slot cannot be null in the current routing contract');
    migrated.generation.review_provider_id = current.generation_reviewer;
  }
  return migrated;
}

function seededSettings(current) {
  const settings = structuredClone(current.settings);
  // Version 1 accidentally exposed the GPT-only web reviewer as a Pi slot.
  // Withdraw that exact product adapter without rebinding a user's other Roles.
  const retiredProviderId = 'pi-web-review';
  const retiredRoleId = 'builtin-role-hard-path-web-advice';
  const removedProviders = settings.providers.filter(item => item.id === retiredProviderId).map(item => item.id);
  const removedRoles = settings.roles.filter(item => item.id === retiredRoleId).map(item => item.id);
  settings.providers = settings.providers.filter(item => item.id !== retiredProviderId);
  settings.roles = settings.roles.filter(item => item.id !== retiredRoleId);
  const unboundRoles = [];
  for (const role of settings.roles) {
    if (role.provider_id === retiredProviderId) { role.provider_id = null; unboundRoles.push(role.id); }
  }
  if (settings.routing.version === 1) {
    for (const route of Object.values(settings.routing.routes)) {
      if (route.provider_id === retiredProviderId) route.provider_id = '';
    }
    requireValue(!['planner_provider_id', 'review_provider_id'].some(key => settings.routing.generation[key] === retiredProviderId),
      'PI_CAW_RETIRED_GENERATION_PROVIDER', 'Authoring is bound to the retired GPT web reviewer; explicitly configure its Pi planner/reviewer before upgrading');
  } else {
    for (const key of Object.keys(settings.routing)) {
      if (settings.routing[key] === retiredProviderId) settings.routing[key] = null;
    }
  }
  const installed = installedDefaults(settings);
  const pendingProviders = DEFAULT_PROVIDER_SLOTS.filter(item => !installed.provider_ids.has(item.id));
  const pendingRoles = BUILTIN_ROLE_DEFAULTS.filter(item => !installed.role_ids.has(item.id));
  const next = {
    ...settings,
    global: settings.global ?? { enabled: true, console_title: 'pi-CAW', max_prompt_chars: 80000 },
    providers: mergeById(settings.providers, pendingProviders),
    roles: mergeById(settings.roles, pendingRoles),
    routing: mergedRouting(settings.routing),
    defaults_version: DEFAULTS_VERSION,
    defaults_installed: {
      provider_ids: [...new Set([...installed.provider_ids, ...DEFAULT_PROVIDER_SLOTS.map(item => item.id)])].sort(),
      role_ids: [...new Set([...installed.role_ids, ...defaultRoleIds])].sort(),
      workflow_ids: [...new Set([...installed.workflow_ids, ...defaultWorkflowIds])].sort(),
    },
  };
  return { next, removedProviders, removedRoles, unboundRoles,
    pendingWorkflows: DEFAULT_WORKFLOW_PACKS.filter(item => !installed.workflow_ids.has(item.workflow.id)) };
}

function workflowProviderContext(settings) {
  return settings.providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    kind: 'native_agent',
    capabilities: { read: true, write: true, background: true },
    config: { role: 'advisor', agent_type: 'default', ...(provider.binding ?? {}) },
  }));
}

async function installWorkflowSeeds(workflowStore, packs) {
  let installed = 0;
  for (const pack of packs) {
    const id = pack.workflow.id;
    try {
      await workflowStore.snapshot(id);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await workflowStore.create(pack.workflow, {
        resources: pack.resources,
        provenance: pack.provenance,
        import_report: pack.import_report,
      });
      installed++;
    } catch (error) {
      if (error.code !== 'WORKFLOW_EXISTS') throw error;
      // A concurrent initializer won this ID. Confirm its Pack exists before
      // treating the race as complete; all other store errors remain visible.
      await workflowStore.snapshot(id);
    }
  }
  return installed;
}

export async function seedDefaults({ settingsStore, workflowStore }) {
  requireValue(settingsStore && typeof settingsStore.read === 'function' && typeof settingsStore.save === 'function'
    && workflowStore && typeof workflowStore.snapshot === 'function' && typeof workflowStore.create === 'function',
  'PI_CAW_DEFAULTS_DEPENDENCIES', 'Default seeding requires SettingsStore and WorkflowStore');

  const current = await settingsStore.read();
  if ((current.settings.defaults_version ?? 0) >= DEFAULTS_VERSION) {
    return { version: current.settings.defaults_version, already_seeded: true, roles_added: 0, providers_added: 0, workflows_added: 0 };
  }

  const { next, pendingWorkflows, removedProviders, removedRoles, unboundRoles } = seededSettings(current);
  const previousContext = workflowStore.validationContext;
  workflowStore.validationContext = {
    ...(previousContext ?? {}),
    providers: workflowProviderContext(next),
  };
  let workflowsAdded;
  try {
    workflowsAdded = await installWorkflowSeeds(workflowStore, pendingWorkflows);
  } finally {
    workflowStore.validationContext = previousContext;
  }

  const saved = await settingsStore.save(next, current.revision);
  return {
    version: saved.settings.defaults_version,
    already_seeded: false,
    providers_added: next.providers.filter(item => !current.settings.providers.some(prior => prior.id === item.id)).length,
    roles_added: next.roles.filter(item => !current.settings.roles.some(prior => prior.id === item.id)).length,
    providers_removed: removedProviders,
    roles_removed: removedRoles,
    roles_unbound: unboundRoles,
    workflows_added: workflowsAdded,
  };
}
