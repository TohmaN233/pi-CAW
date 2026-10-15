// Separate read contracts keep retained results distinct from prompt previews.
export async function loadAuthoringPreview(request, { pack, runId, selectedRun }) {
  if (runId) return { preview: await request('authoring_preview', { run_id: runId }) };
  if (!pack) throw new Error('Authoring preview requires an exact source Pack or Run');
  return request('authoring_discover', { workflow_id: pack.workflow.id, revision_hash: pack.revision_hash,
    ...(selectedRun ? { run_id: selectedRun } : {}) });
}
