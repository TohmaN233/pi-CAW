import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from './physical-tempdir.mjs';
import { compileWorkflowBrief } from '../core/skill-import/workflow-authoring.mjs';
import { readSkillSnapshot } from '../core/skill-import/skill-reader.mjs';
import { compileCoarseSkill } from '../core/skill-import/coarse-compiler.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';
import { prepareResources,revisionHash } from '../core/workflow-revisions.mjs';
import { WorkflowForge,lowerSemanticBlueprint } from '../core/authoring/workflow-forge.mjs';
import { applySemanticRepair,INTERNAL_SEMANTIC_BLUEPRINT_SCHEMA,normalizeSemanticBlueprint,PREVIOUS_COMPACT_SEMANTIC_BLUEPRINT_CONTRACT,PREVIOUS_COMPACT_SEMANTIC_BLUEPRINT_SCHEMA,PREVIOUS_FANOUT_SEMANTIC_BLUEPRINT_CONTRACT,PREVIOUS_FANOUT_SEMANTIC_BLUEPRINT_SCHEMA,PREVIOUS_SEMANTIC_BLUEPRINT_CONTRACT,SEMANTIC_BLUEPRINT_CONTRACT,SEMANTIC_BLUEPRINT_SCHEMA,SEMANTIC_REPAIR_CONTRACT } from '../core/authoring/blueprint-contract.mjs';
import { semanticLoopFindings,sourceRepairLoopIntentFindings } from '../core/authoring/semantic-loops.mjs';
import { evaluateExpression } from '../core/workflow-bindings.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { deterministicProposalFindings } from '../core/skill-import/proposal-validation.mjs';

const source='# Repair process\n\nImplement the requested artifacts.\n\nReview the artifacts independently. If review rejects an item, repair the failed item and review again until all items are accepted, with at most three rounds.';
const providers=['native-luna','native-sol','native-astra'].map(id=>({id,kind:'native_agent',enabled:true,capabilities:{read:true,write:true},config:{}}));
const rules={version:1,instructions:'Host routing',selection_mode:'automatic',routes:{implementation:{provider_id:'native-luna',role:'implementer'},complex_implementation:{provider_id:'native-sol',role:'implementer'},review:{provider_id:'native-sol',role:'reviewer'},planning:{provider_id:'native-astra',role:'implementer'}}};
const context={routing_rules:rules,routing_catalog:providers,providers,roles:[]};
function fixture(compiled){const snapshot={workflow:compiled.workflow,resources:prepareResources(compiled.resources).manifest,provenance:compiled.provenance,import_report:compiled.import_report};return {pack:{...snapshot,revision_hash:revisionHash(snapshot)},resources:compiled.resources};}
const fixtureFromBrief=brief=>fixture(compileWorkflowBrief({workflow_id:'loop-brief',name:'Loop brief',brief,provider_id:'native-luna'}));
const briefFixture=()=>fixtureFromBrief(source);
const shape=(name,kind,type_ref='')=>({name,kind,type_ref,values:[]});
function plan(resources,{items=false}={}){
  const sections=sourceSectionInventory(resources).map(item=>item.section_id);
  const activities=[{key:'repair',instructions:'Repair only defects in the supplied findings, preserving accepted work.',profile:'worker_write',source_sections:sections,inputs:items?[{name:'items',from:'loop:quality.repair_items'}]:[{name:'task',from:'input:task'},{name:'feedback',from:'loop:quality.feedback'}],outputs:[shape('completed','boolean')],tool:''},
    {key:'review',instructions:'Inspect the current artifacts independently and return new semantic findings in supplied item order.',profile:'review',source_sections:sections,inputs:items?[{name:'items',from:'loop:quality.review_items'}]:[{name:'completed',from:'repair.completed'}],outputs:items?[shape('verdicts','list','verdict_list')]:[shape('accepted','boolean'),shape('findings','text')],tool:''}];
  return {contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Repair artifacts under independent bounded review.',source_dispositions:sections.map(section_id=>({section_id,disposition:'workflow',activity_keys:['repair','review'],note:'Required process.'})),requirement_assignments:[],runtime_dependencies:[],records:items?[{key:'verdict',open:false,fields:[{name:'accepted',type:'boolean',required:true},{name:'findings',type:'text',required:true}]}]:[],lists:items?[{key:'verdict_list',item_type:'verdict'}]:[],enums:[],activities,approvals:[],sequences:[{key:'body',members:['repair','review'],failure_meaning:'all_required'}],parallels:[],choices:[],loops:[{key:'quality',entry_activity:'repair',exit_activity:'review',activity_keys:['repair','review'],max_rounds:3,until:items?{loop:'quality',output:'all_accepted'}:{activity:'review',output:'accepted'},feedback_inputs:items?[]:[{name:'findings',from:'review.findings'}],...(items?{item_scope:{items:'input:items',verdicts:'review.verdicts',paths_field:'paths',dependencies_field:'dependencies'}}:{})}]};
}

test('Build Workflow and Skill2Workflow deterministically compile equivalent real bounded loops',async()=>{
  const root=await mkdtemp(join(tmpdir(),'authoring-loops-'));
  try{
    await writeFile(join(root,'SKILL.md'),'---\nname: loop-fixture\ndescription: Bounded artifact repair\n---\n\n'+source);
    const skill=fixture(compileCoarseSkill(await readSkillSnapshot(join(root,'SKILL.md')),{id:'loop-skill',providerId:'native-luna'})),brief=briefFixture();
    const outputs=[brief,skill].map(fixture=>new WorkflowForge().compile({...fixture,blueprint:plan(fixture.resources),context}));
    assert.deepEqual(outputs[0].compiled.workflow.loops,outputs[1].compiled.workflow.loops);
    for(const [index,result] of outputs.entries()){
      assert.equal(result.compiled.validation.valid,true);
      const loop=result.compiled.workflow.loops[0];
      assert.equal(loop.id,'loop_001');assert.equal(loop.max_rounds,3);
      const review=result.compiled.workflow.nodes.find(node=>node.id===loop.exit_node);
      assert.equal(review.access,'read_only');assert.equal(review.executor.kind,'provider');assert.equal(review.executor.provider_id,'native-sol');
      assert.notEqual(result.compiled.workflow.finalization.node_id,loop.exit_node);
      assert.equal(result.proposal.nodes.find(node=>node.semantic_key==='repair').input_bindings.feedback,'/loops/loop_001/feedback');
      assert.equal(sourceRepairLoopIntentFindings(result.proposal,[brief,skill][index].resources).length,0);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('item loop compiles Host handoffs and first-round empty repair bypass',()=>{
  const fixture=briefFixture(),blueprint=plan(fixture.resources,{items:true});validateData(blueprint,SEMANTIC_BLUEPRINT_SCHEMA);
  const result=new WorkflowForge().compile({...fixture,blueprint,context}),loop=result.compiled.workflow.loops[0],entry=result.compiled.workflow.nodes.find(node=>node.id===loop.entry_node);
  assert.equal(entry.type,'condition');assert.equal(loop.item_scope.items,'/inputs/items');assert.equal(loop.item_scope.paths_field,'paths');
  assert.equal(loop.item_scope.dependencies_field,'dependencies');assert.equal(loop.until.args[0].path,'/loops/loop_001/all_accepted');
  assert.equal(evaluateExpression(entry.cases[0].when,{loops:{loop_001:{repair_items:[]}}}),false);
  assert.equal(evaluateExpression(entry.cases[0].when,{loops:{loop_001:{repair_items:[{paths:['out.txt'],findings:'Fix the defect.'}]}}}),true);
  const reviewer=result.proposal.nodes.find(node=>node.semantic_key==='review');assert.deepEqual(reviewer.input_bindings,{items:'/loops/loop_001/review_items'});
  assert.equal(result.compiled.workflow.inputs_schema.properties.items.type,'array');
  assert.equal(result.compiled.validation.valid,true);
});

test('semantic loop defects reject unsafe bounds, changed identities, write reviewers and broken regions',()=>{
  const fixture=briefFixture(),valid=plan(fixture.resources);
  for(const value of [0,-1,Infinity,Number.MAX_SAFE_INTEGER+1]){const bad=structuredClone(valid);bad.loops[0].max_rounds=value;assert.ok(semanticLoopFindings(bad).some(item=>item.code==='loop_bound'));}
  const large=structuredClone(valid);large.loops[0].max_rounds=100;assert.equal(semanticLoopFindings(large).length,0);
  assert.throws(()=>lowerSemanticBlueprint(fixture.pack,fixture.resources,large,context),error=>error.findings?.some(item=>item.code==='loop_source_bound'));
  for(const mutate of [b=>b.activities[1].profile='orchestration_read',b=>b.activities[1].fail_on_false=['accepted'],b=>b.loops[0].until.activity='repair',b=>b.loops[0].activity_keys=['repair'],b=>b.activities[0].inputs[1].from='loop:missing.feedback']){
    const bad=structuredClone(valid);mutate(bad);assert.throws(()=>lowerSemanticBlueprint(fixture.pack,fixture.resources,bad,context),error=>['AUTHORING_SEMANTIC','GENERATION_PROPOSAL_CONTRACT'].includes(error.code));
  }
  const copied=structuredClone(valid);copied.activities[1].instructions='Copy the supplied item IDs into your findings.';
  assert.throws(()=>lowerSemanticBlueprint(fixture.pack,fixture.resources,copied,context),error=>error.findings?.some(item=>item.code==='agent_deterministic_transcription'));
});

test('local retry stays local and cannot satisfy explicit downstream semantic loop intent',()=>{
  const fixture=briefFixture(),blueprint=plan(fixture.resources);delete blueprint.loops;
  blueprint.activities[0].inputs=[{name:'task',from:'input:task'}];blueprint.activities[0].repeat_until={condition:'The local attempt succeeds.',max_attempts:2};
  assert.throws(()=>new WorkflowForge().compile({...fixture,blueprint,context}),error=>error.findings?.some(item=>item.code==='loop_source_missing'));
  const local=fixtureFromBrief('# Process\n\nImplement the artifact. If a local attempt fails, retry that node at most twice. Review once afterward.');
  const localPlan=plan(local.resources);delete localPlan.loops;localPlan.activities[0].inputs=[{name:'task',from:'input:task'}];localPlan.activities[0].repeat_until=blueprint.activities[0].repeat_until;
  const result=new WorkflowForge().compile({...local,blueprint:localPlan,context});
  assert.equal(result.compiled.workflow.loops?.length??0,0);assert.equal(result.proposal.nodes.find(node=>node.semantic_key==='repair').retry_max_attempts,2);
  assert.ok(deterministicProposalFindings(result.proposal,result.compiled,14,fixture.resources).semantic.some(item=>item.code==='loop_source_missing'));
  const simple={'source/WORKFLOW.md':Buffer.from('# Process\n\nImplement and review the artifacts once.')};assert.equal(sourceRepairLoopIntentFindings(result.proposal,simple).length,0);
  const localReview={'source/WORKFLOW.md':Buffer.from('# Process\n\nOne worker reviews and repairs its own artifact until its local checks pass.')};assert.equal(sourceRepairLoopIntentFindings(result.proposal,localReview).length,0);
  for(const instruction of [
    'One worker must repair its own draft and review again, up to three rounds.',
    'One worker must repeat repair and review of its own artifact until its local checks pass, at most three rounds.',
    'Do not use a downstream reviewer. One worker must repair its own draft and review again, up to three rounds.',
    'The documentation mentions a downstream reviewer. One worker must repeat repair and review of its own artifact until its local checks pass, at most three rounds.',
  ]){
    const localRepeat={'source/WORKFLOW.md':Buffer.from(`# Process\n\n${instruction}`)};
    assert.equal(sourceRepairLoopIntentFindings({nodes:[],loops:[]},localRepeat).length,0,instruction);
  }
  const unbounded={'source/WORKFLOW.md':Buffer.from('# Process\n\nAn independent reviewer inspects artifacts. Repair defects and review again until accepted, without a maximum.')};assert.ok(sourceRepairLoopIntentFindings(result.proposal,unbounded).some(item=>item.code==='loop_source_unbounded'));
});

test('targeted repair can add a loop linked to diagnosed semantic activities',()=>{
  const fixture=briefFixture(),blueprint=plan(fixture.resources),loop=blueprint.loops[0];delete blueprint.loops;
  const repaired=applySemanticRepair(blueprint,{contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:{loops:[loop]},remove:{}},{targets:[{semantic_keys:['repair','review']}]});
  assert.deepEqual(repaired.loops,[loop]);assert.deepEqual(repaired.activities,blueprint.activities);
});

test('nested parent region includes the Host-generated child empty-repair control',()=>{
  const fixture=briefFixture(),blueprint=plan(fixture.resources,{items:true}),sections=blueprint.activities[0].source_sections;
  blueprint.activities.unshift({key:'prepare',instructions:'Prepare the initial artifact state.',profile:'worker_write',source_sections:sections,inputs:[{name:'task',from:'input:task'}],outputs:[shape('ready','boolean')],tool:''});
  blueprint.activities.push({key:'complete_review',instructions:'Independently inspect the integrated artifact and return acceptance.',profile:'review',source_sections:sections,inputs:[{name:'verdicts',from:'review.verdicts'}],outputs:[shape('accepted','boolean')],tool:''});
  blueprint.sequences[0].members=['prepare','repair','review','complete_review'];
  blueprint.loops.unshift({key:'overall',entry_activity:'prepare',exit_activity:'complete_review',activity_keys:['prepare','repair','review','complete_review'],max_rounds:3,until:{activity:'complete_review',output:'accepted'}});
  const result=new WorkflowForge().compile({...fixture,blueprint,context}),outer=result.compiled.workflow.loops.find(loop=>loop.id==='loop_001'),inner=result.compiled.workflow.loops.find(loop=>loop.id==='loop_002');
  assert.equal(result.compiled.validation.valid,true);assert.ok(outer.node_ids.includes(inner.entry_node));assert.ok(inner.node_ids.every(id=>outer.node_ids.includes(id)));
});

test('source loop gate defers negated, one-pass, uncertain and reference discussion clauses',()=>{
  const examples=[
    'Use an independent reviewer. Fix any findings once; do not repeat the review.',
    'Use an independent reviewer. Repair once and never review again.',
    'Use an independent reviewer. Repair once without repeating the review.',
    'Use an independent reviewer. Fix findings once. The documentation describes how to repeat the review.',
    'Use an independent reviewer. Fix findings once. You may review again if desired.',
    'Use an independent reviewer. Repair and review again is not required.',
    'Use an independent reviewer. Repeat the review for style feedback. Repair the deployment configuration once.',
    'Use an independent reviewer. Fix the deployment configuration once. Review the style samples again.',
    'Use an independent reviewer. The label is "repair defects and review again". Fix the artifacts once.',
    '使用独立审核员。只修复一次；不要重复审核。',
    '使用独立审核员。修复发现的问题一次，无需再次审核。',
    '使用独立审核员。修复一次，不重复审查。',
    '使用独立审核员。可以考虑修复后重新审核。',
    '使用独立审核员。修复后重新审核不是必须的。',
    '使用独立审核员。修复一次。参考文档提到修复后重新审核。',
    '使用独立审核员。修复部署配置一次。对样例重新审核。',
    '使用独立审核员。示例标签是“修复后重新审核”。仅执行一次。',
  ];
  for(const example of examples){
    const fixture=fixtureFromBrief(`# Process\n\n${example}`),blueprint=plan(fixture.resources);delete blueprint.loops;blueprint.activities[0].inputs=[{name:'task',from:'input:task'}];
    assert.doesNotThrow(()=>new WorkflowForge().compile({...fixture,blueprint,context}),example);
  }
  for(const example of [
    'Use an independent reviewer. If review rejects the artifact, repair its defects and review again, with at most three rounds.',
    'Use an independent reviewer. Repair the findings; then repeat the review, with at most three rounds.',
    'A downstream reviewer inspects the artifact. Repair defects and review again, with at most three rounds.',
    '使用独立审核员。若审核不通过，修复问题后重新审核，最多3轮。',
    '使用独立审核员。修复问题；再次审核，最多3轮。',
  ]){
    const resources={'source/WORKFLOW.md':Buffer.from(`# Process\n\n${example}`)};
    assert.ok(sourceRepairLoopIntentFindings({nodes:[],loops:[]},resources).some(item=>item.code==='loop_source_missing'),example);
  }
});


test('semantic loop review can inherit Main in a fresh read-only worker context without forced Provider switching',()=>{
  const fixture=briefFixture();
  for(const profile of ['main_read','worker_read','worker_complex_read']){
    const blueprint=plan(fixture.resources);blueprint.activities[1].profile=profile;
    assert.equal(semanticLoopFindings(blueprint).length,0);
    const result=new WorkflowForge().compile({...fixture,blueprint,context});
    const exit=result.compiled.workflow.nodes.find(node=>node.id===result.compiled.workflow.loops[0].exit_node);
    assert.equal(result.compiled.validation.valid,true);assert.equal(exit.access,'read_only');
    if(profile==='main_read'){assert.equal(exit.executor.kind,'main');assert.equal(exit.executor.mode??'worker','worker');}
  }
  const continued=plan(fixture.resources);continued.activities[1].task_continues='repair';
  assert.ok(semanticLoopFindings(continued).some(item=>item.code==='loop_independent_review'));
});

test('explicit current-Main semantic loops lower the uncapped acceptance contract and reject unsafe exits',()=>{
  const fixture=fixtureFromBrief('# Process\n\nCurrent Main reviews the repaired artifacts until accepted, without a maximum.');
  const blueprint=plan(fixture.resources);
  blueprint.activities[1].profile='orchestration_read';
  blueprint.loops[0].review_context='current_main';
  blueprint.loops[0].max_rounds=null;
  validateData(blueprint,SEMANTIC_BLUEPRINT_SCHEMA);
  assert.deepEqual(semanticLoopFindings(blueprint),[]);
  const result=new WorkflowForge().compile({...fixture,blueprint,context}),loop=result.compiled.workflow.loops[0];
  assert.equal(result.compiled.validation.valid,true);
  assert.equal(loop.review_context,'current_main');
  assert.equal(loop.max_rounds,null);
  assert.deepEqual(loop.until,{op:'eq',args:[{path:`/nodes/${loop.exit_node}/output/accepted`},{value:true}]});
  const mainReview=result.compiled.workflow.nodes.find(node=>node.id===loop.exit_node);
  assert.equal(mainReview.access,'read_only');
  assert.equal(mainReview.executor.kind,'main');
  assert.equal(mainReview.executor.mode,'orchestration');
  assert.equal(mainReview.outputs_schema.properties.accepted.type,'boolean');
  assert.equal(sourceRepairLoopIntentFindings(result.proposal,fixture.resources).length,0);

  const boundedFixture=briefFixture(),finite=plan(boundedFixture.resources);
  finite.activities[1].profile='orchestration_read';
  finite.loops[0].review_context='current_main';
  assert.deepEqual(semanticLoopFindings(finite),[]);
  assert.equal(new WorkflowForge().compile({...boundedFixture,blueprint:finite,context}).compiled.workflow.loops[0].max_rounds,3);

  const invalid=[
    ['ordinary loops cannot be uncapped',value=>{delete value.loops[0].review_context;value.loops[0].max_rounds=null;}],
    ['current Main must be read-only',value=>{value.activities[1].profile='orchestration_write';}],
    ['current Main must stop on accepted',value=>{value.loops[0].until.output='findings';}],
    ['current Main must stop on true',value=>{value.loops[0].until.value=false;}],
    ['current Main must compare accepted with equality',value=>{value.loops[0].until.op='ne';}],
  ];
  for(const [label,mutate] of invalid){
    const bad=structuredClone(blueprint);mutate(bad);
    assert.throws(()=>lowerSemanticBlueprint(fixture.pack,fixture.resources,bad,context),error=>error.code==='AUTHORING_SEMANTIC',label);
  }
});

test('unbounded source intent needs an exact covering current-Main loop with accepted true',()=>{
  const resource='source/WORKFLOW.md',resources={[resource]:Buffer.from('# Process\n\nCurrent Main reviews until accepted, without a maximum.')};
  const source_span={resource,start_line:3,end_line:3};
  const proposal={nodes:[
    {id:'repair',semantic_key:'repair',source_spans:[source_span]},
    {id:'review',semantic_key:'review',source_spans:[source_span],type:'agent',operation_mode:'read',execution_target:'main',main_mode:'orchestration',outputs_schema:{type:'object',properties:{accepted:{type:'boolean'}}}},
  ],loops:[{entry_node:'repair',exit_node:'review',node_ids:['repair','review'],review_context:'current_main',max_rounds:null,until:{op:'eq',args:[{path:'/nodes/review/output/accepted'},{value:true}]}}]};
  assert.deepEqual(sourceRepairLoopIntentFindings(proposal,resources),[]);
  for(const instruction of [
    '当前 Main 审阅直到通过，不设上限。',
    '由当前 Main 复审直到通过，不设上限。',
  ]){
    const chinese={[resource]:Buffer.from(`# 流程\n\n${instruction}`)};
    assert.deepEqual(sourceRepairLoopIntentFindings(proposal,chinese),[],instruction);
  }
  for(const instruction of [
    'The current Main must review the artifact once.',
    'The current Main must inspect the completed artifact.',
  ]){
    const onePass={[resource]:Buffer.from(`# Process\n\n${instruction}`)};
    assert.deepEqual(sourceRepairLoopIntentFindings({...proposal,loops:[]},onePass),[],instruction);
  }
  const independent={[resource]:Buffer.from('# Process\n\nAn independent reviewer inspects artifacts. Repair defects and review again until accepted, without a maximum.')};
  assert.ok(sourceRepairLoopIntentFindings(proposal,independent).some(item=>item.code==='loop_source_unbounded'));
  for(const instruction of [
    '不允许当前 Main 审阅。 An independent reviewer inspects artifacts. Repair defects and review again until accepted, without a maximum.',
    'An independent reviewer inspects artifacts. Repair defects and review again until accepted, without a maximum. 可选：当前 Main 审阅直到通过，不设上限。',
  ]){
    const nonaffirmative={[resource]:Buffer.from(`# Process\n\n${instruction}`)};
    assert.ok(sourceRepairLoopIntentFindings(proposal,nonaffirmative).some(item=>item.code==='loop_source_unbounded'),instruction);
  }
  for(const statement of [
    'Do not use an independent reviewer.',
    'The documentation mentions an independent reviewer.',
    '"Use an independent reviewer."',
  ]){
    const source={[resource]:Buffer.from(`# Process\n\nCurrent Main reviews until accepted, without a maximum. ${statement}`)};
    assert.deepEqual(sourceRepairLoopIntentFindings(proposal,source),[],statement);
  }
  const affirmativeIndependent={[resource]:Buffer.from('# Process\n\nCurrent Main reviews until accepted, without a maximum. Use an independent reviewer.')};
  assert.ok(sourceRepairLoopIntentFindings(proposal,affirmativeIndependent).some(item=>item.code==='loop_source_unbounded'));
  for(const mutate of [
    value=>delete value.loops[0].review_context,
    value=>{value.loops[0].max_rounds=3;},
    value=>{value.loops[0].node_ids=['review'];},
    value=>{value.loops[0].until.args[0].path='/nodes/review/output/findings';},
    value=>{value.loops[0].until.args[1].value=false;},
    value=>{value.nodes[1].main_mode='worker';},
  ]){
    const bad=structuredClone(proposal);mutate(bad);
    assert.ok(sourceRepairLoopIntentFindings(bad,resources).some(item=>item.code==='loop_source_unbounded'));
  }
});

test('historical v3, v4 and v5 loop contracts stay readable and finite-only',()=>{
  const fixture=briefFixture(),compact=plan(fixture.resources);
  for(const [contract,schema] of [
    [PREVIOUS_COMPACT_SEMANTIC_BLUEPRINT_CONTRACT,PREVIOUS_COMPACT_SEMANTIC_BLUEPRINT_SCHEMA],
    [PREVIOUS_FANOUT_SEMANTIC_BLUEPRINT_CONTRACT,PREVIOUS_FANOUT_SEMANTIC_BLUEPRINT_SCHEMA],
  ]){
    const historical={...structuredClone(compact),contract};
    validateData(historical,schema);
    const historicalSingleton=structuredClone(historical);
    historicalSingleton.loops[0].activity_keys=[historicalSingleton.loops[0].entry_activity];
    validateData(historicalSingleton,schema);
    const normalized=normalizeSemanticBlueprint(historical);
    assert.equal(normalized.loops[0].max_rounds,3);
    validateData(normalized,INTERNAL_SEMANTIC_BLUEPRINT_SCHEMA);
    for(const mutate of [
      value=>{value.loops[0].review_context='current_main';},
      value=>{value.loops[0].max_rounds=null;},
    ]){
      const invalid=structuredClone(historical);mutate(invalid);
      assert.throws(()=>validateData(invalid,schema),{code:'DATA_INVALID'});
    }
  }

  const internal=normalizeSemanticBlueprint(compact);
  assert.equal(internal.contract,PREVIOUS_SEMANTIC_BLUEPRINT_CONTRACT);
  assert.equal(internal.loops[0].max_rounds,3);
  validateData(internal,INTERNAL_SEMANTIC_BLUEPRINT_SCHEMA);
  const internalSingleton=structuredClone(internal);
  internalSingleton.loops[0].activity_keys=[internalSingleton.loops[0].entry_activity];
  validateData(internalSingleton,INTERNAL_SEMANTIC_BLUEPRINT_SCHEMA);
  for(const mutate of [
    value=>{value.loops[0].review_context='current_main';},
    value=>{value.loops[0].max_rounds=null;},
  ]){
    const invalid=structuredClone(internal);mutate(invalid);
    assert.throws(()=>validateData(invalid,INTERNAL_SEMANTIC_BLUEPRINT_SCHEMA),{code:'DATA_INVALID'});
  }

  const currentSingleton=structuredClone(compact);
  currentSingleton.loops[0].activity_keys=[currentSingleton.loops[0].entry_activity];
  assert.throws(()=>validateData(currentSingleton,SEMANTIC_BLUEPRINT_SCHEMA),{code:'DATA_INVALID'});
});
