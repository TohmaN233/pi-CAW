import { readFile, lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { requireValue, noSymlinks, insideRoot } from '../core/workflow-paths.mjs';
import { validateWorkflowGraph } from '../core/workflow-validator.mjs';
import { readEditorResource, writeEditorResource, publishEditorWorkflow, setEditorWorkflowEnabled } from '../core/workflow-editor.mjs';
import { templateKind, roleNode } from '../core/template-kind.mjs';
import { routeReadyWorkflows } from '../core/workflow-routing.mjs';
import { SkillInventory } from '../core/skill-import/inventory.mjs';
import { discoverFolderSkills } from '../core/skill-import/folder-inventory.mjs';
import { importCoarseSkill, verifyCoarseRelocation } from '../core/skill-import/coarse-compiler.mjs';
import { WorkflowAuthoringCompiler, compileWorkflowBrief } from '../core/skill-import/workflow-authoring.mjs';
import { inlineSkillReference } from '../core/skill-import/inline-skill.mjs';
import { skillSourceStatus } from '../core/skill-import/source-status.mjs';
import { importReviewPacket, reviewImportedDraft } from '../core/skill-import/review-import.mjs';
import { expansionPacket } from '../core/skill-import/semantic-expander.mjs';
import { validateRoutingRules } from '../core/skill-import/routing-rules.mjs';
import { AUTHORING_WORKFLOWS, validateStoredAuthoringWorkflow } from '../core/authoring/authoring-workflows.mjs';
import { exportWorkflowPackage, validateWorkflowPackage } from '../core/workflow-package.mjs';
import { resolveWorkflowPins } from '../core/workflow-pins.mjs';
import { discoverRuntimeEnvironment, readHostRuntimeRegistry, updateRuntimeCandidate } from '../core/runtime-environment.mjs';
import { PiAuthoring } from './authoring.mjs';
import { coreProvider, resolveBinding } from './models.mjs';
import { renderTemplate } from '../core/templates.mjs';
import { nodePermissions, leaseToken } from '../core/workflow-execution-envelope.mjs';
import { effectiveSkillPolicy } from '../core/workflow-reference-schema.mjs';
import { nodeWorkspace } from '../core/parallel/workspace.mjs';
import { adoptRunTree, controllerAttempt, reattachAttempt, conversationControlRecoveryRequest } from '../core/workflow-recovery.mjs';
import { childIdentity } from '../core/workflow-subworkflow.mjs';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { waitForWorkflow } from '../core/workflow-wait.mjs';
import { projectWorkflowCatalog, requireWorkflowInScope } from './workflow-scope.mjs';

export const WORKBENCH_OPERATIONS = new Set(['read', 'create', 'save', 'publish', 'revisions', 'restore_revision',
  'duplicate', 'rename', 'delete', 'read_resource', 'write_resource', 'role_templates', 'role_template', 'customize_role',
  'route', 'workflow_scope', 'set_mode_workflow_enabled', 'set_workflow_enabled', 'source_status', 'import_review', 'review_import', 'verify_relocation', 'skill_inventory', 'import_skill',
  'inline_skill', 'build_workflow', 'prepare_expansion', 'export_workflow_package', 'install_workflow_package', 'routing_defaults',
  'save_routing_rules', 'authoring_workflows', 'authoring_prompt_preview', 'start_authoring', 'advance_authoring',
  'continue_authoring', 'accept_authoring', 'apply_authoring_result', 'recheck_authoring', 'accept_rechecked_authoring_review', 'purge_authoring_artifacts', 'get', 'run_definition',
  'adopt_run', 'recover_control', 'resume', 'run_main', 'start', 'local_clients', 'runtime_dependencies', 'discover_runtime_dependencies',
  'register_runtime_dependency', 'prepare_environment', 'recheck_runtime_environment', 'generate_task_brief',
  'run_retention', 'cleanup_run_history', 'cache_cleanup_preview', 'cleanup_caches', 'prepare_integration', 'review_integration', 'integrate_parallel', 'cleanup_parallel',
  'node_details', 'events', 'next', 'wait', 'record_usage', 'retry_node', 'collect_subworkflow', 'child_control', 'recover_claim', 'reattach_subworkflow', 'recover_result', 'recover_strict_result', 'reject_final']);

function builtinRoleCustomizationId(pack) {
  if (pack.provenance?.kind !== 'role_customization') return null;
  const id = pack.provenance.builtin_role_id;
  requireValue(typeof id === 'string' && id.startsWith('builtin-role-'), 'ROLE_CUSTOMIZATION_ID', 'Role customization must identify one built-in Role');
  requireValue(templateKind(pack) === 'role', 'ROLE_CUSTOMIZATION_KIND', 'Role customization must remain a Role template');
  return id;
}
function builtinRoleCustomizations(packs) {
  const result = new Map();
  for (const pack of packs) {
    const id = builtinRoleCustomizationId(pack); if (!id) continue;
    requireValue(!result.has(id), 'ROLE_CUSTOMIZATION_DUPLICATE', `Built-in Role ${id} has more than one customization Pack`);
    result.set(id, pack);
  }
  return result;
}
function roleDescriptor(pack, providers) {
  const node = roleNode(pack), provider = providers.find(item => item.id === node.executor?.provider_id);
  return { node, provider, workflow_id: pack.workflow.id, revision_hash: pack.revision_hash, status: pack.workflow.status,
    enabled: pack.workflow.enabled !== false, provider_id: provider?.id ?? node.executor?.provider_id ?? null,
    model: provider?.binding?.model_id ?? null, reasoning_effort: provider?.binding?.thinking ?? null,
    provider_available: !!provider?.enabled && !!provider.binding };
}

// Original packages use the same immutable snapshot/object contracts. Accept
// their envelope only after verifying its original digest, then run the entire
// Pi validator against an equivalent local envelope. Never rewrite snapshot pins.
export function validatePortableWorkflowPackage(bundle) {
  if (bundle?.format !== 'codex.workflow.package') return validateWorkflowPackage(bundle);
  const { package_sha256, ...payload } = bundle;
  requireValue(payload.format_version === 1, 'WORKFLOW_PACKAGE_VERSION', 'Unsupported Workflow package format');
  requireValue(payload.compatibility?.plugin === 'codex-agents-workflow' && payload.compatibility.package_api === 1 && payload.compatibility.workflow_schema === 1,
    'WORKFLOW_PACKAGE_COMPATIBILITY', 'Workflow package is incompatible with this plugin');
  requireValue(/^[a-f0-9]{64}$/.test(package_sha256) && digest(canonicalJSON(payload)) === package_sha256,
    'WORKFLOW_PACKAGE_INTEGRITY', 'Workflow package digest differs');
  const localPayload = { ...payload, format: 'pi-caw.workflow.package', compatibility: { ...payload.compatibility, plugin: 'pi-CAW' } };
  const checked = validateWorkflowPackage({ ...localPayload, package_sha256: digest(canonicalJSON(localPayload)) });
  return { ...checked, package_sha256 };
}

// The original editor operations share the Pi service's revision store and
// execution owner. There is no second Codex configuration or model registry.
export class WorkbenchApi {
  constructor(service) { this.service = service; this.authoring = new PiAuthoring(service); }
  async list() {
    const { store } = this.service;
    const scope=await this.service.workflowScope();
    return projectWorkflowCatalog(await Promise.all((await store.list()).map(async pack => ({ id: pack.workflow.id, name: pack.workflow.name,
      status: pack.workflow.status, enabled: pack.workflow.enabled, revision_hash: pack.revision_hash,
      description: pack.workflow.description, template_kind: templateKind(pack), kind: templateKind(pack),
      system_managed: pack.provenance?.kind === 'bundled_authoring_workflow', role_builtin_id: builtinRoleCustomizationId(pack),
      import_mode: pack.workflow.import_status?.mode ?? null, skill_policy: pack.workflow.skill_policy,
      validation: await this.validation(pack.workflow, await store.resources(pack.workflow.id, pack.revision_hash)) }))),scope);
  }
  async validation(workflow, resources) {
    await this.service.prepareValidation({ ...workflow, status: 'ready' }, resources);
    return validateWorkflowGraph(workflow, this.service.store.validationContext);
  }
  async roles() {
    const { currentSettings, store } = this.service;
    const packs = await store.list(), customizations = builtinRoleCustomizations(packs);
    const configured = currentSettings.roles.map(role => {
      const provider = currentSettings.providers.find(item => item.id === role.provider_id);
      const { prompt, role_instructions, ...metadata } = role;
      const pack = customizations.get(role.id), customization = pack ? roleDescriptor(pack, currentSettings.providers) : null;
      const active = customization?.status === 'ready' ? customization : null;
      return { ...metadata, ...(active ? { name: pack.workflow.name, description: pack.workflow.description, tags: pack.workflow.tags,
        role: active.node.role, access: active.node.access, provider_id: active.provider_id, enabled: active.enabled } : {}),
        builtin: !!role.source_metadata, template_kind: 'role', status: 'ready', default_enabled: role.enabled !== false,
        revision_hash: digest(canonicalJSON(role)), provider_available: !!provider?.enabled && !!provider.binding,
        model: provider?.binding?.model_id ?? null, reasoning_effort: provider?.binding?.thinking ?? null,
        provider_kind: 'native_agent', description: active ? pack.workflow.description : role.description ?? '',
        ...(active ? { revision_hash: active.revision_hash, provider_available: active.provider_available, model: active.model, reasoning_effort: active.reasoning_effort } : {}),
        customized: !!customization, ...(customization ? { customization: { workflow_id: customization.workflow_id,
          revision_hash: customization.revision_hash, status: customization.status, enabled: customization.enabled,
          provider_id: customization.provider_id, model: customization.model, reasoning_effort: customization.reasoning_effort } } : {}) };
    });
    const custom = packs.filter(pack => !builtinRoleCustomizationId(pack) && templateKind(pack) === 'role' && pack.workflow.status === 'ready').map(pack => {
      const node = roleNode(pack), provider = currentSettings.providers.find(item => item.id === node.executor?.provider_id);
      return { id: pack.workflow.id, name: pack.workflow.name, template_kind: 'role', builtin: false,
        status: pack.workflow.status, enabled: pack.workflow.enabled, access: node.access, provider_id: provider?.id ?? null,
        description: pack.workflow.description, revision_hash: pack.revision_hash,
        provider_available: !!provider?.enabled && !!provider.binding, model: provider?.binding?.model_id ?? null,
        reasoning_effort: provider?.binding?.thinking ?? null };
    });
    return [...configured, ...custom];
  }
  async roleProfile(args) {
    requireValue(typeof args.task === 'string' && args.task.trim() && args.task.length <= 30000, 'ROLE_TASK', 'Role task must be nonempty and bounded');
    const service = this.service, roleId = args.role_id ?? args.workflow_id;
    const builtin = service.currentSettings.roles.find(item => item.id === roleId);
    const customization = builtin ? builtinRoleCustomizations(await service.store.list()).get(roleId) : null;
    let profile;
    if (builtin && customization?.workflow.status !== 'ready') profile = { ...builtin, revision_hash: digest(canonicalJSON(builtin)), status: 'ready', requires_user_approval: builtin.source_metadata?.requires_user_approval === true,
      instruction: builtin.role_instructions || builtin.prompt, append_context: !!builtin.role_instructions || !builtin.source_metadata && !/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(builtin.prompt),
      task_type_id: builtin.source_metadata?.task_type_id ?? builtin.id, stage_id: builtin.source_metadata?.stage_id ?? 'role' };
    else {
      const pack = customization?.workflow.status === 'ready' ? customization : await service.store.snapshot(roleId, args.revision_hash), node = roleNode(pack);
      profile = { id: roleId, source_workflow_id: pack.workflow.id, name: pack.workflow.name, status: pack.workflow.status, enabled: pack.workflow.enabled, revision_hash: pack.revision_hash,
        access: node.access, provider_id: node.executor?.provider_id ?? null, requires_user_approval: node.approval?.required === true,
        instruction: builtin?.role_instructions && node.prompt_template === builtin.prompt ? builtin.role_instructions : node.prompt_template,
        append_context: pack.workflow.role_prompt_mode === 'append_context', ...(node.path_scope === undefined ? {} : { path_scope: node.path_scope }),
        task_type_id: pack.workflow.id, stage_id: node.id,
        skill_policy: effectiveSkillPolicy(pack.workflow.skill_policy, node.skill_policy) };
    }
    requireValue(profile.status === 'ready' && profile.enabled !== false, 'ROLE_NOT_READY', 'Role template must be published and enabled');
    requireValue(!args.revision_hash || profile.revision_hash === args.revision_hash, 'ROLE_REVISION', 'Role changed since the selected revision');
    const provider = service.currentSettings.providers.find(item => item.id === profile.provider_id);
    profile.requires_user_approval ||= provider?.requires_user_approval === true;
    const binding = provider?.binding ? resolveBinding(provider.binding, service.host.catalog()) : null;
    const fields = { task: args.task ?? '', context: args.context ?? '(not provided)', constraints: args.constraints ?? '(not provided)',
      verification: args.verification ?? '(not provided)', task_type_id: profile.task_type_id, stage_id: profile.stage_id, provider_name: provider?.name ?? '(unbound)' };
    const instructions = profile.append_context
      ? `${profile.instruction}\n\nTASK\n${fields.task}\n\nCONTEXT\n${fields.context}\n\nCONSTRAINTS AND OWNERSHIP\n${fields.constraints}\n\nVERIFICATION\n${fields.verification}`
      : renderTemplate(profile.instruction, fields);
    requireValue(instructions.length <= 200000, 'ROLE_TASK', 'Compiled Role instructions exceed limit');
    return { ...profile, instructions, binding, approval: { required: profile.requires_user_approval }, provider_available: !!provider?.enabled && !!binding,
      adapter: { execution: 'pi_sdk', agent_type: 'default', model: binding?.model_id ?? null, reasoning_effort: binding?.thinking ?? null } };
  }
  inventory(args) {
    const service = this.service;
    requireValue(!args.folder || isAbsolute(args.folder), 'SKILL_DISCOVERY_FOLDER', 'Skill folder must be absolute');
    const mode = args.discovery ?? (args.folder ? 'folder' : 'host');
    requireValue(['host', 'folder'].includes(mode), 'SKILL_DISCOVERY_MODE', 'Choose actual Host inventory or folder discovery');
    if (mode === 'host') {
      requireValue(typeof service.host.discoverSkills === 'function', 'SKILL_DISCOVERY_UNAVAILABLE', 'Actual Pi Skill discovery is unavailable');
      return new SkillInventory(() => service.host.discoverSkills(args.workspace ?? service.host.getContext().cwd));
    }
    return new SkillInventory(async () => {
      if (args.folder) return discoverFolderSkills(args.folder);
      const workspace = args.workspace ?? service.host.getContext().cwd;
      const roots = [...new Set([join(workspace, 'skills'), join(workspace, '.pi', 'skills'), join(service.host.agentDir, 'skills')])];
      const results = await Promise.all(roots.map(folder => discoverFolderSkills(folder)));
      // Optional absent Pi skill roots are not errors; a selected bad folder is.
      return { skills: results.flatMap(item => item.skills), errors: results.flatMap(item => item.errors.filter(error => error.code !== 'ENOENT')),
        discovered_by: 'pi-project-and-agent-skill-directories', profile_scope: roots.join('; '), model_invocations: 0 };
    });
  }
  async assertNoAuthoringMutation(workflowId, revision) {
    for (const run of await this.service.runtime.runs.list()) {
      const record = await this.service.runtime.runs.read(run.run_id);
      if (record.pins.root.provenance?.source_workflow_id === workflowId && record.pins.root.provenance?.source_revision === revision)
        requireValue(['succeeded', 'cancelled', 'failed'].includes(record.state.status), 'AUTHORING_SOURCE_BUSY', 'Finish or cancel the exact active authoring Run before replacing its source');
    }
  }
  async call(operation, args, { human, signal }) {
    if (operation === 'recover_strict_result') operation = 'recover_result';
    const service = this.service, { store, runtime, currentSettings } = service;
    const providers = currentSettings.providers.map(coreProvider);
    if (['customize_role', 'review_import'].includes(operation)) requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Built-in customization and source review belong to the authenticated Workbench');
    switch (operation) {
      case 'read': { const pack = await store.snapshot(args.workflow_id, args.revision_hash); return { ...pack, validation: await this.validation(pack.workflow, await store.resources(args.workflow_id, pack.revision_hash)) }; }
      case 'create': return service.call('create_workflow', args, { human });
      case 'save': {
        const pack = await store.snapshot(args.workflow_id, args.expected_revision);
        if (pack.provenance?.kind === 'bundled_authoring_workflow') validateStoredAuthoringWorkflow(args.workflow, providers, { requireReady: false });
        requireValue(!['resources', 'provenance', 'import_report', 'purge_history', 'history_purge'].some(key => Object.hasOwn(args, key)), 'WORKFLOW_EDITOR_METADATA', 'Edit immutable resources through the resource editor');
        return service.call('save_workflow', args, { human });
      }
      case 'publish': {
        const pack = await store.snapshot(args.workflow_id, args.expected_revision);
        if (pack.provenance?.kind === 'bundled_authoring_workflow') validateStoredAuthoringWorkflow(pack.workflow, providers, { requireReady: false });
        const validation = await this.validation({ ...pack.workflow, status: 'ready' }, await store.resources(args.workflow_id, pack.revision_hash));
        requireValue(validation.valid, 'WORKFLOW_NOT_READY', 'Workflow structure or dependencies are invalid', { validation });
        return publishEditorWorkflow(store, args);
      }
      case 'revisions': return store.revisions(args.workflow_id);
      case 'restore_revision': return store.restore(args.workflow_id, args.revision_hash, args.expected_revision);
      case 'duplicate': return store.duplicate(args.workflow_id, args.new_id, args.name, args.revision_hash);
      case 'rename': return store.rename(args.workflow_id, args.name, args.expected_revision);
      case 'delete': {
        const pack = await store.snapshot(args.workflow_id);
        requireValue(pack.provenance?.kind !== 'bundled_authoring_workflow', 'WORKFLOW_SYSTEM_MANAGED', 'Built-in authoring templates can be disabled and edited; their compiler identity cannot be deleted');
        return store.delete(args.workflow_id, args.expected_revision);
      }
      case 'read_resource': return readEditorResource(store, args);
      case 'write_resource': return writeEditorResource(store, args);
      case 'role_templates': return this.roles();
      case 'role_template': return this.roleProfile(args);
      case 'customize_role': {
        const role = currentSettings.roles.find(item => item.id === args.workflow_id);
        requireValue(role?.source_metadata && role.id.startsWith('builtin-role-'), 'ROLE_TEMPLATE_MISSING', 'Built-in Role does not exist');
        const customization = builtinRoleCustomizations(await store.list()).get(role.id);
        if (customization) return store.snapshot(customization.workflow.id);
        const compiled = compileWorkflowBrief({ kind: 'brief', template_kind: 'role',
          workflow_id: `role-${role.source_metadata.task_type_id}`, name: role.name, brief: role.role_instructions || role.prompt,
          provider_id: role.provider_id, access: role.access, role: role.source_metadata.stage_role });
        compiled.workflow.enabled = role.enabled !== false; compiled.workflow.description = role.description ?? '';
        compiled.workflow.tags = [...new Set([...(role.tags ?? []), 'role'])];
        compiled.provenance = { ...compiled.provenance, kind: 'role_customization', builtin_role_id: role.id,
          builtin_role_revision: digest(canonicalJSON(role)) };
        return store.create(compiled.workflow, compiled);
      }
      case 'workflow_scope': return service.workflowScope();
      case 'set_workflow_enabled': {
        requireValue(human,'HUMAN_CONFIGURATION_REQUIRED','Workflow switches belong to the human Workbench');
        const pack=await store.snapshot(args.workflow_id,args.expected_revision);
        requireValue(templateKind(pack)==='workflow'&&pack.provenance?.kind!=='bundled_authoring_workflow',
          'WORKFLOW_CONFIGURATION_KIND','Select an installed user Workflow');
        return setEditorWorkflowEnabled(store,args);
      }
      case 'set_mode_workflow_enabled': {
        requireValue(human,'HUMAN_CONFIGURATION_REQUIRED','Workflow combinations are configured in the human Workbench');
        const identity=service.host.mainIdentity(),catalog=await service.workflowCatalog(),scope=await service.workflowScope(catalog);
        requireValue(service.host.mainIdentity().session_id===identity.session_id,'PI_MAIN_SESSION_CHANGED','Current Pi session changed before saving Workflow preferences');
        requireValue(scope&&args.mode_pack_id===scope.mode_pack_id&&scope.workflow_ids.includes(args.workflow_id)&&typeof args.enabled==='boolean',
          'PI_MODE_WORKFLOW_SCOPE','Select an installed Workflow for this current preference context');
        requireValue(scope.revision===undefined||args.expected_revision===scope.revision,'PI_MODE_WORKFLOW_CONFLICT','Workflow combination changed; refresh before saving');
        requireValue((scope.origin===undefined||args.expected_origin===scope.origin)&&(scope.snapshot_id===undefined||args.expected_snapshot_id===scope.snapshot_id),
          'PI_MODE_WORKFLOW_CONFLICT','Mode origin changed; refresh before saving Workflow preferences');
        requireValue(typeof service.host.setWorkflowEnabled==='function','PI_MODE_WORKFLOW_SETTINGS_UNAVAILABLE','This Host has no current-mode Workflow preference adapter');
        await service.host.setWorkflowEnabled({session_id:identity.session_id,mode_pack_id:scope.mode_pack_id,workflow_id:args.workflow_id,enabled:args.enabled,catalog,
          ...(scope.revision===undefined?{}:{expected_revision:scope.revision}),...(scope.origin===undefined?{}:{expected_origin:scope.origin}),
          ...(scope.snapshot_id===undefined?{}:{expected_snapshot_id:scope.snapshot_id})});
        requireValue(service.host.mainIdentity().session_id===identity.session_id,'PI_MAIN_SESSION_CHANGED','Current Pi session changed while saving Workflow preferences');
        const next=await service.workflowScope();
        requireValue(next?.mode_pack_id===scope.mode_pack_id&&(scope.origin===undefined||next.origin===scope.origin)
          &&(scope.snapshot_id===undefined||next.snapshot_id===scope.snapshot_id)&&next.enabled_workflow_ids.includes(args.workflow_id)===args.enabled,
          'PI_MODE_WORKFLOW_CONFLICT','Current mode or Workflow combination changed while saving; refresh its actual state');
        return next;
      }
      case 'route': {
        const scope=await service.workflowScope();
        const eligible = [];
        for (const pack of await store.list()) if (pack.workflow.status === 'ready' && pack.workflow.enabled && templateKind(pack) === 'workflow' && pack.provenance?.kind !== 'bundled_authoring_workflow') {
          if(scope&&!scope.enabled_workflow_ids.includes(pack.workflow.id))continue;
          if ((await this.validation(pack.workflow, await store.resources(pack.workflow.id, pack.revision_hash))).valid) eligible.push(pack);
        }
        return routeReadyWorkflows(eligible, args.task, { limit: args.limit ?? 5 });
      }
      case 'source_status': return skillSourceStatus(await store.snapshot(args.workflow_id, args.revision_hash));
      case 'import_review': return importReviewPacket(await store.snapshot(args.workflow_id, args.revision_hash));
      case 'review_import': return reviewImportedDraft(store, args.workflow_id, args, { beforeHistoryPurge: () => this.assertNoAuthoringMutation(args.workflow_id, args.expected_revision) });
      case 'verify_relocation': { const pack = await store.snapshot(args.workflow_id, args.revision_hash); return verifyCoarseRelocation(pack, await store.resources(args.workflow_id, pack.revision_hash)); }
      case 'skill_inventory': return this.inventory(args).list(args.folder);
      case 'import_skill': { const selected = await this.inventory(args).select(args.folder, args.skill_id);
        return importCoarseSkill(store, selected.path, { id: args.workflow_id, name: args.name, providerId: args.provider_id, role: 'implementer', expectedSourceHash: selected.source_hash }); }
      case 'inline_skill': return inlineSkillReference(store, args.workflow_id, args);
      case 'build_workflow': {
        requireValue(args.template_kind === undefined || ['role', 'workflow'].includes(args.template_kind), 'TEMPLATE_KIND', 'Template kind must be role or workflow');
        if (args.provider_id) requireValue(currentSettings.providers.some(item => item.id === args.provider_id), 'PROVIDER_MISSING', 'Selected instruction Provider does not exist');
        return new WorkflowAuthoringCompiler({ store }).seed({ ...args, kind: 'brief', template_kind: args.template_kind ?? 'workflow' });
      }
      case 'prepare_expansion': {
        const provider = currentSettings.providers.find(item => item.id === args.provider_id), pack = await store.snapshot(args.workflow_id, args.revision_hash);
        requireValue(provider?.enabled, 'EXPANSION_EXECUTOR_UNAVAILABLE', 'Select an enabled planning Provider');
        const packet = expansionPacket(pack, await store.resources(pack.workflow.id, pack.revision_hash), coreProvider(provider), args.routing_rules ?? currentSettings.routing, providers);
        const binding = provider.binding ? resolveBinding(provider.binding, service.host.catalog()) : null;
        return { ...packet, adapter: { execution: 'pi_sdk', agent_type: 'default', model: binding?.model_id ?? null,
          reasoning_effort: binding?.thinking ?? null }, binding, handoff_required: true, invoked: false, approval_required: false };
      }
      case 'export_workflow_package': { const pack = await store.snapshot(args.workflow_id, args.revision_hash);
        return exportWorkflowPackage(pack, await store.resources(pack.workflow.id, pack.revision_hash), { packageVersion: args.package_version ?? '1.0.0' }); }
      case 'install_workflow_package': {
        requireValue(human || args.package === undefined, 'WORKFLOW_PACKAGE_SOURCE', 'Agent package installation requires a local file or HTTPS source');
        requireValue([args.package !== undefined, args.package_path !== undefined, args.source_url !== undefined].filter(Boolean).length === 1, 'WORKFLOW_PACKAGE_SOURCE', 'Choose exactly one package source');
        let bundle = args.package, source = args.source_url ?? 'workbench-upload';
        if (args.package_path !== undefined) {
          requireValue(typeof args.package_path === 'string' && args.package_path.trim(), 'WORKFLOW_PACKAGE_FILE', 'Package path must name one local package JSON file');
          let path;
          if (isAbsolute(args.package_path)) path = resolve(args.package_path);
          else { requireValue(typeof args.workspace === 'string' && isAbsolute(args.workspace), 'WORKFLOW_PACKAGE_WORKSPACE', 'A relative package path requires an absolute workspace');
            path = resolve(args.workspace, args.package_path); insideRoot(resolve(args.workspace), path); }
          await noSymlinks(path); const before = await lstat(path);
          requireValue(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 70 * 1024 * 1024, 'WORKFLOW_PACKAGE_FILE', 'Package file must be one bounded regular file');
          const bytes = await readFile(path), after = await lstat(path);
          requireValue(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs, 'WORKFLOW_PACKAGE_FILE_CHANGED', 'Package file changed while being read');
          if (args.expected_sha256) requireValue(digest(bytes) === args.expected_sha256, 'WORKFLOW_PACKAGE_FETCH_INTEGRITY', 'Local package hash differs');
          bundle = JSON.parse(bytes.toString('utf8')); source = path;
        }
        if (args.source_url) { const url = new URL(args.source_url); requireValue(url.protocol === 'https:', 'WORKFLOW_PACKAGE_URL', 'Remote package source requires HTTPS');
          const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); requireValue(response.ok, 'WORKFLOW_PACKAGE_FETCH', `Package source returned HTTP ${response.status}`);
          const chunks = []; let size = 0; for await (const chunk of response.body) { size += chunk.length; requireValue(size <= 70 * 1024 * 1024, 'WORKFLOW_PACKAGE_SIZE', 'Downloaded package exceeds limit'); chunks.push(chunk); }
          const bytes = Buffer.concat(chunks); if (args.expected_sha256) requireValue(digest(bytes) === args.expected_sha256, 'WORKFLOW_PACKAGE_FETCH_INTEGRITY', 'Downloaded package hash differs');
          bundle = JSON.parse(bytes.toString('utf8')); }
        const checked = validatePortableWorkflowPackage(bundle); await service.prepareValidation(checked.snapshot.workflow, checked.resources);
        return store.install(checked.snapshot, { resources: checked.resources, installation: { source,
          package_version: checked.package.version, package_sha256: checked.package_sha256, installed_at: new Date().toISOString() } });
      }
      case 'routing_defaults': return currentSettings.routing;
      case 'save_routing_rules': {
        requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Routing is configured in the Workbench');
        const current = await service.settings.read();
        requireValue(canonicalJSON(args.expected_rules) === canonicalJSON(current.settings.routing), 'ROUTING_SETTINGS_CONFLICT', 'Routing rules changed; reload before saving');
        const routing = validateRoutingRules(args.routing_rules);
        await service.settings.save({ ...current.settings, routing }, current.revision);
        await service.refreshContext();
        // Stored authoring templates retain their independently edited planner,
        // reviewer and repair budget, matching the original control plane.
        return routing;
      }
      case 'authoring_workflows': return Promise.all(AUTHORING_WORKFLOWS.map(async definition => { const pack = await store.snapshot(definition.id); return { ...definition, revision_hash: pack.revision_hash, status: pack.workflow.status, enabled: pack.workflow.enabled, workflow: pack.workflow }; }));
      case 'authoring_prompt_preview': return this.authoring.preview(args);
      case 'start_authoring': return this.authoring.start(args);
      case 'advance_authoring': return this.authoring.observe(args);
      case 'continue_authoring': return this.authoring.continue(args);
      case 'accept_authoring': case 'apply_authoring_result': requireValue(human, 'HUMAN_GENERATION', 'Accept the exact reviewed proposal in the Workbench'); return this.authoring.accept(args);
      case 'recheck_authoring': requireValue(human, 'HUMAN_GENERATION', 'Recheck belongs to the Workbench'); return this.authoring.recheck(args);
      case 'accept_rechecked_authoring_review': requireValue(human, 'HUMAN_GENERATION', 'Accepting the exact rechecked authoring review belongs to the Workbench'); return this.authoring.acceptRecheckedReview(args);
      case 'purge_authoring_artifacts': requireValue(human, 'HUMAN_GENERATION', 'Accepted private authoring cleanup belongs to the Workbench'); return this.authoring.purge(args);
      case 'get': {
        const retained=await runtime.runs.retained(args.run_id);
        return retained ? {...retained.state,process_cleaned:true,cleaned_at:retained.cleaned_at} : (await runtime.snapshot(args.run_id)).state;
      }
      case 'run_retention':
        if(args.completed_hours!==undefined)requireValue(human,'HUMAN_RETENTION','Retention is configured in the Workbench');
        return {...await service.retention.policy(args.completed_hours===undefined?undefined:{completed_hours:args.completed_hours}),maintenance_error:service.maintenanceError??null};
      case 'cleanup_run_history':
        requireValue(human,'HUMAN_RUN_CLEANUP','Manual cleanup belongs to the Workbench');
        requireValue(Object.keys(args).every(k=>k==='completed_now') && (args.completed_now===undefined||typeof args.completed_now==='boolean'), 'RUN_CLEANUP_ARGS','Cleanup takes an optional completed_now boolean');
        return service.retention.sweep({completed_now:args.completed_now===true});
      case 'next': return runtime.next(args.run_id);
      case 'events': return runtime.events(args.run_id, { ...await service.authority(args.run_id), after_sequence: args.after_sequence ?? 0 });
      case 'wait': {
        const authority = await service.authority(args.run_id);
        const result = await waitForWorkflow({ runId: args.run_id, directory: runtime.runs.directory(args.run_id), signal,
          afterSequence: args.after_sequence, timeoutMs: args.timeout_ms,
          readState: async () => { await runtime.authorizeController(args.run_id, authority); return runtime.runs.read(args.run_id); },
          readWorker: async () => {
            let worker;
            try { worker = JSON.parse(await readFile(join(runtime.runs.directory(args.run_id), 'pi-worker.json'), 'utf8')); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
            requireValue(worker.run_id === args.run_id && typeof worker.status === 'string', 'PI_WORKER_IDENTITY', 'Worker status does not identify this Run');
            const phases = { awaiting_acceptance: 'awaiting_human_acceptance', attention: 'failed', running: worker.settled_at ? 'stopped' : 'running' };
            return { phase: phases[worker.status] ?? worker.status, outcome: { status: worker.status }, ...(worker.error ? { error: worker.error } : {}) };
          } });
        return { ...result, ...(result.next_action ? { next_action: 'caw', next_action_args: { action: 'wait', run_id: args.run_id,
          after_sequence: result.sequence, ...(args.timeout_ms === undefined ? {} : { timeout_ms: args.timeout_ms }) } } : {}) };
      }
      case 'record_usage': {
        requireValue(human, 'HUMAN_USAGE_REQUIRED', 'Manual cost observations belong to the human Workbench; Pi records actual session usage automatically');
        const authority = await service.authority(args.run_id), record = await controllerAttempt(runtime, args.run_id, { ...args, ...authority });
        requireValue(record.attempt.dispatch, 'USAGE_DISPATCH_REQUIRED', 'Usage must identify an existing exact dispatch');
        const lease = { ...args, ...authority, lease_token: leaseToken(authority.control_token, args.run_id, args.node_id, args.attempt_id, record.attempt.lease_generation ?? 0) };
        return record.definition.executor?.kind === 'main' ? runtime.recordHostMainUsage(args.run_id, lease) : runtime.recordUsage(args.run_id, lease);
      }
      case 'retry_node': return service.call('retry', args, { human });
      case 'run_definition': { const record = await runtime.runs.read(args.run_id); return { ...record.pins.root, providers: record.pins.providers }; }
      case 'adopt_run': case 'recover_control': {
        const recovery = operation === 'recover_control' ? conversationControlRecoveryRequest(args) : null;
        requireValue((human || recovery) && !service.active.has(args.run_id), 'PI_RUN_BUSY', 'A running Pi owner must settle before recovery');
        const adopted = await adoptRunTree(runtime, args.run_id, recovery ?? { expected_sequence: args.expected_sequence,
          reason: args.reason ?? 'Human Workbench recovered the retained Pi Run', main_actor: service.host.mainIdentity().session_id });
        for (const [id, authority] of adopted.authorities) await writeDurableJSON(join(runtime.runs.directory(id), 'pi-controller.json'), { control_token: authority.control_token });
        // Exact CAS/lease fencing comes first. Shutdown may append events, so
        // stopping before that CAS would invalidate the reviewed sequence.
        // No new execution is released until every old owner confirms stop.
        const errors = [...adopted.errors], entries = [...adopted.authorities];
        const stopped = await Promise.allSettled(entries.map(([id]) => service.stopOwnerForRecovery(id)));
        stopped.forEach((result, index) => { if (result.status === 'rejected') errors.push({ run_id: entries[index][0], code: result.reason.code ?? 'PI_OWNER_STOP_UNCONFIRMED', message: result.reason.message }); });
        await runtime.runs.mutate(args.run_id, 'control_recovery', state => {
          requireValue(state.control_hash === digest(adopted.run.control_token), 'RUN_AUTHORITY', 'A newer recovery replaced this controller during cleanup');
          state.control_recovery.errors = errors;
        });
        return { ...await runtime.get(args.run_id), control_token: adopted.run.control_token, recovery_errors: errors };
      }
      case 'node_details': { const record = await runtime.runs.read(args.run_id), node = record.pins.root.workflow.nodes.find(item => item.id === args.node_id); requireValue(node, 'NODE_MISSING', 'Node is not in this Run');
        return { node, provider: record.pins.providers.find(item => item.id === node.executor?.provider_id) ?? null,
          ...(node.executor ? { permissions: nodePermissions(node, record.state), workspace: nodeWorkspace(node.id, record.state, record.pins) } : {}),
          skill_policy: effectiveSkillPolicy(record.pins.inherited_policy ?? record.pins.root.workflow.skill_policy, node.skill_policy), pins_hash: record.state.pins_hash }; }
      case 'prepare_integration': return service.parallel.prepareIntegration(runtime, args.run_id, { ...args, ...await service.authority(args.run_id) });
      case 'review_integration': return service.parallel.review(runtime, args.run_id, { ...args, ...await service.authority(args.run_id) });
      case 'integrate_parallel': { requireValue(human, 'HUMAN_INTEGRATION_REQUIRED', 'Review and accept the exact patch in the Workbench');
        const result = await service.parallel.integrate(runtime, args.run_id, { ...args, ...await service.authority(args.run_id) }); if (!service.active.has(args.run_id)) await service.launchDriver(args.run_id); return result; }
      case 'cleanup_parallel': requireValue(human, 'HUMAN_CLEANUP_REQUIRED', 'Accepted worktrees are cleaned by the human Workbench'); return service.parallel.cleanup(runtime, args.run_id, { ...args, ...await service.authority(args.run_id) });
      case 'collect_subworkflow': { const authority = await service.authority(args.run_id), record = await runtime.runs.read(args.run_id), node = record.state.nodes[args.node_id], attempt = node?.attempts.find(item => item.id === (args.attempt_id ?? node.active_attempt_id)); requireValue(attempt?.child_run_id, 'CHILD_DISPATCH_REQUIRED', 'No exact child Run belongs to this attempt');
        const result = await runtime.collectSubworkflow(args.run_id, { ...authority, node_id: args.node_id, attempt_id: attempt.id, lease_token: leaseToken(authority.control_token, args.run_id, args.node_id, attempt.id, attempt.lease_generation ?? 0) }); if (!service.active.has(args.run_id)) await service.launchDriver(args.run_id); return result; }
      case 'child_control': {
        const authority = await service.authority(args.run_id), record = await controllerAttempt(runtime, args.run_id, { ...args, ...authority });
        requireValue(record.definition.executor?.kind === 'subworkflow', 'SUBWORKFLOW_NODE_REQUIRED', 'This attempt is not a SubWorkflow');
        const identity = childIdentity(args.run_id, args.node_id, args.attempt_id, authority.control_token);
        requireValue(record.attempt.child_run_id === identity.run_id, 'CHILD_DISPATCH_REQUIRED', 'No exact child dispatch exists');
        const child = await runtime.runs.read(identity.run_id);
        requireValue(child.pins.parent?.run_id === args.run_id && child.pins.parent.node_id === args.node_id && child.pins.parent.attempt_id === args.attempt_id
          && child.state.control_hash === digest(identity.control_token), 'CHILD_RUN_CONFLICT', 'Child identity or recovered authority differs');
        return { ...await runtime.get(identity.run_id), control_token: identity.control_token };
      }
      case 'recover_claim': case 'reattach_subworkflow': case 'recover_result': {
        requireValue(human && !service.active.has(args.run_id), 'HUMAN_RECOVERY_REQUIRED', 'Exact recovery requires the previous Pi owner to settle');
        requireValue(typeof service.resumeRecoveredAttempt === 'function', 'PI_RECOVERY_DISPATCH_UNAVAILABLE', 'Pi recovery requires the exact-attempt resume adapter');
        const authority = await service.authority(args.run_id), lease = { ...args, ...authority }, record = await controllerAttempt(runtime, args.run_id, lease);
        let observation;
        if (operation === 'recover_claim') { requireValue(!record.attempt.dispatch, 'DISPATCH_UNCERTAIN', 'This attempt has dispatch intent; inspect its exact executor'); observation = { kind: 'unsubmitted_claim' }; }
        else if (operation === 'reattach_subworkflow') {
          requireValue(record.definition.executor?.kind === 'subworkflow', 'SUBWORKFLOW_NODE_REQUIRED', 'This attempt is not a SubWorkflow');
          const identity = childIdentity(args.run_id, args.node_id, args.attempt_id, authority.control_token), child = await runtime.runs.read(identity.run_id);
          requireValue(record.attempt.child_run_id === identity.run_id && child.pins.parent?.run_id === args.run_id
            && child.pins.parent.node_id === args.node_id && child.pins.parent.attempt_id === args.attempt_id
            && child.state.control_hash === digest(identity.control_token), 'CHILD_RUN_CONFLICT', 'Child does not match the exact parent dispatch');
          observation = { kind: 'subworkflow_exact_identity', attempt_id: args.attempt_id, dispatch_request_id: record.attempt.dispatch.request_id, receipt: { task_id: identity.run_id, child_run_id: identity.run_id }, child_sequence: child.sequence, child_event_hash: child.events.at(-1).hash };
        } else { const proposal = record.attempt.result_proposal; requireValue(proposal?.sha256 && record.attempt.executor_events?.some(event => event.kind === 'session_state' && event.metadata.status === 'closed'), 'PI_SESSION_SHUTDOWN_UNCONFIRMED', 'Exact durable result and confirmed session shutdown are required');
          const result = await runtime.runs.readExecutorResult(args.run_id, args.attempt_id, proposal.sha256); requireValue(result.status === 'succeeded', 'PI_RESULT_NOT_READY', 'Durable result is not successful');
          observation = { kind: 'strict_durable_result', attempt_id: args.attempt_id, dispatch_request_id: record.attempt.dispatch.request_id, result_sha256: proposal.sha256 }; }
        const attached = await reattachAttempt(runtime, args.run_id, lease, observation);
        return service.resumeRecoveredAttempt(args.run_id, { ...authority, node_id: args.node_id, attempt_id: args.attempt_id,
          lease_token: attached.envelope.lease_token }, attached);
      }
      case 'reject_final': {
        requireValue(human && !service.active.has(args.run_id), 'HUMAN_REJECTION_REQUIRED', 'Reject the settled exact proposal in the Workbench');
        const authority = await service.authority(args.run_id), record = await runtime.runs.read(args.run_id), nodeId = record.pins.root.workflow.finalization.node_id, attempt = record.state.nodes[nodeId].attempts.at(-1);
        requireValue(attempt?.result_proposal?.sha256 === args.proposal_sha256, 'PI_FINAL_CHANGED', 'Rejection must identify the reviewed proposal');
        return runtime.failNode(args.run_id, { ...authority, node_id: nodeId, attempt_id: attempt.id, lease_token: leaseToken(authority.control_token, args.run_id, nodeId, attempt.id, attempt.lease_generation ?? 0), error: { code: 'HUMAN_FINAL_REJECTED', message: args.reason ?? 'Human rejected this exact final proposal' } });
      }
      case 'resume': await service.call('continue', args, { human }); return (await runtime.snapshot(args.run_id)).state;
      case 'run_main': case 'start': {
        const pack = await store.snapshot(args.workflow_id, args.revision_hash);
        requireValue(templateKind(pack) === 'workflow', 'ROLE_NOT_RUNNABLE', 'Assign Role templates to one Agent instead of starting a workflow Run');
        if (AUTHORING_WORKFLOWS.some(item => item.id === pack.workflow.id)) return this.authoring.start({ ...args, authoring_workflow_id: pack.workflow.id,
          authoring_workflow_revision: pack.revision_hash, workflow_id: args.inputs?.source_workflow_id, revision_hash: args.inputs?.source_revision });
        const workspace = args.workspace || service.host.getContext().cwd;
        return service.call('run', { ...args, workspace, access: args.access ?? 'read_only', allowed_paths: args.allowed_paths ?? [], run_id: args.run_id ?? `run-${randomUUID()}` }, { human });
      }
      case 'local_clients': {
        const metadata = typeof service.host.runtimeMetadata === 'function' ? await service.host.runtimeMetadata() : null;
        return { pi: { version: metadata?.sdk_version ?? null, source: metadata?.source ?? 'active-pi-session', models: service.host.catalog(),
          ...(service.host.agentDir ? { auth_directory: service.host.agentDir } : {}) }, execution_runtime: service.host.capabilities, connectors: [] };
      }
      case 'runtime_dependencies': return readHostRuntimeRegistry(join(service.directory, 'host-runtime-registry.json'));
      case 'register_runtime_dependency': requireValue(human, 'HUMAN_CONFIGURATION_REQUIRED', 'Executable paths are registered by the human Workbench'); return updateRuntimeCandidate(args.requirement, args.path, { registryPath: join(service.directory, 'host-runtime-registry.json') });
      case 'discover_runtime_dependencies': return discoverRuntimeEnvironment({ executables: args.executables ?? [] }, { registryPath: join(service.directory, 'host-runtime-registry.json'), extraDirectories: args.environment_directories ?? [] });
      case 'prepare_environment': {
        const pack = await store.snapshot(args.workflow_id, args.revision_hash), closure = await resolveWorkflowPins(store, pack);
        return discoverRuntimeEnvironment({ executables: [...closure.packs.flatMap(item => item.workflow.requirements.executables ?? []),
          ...closure.skills.flatMap(item => item.requirements.executables ?? [])] }, { registryPath: join(service.directory, 'host-runtime-registry.json'), extraDirectories: args.environment_directories ?? [] });
      }
      case 'recheck_runtime_environment': return runtime.ensureRuntimeEnvironment(args.run_id, { ...await service.authority(args.run_id), extraDirectories: args.environment_directories ?? [] });
      case 'generate_task_brief': {
        requireValue(human, 'HUMAN_TASK_BRIEF', 'Task-description generation is requested by the human');
        const pack = args.workflow_id ? await store.snapshot(args.workflow_id, args.revision_hash) : null;
        const workflow = args.workflow ?? pack?.workflow;
        requireValue(workflow && typeof workflow.name === 'string', 'TASK_BRIEF_WORKFLOW', 'Select a Workflow first');
        requireValue(typeof (args.existing ?? '') === 'string', 'TASK_BRIEF_INPUT', 'Existing task description must be text');
        const id = currentSettings.routing.routes?.planning?.provider_id, provider = currentSettings.providers.find(item => item.id === id);
        requireValue(provider?.enabled, 'PI_TASK_BRIEF_UNBOUND', 'Configure the planning Provider in Role / Provider settings');
        const schema = { type: 'object', additionalProperties: false, required: ['task'], properties: { task: { type: 'string', minLength: 1, maxLength: 6000 } } };
        const task = await service.host.createTask({ run_id: `brief-${randomUUID()}`, node_id: 'task-brief', name: 'Task description', kind: 'subagent', binding: provider.binding,
          workspace: service.host.getContext().cwd, access: 'read_only', allowed_paths: [], schema, resources: [], strict: true });
        try { const result = await task.run({ schema, prompt: `Write an editable task description in the user's language, preserving supplied facts. Do not execute the workflow or invent paths. Use placeholders for essential missing facts.\n${canonicalJSON({ existing: args.existing ?? '', workflow })}` }); return result.result; }
        finally { await service.host.releaseTask(task); }
      }
      case 'cache_cleanup_preview': case 'cleanup_caches': {
        requireValue(human, 'HUMAN_CACHE_CLEANUP', 'Cache cleanup belongs to the Workbench');
        const plan = await this.cachePlan(); if (operation === 'cache_cleanup_preview') return plan;
        requireValue(args.expected_plan_hash === plan.plan_hash, 'CACHE_PLAN_CHANGED', 'Review the current cleanup preview before deleting');
        requireValue(service.active.size === 0 && service.roleTasks.size === 0, 'CACHE_ACTIVE_RUNS', 'Wait for active tasks before cache cleanup');
        const deleted = [], auditPath = join(service.directory, `cache-cleanup-${randomUUID()}.json`);
        insideRoot(service.directory, auditPath);
        const audit = { started_at: new Date().toISOString(), status: 'running', plan_hash: plan.plan_hash,
          candidates: plan.files, planned_bytes: plan.bytes, deleted: [] };
        await store.withWriter(() => runtime.runs.writer.withWriter(async () => {
          const current = await this.cachePlan(); requireValue(current.plan_hash === plan.plan_hash, 'CACHE_PLAN_CHANGED', 'Cache pins changed before cleanup');
          requireValue(service.active.size === 0 && service.roleTasks.size === 0, 'CACHE_ACTIVE_RUNS', 'Wait for active tasks before cache cleanup');
          await writeDurableJSON(auditPath, audit);
          try {
            for (const file of plan.files) {
              insideRoot(store.root, file.path); await noSymlinks(file.path); const stat = await lstat(file.path);
              requireValue(stat.isFile() && stat.nlink === 1, 'CACHE_FILE_TYPE', 'Cache cleanup requires regular unlinked files');
              requireValue(digest(await readFile(file.path)) === file.sha256, 'CACHE_FILE_CHANGED', 'Cache object changed before deletion');
              await unlink(file.path); deleted.push(file.path); audit.deleted.push({ path: file.path, bytes: file.bytes }); await writeDurableJSON(auditPath, audit);
            }
            audit.status = 'complete'; audit.completed_at = new Date().toISOString(); await writeDurableJSON(auditPath, audit);
          } catch (error) {
            audit.status = 'failed'; audit.error = { code: error.code ?? 'CACHE_CLEANUP', message: error.message.slice(0, 2000) };
            try { await writeDurableJSON(auditPath, audit); }
            catch (auditError) { throw new AggregateError([error, auditError], 'Cache cleanup failed and its durable audit could not be updated'); }
            throw Object.assign(error, { details: { audit_file: auditPath, deleted: deleted.length } });
          }
        }));
        return { deleted, bytes: plan.bytes, scope: store.root, audit_file: auditPath };
      }
      default: throw Object.assign(new Error(`Unsupported Pi Workbench operation: ${operation}`), { code: 'PI_CAW_OPERATION' });
    }
  }
  async cachePlan() {
    const { store, runtime } = this.service, packs = await store.list(), pinned = new Set(), all = [];
    const hashes = value => { if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) pinned.add(value); else if (value && typeof value === 'object') Object.values(value).forEach(hashes); };
    packs.forEach(hashes); for (const run of await runtime.runs.list()) hashes((await runtime.runs.read(run.run_id)).pins);
    for (const pack of packs) for (const revision of await store.revisions(pack.workflow.id)) all.push(await store.snapshot(pack.workflow.id, revision.revision_hash));
    let previous; do { previous = pinned.size; for (const pack of all) if (pinned.has(pack.revision_hash)) hashes(pack); } while (pinned.size !== previous);
    const files = [];
    const entry = async (path, kind) => {
      insideRoot(store.root, path); await noSymlinks(path); const stat = await lstat(path);
      requireValue(stat.isFile() && stat.nlink === 1, 'CACHE_FILE_TYPE', 'Cache cleanup requires regular unlinked files');
      const bytes = await readFile(path); return { path, kind, bytes: bytes.length, sha256: digest(bytes) };
    };
    for (const pack of packs) {
      const root = resolve(store.root, `wf-${pack.workflow.id}.pack`), retained = new Set(); insideRoot(store.root, root);
      for (const historical of all.filter(item => item.workflow.id === pack.workflow.id)) {
        if (pinned.has(historical.revision_hash)) for (const item of historical.resources) retained.add(item.sha256);
        else files.push(await entry(join(root, 'revisions', `${historical.revision_hash}.json`), 'workflow_revision'));
      }
      await noSymlinks(join(root, 'objects'));
      for (const item of await readdir(join(root, 'objects'), { withFileTypes: true })) {
        requireValue(item.isFile() && !item.isSymbolicLink() && /^[a-f0-9]{64}$/.test(item.name), 'CACHE_OBJECT_TYPE', 'Unexpected Workflow object entry');
        if (!retained.has(item.name)) files.push(await entry(join(root, 'objects', item.name), 'workflow_resource'));
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const workflow_revisions = files.filter(item => item.kind === 'workflow_revision').length;
    return { plan_hash: digest(canonicalJSON(files)), files, bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      workflow_revisions, workflow_resources: files.length - workflow_revisions, retained_revisions: all.length - workflow_revisions, scope: store.root,
      note: 'Unpinned Workflow revisions and resource objects; Run journals, active packages, Pi chats and credentials are preserved.' };
  }
}
