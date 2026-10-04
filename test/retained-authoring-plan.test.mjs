import test from 'node:test';
import assert from 'node:assert/strict';
import {selectRetainedAuthoringAttempt,retainedAuthoringReplaySource} from '../core/skill-import/retained-authoring-plan.mjs';
import {SEMANTIC_BLUEPRINT_CONTRACT,SEMANTIC_REPAIR_CONTRACT} from '../core/authoring/blueprint-contract.mjs';
import {canonicalJSON,digest} from '../core/workflow-revisions.mjs';

const succeeded=id=>({id,status:'succeeded',result_proposal:{sha256:digest(id)}});
const blueprint=purpose=>({contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose});
const completion={status:'succeeded',structured_output:{proposal:{contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:{},remove:{}}}};
const rawHash=digest(canonicalJSON(completion.structured_output));
const record=()=>({state:{nodes:{expand:{attempts:[succeeded('initial'),succeeded('patch')],active_attempt_id:'patch'}},
  generation_projection:{source_attempt_id:'patch',source_output_hash:rawHash,authoring_plan:blueprint('Exact projected semantic plan')},
  generation_repair:{previous_proposal:blueprint('Changed base'),plan_ledger:[{attempt_id:'patch',output_hash:rawHash,proposal:blueprint('Older ledger')}],latest_cumulative_plan:{attempt_id:'patch'}}}});

test('retained attempt selection honors explicit history and rejects absent/failed/empty attempts',()=>{
  const prior=record();prior.state.nodes.expand.attempts.push({id:'failed',status:'failed',result_proposal:{sha256:digest('failed')}});
  assert.equal(selectRetainedAuthoringAttempt(prior).id,'patch');assert.equal(selectRetainedAuthoringAttempt(prior,'initial').id,'initial');
  for(const id of ['absent','failed',''])assert.throws(()=>selectRetainedAuthoringAttempt(prior,id),{code:'GENERATION_RECHECK_SOURCE'});
});
test('exact attempt/output projection precedes the ledger without replaying a patch or compiled IR; mismatches fail visibly',()=>{
  const prior=record(),before=canonicalJSON(prior),attempt=selectRetainedAuthoringAttempt(prior),chosen=retainedAuthoringReplaySource(prior,attempt,completion);
  assert.equal(chosen.origin,'exact_semantic_projection');assert.equal(chosen.sourceOutput.proposal.purpose,'Exact projected semantic plan');
  assert.equal(chosen.rawOutputHash,rawHash);assert.equal(chosen.previousPlan,null);assert.equal(canonicalJSON(prior),before);
  chosen.sourceOutput.proposal.purpose='Caller mutation';assert.equal(prior.state.generation_projection.authoring_plan.purpose,'Exact projected semantic plan');
  for(const mutate of [p=>p.source_output_hash=digest('other bytes'),p=>p.authoring_plan={source_revision:digest('source'),nodes:[],edges:[]}]){
    const bad=record();mutate(bad.state.generation_projection);
    assert.throws(()=>retainedAuthoringReplaySource(bad,attempt,completion),{code:'GENERATION_PROJECTION_CONFLICT'});
  }
  delete prior.state.generation_projection.authoring_plan;
  assert.equal(retainedAuthoringReplaySource(prior,attempt,completion).origin,'exact_cumulative_ledger');
});
test('other-attempt projection is never reused; raw patch cannot use its own promoted cumulative plan as base',()=>{
  const prior=record(),attempt=selectRetainedAuthoringAttempt(prior,'initial');
  prior.state.generation_repair.plan_ledger.push({attempt_id:'initial',output_hash:rawHash,proposal:blueprint('Exact historical semantic plan')});
  assert.equal(retainedAuthoringReplaySource(prior,attempt,completion).sourceOutput.proposal.purpose,'Exact historical semantic plan');
  delete prior.state.generation_projection;prior.state.generation_repair.plan_ledger=[];
  const current=selectRetainedAuthoringAttempt(prior);
  assert.equal(retainedAuthoringReplaySource(prior,current,completion).previousPlan,null);
  prior.state.generation_repair.latest_cumulative_plan.attempt_id='initial';
  assert.equal(retainedAuthoringReplaySource(prior,current,completion).previousPlan.purpose,'Changed base');
});
