import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshRetainedRepairTargets} from '../core/skill-import/repair-target-refresh.mjs';
const base={activities:[{key:'compile'},{key:'saved'},{key:'invalid_route'}],choices:[{key:'selection'}]};
const finding=keys=>({kind:'semantic',code:'coalesce_route_missing',semantic_keys:keys,affected_semantic_fields:['activities.compile.inputs','choices']});
const feedback={code:'AUTHORING_SEMANTIC',findings:[finding(['compile','saved'])]};
const validator=(code,findings)=>()=>{throw Object.assign(new Error('diagnosis'),{code,findings});};
test('retained replay refreshes only matching deterministic findings and keeps original evidence immutable',()=>{
 const before=JSON.stringify({base,feedback});
 const result=refreshRetainedRepairTargets(base,feedback,{validate:validator('AUTHORING_SEMANTIC',[finding(['compile','saved','selection','invalid_route'])])});
 assert.deepEqual(result.targets[0].semantic_keys,['compile','saved','selection','invalid_route']);
 assert.equal(result.receipt.outcome,'matching_deterministic_findings');
 assert.notEqual(result.receipt.previous_findings_sha256,result.receipt.current_findings_sha256);
 assert.equal(JSON.stringify({base,feedback}),before);
 const valid=refreshRetainedRepairTargets(base,feedback,{validate:()=>{}});
 assert.deepEqual(valid.targets,feedback.findings);assert.equal(valid.receipt.outcome,'base_now_valid');
});
test('mechanical failures, new diagnoses, invented keys and unrelated scope stay visible without replay',()=>{
 assert.throws(()=>refreshRetainedRepairTargets(base,feedback,{validate:validator('HOST_BINDING',[])}),{code:'HOST_BINDING'});
 assert.throws(()=>refreshRetainedRepairTargets(base,feedback,{validate:validator('AUTHORING_SEMANTIC',[{...finding(['compile']),code:'different'}])}),{code:'GENERATION_RECHECK_REPAIR_TARGET'});
 assert.throws(()=>refreshRetainedRepairTargets(base,feedback,{validate:validator('AUTHORING_SEMANTIC',[finding(['unrelated'])])}),{code:'GENERATION_RECHECK_REPAIR_TARGET'});
 assert.throws(()=>refreshRetainedRepairTargets(base,feedback,{validate:validator('AUTHORING_SEMANTIC',[finding(['compile','invented'])])}),{code:'GENERATION_RECHECK_REPAIR_TARGET'});
});
