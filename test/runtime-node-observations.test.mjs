import test from 'node:test';
import assert from 'node:assert/strict';
import {dependencyExecutables} from '../core/skill-import/source-contracts.mjs';
import {observedSourceRequirements} from '../core/skill-import/source-requirements.mjs';
import {applySemanticRepair,SEMANTIC_REPAIR_CONTRACT} from '../core/authoring/blueprint-contract.mjs';
import {readFile} from 'node:fs/promises';

const source='Call registered study_response_commit with directly bound Root taskId and requestId, study_task_context\'s exact bindingSha256 and the new author answer. Host rechecks phase and selected source bytes, writes an additive canonical learning note and returns its exact receipt. This is the required terminal finalizer; succeeded must be true. No final Main node, whole-project loop or answer transcription follows. Existing human notes, source versions, progress records and private answer controls remain intact.';
test('graph and data nodes never infer a JavaScript runtime from unrelated verbs in source prose',()=>{
 for(const text of [source,'Use each workflow node with its bound outputs.','A required graph node saves the answer.','Node records require review.','Need a node for each branch.','Run the Host compiler; the final Main node is not used.','Python is required. Use the last Main node for finalization.'])assert.equal(dependencyExecutables(text).includes('node'),false,text);
 assert.equal(observedSourceRequirements({'source/SKILL.md':Buffer.from('# Question\n\n'+source)}).some(item=>item.requirement_kind==='dependency'&&item.details.executable==='node'),false);
 for(const text of ['node scripts/build.mjs','node "scripts/build.mjs"','`node --version`','Install Node.js before executing generated code.','Node must be available on PATH.','Use node scripts/build.js.'])assert.ok(dependencyExecutables(text).includes('node'),text);
 assert.deepEqual(dependencyExecutables('python "node"'),['python']);
});
test('bounded repair can remove directly linked requirement/dependency handoffs but keeps unrelated evidence protected',async()=>{
 const base=JSON.parse(await readFile(new URL('./fixtures/artifact-plan.json',import.meta.url),'utf8'));
 base.requirement_assignments=[{requirement_id:'linked',activity_keys:['author_bundle']},{requirement_id:'unrelated',activity_keys:['persist']}];
 base.runtime_dependencies=[{key:'linked_runtime',activity_keys:['author_bundle'],source_section:'section_03_author_one_product'},{key:'unrelated_runtime',activity_keys:['persist'],source_section:'section_04_persist_and_validate'}];
 const collections=['source_dispositions','requirement_assignments','runtime_dependencies','records','lists','enums','activities','approvals','sequences','parallels','choices'];
 const patch={contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',remove:Object.fromEntries(collections.map(name=>[name,[]])),upsert:Object.fromEntries(collections.map(name=>[name,[]]))};
 patch.remove.requirement_assignments=['linked'];patch.remove.runtime_dependencies=['linked_runtime'];
 const options={targets:[{semantic_keys:['author_bundle'],affected_semantic_fields:['activities.inputs','runtime_dependencies']}]};
 const after=applySemanticRepair(base,patch,options);
 assert.deepEqual(after.requirement_assignments,[base.requirement_assignments[1]]);assert.deepEqual(after.runtime_dependencies,[base.runtime_dependencies[1]]);
 for(const [collection,id] of [['requirement_assignments','unrelated'],['runtime_dependencies','unrelated_runtime']]){const bad=structuredClone(patch);bad.remove[collection]=[id];assert.throws(()=>applySemanticRepair(base,bad,options),{code:'AUTHORING_REPAIR_SCOPE'});}
});
