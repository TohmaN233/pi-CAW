import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import {PiSdkHost} from '../lib/pi-sdk-host.mjs';
import {createParentMainBridge} from '../lib/parent-main-bridge.mjs';
import {createRemoteMainTask,dispatchMainCallback} from '../lib/pi-worker.mjs';
import {createOwnerRpcServer} from '../lib/detached-owner.mjs';

const schema={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
const submit=args=>ai.fauxAssistantMessage(ai.fauxToolCall('caw',{action:'main_result',args}),{stopReason:'toolUse'});
const stopped=text=>ai.fauxAssistantMessage(text);

// This fixture uses the real AgentSession, registered extension tool validator,
// PiSdkHost and reverse owner RPC. Only provider messages and the Host's budget
// decision are scripted; all session entries/tool receipts come from Pi.
async function fixture(t,{responses,onCorrection=async()=>{}}){
  const root=await mkdtemp(join(tmpdir(),'pi-caw-current-main-sdk-')),workspace=join(root,'workspace'),agentDir=join(root,'agent');
  await mkdir(workspace);await mkdir(agentDir);
  await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[],retry:{enabled:false}}));
  const faux=ai.fauxProvider({provider:'current-main-'+randomUUID(),models:[{id:'parent',reasoning:false}],tokensPerSecond:0});
  faux.setResponses(responses);
  const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  runtime.registerNativeProvider(faux.provider);await runtime.refresh({allowNetwork:false});
  const manager=sdk.SessionManager.create(workspace,join(agentDir,'sessions')),errors=[],executions=[],failures=[],events=[],deliveries=[],corrections=[],operations=new Map(),remoteTasks=new Set();
  let session,deliver;
  const context={cwd:workspace,sessionManager:manager,modelRegistry:new sdk.ModelRegistry(runtime),model:faux.getModel(),thinkingLevel:'off',isProjectTrusted:()=>false,
    abort:()=>{void session.abort();}};
  const host=new PiSdkHost({sdk,Type:ai.Type,supportedThinking:ai.getSupportedThinkingLevels,agentDir,getContext:()=>context,
    deliverMain:prompt=>{deliveries.push(prompt);return deliver(prompt);}});
  const loader=new sdk.DefaultResourceLoader({cwd:workspace,agentDir,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    extensionFactories:[{name:'actual-current-main-protocol',factory:pi=>{
      // Match extensions/pi-caw.ts: queued follow-ups need message_start as
      // well as before_agent_start to activate their fresh Main marker.
      deliver=prompt=>pi.sendUserMessage(prompt,{deliverAs:'followUp'});
      pi.on('session_start',()=>{events.push('session_start');});
      pi.on('before_agent_start',event=>{events.push('before_agent_start');host.main.begin(event.prompt);});
      pi.on('message_start',event=>{
        if(event.message.role==='user'){
          const content=event.message.content,text=typeof content==='string'?content:content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
          events.push('user_message_start');host.main.begin(text);
        }
      });
      pi.on('tool_call',event=>host.main.guard(event));
      pi.on('agent_end',async()=>{events.push('agent_end');await host.main.end();});
      pi.registerTool({name:'caw',label:'Current Main protocol',description:'Retrieve the active Main task or submit its semantic result.',
        // Production caw uses an action union and an optional string-keyed
        // record of unknown args; malformed result fields reach real execute.
        parameters:ai.Type.Object({action:ai.Type.Union([ai.Type.Literal('main_task'),ai.Type.Literal('main_result')]),args:ai.Type.Optional(ai.Type.Record(ai.Type.String(),ai.Type.Unknown()))}),
        async execute(id,params){
          executions.push({id,params:structuredClone(params)});
          try{
            const result=params.action==='main_task'?host.main.packet():await host.main.submit(params.args??{},id);
            return {content:[{type:'text',text:JSON.stringify(result)}],details:{kind:'pi-caw',action:params.action}};
          }catch(error){failures.push({id,code:error.code,message:error.message});throw error;}
        }});
    }}]});
  await loader.reload();
  session=(await sdk.createAgentSession({cwd:workspace,agentDir,modelRuntime:runtime,model:faux.getModel(),thinkingLevel:'off',sessionManager:manager,resourceLoader:loader,tools:['caw'],noTools:'all'})).session;
  await session.bindExtensions({mode:'rpc',onError:error=>errors.push(error),abortHandler:()=>{void session.abort();}});
  assert.deepEqual(events,['session_start'],'bindExtensions must initialize the actual extension lifecycle');
  const run_id=randomUUID(),main_actor=manager.getSessionId(),controller=new AbortController();
  const owner=await createOwnerRpcServer({run_id,handle:(operation,args)=>dispatchMainCallback(operations,operation,args)});
  const parent=await createParentMainBridge({host,run_id,main_actor});
  const metadata=[];
  const task=await createRemoteMainTask({request:{kind:'main',run_id,node_id:'sourceMain',main_mode:'orchestration',context_mode:'current',workspace,access:'read_only',allowed_paths:[],resources:[],
    authorize:async()=>{},onOperation:async value=>metadata.push(value),onSemanticCorrection:async value=>{corrections.push(value);await onCorrection(value);}},
    context:{signal:controller.signal,owner_descriptor:owner.descriptor,assertAuthority:async()=>{}},target:parent.descriptor,main_actor,operations,remoteTasks});
  t.after(async()=>{
    await task.close();await parent.close();await owner.close();await host.close();await session.abort();session.dispose();
    assert(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,maxRetries:3,retryDelay:100});
  });
  return {task,host,session,manager,faux,executions,failures,events,deliveries,corrections,errors,operations,remoteTasks,metadata};
}

test('actual current-chat SDK tool errors cross agent_end and reverse RPC into a follow-up, then the same task runs after Host rejection',{timeout:20000},async t=>{
  const guessedStage=randomUUID();
  const f=await fixture(t,{responses:[
    submit({output:{text:'Already written'}}),
    submit({summary:'Still the wrong field',output:{text:'Already written'}}),
    submit({summary:'Invented stage',stage_id:guessedStage,patch:[{op:'set',path:'/text',value:'Already written'}]}),
    stopped('Completed without a successful protocol submission.'),
    submit({summary:'Correct protocol',result:{text:'Host rejects this semantic value'}}),stopped('Submitted the actual result.'),
    submit({summary:'Host correction',result:{text:'Host accepts this semantic value'}}),stopped('Submitted the corrected result.'),
  ]});
  const first=await f.task.run({prompt:'Submit sourceMain semantic text through the current chat.',schema});
  assert.equal(first.result.text,'Host rejects this semantic value');
  assert.equal(f.corrections.length,1);assert.equal(f.corrections[0].code,'PI_RESULT_STAGE_MISSING');
  assert.equal(f.deliveries.length,2);assert.notEqual(f.deliveries[0].split('\n')[0],f.deliveries[1].split('\n')[0]);
  assert.match(f.deliveries[1],/"action":"main_result"/);assert(!f.deliveries[1].includes('Required semantic result schema'));
  assert.equal(f.host.main.pending.identity.session_id,first.session_id);assert.equal(f.host.main.pending.active,false);
  assert.equal(f.operations.size,1);assert.equal(f.remoteTasks.size,1,'Host rejection must retain the same exact task owner');
  const hostAccepts=result=>result.text==='Host accepts this semantic value';
  assert.equal(hostAccepts(first.result),false);
  const second=await f.task.run({prompt:'The Host rejected the first semantic value. Submit the corrected value.',schema});
  assert.equal(hostAccepts(second.result),true);assert.equal(second.session_id,first.session_id);assert.notEqual(second.turn_id,first.turn_id);
  assert.equal(f.deliveries.length,3);assert.equal(new Set(f.deliveries.map(prompt=>prompt.split('\n')[0])).size,3);
  assert.equal(f.executions.length,5,'All malformed calls and valid submissions must execute through the registered caw tool');
  assert.equal(f.events.filter(event=>event==='agent_end').length,3);
  assert.equal(f.events.filter(event=>event==='user_message_start').length,3);
  assert(f.events.filter(event=>event==='before_agent_start').length<3,'At least one queued follow-up must activate through the production message_start hook');
  assert.equal(f.metadata.filter(event=>event.tool==='model'&&event.phase==='prompt_prepared').length,3);
  assert.equal(f.faux.state.callCount,8);assert.deepEqual(f.errors,[]);
  const entries=f.manager.getEntries(),receipts=entries.filter(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='caw');
  assert.deepEqual(receipts.map(entry=>entry.message.isError),[true,true,true,false,false]);
  assert.deepEqual(f.failures.map(error=>error.code),['PI_RESULT_SUMMARY','PI_RESULT_BODY','PI_RESULT_STAGE_MISSING']);
  for(let index=0;index<f.failures.length;index++){
    assert.equal(f.failures[index].id,receipts[index].message.toolCallId);
    assert.equal(receipts[index].message.content[0].text,f.failures[index].message,'The real toolResult must expose the exact rejection to the model');
  }
  for(let index=0;index<receipts.length;index++)assert.equal(receipts[index].message.toolCallId,f.executions[index].id);
  for(const result of [first,second])assert(entries.some(entry=>entry.id===result.turn_id&&entry.message?.role==='assistant'&&entry.message.stopReason==='stop'));
  assert(entries.some(entry=>entry.id===f.corrections[0].turn_id&&entry.message?.role==='assistant'&&entry.message.stopReason==='stop'));
  const transcript=(await readFile(f.manager.getSessionFile(),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(transcript.filter(entry=>entry.message?.role==='toolResult'&&entry.message.toolName==='caw').length,5);
  assert(transcript.some(entry=>entry.message?.toolsAdded?.some(tool=>tool.name==='caw'&&tool.parameters.properties.args.patternProperties)));
  await f.task.close();assert.equal(f.host.main.pending,null);assert.equal(f.operations.size,0);assert.equal(f.remoteTasks.size,0);
});

test('actual current-chat SDK budget refusal preserves its diagnostic and sends no extra follow-up',{timeout:15000},async t=>{
  const message='Pinned Main correction budget exhausted. Last rejection: missing semantic result. Evidence: exact-rejection.json';
  const f=await fixture(t,{responses:[stopped('No main_result submission on this turn.')],onCorrection:async()=>{throw Object.assign(new Error(message),{code:'PI_MAIN_REPAIR_EXHAUSTED'});}});
  await assert.rejects(f.task.run({prompt:'Produce one current Main result.',schema}),error=>error.code==='PI_MAIN_REPAIR_EXHAUSTED'&&error.message.includes(message));
  assert.equal(f.corrections.length,1);assert.equal(f.corrections[0].code,'PI_MAIN_RESULT_MISSING');
  assert.equal(f.faux.state.callCount,1);assert.equal(f.deliveries.length,1);assert.equal(f.events.filter(event=>event==='agent_end').length,1);
  await assert.rejects(f.task.run({prompt:'Do not replay exhausted Main.',schema}),{code:'PI_PARENT_MAIN_REPLAY'});
  assert.equal(f.faux.state.callCount,1);assert.equal(f.operations.size,1);assert.equal(f.remoteTasks.size,1);assert.deepEqual(f.errors,[]);
});
