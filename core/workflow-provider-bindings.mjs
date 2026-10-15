// Workflow-local execution choices are Host configuration, never graph edits.
// Historical Runs without this map retain their original Provider pins.
export function providersForWorkflow(context, workflow) {
  return context.workflow_providers?.[workflow.id] ?? context.providers ?? [];
}

export function workflowProviderIds(workflow) {
  return [...new Set([...(workflow.requirements?.providers ?? []), ...workflow.nodes
    .filter(node => ['provider', 'thread'].includes(node.executor?.kind)).map(node => node.executor.provider_id),
    ...workflow.nodes.map(node => node.authoring_reviewer_provider_id).filter(Boolean)])].sort();
}

export function emptyWorkflowBindings(pack) {
  return { schema_version: 1, workflow_id: pack.workflow.id, workflow_revision: pack.revision_hash,
    providers: Object.fromEntries(workflowProviderIds(pack.workflow).map(id => [id, null])) };
}
