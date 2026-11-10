import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { requireValue } from '../core/workflow-paths.mjs';

const OUTCOMES = Object.freeze({
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
});

const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Project one already-read, settled terminal Run into body-free evidence. */
export function createEvolutionObservation(record, { settled = false } = {}) {
  requireValue(record && typeof record === 'object' && record.state && typeof record.state === 'object',
    'EVOLUTION_EVIDENCE_RECORD', 'Evolution evidence needs an observed Run record');
  if (!settled) return null;

  const { state, pins, sequence, events } = record;
  const outcome = OUTCOMES[state.status];
  if (!outcome) return null;

  const root = pins?.root;
  requireValue(typeof state.run_id === 'string' && state.run_id.length > 0
    && typeof state.workflow_id === 'string' && root?.workflow?.id === state.workflow_id
    && typeof root.revision_hash === 'string' && sha256(root.revision_hash),
  'EVOLUTION_EVIDENCE_IDENTITY', 'Terminal Run identity and pinned Workflow revision must agree');
  requireValue(typeof state.main_actor === 'string' && state.main_actor.length > 0
    && state.permissions && typeof state.permissions.workspace === 'string'
    && state.inputs && typeof state.inputs === 'object' && !Array.isArray(state.inputs)
    && state.constraints && typeof state.constraints === 'object' && !Array.isArray(state.constraints)
    && sha256(state.pins_hash),
  'EVOLUTION_EVIDENCE_CONFIGURATION', 'Terminal Run inputs, actor, workspace and pinned configuration are required');
  requireValue(Number.isSafeInteger(sequence) && sequence > 0 && Array.isArray(events),
    'EVOLUTION_EVIDENCE_SEQUENCE', 'Terminal Run needs its verified journal sequence');

  const terminalEvent = events.at(-1);
  requireValue(terminalEvent && terminalEvent.sequence === sequence && sha256(terminalEvent.hash),
    'EVOLUTION_EVIDENCE_RECEIPT', 'Terminal Run needs the exact verified final journal event');

  const terminalIdentity = { runId: state.run_id, sequence, eventHash: terminalEvent.hash, outcome };
  const observationId = digest(canonicalJSON({ schemaVersion: 1, ...terminalIdentity }));
  const sourceRef = `pi-caw://runs/${encodeURIComponent(state.run_id)}/terminal/${sequence}-${terminalEvent.hash}`;
  const inputHash = digest(canonicalJSON(state.inputs));
  // The stored pins hash binds the immutable Workflow, resources, providers and
  // dependent Workflows. Include actual Run grants and constraints as well.
  const configurationHash = digest(canonicalJSON({
    pinsHash: state.pins_hash,
    permissions: state.permissions,
    constraints: state.constraints,
  }));
  const summaries = {
    completed: 'Run completed successfully.',
    failed: 'Run ended in failure.',
    cancelled: 'Run was cancelled.',
  };

  return {
    schemaVersion: 1,
    observationId,
    runId: state.run_id,
    workflowId: root.workflow.id,
    workflowRevision: root.revision_hash,
    actorSessionId: state.main_actor,
    workspace: state.permissions.workspace,
    inputHash,
    configurationHash,
    outcome,
    summary: summaries[outcome],
    sourceRef,
  };
}
