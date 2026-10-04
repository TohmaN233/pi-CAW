import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { createDraft } from '../core/workflow-schema.mjs';


// Real native Pi extension + SDK; fake model transport, no web app or paid calls.
const root=resolve(import.meta.dirname,'../.artifacts','native-pi-loops-'+randomUUID());
const cwd=join(root,'workspace'),agentDir=join(root,'agent'),state=join(root,'state');
await mkdir(join(cwd,'product'),{recursive:true});await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_CAW_DIR=state;
await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[],retry:{enabled:false}}));
const schema={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
const g={...createDraft('native-bounded-loop','Native bounded repair'),status:'ready',
  inputs_schema:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{files:{type:'array',items:{type:'string'}}},required:['files']}}},required:['items']},
  outputs_schema:schema,skill_policy:{mode:'cooperative',implicit:'allow',ambient_allow:[],shadowed_skill_paths:[]},finalization:{required:true,node_id:'final'}};
const node=(id,access,inputs)=>({id,type:'agent',executor:{kind:'main',mode:id==='final'?'orchestration':'worker'},role:id==='final'?'finalizer':'implementer',
  access,...(access==='bounded_write'?{path_scope:['product']}:{}),approval:{required:false},retry:{max_attempts:3},
  prompt_template:'Use only declared inputs. Read or repair assigned artifact, then submit semantic result.',input_bindings:inputs,outputs_schema:schema});
const review=node('review','read_only',{items:'/loops/repair-loop/review_items'});
review.outputs_schema={type:'object',properties:{verdicts:{type:'array',items:{type:'object',properties:{accepted:{type:'boolean'},findings:{type:'string'}},required:['accepted'],additionalProperties:false}}},required:['verdicts'],additionalProperties:false};
g.nodes=[{id:'start',type:'start'},node('work','bounded_write',{items:'/inputs/items'}),
  {id:'gate',type:'condition',cases:[{label:'repair',when:{op:'ne',args:[{path:'/loops/repair-loop/repair_items'},{value:[]}]}}],default_label:'review'},
  node('repair','bounded_write',{items:'/loops/repair-loop/repair_items'}),review,node('final','read_only',{}),{id:'end',type:'end'}];
const edge=(source,target,label)=>({id:source+'-'+target,source,target,...(label?{label}:{})});
g.edges=[edge('start','work'),edge('work','gate'),edge('gate','repair','repair'),edge('gate','review','review'),edge('repair','review'),edge('review','final'),edge('final','end')];
g.loops=[{id:'repair-loop',entry_node:'gate',exit_node:'review',node_ids:['gate','repair','review'],max_rounds:3,
  until:{op:'eq',args:[{path:'/loops/repair-loop/all_accepted'},{value:true}]},
  item_scope:{items:'/inputs/items',verdicts:'/nodes/review/output/verdicts',paths_field:'files'}}];
await (await new WorkflowStore(join(state,'workflows')).initialize()).create(g);
const faux=ai.fauxProvider({provider:`native-pi-${randomUUID()}`,models:[{id:'current-main',reasoning:false}],tokensPerSecond:0});
const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
runtime.registerNativeProvider(faux.provider);await runtime.refresh({allowNetwork:false});
const manager=sdk.SessionManager.create(cwd,join(agentDir,'sessions'));
manager.appendMessage(ai.fauxAssistantMessage('PRIVATE_NATIVE_PARENT_DECISION'));
let api;
const loader=new sdk.DefaultResourceLoader({cwd,agentDir,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  additionalExtensionPaths:[resolve(import.meta.dirname,'../extensions/pi-caw.ts')],
  extensionFactories:[{name:'native-smoke-capture',factory:pi=>{api=pi;}}]});
await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
const session=(await sdk.createAgentSession({cwd,agentDir,modelRuntime:runtime,model:faux.getModel(),thinkingLevel:'off',
  sessionManager:manager,resourceLoader:loader,tools:['read','write','bash','caw']})).session;
const errors=[];
const call=(operation,args={})=>new Promise((resolveCall,reject)=>api.events.emit('pi-caw:host-command',{
  session_id:manager.getSessionId(),operation,args,resolve:resolveCall,reject}));
const tool=(name,args)=>ai.fauxAssistantMessage(ai.fauxToolCall(name,args),{stopReason:'toolUse'});

let runId;
try {
  await session.bindExtensions({mode:'rpc',onError:error=>errors.push(error),abortHandler:()=>{void session.abort();}});
  faux.setResponses([
    tool('write',{path:'product/source.txt',content:'unfinished'}),tool('caw_submit_result',{result:{text:'Artifact created'},summary:'Created'}),ai.fauxAssistantMessage('Created.'),
    tool('caw_submit_result',{result:{verdicts:[]},summary:'Invalid review'}),
    context=>{assert(JSON.stringify(context).includes('one semantic accepted/findings record per current review item'));return tool('caw_submit_result',{result:{verdicts:[{accepted:false,findings:'Replace unfinished content with finished.'}]},summary:'Repair needed'});},ai.fauxAssistantMessage('Rejected.'),
    context=>{assert(JSON.stringify(context).includes('Replace unfinished content'));return tool('write',{path:'product/source.txt',content:'finished'});},
    tool('caw_submit_result',{result:{text:'Artifact repaired'},summary:'Repaired'}),ai.fauxAssistantMessage('Repaired.'),
    tool('read',{path:'product/source.txt'}),tool('caw_submit_result',{result:{verdicts:[{accepted:true}]},summary:'Reviewed actual repaired source'}),ai.fauxAssistantMessage('Accepted by review.'),
    tool('caw',{action:'main_task'}),tool('caw',{action:'main_result',args:{result:{text:'Repaired artifact ready'},summary:'Ready for human'}}),ai.fauxAssistantMessage('Awaiting human.'),ai.fauxAssistantMessage('Awaiting human review.'),
  ]);
  const launched=await call('run',{workflow_id:g.id,workspace:cwd,access:'bounded_write',allowed_paths:[join(cwd,'product')],inputs:{items:[{files:['product/source.txt']}]}});runId=launched.run_id;
  const runs=await new WorkflowRunStore(join(state,'runs')).initialize();let record;
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){record=await runs.read(runId);if(record.state.nodes.final.attempts.at(-1)?.result_proposal)break;
    if(['failed','interrupted'].includes(record.state.status))throw new Error(JSON.stringify(record.state.nodes));
    await new Promise(r=>setTimeout(r,25));}
  assert(record.state.nodes.final.attempts.at(-1)?.result_proposal,'Final dispatch did not finish');
  assert.equal(record.state.loops['repair-loop'].round,2);assert.equal(record.state.loops['repair-loop'].status,'accepted');
  assert.equal(record.state.loops['repair-loop'].rounds.length,2);assert.equal(record.state.nodes.repair.attempts.length,1);
  assert.equal(record.state.nodes.review.attempts.length,2);assert.equal(record.state.nodes.work.attempts.length,1);
  const reviews=record.state.nodes.review.attempts.map(a=>a.dispatch.receipt.thread_id);assert.notEqual(reviews[0],reviews[1]);
  assert.equal(await readFile(join(cwd,'product/source.txt'),'utf8'),'finished');assert.deepEqual(errors,[]);
  assert.notEqual(record.state.status,'succeeded');
  const receipt={host:'native-pi',sdk_version:sdk.VERSION,real_model_calls:0,pi_own_required:false,
    loop_rounds:2,failed_item_repaired:true,fresh_review_sessions:true,invalid_verdict_corrected_in_same_turn:true,human_acceptance_pending:true,run_id:runId,evidence_directory:root};
  await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}finally{if(runId)await call('cancel',{run_id:runId});await session.extensionRunner.emit({type:'session_shutdown'});await session.abort();session.dispose();}
