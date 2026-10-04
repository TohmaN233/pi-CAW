import {canonicalJSON,digest} from '../workflow-revisions.mjs';
import {requireValue} from '../workflow-paths.mjs';
import {SEMANTIC_BLUEPRINT_CONTRACT} from '../authoring/blueprint-contract.mjs';

export function selectRetainedAuthoringAttempt(record,sourceAttemptId) {
  requireValue(sourceAttemptId===undefined||typeof sourceAttemptId==='string'&&sourceAttemptId.length>0,
    'GENERATION_RECHECK_SOURCE','source_attempt_id must identify an exact retained planner attempt');
  const attempts=record.state.nodes.expand?.attempts??[];
  const attempt=sourceAttemptId===undefined?[...attempts].reverse().find(item=>item.status==='succeeded'&&item.result_proposal):attempts.find(item=>item.id===sourceAttemptId);
  requireValue(attempt?.status==='succeeded'&&attempt.result_proposal?.sha256,'GENERATION_RECHECK_SOURCE',
    sourceAttemptId===undefined?'No durable completed planner proposal is available':'Selected planner attempt must be succeeded with an exact durable result artifact');
  return attempt;
}

// Call only after the selected immutable completion has been byte/hash verified.
// Journal-persisted semantic plans are replay inputs; compiled IR is not one.
export function retainedAuthoringReplaySource(record,attempt,completion) {
  requireValue(completion?.status==='succeeded'&&completion.structured_output,'GENERATION_RECHECK_SOURCE',
    'The planner artifact must be a successful structured completion');
  const rawOutputHash=digest(canonicalJSON(completion.structured_output)),projection=record.state.generation_projection;
  if(projection?.authoring_plan&&projection.source_attempt_id===attempt.id){
    requireValue(projection.source_output_hash===rawOutputHash,'GENERATION_PROJECTION_CONFLICT',
      'Retained semantic projection belongs to different original planner bytes',{source_attempt_id:attempt.id});
    requireValue(projection.authoring_plan.contract===SEMANTIC_BLUEPRINT_CONTRACT,'GENERATION_PROJECTION_CONFLICT',
      'Retained semantic projection must contain the full semantic blueprint, never compiled IR');
    return {sourceOutput:{proposal:structuredClone(projection.authoring_plan)},origin:'exact_semantic_projection',rawOutputHash,previousPlan:null,repairFeedback:null};
  }
  const recorded=record.state.generation_repair?.plan_ledger?.find(item=>item.attempt_id===attempt.id&&item.output_hash===rawOutputHash);
  if(recorded){
    requireValue(recorded.proposal?.contract===SEMANTIC_BLUEPRINT_CONTRACT,'GENERATION_PROJECTION_CONFLICT',
      'Retained cumulative ledger must contain the full semantic blueprint, never compiled IR');
    return {sourceOutput:{proposal:structuredClone(recorded.proposal)},origin:'exact_cumulative_ledger',rawOutputHash,previousPlan:null,repairFeedback:null};
  }
  const current=record.state.nodes.expand.active_attempt_id===attempt.id,repair=record.state.generation_repair;
  // Once feedback has promoted this attempt to the new base, that base cannot
  // also be used to apply its own original patch a second time.
  const baseIsOriginal=current&&repair?.latest_cumulative_plan?.attempt_id!==attempt.id;
  return {sourceOutput:structuredClone(completion.structured_output),origin:'original_artifact',rawOutputHash,
    previousPlan:baseIsOriginal?repair?.previous_proposal??null:null,repairFeedback:baseIsOriginal?repair?.feedback??null:null};
}
