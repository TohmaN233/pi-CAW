import { requireValue } from '../core/workflow-paths.mjs';

/** The trusted Host supplies current-session policy; no preference changes the shared graph. */
export function validateWorkflowScope(value) {
  if(value===undefined||value===null)return null;
  requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['mode_pack_id','workflow_ids','enabled_workflow_ids','revision','origin','snapshot_id'].includes(key))
    &&typeof value.mode_pack_id==='string'&&value.mode_pack_id.length>0&&value.mode_pack_id.length<=256,
    'PI_MODE_WORKFLOW_SCOPE','Host Workflow scope requires an exact current Mode Pack');
  for(const key of ['workflow_ids','enabled_workflow_ids'])requireValue(Array.isArray(value[key])&&value[key].length<=256
    &&value[key].every(id=>typeof id==='string'&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))&&new Set(value[key]).size===value[key].length,
    'PI_MODE_WORKFLOW_SCOPE','Host Workflow scope requires bounded unique Workflow IDs');
  requireValue(value.enabled_workflow_ids.every(id=>value.workflow_ids.includes(id)),'PI_MODE_WORKFLOW_SCOPE','Enabled Workflow preferences must name declared library entries');
  requireValue(value.revision===undefined||Number.isSafeInteger(value.revision)&&value.revision>=0,'PI_MODE_WORKFLOW_SCOPE','Host Workflow preference revision must be a nonnegative integer');
  for(const key of ['origin','snapshot_id'])requireValue(value[key]===undefined||typeof value[key]==='string'&&value[key].length>0&&value[key].length<=256,'PI_MODE_WORKFLOW_SCOPE','Host Workflow preference origin must be bounded');
  return structuredClone(value);
}

export function projectWorkflowCatalog(rows,scope) {
  if(!scope)return rows;
  return rows.map(row=>{
    if(row.template_kind==='role'||row.system_managed)return row;
    const mode_enabled=scope.enabled_workflow_ids.includes(row.id),effective_enabled=row.enabled&&mode_enabled;
    return {...row,global_enabled:row.enabled,mode_enabled,effective_enabled,mode_pack_id:scope.mode_pack_id,
      ...(scope.revision===undefined?{}:{mode_revision:scope.revision}),enabled:effective_enabled};
  });
}

export function requireWorkflowInScope(scope,workflowId) {
  if(!scope)return;
  requireValue(scope.workflow_ids.includes(workflowId),'PI_MODE_WORKFLOW_SCOPE',`Workflow ${workflowId} is not in the installed Workflow library`);
  requireValue(scope.enabled_workflow_ids.includes(workflowId),'PI_MODE_WORKFLOW_DISABLED',`Workflow ${workflowId} is disabled in the current Mode Pack ${scope.mode_pack_id}`);
}
