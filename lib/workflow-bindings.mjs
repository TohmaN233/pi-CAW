import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { packDirectory, noSymlinks, requireValue, ensureDirectory } from '../core/workflow-paths.mjs';
import { syncDirectory } from '../core/workflow-store.mjs';
import { coreProvider, resolveBinding } from './models.mjs';
import { workflowProviderIds, emptyWorkflowBindings } from '../core/workflow-provider-bindings.mjs';
export { workflowProviderIds, emptyWorkflowBindings } from '../core/workflow-provider-bindings.mjs';

function validateDocument(value, pack) {
  requireValue(value && value.schema_version === 1 && value.workflow_id === pack.workflow.id
    && /^[a-f0-9]{64}$/.test(value.workflow_revision)
    && Object.keys(value).every(key => ['schema_version', 'workflow_id', 'workflow_revision', 'providers'].includes(key))
    && value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers),
  'PI_WORKFLOW_BINDINGS', 'Invalid local Workflow model bindings');
  requireValue(Object.keys(value.providers).length <= 512, 'PI_WORKFLOW_BINDINGS', 'Too many local Provider bindings');
  for (const [id, binding] of Object.entries(value.providers)) {
    requireValue(typeof id === 'string' && id.length > 0 && id.length <= 128 && (binding === null || binding
      && Object.keys(binding).every(key => ['provider', 'model_id', 'thinking', 'fingerprint'].includes(key))
      && ['provider', 'model_id', 'thinking'].every(key => typeof binding[key] === 'string' && binding[key])
      && (binding.fingerprint === undefined || /^[a-f0-9]{64}$/.test(binding.fingerprint))),
    'PI_WORKFLOW_BINDINGS', 'Each local slot needs an explicit Pi binding or null');
  }
  if (value.workflow_revision === pack.revision_hash) requireValue(canonicalJSON(Object.keys(value.providers).sort())
    === canonicalJSON(workflowProviderIds(pack.workflow)), 'PI_WORKFLOW_BINDINGS', 'Local slots differ from the exact Workflow revision');
  return value;
}

export class WorkflowBindings {
  constructor(store) { this.store = store; }
  path(pack) { return this.store.installationRecordPath(pack.workflow.id, pack.revision_hash, 'local-bindings'); }
  async read(pack) {
    const retained = await this.store.installationRecord(pack.workflow.id, pack.revision_hash, 'local-bindings');
    const document = retained ? validateDocument(retained.record, pack) : null;
    requireValue(!retained?.revision_specific || document.workflow_revision === pack.revision_hash,
      'PI_WORKFLOW_BINDINGS', 'Revision-specific bindings belong to a different Workflow revision');
    const previousLocal = !retained && await this.store.hasLocalBindingScope(pack.workflow.id);
    const stale = previousLocal || document !== null && document.workflow_revision !== pack.revision_hash;
    return { local: document !== null || previousLocal, stale, bindings: !document || stale ? emptyWorkflowBindings(pack) : document,
      revision: digest(canonicalJSON(document)) };
  }
  async save(pack, providers, expectedRevision, catalog) {
    const next = validateDocument({ ...emptyWorkflowBindings(pack), providers }, pack);
    for (const [id, binding] of Object.entries(next.providers)) if (binding !== null) next.providers[id] = resolveBinding(binding, catalog);
    return this.store.withWriter(async () => {
      const head = await this.store.metadata(pack.workflow.id);
      requireValue(head.revision_hash === pack.revision_hash, 'REVISION_CONFLICT', 'Workflow changed before model bindings were saved');
      const previous = await this.read(pack);
      requireValue(previous.revision === expectedRevision, 'REVISION_CONFLICT', 'Workflow model bindings changed; refresh before saving');
      const path = await this.store.hasLocalBindingScope(pack.workflow.id) ? this.path(pack)
        : join(packDirectory(this.store.root, pack.workflow.id), 'local-bindings.json');
      const temporary = path + '.' + randomUUID() + '.tmp';
      let failure;
      try {
        await noSymlinks(packDirectory(this.store.root, pack.workflow.id));
        await ensureDirectory(dirname(path));
        try { await noSymlinks(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(canonicalJSON(next)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path); await syncDirectory(dirname(path));
      } catch (error) { failure = error; }
      try { await rm(temporary, { force: true }); } catch (error) {
        throw new AggregateError([...(failure ? [failure] : []), error], 'Workflow binding write or cleanup failed');
      }
      if (failure) throw failure;
      return this.read(pack);
    });
  }
  async resolve(pack, settings, catalog, { requireBound = false } = {}) {
    const local = await this.read(pack), blockers = [], sourceIds = workflowProviderIds(pack.workflow);
    const providers = sourceIds.map(id => {
      const configured = local.local ? { id, name: id, enabled: true, binding: local.bindings.providers[id],
        description: 'Workflow-local Pi model binding', capabilities: { read: true, write: true, background: true } }
        : settings.providers.find(provider => provider.id === id);
      if (!configured) {
        blockers.push({ code: 'PI_MODEL_BINDING_REQUIRED', workflow_id: pack.workflow.id, provider_id: id,
          message: `Choose a Pi model for Workflow slot ${id}` });
        return coreProvider({ id, name: id, enabled: false, binding: null });
      }
      let binding = configured.binding;
      try { binding = resolveBinding(binding, catalog); }
      catch (error) { blockers.push({ code: error.code, message: error.message, workflow_id: pack.workflow.id, provider_id: id }); }
      if (!configured.enabled) blockers.push({ code: 'PI_PROVIDER_DISABLED', message: `Provider ${id} is disabled`, workflow_id: pack.workflow.id, provider_id: id });
      return coreProvider({ ...configured, binding });
    });
    if (local.stale) blockers.unshift({ code: 'PI_WORKFLOW_BINDINGS_STALE', workflow_id: pack.workflow.id,
      message: 'This Workflow revision requires its own model bindings; previous selections were not reused' });
    if (requireBound) requireValue(!blockers.length, blockers[0]?.code ?? 'PI_MODEL_BINDING_REQUIRED',
      blockers[0]?.message ?? 'Workflow model configuration is incomplete', { blockers });
    return { ...local, providers, blockers };
  }
}
