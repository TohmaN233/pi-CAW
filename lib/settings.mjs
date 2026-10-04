import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { requireValue, noSymlinks } from '../core/workflow-paths.mjs';
import { syncDirectory } from '../core/workflow-store.mjs';

export function resolveStateDirectory(agentDir, env = process.env) {
  const path = env.PI_CAW_DIR ?? join(agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'pi-CAW');
  requireValue(isAbsolute(path), 'PI_CAW_STATE_PATH', 'pi-CAW state directory must be absolute');
  return resolve(path);
}
export function emptySettings() {
  return { schema_version: 1, providers: [], roles: [], routing: {} };
}
export function validateSettings(value) {
  requireValue(value && value.schema_version === 1 && Array.isArray(value.providers) && Array.isArray(value.roles)
    && value.providers.length <= 100 && value.roles.length <= 200, 'PI_CAW_SETTINGS', 'Invalid pi-CAW settings');
  requireValue(Object.keys(value).every(key => ['schema_version', 'providers', 'roles', 'routing', 'global', 'defaults_version', 'defaults_installed'].includes(key)), 'PI_CAW_SETTINGS', 'Unknown settings field');
  if (value.global !== undefined) {
    const global = value.global;
    requireValue(global && Object.keys(global).every(key => ['enabled', 'console_title', 'max_prompt_chars'].includes(key))
      && typeof global.enabled === 'boolean' && typeof global.console_title === 'string' && global.console_title.trim() && global.console_title.length <= 128
      && Number.isInteger(global.max_prompt_chars) && global.max_prompt_chars >= 1000 && global.max_prompt_chars <= 200000,
      'PI_CAW_GLOBAL', 'Global settings need enabled, console title and a bounded prompt limit');
  }
  requireValue(value.defaults_version === undefined || Number.isInteger(value.defaults_version) && value.defaults_version >= 1 && value.defaults_version <= 100,
    'PI_CAW_DEFAULTS_VERSION', 'Invalid installed-defaults version');
  if (value.defaults_installed !== undefined) {
    const installed = value.defaults_installed;
    requireValue(installed && typeof installed === 'object' && !Array.isArray(installed)
      && Object.keys(installed).every(key => ['provider_ids', 'role_ids', 'workflow_ids'].includes(key))
      && ['provider_ids', 'role_ids', 'workflow_ids'].every(key => Array.isArray(installed[key]) && installed[key].length <= 500
        && installed[key].every(id => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))
        && new Set(installed[key]).size === installed[key].length), 'PI_CAW_DEFAULTS_MARKER', 'Invalid installed-defaults ledger');
  }
  const validateBinding = binding => {
    if (binding === null) return;
    requireValue(binding && typeof binding.provider === 'string' && binding.provider && typeof binding.model_id === 'string'
      && binding.model_id && typeof binding.thinking === 'string' && binding.thinking,
    'PI_MODEL_BINDING_REQUIRED', 'A binding must explicitly name provider, model_id and thinking');
    requireValue(Object.keys(binding).every(key => ['provider', 'model_id', 'thinking', 'fingerprint'].includes(key)), 'PI_MODEL_BINDING', 'Unknown model binding field');
  };
  const ids = new Set();
  for (const provider of value.providers) {
    requireValue(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider.id) && !ids.has(provider.id)
      && typeof provider.name === 'string' && provider.name && typeof provider.enabled === 'boolean', 'PI_PROVIDER', 'Invalid or duplicate Pi Provider');
    ids.add(provider.id); validateBinding(provider.binding);
    requireValue(Object.keys(provider).every(key => ['id', 'name', 'enabled', 'binding', 'description', 'requires_user_approval', 'capabilities'].includes(key)), 'PI_PROVIDER', 'Pi owns provider transport and credentials; only bindings and executor fit metadata are stored here');
    requireValue(provider.description === undefined || typeof provider.description === 'string' && provider.description.length <= 4000, 'PI_PROVIDER', 'Provider description must be bounded text');
    requireValue(provider.requires_user_approval === undefined || typeof provider.requires_user_approval === 'boolean', 'PI_PROVIDER', 'Provider approval must be boolean');
    if (provider.capabilities !== undefined) requireValue(provider.capabilities && Object.keys(provider.capabilities).length === 3
      && ['read', 'write', 'background'].every(key => typeof provider.capabilities[key] === 'boolean'), 'PI_PROVIDER', 'Provider capabilities need explicit read, write and background flags');
  }
  const roles = new Set();
  for (const role of value.roles) {
    requireValue(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(role.id) && !roles.has(role.id) && typeof role.name === 'string'
      && typeof role.prompt === 'string' && role.prompt.trim() && role.prompt.length <= 60_000
      && typeof role.enabled === 'boolean' && ['read_only', 'bounded_write'].includes(role.access)
      && (role.provider_id === null || ids.has(role.provider_id)), 'PI_ROLE', 'Role needs a unique ID, explicit access and an existing Provider or an empty binding');
    requireValue(Object.keys(role).every(key => ['id', 'name', 'prompt', 'enabled', 'access', 'provider_id', 'description', 'route', 'tags', 'role_instructions', 'source_metadata'].includes(key)), 'PI_ROLE', 'Unknown Role field');
    requireValue(role.description === undefined || typeof role.description === 'string' && role.description.length <= 8_000,
      'PI_ROLE', 'Role description must be bounded text');
    requireValue(role.route === undefined || ['delegate', 'audit', 'full'].includes(role.route), 'PI_ROLE', 'Unknown Role route');
    requireValue(role.tags === undefined || Array.isArray(role.tags) && role.tags.length <= 32
      && role.tags.every(tag => typeof tag === 'string' && tag.trim() && tag.length <= 128), 'PI_ROLE', 'Role tags must be a bounded list of strings');
    requireValue(role.role_instructions === undefined || typeof role.role_instructions === 'string' && role.role_instructions.length <= 8_000,
      'PI_ROLE', 'Role instructions must be bounded text');
    if (role.source_metadata !== undefined) {
      const source = role.source_metadata;
      requireValue(source && typeof source === 'object' && !Array.isArray(source)
        && Object.keys(source).every(key => ['task_type_id', 'stage_id', 'stage_role', 'source_provider_id', 'requires_user_approval'].includes(key))
        && typeof source.task_type_id === 'string' && source.task_type_id.length <= 128
        && typeof source.stage_id === 'string' && source.stage_id.length <= 128
        && typeof source.stage_role === 'string' && source.stage_role.length <= 64
        && typeof source.source_provider_id === 'string' && source.source_provider_id.length <= 128
        && typeof source.requires_user_approval === 'boolean', 'PI_ROLE_SOURCE_METADATA', 'Invalid source Role metadata');
    }
    roles.add(role.id);
  }
  requireValue(value.routing && typeof value.routing === 'object' && !Array.isArray(value.routing), 'PI_ROUTING', 'Routing must be an object');
  if (value.routing.version === 1) {
    const routing = value.routing;
    const routeNames = ['implementation', 'complex_implementation', 'review', 'planning'];
    requireValue(Object.keys(routing).every(key => ['version', 'instructions', 'selection_mode', 'routes', 'generation'].includes(key))
      && typeof routing.instructions === 'string' && routing.instructions.trim() && routing.instructions.length <= 16_000
      && ['automatic', 'fixed'].includes(routing.selection_mode)
      && routing.routes && typeof routing.routes === 'object' && !Array.isArray(routing.routes)
      && Object.keys(routing.routes).length === routeNames.length && routeNames.every(name => Object.hasOwn(routing.routes, name)),
    'PI_ROUTING', 'Routing requires version 1, instructions, selection mode and four task routes');
    for (const [task, route] of Object.entries(routing.routes)) {
      requireValue(route && typeof route === 'object' && !Array.isArray(route)
        && Object.keys(route).every(key => ['provider_id', 'role'].includes(key))
        && typeof route.provider_id === 'string' && route.provider_id.length <= 128
        && (route.provider_id === '' || ids.has(route.provider_id))
        && typeof route.role === 'string' && route.role.trim() && route.role.length <= 64,
      'PI_ROUTING', `Each ${task} route needs a registered Provider slot and responsibility`);
    }
    const generation = routing.generation;
    requireValue(generation && typeof generation === 'object' && !Array.isArray(generation)
      && Object.keys(generation).every(key => ['planner_provider_id', 'review_provider_id', 'max_rounds'].includes(key))
      && (generation.planner_provider_id === undefined || typeof generation.planner_provider_id === 'string'
        && ids.has(generation.planner_provider_id))
      && typeof generation.review_provider_id === 'string' && ids.has(generation.review_provider_id)
      && Number.isInteger(generation.max_rounds) && generation.max_rounds >= 1 && generation.max_rounds <= 4,
    'PI_ROUTING', 'Generation routing requires registered planner/reviewer slots and a bounded repair count');
  } else {
    requireValue(Object.values(value.routing).every(id => id === null || ids.has(id)), 'PI_ROUTING', 'Legacy routing values must be explicit Provider IDs or empty bindings');
  }
  return structuredClone(value);
}
export class SettingsStore {
  constructor(directory) { this.path = join(directory, 'settings.json'); this.queue = Promise.resolve(); }
  async read() {
    let bytes;
    try { await noSymlinks(this.path); bytes = await readFile(this.path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const settings = emptySettings(); return { settings, revision: digest(canonicalJSON(settings)) }; }
    requireValue(Buffer.byteLength(bytes) <= 512 * 1024, 'PI_CAW_SETTINGS_SIZE', 'Settings exceed the size limit');
    const settings = validateSettings(JSON.parse(bytes));
    return { settings, revision: digest(canonicalJSON(settings)) };
  }
  save(settings, expectedRevision) {
    const next = validateSettings(settings);
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true }); await noSymlinks(dirname(this.path));
      const lockPath = this.path + '.lock';
      const lock = await open(lockPath, 'wx', 0o600);
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      let primary;
      try {
        const current = await this.read();
        requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', 'Settings changed since they were read');
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(canonicalJSON(next)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path); await syncDirectory(dirname(this.path));
      } catch (error) { primary = error; }
      const errors = [];
      for (const cleanup of [() => rm(temporary, { force: true }), () => lock.close(), () => rm(lockPath)]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (primary && errors.length) throw new AggregateError([primary, ...errors], 'Settings write and cleanup failed');
      if (primary) throw primary;
      if (errors.length) throw new AggregateError(errors, 'Settings cleanup failed after commit');
      return this.read();
    });
    this.queue = operation.catch(() => undefined); // Only serialize; each caller receives its own error.
    return operation;
  }
}
