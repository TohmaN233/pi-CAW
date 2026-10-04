import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './fixtures.mjs';
import {importCoarseSkill} from '../core/skill-import/coarse-compiler.mjs';
import {sourceSectionInventory} from '../core/skill-import/source-dispositions.mjs';
import {observedSourceRequirements} from '../core/skill-import/source-requirements.mjs';
import {validateGenerationProposal} from '../core/skill-import/proposal-validation.mjs';
import {SEMANTIC_BLUEPRINT_CONTRACT,SEMANTIC_REPAIR_CONTRACT,applySemanticRepair} from '../core/authoring/blueprint-contract.mjs';
import {canonicalJSON,digest} from '../core/workflow-revisions.mjs';
import {defaultRoutingRules,TASK_TYPES} from '../core/skill-import/routing-rules.mjs';
import {validateData} from '../core/workflow-data-schema.mjs';
import {EXPANSION_PROPOSAL_SCHEMA} from '../core/skill-import/expansion-run.mjs';
import {resolveBindings} from '../core/workflow-bindings.mjs';
import {semanticInputReferences,SEMANTIC_INPUT_GUIDE} from '../core/authoring/semantic-inputs.mjs';
import {SEMANTIC_BLUEPRINT_SCHEMA,SEMANTIC_BLUEPRINT_GUIDE} from '../core/authoring/blueprint-contract.mjs';

const closed=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text={type:'string',minLength:1,maxLength:256};
const files={type:'array',minItems:0,maxItems:8,items:text};
const host=(id,input_schema,output_schema)=>({id,identity:{name:id,version:'1',sha256:digest(id)},argv:[id],input_schema,output_schema,
  env_allow:[],permissions:{network:false,read_paths:['.'],write_paths:[]},output_cap_bytes:131072,deadline_ms:5000,idempotency:{mode:'safe'}});

test('semantic coalesce has one bounded declarative grammar and exposes it to native planners',()=>{
  assert.deepEqual(semanticInputReferences('input:task'),[{input:'task'}]);
  assert.deepEqual(semanticInputReferences('author.result.files'),[{activity:'author',output:'result.files'}]);
  assert.deepEqual(semanticInputReferences('author.result.display label'),[{activity:'author',output:'result.display label'}],
    'Ordinary projections keep literal declared property names; exact schema qualification still decides whether they exist');
  assert.deepEqual(semanticInputReferences('coalesce(left.result,right.result).files'),[{activity:'left',output:'result.files'},{activity:'right',output:'result.files'}]);
  for(const expression of ['coalesce(left.files)','coalesce(left.files,left.files)','coalesce(left.files,left.answer)',
    'coalesce(input:files,right.files)','coalesce(left.files,right.files).','coalesce(left.files,run())','eval(left.files)',
    `coalesce(${Array.from({length:33},(_,index)=>`a${index}.files`).join(',')})`])assert.equal(semanticInputReferences(expression),null,expression);
  assert.equal(semanticInputReferences(`coalesce(${Array.from({length:32},(_,index)=>`a${index}.files`).join(',')})`).length,32);
  assert.equal(SEMANTIC_BLUEPRINT_SCHEMA.properties.activities.items.properties.inputs.items.properties.from.description,SEMANTIC_INPUT_GUIDE);
  assert.equal(SEMANTIC_BLUEPRINT_GUIDE.input_sources,SEMANTIC_INPUT_GUIDE);
});

test('finite enum-only Host routes compile native choices and exact required Host fan-in without semantic expressions',async t=>{
  const f=await fixture(t),directory=join(f.root,'choice-source');await mkdir(directory);
  await writeFile(join(directory,'SKILL.md'),'---\nname: selected-product\ndescription: Route one selected product.\n---\n# Process\n\nRoute the selected task with the Host, persist exactly one selected product, then validate its files through a common Host finalizer.\n');
  const pack=await importCoarseSkill(f.service.store,join(directory,'SKILL.md'),{id:'selected-product',providerId:'worker',role:'implementer'});
  const resources=await f.service.store.resources(pack.workflow.id,pack.revision_hash),sections=sourceSectionInventory(resources).map(x=>x.section_id);
  const contracts=[host('route',closed({taskId:text}),closed({branch:{enum:['left','right']}})),
    host('persist',closed({taskId:text}),closed({bindingSha256:text,files})),
    host('compile',closed({taskId:text,bindingSha256:text,files}),closed({succeeded:{type:'boolean',const:true}}))];
  const shape=(name,kind='text',values=[])=>({name,kind,type_ref:'',values});
  const activity=(key,tool,outputs)=>({key,profile:'main_read',tool,source_sections:sections,instructions:'Perform the selected operation through its registered Host tool.',
    inputs:[{name:'taskId',from:'input:taskId'}],outputs,on_missing:'block',outcome:'validated_artifact'});
  const plan={contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Route one product and validate its exact saved files.',
    source_dispositions:sections.map(section_id=>({section_id,disposition:'workflow',activity_keys:['route','left','right','compile'],note:'Preserve selected product routing.'})),
    requirement_assignments:observedSourceRequirements(resources).map(x=>({requirement_id:x.requirement_id,activity_keys:['route','left','right','compile']})),
    runtime_dependencies:[],records:[],lists:[],enums:[],activities:[activity('route','route',[shape('branch','enum',['left','right'])]),
      activity('left','persist',[shape('bindingSha256'),shape('files','list')]),activity('right','persist',[shape('bindingSha256'),shape('files','list')]),
      {...activity('compile','compile',[shape('succeeded','boolean')]),fail_on_false:['succeeded']}],
    approvals:[],parallels:[],choices:[{key:'selection',decision_activity:'route',output:'branch',branches:[{value:'left',body:'left'},{value:'right',body:'right'}],default_body:'left'}],
    sequences:[{key:'process',members:['selection','compile'],failure_meaning:'all_required'}]};
  const context={...f.service.store.validationContext,host_tools:contracts.map(x=>x.id),host_tool_contracts:contracts};
  const routing_rules={...defaultRoutingRules(),routes:Object.fromEntries(TASK_TYPES.map(x=>[x,{provider_id:'worker',role:'implementer'}]))};
  const options={pack,resources,context,provenance:{...pack.provenance,source_revision:pack.revision_hash,routing_rules}};
  const before=canonicalJSON(plan),beforeContracts=canonicalJSON(contracts),result=validateGenerationProposal({proposal:plan},options);
  validateData(result.proposal,EXPANSION_PROPOSAL_SCHEMA);
  const compile=result.proposal.nodes.find(x=>x.semantic_key==='compile'),producers=result.proposal.nodes.filter(x=>['left','right'].includes(x.semantic_key));
  assert.equal(result.proposal.nodes.filter(x=>x.type==='condition').length,1);
  for(const field of ['bindingSha256','files']){
    assert.deepEqual(new Set(compile.input_bindings[field].coalesce),new Set(producers.map(x=>`/nodes/${x.id}/output/${field}`)));
    for(const selected of producers){const values={bindingSha256:'selected-binding',files:[]};
      assert.deepEqual({...resolveBindings(compile.input_bindings,{inputs:{taskId:'selected-task'},nodes:{[selected.id]:{output:values}}})},{taskId:'selected-task',...values});}
  }
  assert.deepEqual(validateGenerationProposal({proposal:result.proposal,host_pipeline:result.pipeline_trace},options).proposal,result.proposal);
  assert.equal(canonicalJSON(plan),before);assert.equal(canonicalJSON(contracts),beforeContracts);
  // Optional files cannot be inferred by required-argument derivation. The
  // declarative operator binds that selected value explicitly, without a model
  // re-emitting file identities or an Agent selecting a successful branch.
  const optionalContracts=structuredClone(contracts);optionalContracts[2].input_schema.required=['taskId','bindingSha256'];
  const explicit=structuredClone(plan);explicit.activities.at(-1).inputs.push(
    {name:'files',from:'coalesce(left.files,right.files)'},
    {name:'bindingSha256',from:'coalesce(left.bindingSha256,right.bindingSha256)'});
  const explicitOptions={...options,context:{...context,host_tool_contracts:optionalContracts}};
  const selected=validateGenerationProposal({proposal:explicit},explicitOptions),selectedCompile=selected.proposal.nodes.find(x=>x.semantic_key==='compile');
  assert.equal(selectedCompile.input_bindings.files.coalesce.length,2);
  validateData(selected.proposal,EXPANSION_PROPOSAL_SCHEMA);
  assert.deepEqual(validateGenerationProposal({proposal:selected.proposal,host_pipeline:selected.pipeline_trace},explicitOptions).proposal,selected.proposal);
  const mismatch=structuredClone(explicit);mismatch.activities.at(-1).inputs.find(x=>x.name==='files').from='coalesce(left.files,right.bindingSha256)';
  assert.throws(()=>validateGenerationProposal({proposal:mismatch},explicitOptions),error=>error.findings?.some(x=>x.code==='coalesce_schema_mismatch'));
  const missing=structuredClone(explicit);missing.activities.at(-1).inputs.find(x=>x.name==='files').from='coalesce(left.r,right.r).files';
  assert.throws(()=>validateGenerationProposal({proposal:missing},explicitOptions),error=>error.findings?.some(x=>x.code==='unknown_input_output'));
  const wrong=structuredClone(plan);wrong.choices[0].branches[0].value=true;
  assert.throws(()=>validateGenerationProposal({proposal:wrong},options),error=>error.findings?.some(x=>x.code==='choice_value_type'));
  const unknown=structuredClone(plan);unknown.choices[0].branches[0].value='unknown';
  assert.throws(()=>validateGenerationProposal({proposal:unknown},options),error=>error.findings?.some(x=>x.code==='choice_value_type'));
  const alias=structuredClone(plan);alias.activities[1].outputs=[shape('r','object')];
  assert.throws(()=>validateGenerationProposal({proposal:alias},options),error=>error.findings?.some(x=>x.code==='unknown_host_output'),
    'Unqualified whole-object placeholders cannot silently alias a registered Host result');
  const parallel=structuredClone(plan);parallel.choices=[];parallel.parallels=[{key:'selection',members:['left','right'],failure_meaning:'all_required'}];parallel.sequences[0].members=['route','selection','compile'];
  assert.throws(()=>validateGenerationProposal({proposal:parallel},options),'Simultaneous producers cannot be silently coalesced');
  const simultaneous=structuredClone(parallel);simultaneous.activities.at(-1).inputs=structuredClone(explicit.activities.at(-1).inputs);
  assert.throws(()=>validateGenerationProposal({proposal:simultaneous},explicitOptions),error=>error.findings?.some(x=>x.code==='coalesce_not_exclusive'));
  const uncovered=structuredClone(explicit),third=structuredClone(uncovered.activities[1]);third.key='third';uncovered.activities.splice(3,0,third);
  uncovered.choices[0].default_body='third';uncovered.choices[0].branches.push({value:'third',body:'third'});uncovered.activities[0].outputs[0].values.push('third');
  const threeContracts=structuredClone(optionalContracts);threeContracts[0].output_schema.properties.branch.enum.push('third');
  assert.throws(()=>validateGenerationProposal({proposal:uncovered},{...explicitOptions,context:{...context,host_tool_contracts:threeContracts}}),error=>error.findings?.some(x=>x.code==='coalesce_route_missing'));
  // A retained repair must be allowed to remove the exact uncovered default
  // leaf and replace its owning choice, without gaining scope over shared work.
  const orphan=structuredClone(explicit),invalid=structuredClone(orphan.activities[1]),audit=structuredClone(orphan.activities[0]);
  invalid.key='invalid_route';audit.key='prefix_audit';orphan.activities.push(invalid,audit);
  orphan.choices[0].default_body='invalid_default';
  orphan.sequences.push({key:'invalid_default',members:['invalid_route'],failure_meaning:'all_required'});
  orphan.sequences[0].members.unshift('prefix_audit');
  let missingDefault;
  try{validateGenerationProposal({proposal:orphan},explicitOptions);assert.fail('The uncovered default must fail');}
  catch(error){missingDefault=error.findings?.find(x=>x.code==='coalesce_route_missing');assert.ok(missingDefault,JSON.stringify(error.findings));}
  for(const key of ['compile','left','right','selection','invalid_default','invalid_route','process'])assert.ok(missingDefault.semantic_keys.includes(key),key);
  for(const key of ['prefix_audit','route'])assert.ok(!missingDefault.semantic_keys.includes(key),'Shared prefix work stays outside the missing-route repair scope');
  assert.ok(missingDefault.source_refs.length>0,'The uncovered CFG path retains exact source evidence');
  const collections=['source_dispositions','requirement_assignments','runtime_dependencies','records','lists','enums','activities','approvals','sequences','parallels','choices'];
  const empty=()=>Object.fromEntries(collections.map(name=>[name,[]]));
  const patch={contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:empty(),remove:empty()};
  patch.remove.activities=['invalid_route'];patch.remove.sequences=['invalid_default'];
  patch.upsert.choices=[{...orphan.choices[0],default_body:'left'}];
  const repaired=applySemanticRepair(orphan,patch,{targets:[missingDefault]});
  assert.ok(!repaired.activities.some(x=>x.key==='invalid_route'));
  assert.ok(repaired.activities.some(x=>x.key==='prefix_audit'));
  validateGenerationProposal({proposal:repaired},explicitOptions);
  const unrelated=structuredClone(patch);unrelated.remove.activities.push('prefix_audit');
  assert.throws(()=>applySemanticRepair(orphan,unrelated,{targets:[missingDefault]}),error=>error.code==='AUTHORING_REPAIR_SCOPE'&&error.message.includes('prefix_audit'));
  assert.equal(f.requests.length,0);assert.equal(f.mainRequests.length,0);
});
