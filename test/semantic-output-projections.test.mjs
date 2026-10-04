import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSemanticBlueprintFindings,SEMANTIC_BLUEPRINT_CONTRACT,resolveDeclaredSchemaProjection,semanticProjectionPointer} from '../core/authoring/blueprint-contract.mjs';
import {lowerSemanticBlueprint} from '../core/authoring/workflow-forge.mjs';
import {sourceContractMap} from '../core/skill-import/source-contracts.mjs';
import {sourceSectionInventory} from '../core/skill-import/source-dispositions.mjs';

const closed=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string',minLength:1,maxLength:100};
const result=closed({draft:closed({title:text},[]),files:{type:'array',minItems:0,maxItems:0,items:closed({path:text})}});
function fixture(schema=result){
  const resources={'source/SKILL.md':Buffer.from('# Assignment\n\nProduce the assignment plan and hand its semantic fields to the next activity.\n'),'source/author-result.schema.json':Buffer.from(JSON.stringify(schema))};
  const sourceContracts=sourceContractMap(resources),contract=[...sourceContracts.values()].find(item=>item.json_pointer===''),sections=sourceSectionInventory(resources),sectionIds=sections.map(item=>item.section_id);
  const output=(name,kind='text',type_ref='')=>({name,kind,type_ref,values:[]});
  const plan={contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Prepare an assignment plan',source_dispositions:sectionIds.map(section_id=>({section_id,disposition:'workflow',activity_keys:['author_assignment','consumer'],note:'Produce and consume the bounded semantic result'})),requirement_assignments:[],records:[],lists:[],enums:[],activities:[
    {key:'author_assignment',profile:'worker_read',tool:'',source_sections:sectionIds,instructions:'Produce a new assignment plan.',inputs:[],outputs:[{...output('author_result','object'),contract_ref:contract.contract_id}]},
    {key:'consumer',profile:'worker_read',tool:'',source_sections:sectionIds,instructions:'Assess the assignment plan.',inputs:[{name:'files',from:'author_assignment.author_result.files'},{name:'title',from:'author_assignment.author_result.draft.title'}],outputs:[output('assessment')]},
  ],approvals:[],sequences:[{key:'sequence',members:['author_assignment','consumer'],failure_meaning:'all_required'}],parallels:[],choices:[]};
  const options={sectionIds:new Set(sectionIds),sectionInventory:sections,sourceContracts,contractIds:new Set(sourceContracts.keys())};
  const lower=()=>lowerSemanticBlueprint({workflow:{id:'assignment-projection',requirements:{}}},resources,plan);
  return {plan,resources,options,lower};
}

test('exact semantic schemas authorize nested projections and Forge emits separate pointer segments without altering optionality',()=>{
  const {plan,options,lower}=fixture();
  assert.deepEqual(collectSemanticBlueprintFindings(plan,options),[]);
  const graph=lower(),author=graph.nodes.find(node=>node.semantic_key==='author_assignment'),consumer=graph.nodes.find(node=>node.semantic_key==='consumer');
  assert.deepEqual(author.outputs_schema.properties.author_result,result);
  assert.deepEqual(consumer.input_bindings,{files:`/nodes/${author.id}/output/author_result/files`,title:`/nodes/${author.id}/output/author_result/draft/title`});
  assert.deepEqual(author.outputs_schema.properties.author_result.properties.draft.required,[]);
});

test('unknown properties, open-object guesses and array/scalar traversal fail visibly before lowering',()=>{
  for(const projection of ['author_result.unknown','author_result.draft.missing','author_result.files.path','author_result.files.0','author_result.draft.title.extra','author_result..draft']){
    const {plan,options,lower}=fixture();plan.activities[1].inputs=[{name:'selected',from:`author_assignment.${projection}`}];
    assert.ok(collectSemanticBlueprintFindings(plan,options).some(item=>item.code==='unknown_input_output'),projection);
    assert.throws(lower,error=>error.code==='AUTHORING_SEMANTIC',projection);
  }
  const {plan,options}=fixture(closed({draft:{type:'object',additionalProperties:true},files:result.properties.files}));
  assert.ok(collectSemanticBlueprintFindings(plan,options).some(item=>item.code==='unknown_input_output'));
  assert.equal(resolveDeclaredSchemaProjection({type:'object',additionalProperties:true},'guessed'),null);
  assert.equal(resolveDeclaredSchemaProjection(result,'files.path'),null);
  assert.equal(semanticProjectionPointer('result.a/b.c~d'),'result/a~1b/c~0d');
  const unattested=fixture();delete unattested.options.sourceContracts;
  assert.throws(()=>collectSemanticBlueprintFindings(unattested.plan,unattested.options),error=>error.code==='AUTHORING_FORMAT'&&error.retry_class==='mechanical');
});

test('declared records prove nested fields; exact source schema overrides misleading placeholder records in both deep guard and projection checks',()=>{
  const named=fixture();delete named.plan.activities[0].outputs[0].contract_ref;
  named.plan.activities[0].outputs[0].type_ref='Result';
  named.plan.records=[{key:'Result',open:false,fields:[{name:'draft',type:'Draft',required:true},{name:'files',type:'Files',required:true}]},{key:'Draft',open:false,fields:[{name:'title',type:'text',required:false}]}];
  named.plan.lists=[{key:'Files',item_type:'text'}];
  assert.deepEqual(collectSemanticBlueprintFindings(named.plan,named.options),[]);
  assert.ok(named.lower().nodes.find(node=>node.semantic_key==='consumer').input_bindings.title.endsWith('/author_result/draft/title'));
  const authoritative=fixture();authoritative.plan.activities[0].outputs[0].type_ref='WrongPlaceholder';
  authoritative.plan.records=[{key:'WrongPlaceholder',open:false,fields:[{name:'sourceHash',type:'text',required:true}]}];
  assert.deepEqual(collectSemanticBlueprintFindings(authoritative.plan,authoritative.options),[]);
  assert.deepEqual(authoritative.lower().nodes.find(node=>node.semantic_key==='author_assignment').outputs_schema.properties.author_result,result);
  const unsafe=fixture(closed({...result.properties,draft:closed({title:text,meta:closed({sourceHash:text})})}));
  const defects=collectSemanticBlueprintFindings(unsafe.plan,unsafe.options);
  assert.ok(defects.some(item=>item.code==='agent_deterministic_transcription'&&item.message.includes('sourceHash')));
  assert.throws(unsafe.lower,/Host-owned/);
});

test('pinned Host schemas prove nested output properties even when the semantic output declaration is a placeholder',()=>{
  const {plan,options,resources}=fixture();plan.activities[0].tool='selected_context';plan.activities[0].profile='main_read';delete plan.activities[0].outputs[0].contract_ref;
  const host={id:'selected_context',identity:{name:'selected-context',version:'1',sha256:'a'.repeat(64)},argv:['selected-context'],input_schema:closed({}),output_schema:closed({author_result:result}),env_allow:[],permissions:{network:false,read_paths:['.'],write_paths:[]},output_cap_bytes:10000,deadline_ms:10000,idempotency:{mode:'safe'}};
  options.hostToolContracts=[host];
  assert.deepEqual(collectSemanticBlueprintFindings(plan,options),[]);
  const graph=lowerSemanticBlueprint({workflow:{id:'host-projection',requirements:{},host_tools:[host]}},resources,plan),context=graph.nodes.find(node=>node.semantic_key==='author_assignment'),consumer=graph.nodes.find(node=>node.semantic_key==='consumer');
  assert.deepEqual(context.outputs_schema.properties.author_result,result);
  assert.equal(consumer.input_bindings.title,`/nodes/${context.id}/output/author_result/draft/title`);
  plan.activities[1].inputs=[{name:'unknown',from:'author_assignment.author_result.draft.missing'}];
  assert.ok(collectSemanticBlueprintFindings(plan,options).some(item=>item.code==='unknown_input_output'));
  plan.activities[0].outputs=[];plan.activities[1].inputs=[{name:'files',from:'author_assignment.author_result.files'}];
  assert.ok(collectSemanticBlueprintFindings(plan,options).some(item=>item.code==='unknown_input_output'));
});

test('approval subjects use the same declared nested projection and pointer contract as activity inputs',()=>{
  const {plan,options,lower}=fixture();plan.approvals=[{key:'approval',question:'Accept this title?',source_sections:plan.activities[0].source_sections,subject:'author_assignment.author_result.draft.title',before:['consumer']}];plan.sequences[0].members=['author_assignment','approval','consumer'];
  assert.deepEqual(collectSemanticBlueprintFindings(plan,options),[]);
  const graph=lower(),author=graph.nodes.find(node=>node.semantic_key==='author_assignment'),gate=graph.nodes.find(node=>node.semantic_key==='approval');
  assert.deepEqual(gate.input_bindings,{subject:`/nodes/${author.id}/output/author_result/draft/title`});
  plan.approvals[0].subject='author_assignment.author_result.draft.unknown';
  assert.ok(collectSemanticBlueprintFindings(plan,options).some(item=>item.code==='approval_subject_unknown'));
  assert.throws(lower,error=>error.code==='AUTHORING_SEMANTIC');
});
