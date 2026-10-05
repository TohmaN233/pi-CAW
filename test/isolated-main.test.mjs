import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import {PiSdkHost} from '../lib/pi-sdk-host.mjs';
import {PiCawService} from '../lib/service.mjs';
import {agent, workflow} from './fixtures.mjs';
import {mainContextMode, mainContextChoice} from '../lib/main-context.mjs';

test('Main chooses isolation or conversation continuity without overriding declared Strict',()=>{
  assert.equal(mainContextMode({mode:'strict'}),'isolated');
  assert.equal(mainContextMode({mode:'cooperative'}),'current');
  assert.equal(mainContextMode({mode:'cooperative'},'isolated'),'isolated');
  assert.equal(mainContextMode({mode:'cooperative'},'current'),'current');
  assert.throws(()=>mainContextMode({mode:'strict'},'current'),{code:'PI_MAIN_CONTEXT'});
  assert.throws(()=>mainContextChoice('child'),{code:'PI_MAIN_CONTEXT'});
});

test('isolated Main inherits the live model and thinking at each dispatch, never a Provider override',async()=>{
  let selected={provider:'local',id:'first'},thinking='low';
  const context={cwd:process.cwd(),model:selected,thinkingLevel:thinking,sessionManager:{getSessionId:()=> 'parent',getSessionFile:()=> 'parent.jsonl'}};
  const host=new PiSdkHost({sdk:{},Type:{},supportedThinking:()=>[],agentDir:process.cwd(),getContext:()=>context});
  host.catalog=()=>['first','second'].map(model_id=>({provider:'local',model_id,thinking_levels:['low','high'],fingerprint:'a'.repeat(64)}));
  const requests=[];
  host.createTask=async request=>{requests.push(request);return{session_id:randomUUID()};};
  const task=await host.createMainTask({kind:'main',strict:true});
  assert.equal(task.observed_model.model_id,'first');assert.equal(task.observed_model.thinking,'low');
  context.model={provider:'local',id:'second'};context.thinkingLevel='high';
  const next=await host.createMainTask({kind:'main',strict:false,context_mode:'isolated'});
  assert.equal(next.observed_model.model_id,'second');assert.equal(next.observed_model.thinking,'high');
  assert.equal(requests[0].kind,'isolated_main');assert.equal(requests[1].kind,'isolated_main');
  assert.equal(task.main_actor,'parent');assert.equal(next.main_actor,'parent');
  assert.notEqual(task.session_id,next.session_id);
  await assert.rejects(host.createMainTask({strict:true,binding:{provider:'other'}}),{code:'PI_MAIN_MODEL_OWNER'});
  await assert.rejects(host.createMainTask({strict:true,session_file:'another.jsonl'}),{code:'PI_MAIN_MODEL_OWNER'});
});

const until = async (read, predicate) => {
  const deadline = Date.now() + 20000;
  let last;
  while (Date.now() < deadline) { const value = last = await read(); if (predicate(value)) return value;
    if (value.state && ['failed','interrupted'].includes(value.state.status)) throw new Error(JSON.stringify({status:value.state.status,error:value.state.pi_owner_error,nodes:value.state.nodes}));
    await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Exact isolated Main evidence did not arrive: '+JSON.stringify({status:last?.state?.status,owner:last?.observedOwner,nodes:Object.fromEntries(Object.entries(last?.state?.nodes??{}).map(([id,node])=>[id,{status:node.status,error:node.error}]))}));
};

test('strict logical Main runs through the real detached owner with fresh Pi contexts and the calling model', {timeout:30000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-isolated-main-'));
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({packages:[],retry:{enabled:false}}));
  await writeFile(join(cwd, 'AGENTS.md'), 'AMBIENT_CONTEXT_MUST_NOT_LEAK');
  const faux = ai.fauxProvider({provider:`isolated-main-${randomUUID()}`, models:[{id:'selected-main',reasoning:false}],tokensPerSecond:0});
  const seen = [];
  for (const text of ['First isolated result', 'Final isolated result']) seen.push(text);
  let index = 0;
  faux.setResponses(seen.flatMap(text => [context => {
    assert.ok(!JSON.stringify(context).includes('PRIVATE_PARENT_HISTORY'));
    assert.ok(!JSON.stringify(context).includes('AMBIENT_CONTEXT_MUST_NOT_LEAK'));
    assert.ok(!JSON.stringify(context).includes('First isolated result'));
    index++;
    return ai.fauxAssistantMessage(ai.fauxToolCall('caw_submit_result',{result:{text},summary:text}),{stopReason:'toolUse'});
  }, ai.fauxAssistantMessage('Submitted.') ]));
  const runtime = await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
  runtime.registerNativeProvider(faux.provider); await runtime.refresh({allowNetwork:false});
  const parent = sdk.SessionManager.create(cwd,join(agentDir,'sessions'));
  parent.appendMessage(ai.fauxAssistantMessage('PRIVATE_PARENT_HISTORY'));
  const context = {cwd,sessionManager:parent,modelRegistry:new sdk.ModelRegistry(runtime),model:faux.getModel(),thinkingLevel:'off',isProjectTrusted:()=>false};
  const host = new PiSdkHost({sdk,Type:ai.Type,supportedThinking:ai.getSupportedThinkingLevels,agentDir,getContext:()=>context,
    deliverMain:()=>assert.fail('An isolated node must not send a prompt to the parent conversation')});
  host.modelRuntimes.set(faux.getModel().provider,runtime);
  const service = await new PiCawService({directory:join(root,'state'),host}).initialize();
  let runId;
  t.after(async()=>{
    if(runId) await service.detachedOwners.stop(runId,'test_cleanup');
    await service.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
    await rm(root,{recursive:true,maxRetries:5,retryDelay:100});
  });
  const graph = workflow([agent('work',{kind:'main'})]);
  graph.skill_policy = {mode:'strict',implicit:'deny',ambient_allow:[],shadowed_skill_paths:[]};
  await service.call('create_workflow',{workflow:graph});
  const started = await service.call('run',{workflow_id:'example',workspace:cwd,access:'read_only',inputs:{task:'Perform this isolated task'}});
  runId = started.run_id;
  const record = await until(async()=>{
    const value=await service.runtime.runs.read(runId), owner=await service.detachedOwners.read(runId);
    if(owner.phase==='failed') throw new Error(JSON.stringify(owner.outcome));
    if(owner.status==='attention') throw new Error(JSON.stringify(owner.outcome));
    value.observedOwner={phase:owner.phase,status:owner.status,outcome:owner.outcome};
    return value;
  },value=>!!value.state.nodes.final.attempts.at(-1)?.result_proposal);
  assert.equal(index,2);
  const receipts = ['work','final'].map(id=>record.state.nodes[id].attempts.at(-1).dispatch.receipt);
  assert.equal(record.state.nodes.work.status,'succeeded');
  assert.equal(record.state.main_actor,parent.getSessionId());
  assert.equal(new Set(receipts.map(receipt=>receipt.thread_id)).size,2);
  for(const receipt of receipts){
    assert.equal(receipt.executor,'pi-isolated-main');
    assert.equal(receipt.main_actor,parent.getSessionId());
    assert.equal(receipt.session_id,parent.getSessionId());
    assert.notEqual(receipt.thread_id,parent.getSessionId());
    assert.equal(receipt.observed_model.model_id,'selected-main');
    assert.equal(receipt.observed_model.thinking,'off');
    assert.ok(resolve(receipt.session_file).startsWith(resolve(service.directory,'execution-sessions',runId)+sep));
    assert.equal(receipt.session_storage,'private');
    const entries=(await readFile(receipt.session_file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(entries.some(row=>row.customType==='pi-caw:task'&&row.data.kind==='isolated_main'));
    assert.ok(entries.some(row=>row.message?.role==='toolResult'&&row.message.toolName==='caw_submit_result'));
  }
  assert.equal(parent.getEntries().filter(row=>row.type==='message').length,1);
  const final = record.state.nodes.final.attempts.at(-1);
  await service.call('accept_final',{run_id:runId,accepted:true,proposal_sha256:final.result_proposal.sha256},{human:true});
  await until(()=>service.detachedOwners.read(runId),value=>value.termination?.confirmed===true);
  assert.equal((await service.runtime.runs.read(runId)).state.status,'succeeded');
  assert.equal(host.tasks.size,0);
  assert.equal((await sdk.SessionManager.listAll(join(agentDir,'sessions'))).some(item=>receipts.some(r=>r.thread_id===item.id)),false);
  await service.retention.sweep({completed_now:true});
  for(const receipt of receipts) await assert.rejects(readFile(receipt.session_file),{code:'ENOENT'});
  assert.ok(await readFile(parent.getSessionFile(),'utf8'));
});
