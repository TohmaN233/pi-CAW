import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createParentMainBridge} from '../lib/parent-main-bridge.mjs';
import {createOwnerRpcServer,ownerRpc} from '../lib/detached-owner.mjs';
import {createRemoteMainTask,dispatchMainCallback} from '../lib/pi-worker.mjs';

async function fixture(t,{run,callback}={}){
  const run_id='exact-rpc-main',main_actor='original-pi-chat';
  let request,created=0,closed=0;
  const owner=await createOwnerRpcServer({run_id,handle:callback??(async()=>({recorded:true}))});
  const host={mainIdentity:()=>({session_id:main_actor}),async createMainTask(value){
    request=value;created++;
    return {session_id:main_actor,async run(args){return run?run(request,args):{turn_id:randomUUID(),result:{text:args.prompt}};},
      async abort(){},async close(){closed++;}};
  }};
  const bridge=await createParentMainBridge({host,run_id,main_actor});
  t.after(async()=>{await bridge.close();await owner.close();});
  const task_handle=randomUUID(),operation_id=randomUUID();
  await ownerRpc(bridge.descriptor,'create_main_task',{task_handle,operation_id,main_actor,owner_descriptor:owner.descriptor,
    request:{kind:'main',run_id,semantic_correction_required:true}});
  return {bridge,task_handle,operation_id,counts:()=>({created,closed}),request:()=>request};
}

test('parent Main reverse RPC awaits exact semantic correction callback',async t=>{
  const corrections=[],correction={turn_id:'actual-pi-turn',reason:'Missing current Main result',code:'PI_MAIN_RESULT_MISSING'};
  const f=await fixture(t,{callback:async(operation,args)=>{assert.equal(operation,'main_semantic_correction');corrections.push(args);return {corrected:true};},
    run:async request=>{assert.equal(typeof request.onSemanticCorrection,'function');await request.onSemanticCorrection(correction);return {result:{text:'repaired'}};}});
  assert.deepEqual(await ownerRpc(f.bridge.descriptor,'run_main_task',{task_handle:f.task_handle,prompt:'first',schema:{}}),{result:{text:'repaired'}});
  assert.deepEqual(corrections,[{operation_id:f.operation_id,correction}]);
});

test('same parent owner can run its successful exact task again without creating or releasing a session',async t=>{
  const f=await fixture(t);
  const first=await ownerRpc(f.bridge.descriptor,'run_main_task',{task_handle:f.task_handle,prompt:'first',schema:{}});
  const second=await ownerRpc(f.bridge.descriptor,'run_main_task',{task_handle:f.task_handle,prompt:'semantic correction',schema:{}});
  assert.equal(first.result.text,'first');assert.equal(second.result.text,'semantic correction');assert.notEqual(first.turn_id,second.turn_id);
  assert.deepEqual(f.counts(),{created:1,closed:0});
  await ownerRpc(f.bridge.descriptor,'close_main_task',{task_handle:f.task_handle});
  assert.deepEqual(f.counts(),{created:1,closed:1});
});

async function remoteFixture(t,{run,onSemanticCorrection,assertAuthority=async()=>{}}={}){
  const run_id='worker-main-rpc',main_actor='same-original-chat',operations=new Map(),remoteTasks=new Set(),controller=new AbortController();
  let created=0,calls=0,closed=0,aborts=0,hostRequest;
  const owner=await createOwnerRpcServer({run_id,handle:(operation,args)=>dispatchMainCallback(operations,operation,args)});
  const host={mainIdentity:()=>({session_id:main_actor}),async createMainTask(request){created++;hostRequest=request;
    return {session_id:main_actor,async run(args){calls++;return run?run(request,args,calls):{turn_id:`turn-${calls}`,result:{text:args.prompt}};},
      async abort(){aborts++;},async close(){closed++;}};
  }};
  const bridge=await createParentMainBridge({host,run_id,main_actor});
  const context={signal:controller.signal,owner_descriptor:owner.descriptor,assertAuthority};
  const task=await createRemoteMainTask({request:{kind:'main',run_id,onSemanticCorrection},context,target:bridge.descriptor,main_actor,operations,remoteTasks});
  t.after(async()=>{await task.close();await bridge.close();await owner.close();});
  return {task,bridge,controller,operations,remoteTasks,request:()=>hostRequest,counts:()=>({created,calls,closed,aborts})};
}

test('worker packet bridges semantic correction over real RPC and retains callbacks until exact close',async t=>{
  const corrections=[],correction={turn_id:'pi-turn-one',reason:'Use caw main_result',code:'PI_MAIN_RESULT_MISSING'};
  const f=await remoteFixture(t,{onSemanticCorrection:async value=>corrections.push(value),
    run:async request=>{assert.equal(typeof request.onSemanticCorrection,'function');await request.onSemanticCorrection(correction);return {result:{text:'repaired'}};}});
  assert.deepEqual(await f.task.run({prompt:'first',schema:{}}),{result:{text:'repaired'}});
  assert.deepEqual(corrections,[correction]);assert.equal(f.operations.size,1);assert.equal(f.remoteTasks.size,1);
  await f.task.close();assert.equal(f.operations.size,0);assert.equal(f.remoteTasks.size,0);assert.equal(f.counts().closed,1);
});

test('worker allows a second successful run on the same owner and session without closing',async t=>{
  const f=await remoteFixture(t);
  assert.equal((await f.task.run({prompt:'first',schema:{}})).turn_id,'turn-1');
  assert.equal((await f.task.run({prompt:'Host rejected semantics',schema:{}})).turn_id,'turn-2');
  assert.deepEqual(f.counts(),{created:1,calls:2,closed:0,aborts:0});
  assert.equal(f.operations.size,1);assert.equal(f.remoteTasks.size,1);
});

for(const code of ['EIO','PI_MAIN_REPAIR_EXHAUSTED'])test(`semantic correction RPC preserves ${code} and consumes the failed task`,async t=>{
  const message=code==='EIO'?'Exact storage failure':'Current-chat Main exhausted its pinned correction budget. Use caw main_result\nRejection evidence: semantic.json (sha256 exact-evidence)';
  const f=await remoteFixture(t,{onSemanticCorrection:async()=>{throw Object.assign(new Error(message),{code});},
    run:async request=>{await request.onSemanticCorrection({turn_id:'exact-turn',reason:'Use caw main_result',code:'PI_MAIN_RESULT_MISSING'});return {result:{text:'must not succeed'}};}});
  await assert.rejects(f.task.run({prompt:'first',schema:{}}),error=>error.code===code&&error.message===message);
  await assert.rejects(f.task.run({prompt:'repeat failed',schema:{}}),{code:'PI_PARENT_MAIN_REPLAY'});
  assert.equal(f.counts().calls,1);assert.equal(f.counts().closed,0);
});

test('worker reserves each dispatch before awaited authority and rejects concurrent replay',async t=>{
  let release,entered,authorizations=0;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=await remoteFixture(t,{assertAuthority:async()=>{if(++authorizations===2){entered();await gate;}}});
  const first=f.task.run({prompt:'first',schema:{}});
  try{await started;await assert.rejects(f.task.run({prompt:'concurrent',schema:{}}),{code:'PI_PARENT_MAIN_REPLAY'});}
  finally{release();}
  await first;assert.equal(f.counts().calls,1);
});

test('worker cancellation cannot make the exact task replayable and owner remains until close',async t=>{
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const f=await remoteFixture(t,{run:async(_request,args)=>{
    entered();await new Promise(resolve=>{args.signal.addEventListener('abort',resolve,{once:true});if(args.signal.aborted)resolve();});
    throw Object.assign(new Error('Original dispatch cancelled'),{code:'PI_TASK_ABORTED'});
  }});
  const signal=new AbortController(),first=f.task.run({prompt:'first',schema:{},signal:signal.signal});
  const outcome=first.then(value=>({value}),error=>({error}));
  await started;signal.abort();assert.equal((await outcome).error.code,'PI_TASK_ABORTED');
  await assert.rejects(f.task.run({prompt:'repeat cancellation',schema:{}}),{code:'PI_PARENT_MAIN_REPLAY'});
  assert.equal(f.counts().calls,1);assert.equal(f.counts().closed,0);assert.equal(f.remoteTasks.size,1);
});

test('a disconnected worker dispatch remains consumed and retains its exact cleanup owner',async t=>{
  const run_id='uncertain-main-rpc',main_actor='original-chat',operations=new Map(),remoteTasks=new Set(),controller=new AbortController();
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const target=await createOwnerRpcServer({run_id,handle:async(operation,args)=>{
    if(operation==='create_main_task')return {task_handle:args.task_handle,session_id:main_actor};
    assert.equal(operation,'run_main_task');entered();return new Promise(()=>{});
  }});
  t.after(()=>target.close());
  const task=await createRemoteMainTask({request:{kind:'main',run_id},context:{signal:controller.signal,assertAuthority:async()=>{},owner_descriptor:target.descriptor},
    target:target.descriptor,main_actor,operations,remoteTasks});
  const outcome=task.run({prompt:'exact dispatch',schema:{}}).then(value=>({value}),error=>({error}));
  await started;await target.close();
  const {error}=await outcome;
  assert.equal(error.code,'PI_PARENT_MAIN_DISCONNECTED');assert.equal(error.quiescent,false);
  await assert.rejects(task.run({prompt:'must not replay',schema:{}}),{code:'PI_PARENT_MAIN_REPLAY'});
  await assert.rejects(task.close(),{code:'PI_PARENT_MAIN_DISCONNECTED'});
  assert.equal(operations.size,1);assert.equal(remoteTasks.size,1);
});
