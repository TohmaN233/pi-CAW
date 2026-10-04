// One publication per refresh: state, next, events and live never mix generations.
import { t } from '../web/i18n.js';
export function createRunRefresh() {
  let generation = 0;
  let sequence = -1;
  let active = true;
  let previous = null;
  return {
    invalidate() { generation += 1; },
    activate() { active = true; generation += 1; },
    dispose() { active = false; generation += 1; },
    async refresh(load, publish) {
      if (!active) return false;
      const request = ++generation;
      let snapshot;
      try { snapshot = await load(previous); }
      catch (error) { if (request === generation) throw error; return false; }
      if (request !== generation || snapshot.state.sequence < sequence) return false;
      sequence = snapshot.state.sequence;
      previous = snapshot;
      publish(snapshot);
      return true;
    },
  };
}


// Only the previously published generation can advance this event cursor.
export async function loadRunSnapshot(api, runId, authority, previous) {
  const priorEvents = authority && previous?.eventAuthority === authority ? previous.events : [];
  const after_sequence = priorEvents?.at(-1)?.sequence ?? 0;
  const next = await api('run_snapshot', { run_id: runId, control_token: authority, after_sequence });
  if (next.state.sequence < after_sequence) throw new Error(t('Run 快照序号落后于事件游标', 'Run snapshot sequence regressed behind the event cursor'));
  return { ...next, events: [...(priorEvents ?? []), ...next.events], eventAuthority: authority };
}

function pendingShapeError(field) {
  return Object.assign(new Error(`current_main_pending returned an invalid ${field}`),
    { detail: { code: 'CURRENT_MAIN_PENDING_INVALID', field } });
}

const objectRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function currentMainPending(value, runId) {
  if (value === null) return null;
  if (!objectRecord(value)) throw pendingShapeError('response');
  // control_wait is scoped by the request itself; the other Host views carry run_id.
  if (value.kind === 'control_wait' ? value.run_id !== undefined && value.run_id !== runId : value.run_id !== runId)
    throw pendingShapeError('run_id');
  if (value.kind === 'final_acceptance') {
    if (typeof value.node_id !== 'string' || !objectRecord(value.proposal)) throw pendingShapeError('final_acceptance');
  } else if (value.kind === 'control_wait') {
    if (!objectRecord(value.outcome)) throw pendingShapeError('control_wait');
  } else if (value.kind === 'host_main') {
    if (typeof value.status !== 'string' || !value.status) throw pendingShapeError('host_main');
  } else if (value.kind === undefined) {
    // Detached Host Main workers publish an untagged, durable phase record.
    if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.phase !== 'string' || !value.phase ||
        typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw pendingShapeError('worker_phase');
    return { ...value, kind: 'host_main', status: value.phase };
  } else throw pendingShapeError('kind');
  return value;
}

/** @param {(snapshot: any) => Promise<any>} [loadLive] */
export async function loadRunPanelSnapshot(api, runId, authority, previous, loadLive = async _snapshot => null) {
  const snapshot = await loadRunSnapshot(api, runId, authority, previous);
  const pending = currentMainPending(await api('current_main_pending', { run_id: runId }), runId);
  return { ...snapshot, bridgeProposal: pending, live: await loadLive(snapshot) };
}

// Pi owns the controller; the Workbench reads its authenticated journal without
// exposing that authority to UI fields. A displayed proposal belongs to the
// same observed attempt, even if the owner advances while this read is pending.
export async function loadPiRunPanelSnapshot(api, runId, previous) {
  const after_sequence = previous?.events?.at(-1)?.sequence ?? 0;
  const [snapshot, pack] = await Promise.all([
    api('run_snapshot', { run_id: runId, after_sequence }),
    api('run_definition', { run_id: runId }),
  ]);
  if (snapshot.state.run_id !== runId || snapshot.state.sequence < after_sequence)
    throw new Error('Pi Run snapshot identity or event cursor changed');
  const finalNode = pack.workflow.finalization.node_id;
  const attempt = snapshot.state.nodes[finalNode]?.attempts.at(-1);
  const proposal = attempt?.result_proposal ? await api('final_proposal', { run_id: runId }) : null;
  if (attempt?.result_proposal && proposal?.proposal_sha256 !== attempt.result_proposal.sha256)
    throw new Error('The final proposal changed during refresh. Read the current Run again.');
  const authoring = ['authoring_workflow_run', 'skill_expansion_job'].includes(pack.provenance?.kind)
    ? await api('advance_authoring', { run_id: runId }) : null;
  if (['review_required', 'ready_to_apply'].includes(authoring?.phase) && authoring.proposal_sha256 !== proposal?.proposal_sha256)
    throw new Error('The authoring proposal changed during refresh. Read the current Run again.');
  return { ...snapshot, pack, proposal, authoring, events: [...(previous?.events ?? []), ...snapshot.events] };
}

/**
 * @param {any} proposal
 * @param {{ accepted?: boolean, reason?: string, expected_revision?: string }} options
 */
export function finalDecisionArgs(proposal, options = {}) {
  const { accepted = false, reason, expected_revision } = options;
  if (!/^[a-f0-9]{64}$/.test(proposal?.proposal_sha256 ?? ''))
    throw new Error('Review an exact final proposal before making a decision');
  if (!accepted && (typeof reason !== 'string' || !reason.trim() || reason.length > 2000))
    throw new Error('Enter a rejection reason of 1–2000 characters');
  return { proposal_sha256: proposal.proposal_sha256, ...(accepted ? { accepted: true } : { reason: reason.trim() }),
    ...(expected_revision ? { expected_revision } : {}) };
}

export function retainedRecheckedReview(state, pack, proposal) {
  if (!['authoring_workflow_run', 'skill_expansion_job'].includes(pack?.provenance?.kind)
      || state?.generation_repair?.feedback?.code !== 'GENERATION_CHECKLIST_INVALID'
      || state.nodes?.final?.status !== 'ready') return null;
  const attempt = [...(state.nodes.final.attempts ?? [])].reverse().find(item => item.status === 'failed'
    && item.result_proposal && item.error?.code === 'GENERATION_REVIEW_REJECTED');
  if (!attempt?.dispatch?.receipt || attempt.dispatch.cancellation_pending
      || !attempt.executor_events?.some(event => event.kind === 'session_state' && event.metadata?.status === 'closed')
      || !/^[a-f0-9]{64}$/.test(proposal?.proposal_sha256 ?? '')
      || attempt.result_proposal.sha256 !== proposal.proposal_sha256) return null;
  return attempt;
}
