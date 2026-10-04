import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';
import { importCoarseSkill } from '../core/skill-import/coarse-compiler.mjs';
import { compileExpansion, applyExpansion } from '../core/skill-import/semantic-expander.mjs';
import { observedSourceRequirements } from '../core/skill-import/source-requirements.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';
import { CONVERSION_CONTRACT } from '../core/skill-import/conversion-contract.mjs';
import { requireCurrentConversionCertificate } from '../core/skill-import/conversion-certificate.mjs';
import { requireDeployableConvertedSnapshot } from '../core/skill-import/conversion-deployment.mjs';
import { validateWorkflowGraph } from '../core/workflow-validator.mjs';
import { resolveBindings } from '../core/workflow-bindings.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { digest } from '../core/workflow-revisions.mjs';

const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string',minLength:1};
const draft=object({title:string});
const files={type:'array',items:object({path:string}),maxItems:8};
function contract(id,input_schema,output_schema){return {id,identity:{name:'offline-scoped-domain',version:'1',sha256:digest(id)},argv:[id],
  input_schema,output_schema,env_allow:[],permissions:{network:false,read_paths:['.'],write_paths:[]},output_cap_bytes:131072,deadline_ms:5000,idempotency:{mode:'reconcile_required'}};}

/** Exercise actual filesystem import and source compiler, not a fabricated coarse final node. */
async function imported(t,{approval=false,editedFinal=false}={}) {
  const f=await fixture(t),directory=join(f.root,'scoped-source');await mkdir(directory);
  const source=['---','name: scoped-host-delivery','description: Author a scoped document and commit through the Host.','---','# Process',
    'Read the selected task context from the Host.',
    'Author new content inside `sources/` and return newly chosen relative artifact paths.',
    ...(approval?['The user must approve the authored files before committing them.']:[]),
    'Have the Host validate and commit the authored files, reporting succeeded as its required boolean result.',''].join('\n');
  await writeFile(join(directory,'SKILL.md'),source);
  const initial=await importCoarseSkill(f.service.store,join(directory,'SKILL.md'),{id:'scoped-host-delivery',providerId:'worker',role:'implementer'});
  const seed=structuredClone(initial.workflow);seed.skill_policy={mode:'strict',implicit:'deny',ambient_allow:[],shadowed_skill_paths:seed.skill_policy.shadowed_skill_paths};
  seed.nodes.find(node=>node.id==='instructions').path_scope=['sources'];
  if(editedFinal)seed.nodes.find(node=>node.id==='final').prompt_template+=' Also inspect the exact human-requested accessibility checklist.';
  const pack=await f.service.store.save(seed.id,seed,{expected_revision:initial.revision_hash}),resources=await f.service.store.resources(seed.id,pack.revision_hash);
  const contracts=[contract('scoped_context',object({taskId:string}),object({guidance:string})),
    contract('scoped_commit',object({taskId:string,files,draft},['taskId','files']),object({succeeded:{type:'boolean'},artifact:string}))];
  const context={...f.service.store.validationContext,host_tools:contracts.map(item=>item.id),host_tool_contracts:contracts};
  f.service.store.validationContext=context;
  const source_span={resource:'source/SKILL.md',start_line:6,end_line:source.split('\n').length-1};
  const requirements=observedSourceRequirements(resources),ids=requirements.map(item=>item.requirement_id);
  const decorate=node=>({...node,confidence:1,source_span,resource_refs:['source/SKILL.md'],requirement_ids:ids});
  const nodes=[decorate({id:'context',semantic_key:'context',type:'tool',tool:'scoped_context',input_bindings:{taskId:'/inputs/taskId'}}),
    decorate({id:'author',semantic_key:'author',type:'agent',operation_mode:'write',prompt_template:'Use the scoped guidance to author original content. Choose new relative artifact paths inside sources/. Return new file paths and optional new semantic draft fields.',input_bindings:{guidance:'/nodes/context/output/guidance'},outputs_schema:object({files,draft},['files']),completion_contract:{on_missing:'block',outcome:'artifact'}}),
    ...(approval?[decorate({id:'approval',semantic_key:'approval',type:'human_gate',prompt_template:'Approve the authored files before the Host commits them.',input_bindings:{files:'/nodes/author/output/files'}})]:[]),
    decorate({id:'commit',semantic_key:'commit',type:'tool',tool:'scoped_commit',input_bindings:{taskId:'/inputs/taskId',files:'/nodes/author/output/files',draft:'/nodes/author/output/draft'},completion_contract:{on_missing:'block',outcome:'validated_artifact',fail_on_false:['succeeded']}})];
  const path=['start',...nodes.map(node=>node.id),'final'];
  const proposal={source_revision:pack.revision_hash,nodes,edges:path.slice(0,-1).map((source,index)=>({id:`edge-${index}`,source,target:path[index+1],confidence:1,source_span})),
    source_requirements:requirements,requirement_mappings:requirements.map(item=>({requirement_id:item.requirement_id,
      node_ids:item.requirement_kind==='approval'?['approval','commit']:['context','author','commit'],binding_names:[],runtime_guards:[],resource_refs:item.resource_refs??[],status:'agent_assisted',rationale:'The source activity and qualified Host handoff preserve this pinned requirement.'})),
    source_dispositions:sourceSectionInventory(resources).map(section=>({section_id:section.section_id,disposition:'workflow',node_ids:nodes.map(node=>node.id),requirement_ids:ids,rationale:'Execute the scoped source process through these exact activities.'}))};
  return {...f,pack,resources,contracts,context,proposal};
}
async function deployed(f) {
  const result=await applyExpansion(f.service.store,f.pack.workflow.id,f.proposal,{expected_revision:f.pack.revision_hash,context:f.context,
    inference_confirmation:'Offline exact-source review confirms this regression fixture.',conversion_review_contract_version:CONVERSION_CONTRACT.version});
  const resources=await f.service.store.resources(result.workflow.id,result.revision_hash);
  requireCurrentConversionCertificate(result.workflow,resources,result.import_report,{required:true,provenance:result.provenance});
  requireDeployableConvertedSnapshot(result);
  const validation=validateWorkflowGraph(result.workflow,f.context);assert.equal(validation.valid,true,JSON.stringify(validation));
  return result;
}

function branchAuthors(f) {
  const author=f.proposal.nodes.find(node=>node.id==='author');
  const alternate={...structuredClone(author),id:'alternate',semantic_key:'alternate'};
  const choice={...structuredClone(author),id:'choose',semantic_key:'choose',type:'condition',
    cases:[{label:'first',when:{op:'eq',args:[{path:'/inputs/variant'},{value:'first'}]}}],default_label:'second'};
  for(const key of ['operation_mode','prompt_template','input_bindings','outputs_schema','completion_contract'])delete choice[key];
  f.pack.workflow.inputs_schema=object({taskId:string,task:string,variant:{type:'string',enum:['first','second']}});
  f.proposal.nodes.push(choice,alternate);
  const incoming=f.proposal.edges.find(edge=>edge.target==='author');incoming.target='choose';
  f.proposal.edges.push({...incoming,id:'choose-first',source:'choose',target:'author',label:'first'},
    {...incoming,id:'choose-second',source:'choose',target:'alternate',label:'second'});
  const outgoing=f.proposal.edges.find(edge=>edge.source==='author');
  f.proposal.edges.push({...outgoing,id:'alternate-next',source:'alternate'});
  const selected={files:{coalesce:['/nodes/author/output/files','/nodes/alternate/output/files']},
    draft:{coalesce:['/nodes/author/output/draft','/nodes/alternate/output/draft']}};
  for(const node of f.proposal.nodes)for(const [name,binding] of Object.entries(node.input_bindings??{}))
    if(binding==='/nodes/author/output/'+name&&selected[name])node.input_bindings[name]=structuredClone(selected[name]);
  for(const mapping of f.proposal.requirement_mappings)if(mapping.node_ids.includes('author'))mapping.node_ids.push('choose','alternate');
  for(const disposition of f.proposal.source_dispositions)disposition.node_ids.push('choose','alternate');
}

test('a conditional author branch keeps explicit approval and ends at the guarded Host, including certified deployment',async t=>{
  const f=await imported(t,{approval:true});branchAuthors(f);
  const compiled=compileExpansion(f.pack,f.resources,f.proposal,f.context);
  assert.equal(compiled.workflow.finalization.node_id,'commit');
  assert.equal(compiled.workflow.nodes.some(node=>node.executor?.kind==='main'),false);
  assert.equal(compiled.workflow.nodes.find(node=>node.id==='approval').approval.required,true);
  assert.equal(compiled.workflow.edges.filter(edge=>edge.source==='choose').length,2);
  assert.equal(compiled.workflow.edges.filter(edge=>edge.target==='approval').length,2);
  const output=await deployed(f);
  assert.equal(output.workflow.finalization.node_id,'commit');
  assert.equal(output.workflow.nodes.find(node=>node.id==='approval').approval.required,true);
  assert.equal(output.workflow.nodes.filter(node=>node.type==='agent').length,2);
});

test('a conditional upstream graph never discards an edited finalizer duty',async t=>{
  const f=await imported(t,{editedFinal:true});branchAuthors(f);
  const compiled=compileExpansion(f.pack,f.resources,f.proposal,f.context);
  assert.equal(compiled.workflow.finalization.node_id,'final');
  assert.match(compiled.workflow.nodes.find(node=>node.id==='final').prompt_template,/human-requested accessibility checklist/);
});

test('real strict scoped import compiles to five nodes with a guarded Host finalizer and survives certified deployment',async t=>{
  const f=await imported(t),compiled=compileExpansion(f.pack,f.resources,f.proposal,f.context);
  assert.deepEqual(compiled.workflow.nodes.map(node=>node.id),['start','end','context','author','commit']);
  assert.equal(compiled.workflow.nodes.length,5);assert.equal(compiled.workflow.finalization.node_id,'commit');
  assert.deepEqual(compiled.workflow.edges.map(edge=>[edge.source,edge.target]),[['start','context'],['context','author'],['author','commit'],['commit','end']]);
  assert.equal(compiled.workflow.nodes.some(node=>node.executor?.kind==='main'),false);
  for(const node of compiled.workflow.nodes.filter(node=>node.type==='tool'))assert.equal(node.approval.required,false);
  assert.deepEqual(compiled.workflow.nodes.find(node=>node.id==='author').path_scope,['sources']);
  assert.deepEqual(compiled.workflow.nodes.find(node=>node.id==='commit').completion_contract.fail_on_false,['succeeded']);
  const output=await deployed(f);assert.deepEqual(output.workflow.skill_policy,{mode:'strict',implicit:'deny',ambient_allow:[],shadowed_skill_paths:[]});
  assert.equal(output.workflow.finalization.node_id,'commit');assert.deepEqual(output.workflow.nodes.find(node=>node.id==='author').path_scope,['sources']);
  assert.equal(f.requests.length,0);assert.equal(f.mainRequests.length,0);
});

test('compiled optional Host draft omission is lawful; required file omission and unqualified omission still fail',async t=>{
  const f=await imported(t),compiled=compileExpansion(f.pack,f.resources,f.proposal,f.context),commit=compiled.workflow.nodes.find(node=>node.id==='commit');
  assert.deepEqual(commit.input_bindings.draft,{path:'/nodes/author/output/draft',omit_if_missing:true});
  assert.equal(commit.input_bindings.files,'/nodes/author/output/files');
  const scope={inputs:{taskId:'host-task'},nodes:{author:{output:{files:[{path:'sources/new.tex'}]}}}};
  const input=resolveBindings(commit.input_bindings,scope,{optionalHostInputs:new Set(['draft'])});assert.equal(Object.hasOwn(input,'draft'),false);validateData(input,f.contracts[1].input_schema);
  assert.throws(()=>resolveBindings(commit.input_bindings,scope),{code:'BINDING_OMISSION_SCOPE'});
  assert.throws(()=>resolveBindings(commit.input_bindings,{...scope,nodes:{author:{output:{}}}},{optionalHostInputs:new Set(['draft'])}),{code:'BINDING_MISSING'});
  const absent=structuredClone(f.proposal);delete absent.nodes.find(node=>node.id==='commit').input_bindings.files;absent.nodes.find(node=>node.id==='author').outputs_schema=object({draft},[]);
  assert.throws(()=>compileExpansion(f.pack,f.resources,absent,f.context),{code:'EXPANSION_TOOL_BINDINGS'});
});

test('optional Host consumers retain strict required result/files and exact commit/files projections',async t=>{
  const f=await imported(t),author=f.proposal.nodes.find(node=>node.id==='author'),commit=f.proposal.nodes.find(node=>node.id==='commit');
  author.outputs_schema=object({result:object({files,draft},['files'])});
  f.contracts[1].input_schema.required=['taskId'];
  f.contracts[1].output_schema=object({succeeded:{type:'boolean'},files});
  commit.input_bindings.files='/nodes/author/output/result/files';
  commit.input_bindings.draft='/nodes/author/output/result/draft';
  // Tool proposals can carry placeholders. The pinned producer contract wins
  // even before the compiler installs that exact schema on the tool node.
  commit.outputs_schema=object({succeeded:{type:'boolean'},files},['succeeded']);
  const publish={...structuredClone(commit),id:'publish',semantic_key:'publish',tool:'scoped_publish',
    input_bindings:{taskId:'/inputs/taskId',files:'/nodes/commit/output/files'}};
  f.contracts.push(contract('scoped_publish',object({taskId:string,files},['taskId']),object({succeeded:{type:'boolean'},artifact:string})));
  f.context.host_tools.push('scoped_publish');
  f.proposal.nodes.push(publish);
  const finalEdge=f.proposal.edges.find(edge=>edge.target==='final');finalEdge.target='publish';
  f.proposal.edges.push({...finalEdge,id:'publish-final',source:'publish',target:'final'});
  const compiled=compileExpansion(f.pack,f.resources,f.proposal,f.context),nodes=new Map(compiled.workflow.nodes.map(node=>[node.id,node]));
  assert.equal(nodes.get('commit').input_bindings.files,'/nodes/author/output/result/files');
  assert.deepEqual(nodes.get('commit').input_bindings.draft,{path:'/nodes/author/output/result/draft',omit_if_missing:true});
  assert.equal(nodes.get('publish').input_bindings.files,'/nodes/commit/output/files');
  for(const node of [nodes.get('commit'),nodes.get('publish')])assert.throws(()=>resolveBindings(node.input_bindings,
    {inputs:{taskId:'host-task'},nodes:{author:{output:{result:{}}},commit:{output:{succeeded:true}}}},
    {optionalHostInputs:new Set(['files','draft'])}),{code:'BINDING_MISSING'});
  // Rechecking compiler-generated metadata must remove the old blanket omit.
  commit.input_bindings.files={path:'/nodes/author/output/result/files',omit_if_missing:true};
  publish.input_bindings.files={path:'/nodes/commit/output/files',omit_if_missing:true};
  const recompiled=compileExpansion(f.pack,f.resources,f.proposal,f.context);
  assert.equal(recompiled.workflow.nodes.find(node=>node.id==='commit').input_bindings.files,'/nodes/author/output/result/files');
  assert.equal(recompiled.workflow.nodes.find(node=>node.id==='publish').input_bindings.files,'/nodes/commit/output/files');
});

test('optional title and frameOutline preserve omission through optional ancestors while required consumers stay strict',async t=>{
  const f=await imported(t),author=f.proposal.nodes.find(node=>node.id==='author'),commit=f.proposal.nodes.find(node=>node.id==='commit');
  const outline={type:'array',items:string,maxItems:8};
  author.outputs_schema=object({files,result:object({draft:object({title:string,frameOutline:outline})},['draft'])},['files']);
  f.contracts[1].input_schema=object({taskId:string,files,title:string,frameOutline:outline},['taskId','files']);
  commit.input_bindings={taskId:'/inputs/taskId',files:'/nodes/author/output/files',
    title:'/nodes/author/output/result/draft/title',frameOutline:'/nodes/author/output/result/draft/frameOutline'};
  const compile=()=>compileExpansion(f.pack,f.resources,f.proposal,f.context).workflow.nodes.find(node=>node.id==='commit');
  for(const name of ['title','frameOutline'])assert.deepEqual(compile().input_bindings[name],{path:commit.input_bindings[name],omit_if_missing:true});
  author.outputs_schema.required.push('result');
  author.outputs_schema.properties.result.properties.draft.required=['title'];
  assert.equal(compile().input_bindings.title,commit.input_bindings.title);
  assert.deepEqual(compile().input_bindings.frameOutline,{path:commit.input_bindings.frameOutline,omit_if_missing:true});
  f.contracts[1].input_schema.required.push('frameOutline');
  assert.equal(compile().input_bindings.frameOutline,commit.input_bindings.frameOutline);
  assert.throws(()=>resolveBindings(compile().input_bindings,{inputs:{taskId:'host-task'},nodes:{author:{output:{files:[],result:{draft:{title:'New title'}}}}}}),{code:'BINDING_MISSING'});
});

test('Root input required chains and escaped segments qualify omission; unknown projections remain observable',async t=>{
  const f=await imported(t),commit=f.proposal.nodes.find(node=>node.id==='commit');
  f.pack.workflow.inputs_schema=object({taskId:string,settings:object({'a/b':object({'~title':string})}),optionalSettings:object({title:string}),
    dynamic:{type:'object',properties:{},additionalProperties:string}},['taskId','settings']);
  f.contracts[1].input_schema=object({taskId:string,files,rootRequired:string,rootOptional:string,unknown:string},['taskId','files']);
  commit.input_bindings={taskId:'/inputs/taskId',files:'/nodes/author/output/files',
    rootRequired:'/inputs/settings/a~1b/~0title',rootOptional:'/inputs/optionalSettings/title',unknown:'/inputs/dynamic/undeclared'};
  const compile=()=>compileExpansion(f.pack,f.resources,f.proposal,f.context).workflow.nodes.find(node=>node.id==='commit');
  assert.equal(compile().input_bindings.rootRequired,commit.input_bindings.rootRequired);
  assert.deepEqual(compile().input_bindings.rootOptional,{path:commit.input_bindings.rootOptional,omit_if_missing:true});
  assert.equal(compile().input_bindings.unknown,commit.input_bindings.unknown);
  const scope={inputs:{taskId:'host-task',settings:{'a/b':{'~title':'New title'}}},nodes:{author:{output:{files:[]}}}};
  assert.throws(()=>resolveBindings(compile().input_bindings,scope,{optionalHostInputs:new Set(['rootRequired','rootOptional','unknown'])}),{code:'BINDING_MISSING'});
  commit.input_bindings.unknown={path:commit.input_bindings.unknown,omit_if_missing:true};
  assert.throws(compile,{code:'EXPANSION_BINDING_OMISSION_SCHEMA'});
});

test('an explicit source human approval remains a gate with approval required through certified deployment',async t=>{
  const f=await imported(t,{approval:true}),compiled=compileExpansion(f.pack,f.resources,f.proposal,f.context),gate=compiled.workflow.nodes.find(node=>node.id==='approval');
  assert.equal(gate.type,'human_gate');assert.equal(gate.approval.required,true);
  assert.ok(compiled.workflow.edges.some(edge=>edge.source==='author'&&edge.target==='approval'));assert.ok(compiled.workflow.edges.some(edge=>edge.source==='approval'&&edge.target==='commit'));
  const output=await deployed(f);assert.equal(output.workflow.nodes.find(node=>node.id==='approval').approval.required,true);
});

test('an edited coarse Main finalizer retains its independent duty instead of being folded into the Host commit',async t=>{
  const f=await imported(t,{editedFinal:true}),compiled=compileExpansion(f.pack,f.resources,f.proposal,f.context);
  assert.equal(compiled.workflow.finalization.node_id,'final');assert.equal(compiled.workflow.nodes.length,6);
  assert.match(compiled.workflow.nodes.find(node=>node.id==='final').prompt_template,/human-requested accessibility checklist/);
  const output=await deployed(f);assert.equal(output.workflow.finalization.node_id,'final');assert.ok(output.workflow.nodes.some(node=>node.id==='final'));
  assert.match(output.workflow.nodes.find(node=>node.id==='final').prompt_template,/human-requested accessibility checklist/);
});
