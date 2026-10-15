import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { resolveBinding } from '../lib/models.mjs';
import { fanoutResultSchema,validateFanoutResult } from '../core/execution/fanout-semantics.mjs';

test('real offline SDK patches nested fanout semantics while retaining the large staged body',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'pi-caw-fanout-stage-')),workspace=join(root,'workspace'),agentDir=join(root,'agent');await mkdir(workspace);await mkdir(agentDir);
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[],retry:{enabled:false}}));
  const faux=ai.fauxProvider({provider:'fanout-stage-'+randomUUID(),models:[{id:'worker',reasoning:false}],tokensPerSecond:0});
  const large='Exact retained sibling content. '.repeat(2000),body={items:[{outcome:'completed',result:{value:'bad',text:large},block_reason:'invalid extra field'},{outcome:'completed',result:{value:2,text:large}}]};
  let stageId,patches=0;
  const patch=context=>{
    const staged=JSON.stringify(context).match(/PI_RESULT_STAGED ([a-f0-9-]{36})/);assert(staged,'The actual SDK tool failure must expose its retained stage ID');
    if(stageId)assert.equal(staged[1],stageId);else stageId=staged[1];
    return ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{summary:'Small nested correction',stage_id:stageId,patch:[++patches===1?{op:'set',path:'/items/0/result/value',value:1}:{op:'remove',path:'/items/0/block_reason'}]}),{stopReason:'toolUse'});
  };
  faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{summary:'Stage exact large body',result:body}),{stopReason:'toolUse'}),patch,patch,ai.fauxAssistantMessage('Submitted the retained body.')]);
  const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);await runtime.refresh({allowNetwork:false});
  const parent=sdk.SessionManager.create(workspace,join(agentDir,'sessions')),context={cwd:workspace,sessionManager:parent,modelRegistry:new sdk.ModelRegistry(runtime),model:faux.getModel(),thinkingLevel:'off',isProjectTrusted:()=>false};
  const host=new PiSdkHost({sdk,Type:ai.Type,supportedThinking:ai.getSupportedThinkingLevels,agentDir,getContext:()=>context});host.modelRuntimes.set(faux.getModel().provider,runtime);
  t.after(async()=>{await host.close();assert(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,maxRetries:3,retryDelay:100});});
  const definition={fanout:{result_mode:'per_item',result_output:'results'},outputs_schema:{properties:{results:{items:{type:'object',properties:{value:{type:'integer'},text:{type:'string'}},required:['value','text'],additionalProperties:false}}}}};
  const schema=fanoutResultSchema(definition);let preflights=0;
  const task=await host.createTask({kind:'subagent',run_id:randomUUID(),node_id:'pool',name:'Exact nested fanout',binding:resolveBinding({provider:faux.getModel().provider,model_id:'worker',thinking:'off'},host.catalog()),workspace,access:'read_only',allowed_paths:[],resources:[],schema,validateResult:result=>{preflights++;validateFanoutResult(definition,result,[0,1]);}});
  const output=await task.run({prompt:'Submit two semantic items and use small staged patches for corrections.',schema});await host.releaseTask(task);
  assert.equal(patches,2);assert.equal(preflights,2);assert.deepEqual(output.result,{items:[{outcome:'completed',result:{value:1,text:large}},body.items[1]]});assert.deepEqual(output.changed_paths,[]);
  const transcript=await readFile(task.session_file,'utf8');assert.match(transcript,/PI_RESULT_STAGED/);assert.match(transcript,/items\\?\/0\\?\/result\\?\/value/);assert(output.turn_id);assert.equal(parent.getEntries().filter(entry=>entry.type==='message').length,0);
});
