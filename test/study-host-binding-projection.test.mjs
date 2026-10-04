import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './fixtures.mjs';
import {importCoarseSkill} from '../core/skill-import/coarse-compiler.mjs';
import {observedSourceRequirements,projectObservedRequirements} from '../core/skill-import/source-requirements.mjs';
import {sourceSectionInventory} from '../core/skill-import/source-dispositions.mjs';
import {sourceContractMap} from '../core/skill-import/source-contracts.mjs';
import {validateGenerationProposal} from '../core/skill-import/proposal-validation.mjs';
import {SEMANTIC_BLUEPRINT_CONTRACT,SEMANTIC_REPAIR_CONTRACT} from '../core/authoring/blueprint-contract.mjs';
import {canonicalJSON,digest} from '../core/workflow-revisions.mjs';
import {validateData} from '../core/workflow-data-schema.mjs';
import {EXPANSION_PROPOSAL_SCHEMA} from '../core/skill-import/expansion-run.mjs';
import {defaultRoutingRules,TASK_TYPES} from '../core/skill-import/routing-rules.mjs';

const closed=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string',minLength:1,maxLength:256};
const hash={type:'string',minLength:64,maxLength:64,pattern:'^[a-f0-9]+$'};
const answer={type:'string',minLength:1,maxLength:20000};
const host=(id,input_schema,output_schema)=>({id,identity:{name:'offline-study-domain',version:'1',sha256:digest(id)},argv:[id],
  input_schema,output_schema,env_allow:[],permissions:{network:false,read_paths:['.'],write_paths:[]},
  output_cap_bytes:131072,deadline_ms:5000,idempotency:{mode:'reconcile_required'}});

test('mapping coverage names never broaden explicit Agent or human-gate input contracts',()=>{
  const resources={'source/SKILL.md':Buffer.from('# Process\n\nReceive user input as the question.\n')},requirements=observedSourceRequirements(resources);
  const proposal={source_requirements:requirements,requirement_mappings:requirements.map(item=>({requirement_id:item.requirement_id,
    node_ids:['context','author','empty','gate','commit'],binding_names:['taskId','bindingSha256','question'],runtime_guards:[],resource_refs:['source/SKILL.md'],status:'agent_assisted',rationale:'The responsible activities preserve the input boundary.'})),
    nodes:[{id:'context',type:'tool',outputs_schema:closed({taskId:text,bindingSha256:hash}),input_bindings:{taskId:'/inputs/taskId'}},
      {id:'author',type:'agent',input_bindings:{question:'/inputs/question'}},{id:'empty',type:'agent',input_bindings:{}},
      {id:'gate',type:'human_gate',input_bindings:{question:'/inputs/question'}},{id:'commit',type:'tool',input_bindings:{}}],
    edges:[['context','author'],['author','empty'],['empty','gate'],['gate','commit']].map(([source,target])=>({source,target}))};
  assert.ok(requirements.some(item=>item.requirement_kind==='user_input'));
  const projected=projectObservedRequirements(proposal,resources);
  for(const id of ['author','empty','gate','commit'])assert.deepEqual(projected.nodes.find(node=>node.id===id).input_bindings,proposal.nodes.find(node=>node.id===id).input_bindings);
  assert.deepEqual(projected.requirement_mappings[0].binding_names,['taskId','bindingSha256','question']);
});

// Public synthetic fixture reproduces the retained v2 Study semantic shape.
// No private Run, question, source material or implementation identity is read.
test('Study initial/repair admission preserves exactly context and question for the Author while Host arguments derive from pinned contracts',async t=>{
  const f=await fixture(t),directory=join(f.root,'study-source');await mkdir(directory);
  await writeFile(join(directory,'SKILL.md'),['---','name: study-explanation','description: Explain the selected learner question.','---','# Process',
    'Receive user input as the question.',
    'Read selected source context through the Host, explain the question, and have the Host persist the answer.',
    'The author returns newly written semantic answer text using author-result.schema.json.',''].join('\n'));
  await writeFile(join(directory,'author-result.schema.json'),JSON.stringify(closed({answer})));
  const pack=await importCoarseSkill(f.service.store,join(directory,'SKILL.md'),{id:'study-explanation',providerId:'worker',role:'implementer'});
  const resources=await f.service.store.resources(pack.workflow.id,pack.revision_hash);
  const sections=sourceSectionInventory(resources).map(item=>item.section_id),contracts=[
    host('study_task_context',closed({taskId:text}),closed({taskId:text,bindingSha256:hash,context:{type:'object'}})),
    host('study_response_commit',closed({taskId:text,requestId:text,bindingSha256:hash,answer}),closed({taskId:text,succeeded:{type:'boolean',const:true},note:closed({noteId:text,revision:{type:'integer',minimum:1}})}))];
  const answerContract=[...sourceContractMap(resources).values()].find(item=>item.json_pointer==='/properties/answer');
  assert.ok(answerContract);
  const shape=(name,kind='text')=>({name,kind,type_ref:'',values:[]});
  const plan={contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Explain the selected question and persist its answer.',
    source_dispositions:sections.map(section_id=>({section_id,disposition:'workflow',activity_keys:['selected_context','author_answer','commit_response'],note:'Preserve the scoped explanation process.'})),
    requirement_assignments:observedSourceRequirements(resources).map(item=>({requirement_id:item.requirement_id,activity_keys:['selected_context','author_answer','commit_response']})),
    runtime_dependencies:[],records:[],lists:[],enums:[],activities:[
      {key:'selected_context',profile:'main_read',tool:'study_task_context',source_sections:sections,instructions:'Read the selected source context through the Host.',inputs:[{name:'taskId',from:'input:taskId'}],outputs:[shape('taskId'),shape('bindingSha256'),shape('context','object')]},
      {key:'author_answer',profile:'worker_read',tool:'',source_sections:sections,instructions:'Explain the question using the selected source context. Return newly authored answer text.',
        inputs:[{name:'context',from:'selected_context.context'},{name:'question',from:'input:question'}],outputs:[{...shape('answer'),contract_ref:answerContract.contract_id}]},
      {key:'commit_response',profile:'main_read',tool:'study_response_commit',source_sections:sections,instructions:'Persist the explanation through the Host.',
        inputs:[{name:'taskId',from:'input:taskId'},{name:'requestId',from:'input:requestId'},{name:'bindingSha256',from:'selected_context.bindingSha256'},{name:'answer',from:'author_answer.answer'}],
        outputs:[shape('succeeded','boolean'),shape('note','object')],on_missing:'block',outcome:'validated_artifact',fail_on_false:['succeeded']},
    ],approvals:[],sequences:[{key:'process',members:['selected_context','author_answer','commit_response'],failure_meaning:'all_required'}],parallels:[],choices:[]};
  const context={...f.service.store.validationContext,host_tools:contracts.map(item=>item.id),host_tool_contracts:contracts};
  const routing_rules={...defaultRoutingRules(),routes:Object.fromEntries(TASK_TYPES.map(type=>[type,{provider_id:'worker',role:'implementer'}]))};
  const options={pack,resources,context,provenance:{...pack.provenance,source_revision:pack.revision_hash,routing_rules}};
  const before=canonicalJSON(plan),identityBefore=canonicalJSON(contracts);
  const check=result=>{
    const author=result.proposal.nodes.find(node=>node.semantic_key==='author_answer'),contextNode=result.proposal.nodes.find(node=>node.semantic_key==='selected_context');
    assert.deepEqual(author.input_bindings,{context:`/nodes/${contextNode.id}/output/context`,question:'/inputs/question'});
    assert.deepEqual(author.outputs_schema,closed({answer}));
    assert.ok(result.proposal.requirement_mappings.some(item=>item.binding_names.includes('taskId')),'Exercise the coverage name that formerly leaked into the Author');
    const commit=result.compiled.workflow.nodes.find(node=>node.executor?.tool==='study_response_commit');
    assert.equal(commit.input_bindings.taskId,'/inputs/taskId');assert.equal(commit.input_bindings.requestId,'/inputs/requestId');
    assert.equal(commit.input_bindings.bindingSha256,`/nodes/${contextNode.id}/output/bindingSha256`);
    validateData(result.proposal,EXPANSION_PROPOSAL_SCHEMA);
    const projected=validateGenerationProposal({proposal:result.proposal,host_pipeline:result.pipeline_trace},options);
    assert.deepEqual(projected.proposal,result.proposal);
  };
  check(validateGenerationProposal({proposal:plan},options));
  const fields=['source_dispositions','requirement_assignments','runtime_dependencies','records','lists','enums','activities','approvals','sequences','parallels','choices'];
  const empty=Object.fromEntries(fields.map(name=>[name,[]])),changed=structuredClone(plan.activities[1]);changed.instructions+=' Relate each explanation to the learner question.';
  const repair={contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:{...empty,activities:[changed]},remove:empty};
  check(validateGenerationProposal({proposal:repair},{...options,previousPlan:plan,repairFeedback:{findings:[{semantic_keys:['author_answer'],affected_semantic_fields:['activities.author_answer.instructions']}]}}));
  // Only qualified required Host arguments may be inferred when not explicit.
  const omitted=structuredClone(plan);omitted.activities[2].inputs=omitted.activities[2].inputs.filter(item=>item.name!=='taskId');
  check(validateGenerationProposal({proposal:omitted},options));
  assert.equal(canonicalJSON(plan),before);assert.equal(canonicalJSON(contracts),identityBefore);
  assert.equal(f.requests.length,0);assert.equal(f.mainRequests.length,0);
});
