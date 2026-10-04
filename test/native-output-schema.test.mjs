import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import {PiSdkHost} from '../lib/pi-sdk-host.mjs';
import {resolveBinding} from '../lib/models.mjs';
import {managedNativeResultSchema,strictAgentOutputSchema} from '../core/execution/host-main-automation.mjs';
import {validateData} from '../core/workflow-data-schema.mjs';
import {validateWorkflowGraph} from '../core/workflow-validator.mjs';
import {agent,workflow} from './fixtures.mjs';

// Fictional documentation output schema. The file
// record's semantic options are optional; their omission must stay omission.
const schema=JSON.parse(await readFile(new URL('./fixtures/native-optional-output-schema.json',import.meta.url),'utf8'));
const sample=schema=>schema.type==='object'?Object.fromEntries((schema.required??[]).map(key=>[key,sample(schema.properties[key])])):schema.type==='array'?[]:schema.enum?.[0]??(schema.type==='integer'||schema.type==='number'?1:schema.type==='boolean'?true:'New semantic text');
const output=()=>({...sample(schema),files:[{format:'md',path:'sources/new-document.md'},{format:'html',path:'sources/new-document.html',outputMode:'render'}]});

test('synthetic file options remain optional through Pi native schema and Ready validation',()=>{
  assert.deepEqual(schema.properties.files.items.required,['format','path']);
  const before=JSON.stringify(schema),node={...agent('author'),access:'bounded_write',path_scope:['sources'],
    prompt_template:'Author the requested original document and return newly chosen relative file paths and newly authored semantic values.',outputs_schema:schema};
  assert.deepEqual(managedNativeResultSchema(node),schema);
  assert.equal(JSON.stringify(schema),before);
  validateData(output(),schema);
  const result=validateWorkflowGraph(workflow([node]),{providers:[{id:'worker',enabled:true,kind:'native_agent',capabilities:{read:true,write:true},config:{agent_type:'default',role:'advisor'}}]});
  assert.equal(result.valid,true,JSON.stringify(result));
  assert.throws(()=>strictAgentOutputSchema(schema),{code:'AGENT_OUTPUT_SCHEMA'});
  for(const change of [value=>{delete value.files[0].path;},value=>{value.files[0].unrelated='copied';},value=>{value.files[0].expectedPages='two';},value=>{value.files[0].documentKind=null;}]){
    const value=output();change(value);assert.throws(()=>validateData(value,schema),{code:'DATA_INVALID'});
  }
  for(const change of [value=>{value.properties.files.items.additionalProperties=true;},value=>{value.properties.files.items.required.push('undeclared');}]){
    const value=structuredClone(schema);change(value);assert.throws(()=>managedNativeResultSchema({outputs_schema:value}),{code:'AGENT_OUTPUT_SCHEMA'});
  }
});

test('offline Pi SDK native submit accepts exact file option omission without null or required coercion',{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'pi-caw-native-output-')),cwd=join(root,'workspace'),agentDir=join(root,'agent');
  await mkdir(cwd);await mkdir(agentDir);await mkdir(join(cwd,'sources'));
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[],retry:{enabled:false}}));
  const faux=ai.fauxProvider({provider:`optional-output-${randomUUID()}`,models:[{id:'worker',reasoning:false}],tokensPerSecond:0});
  const expected=output();faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{result:expected,summary:'Offline semantic result fixture'}),{stopReason:'toolUse'}),ai.fauxAssistantMessage('Submitted.')]);
  const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  runtime.registerNativeProvider(faux.provider);await runtime.refresh({allowNetwork:false});
  const parent=sdk.SessionManager.create(cwd,join(agentDir,'sessions'));parent.appendMessage(ai.fauxAssistantMessage('Offline parent.'));
  const context={cwd,sessionManager:parent,modelRegistry:new sdk.ModelRegistry(runtime),isProjectTrusted:()=>false};
  const host=new PiSdkHost({sdk,Type:ai.Type,supportedThinking:ai.getSupportedThinkingLevels,agentDir,getContext:()=>context});
  // Reuse this offline runtime; no provider discovery or external request.
  host.modelRuntimes.set(faux.getModel().provider,runtime);
  t.after(async()=>{await host.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,maxRetries:3,retryDelay:100});});
  const binding=resolveBinding({provider:faux.getModel().provider,model_id:'worker',thinking:'off'},host.catalog());
  const task=await host.createTask({kind:'subagent',run_id:'native-output-fixture',node_id:'author',name:'Optional semantic output',binding,
    workspace:cwd,access:'bounded_write',allowed_paths:['sources'],resources:[],strict:true,schema,authorize:async()=>{}});
  const result=await task.run({prompt:'Submit the offline original semantic result fixture.',schema});
  assert.deepEqual(result.result,expected);
  assert.equal(Object.hasOwn(result.result.files[0],'documentKind'),false);
  assert.equal(Object.hasOwn(result.result.files[0],'expectedPages'),false);
  assert.equal(Object.hasOwn(result.result.files[0],'outputMode'),false);
  assert.equal(result.evidence.observed,'completed');
  assert.equal(result.usage.cost_micros,0);
});
