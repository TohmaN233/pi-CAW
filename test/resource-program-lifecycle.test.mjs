import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../core/workflow-revisions.mjs';
import {HostToolRunner,PROGRAM_EXECUTION_RELEASE} from '../core/execution/host-tool-runner.mjs';
import {workflowResourceProgramRegistry,workflowResourceProgramIdentity} from '../core/execution/workflow-resource-program.mjs';

const reply=value=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
const deferred=()=>{let release;return {promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};};
async function fixture(t,{run,quiesce}={}){
  const workspace=await mkdtemp(join(tmpdir(),'resource-lifecycle-'));
  t.after(()=>rm(workspace,{recursive:true,maxRetries:3,retryDelay:100}));
  const code=Buffer.from('fictional pinned executable'),resource={path:'program.mjs',sha256:digest(code),bytes:code};
  let quiesces=0;
  const registry=workflowResourceProgramRegistry({createBroker:async options=>({
    async call(name,args){
      if(name==='mkdir_workspace'){await mkdir(join(workspace,args.path),{recursive:true});return reply({});}
      if(name==='materialize_workflow_resource'){
        const bytes=options.resources.find(item=>item.path===args.path).bytes;
        await writeFile(join(workspace,args.destination),bytes);return reply({});
      }
      assert.equal(name,'run_task_program');await writeFile(join(workspace,'effect.txt'),'exact effect');
      if(run)return run();
      return reply({exit_code:0,stdout:JSON.stringify({done:true}),stderr:''});
    },
    async quiesce(){quiesces++;return quiesce?quiesce(quiesces):{quiescent:true,error:null};},
  })});
  const contract={id:'resource_fixture',identity:workflowResourceProgramIdentity(),argv:['node','program.mjs','.scratch'],env_allow:[],
    input_schema:{type:'object',additionalProperties:false},output_schema:{type:'object',properties:{done:{type:'boolean'}},required:['done'],additionalProperties:false},
    permissions:{network:false,read_paths:['.'],write_paths:['.']},deadline_ms:10000,output_cap_bytes:131072,idempotency:{mode:'reconcile_required'}};
  const context={run_id:'lifecycle',node_id:'tool',attempt_id:'exact-attempt',workspace,resources:[resource],permissions:{access:'bounded_write',allowed_paths:['.']}};
  return {registry,contract,context,runner:new HostToolRunner({registry}),quiesces:()=>quiesces};
}

test('actual resource registry retains an unconfirmed owner through error reconciliation',async t=>{
  let confirmed=false;
  const original=Object.assign(new Error('synthetic owner is live'),{code:'PI_EXECUTION_STOP_UNCONFIRMED'});
  const f=await fixture(t,{run:()=>{throw original;},quiesce:()=>({quiescent:confirmed,error:null})});
  let failure;
  await assert.rejects(f.runner.execute(f.contract,{},f.context,{receiptOnError:true}),error=>{
    failure=error;return error instanceof AggregateError&&error.quiescent===false;
  });
  assert.equal(f.quiesces(),2);assert.equal(failure.host_tool_receipt,undefined);
  assert.equal(failure.errors[0].errors[0],original,'retain the original program failure alongside cleanup failure');
  const cancelContext={run_id:f.context.run_id,node_id:f.context.node_id,attempt_id:f.context.attempt_id};
  await assert.rejects(f.registry['workflow-resource-program'].cancel({context:cancelContext}),{code:'WORKFLOW_RESOURCE_STOP'});
  confirmed=true;
  const stopped=await f.registry['workflow-resource-program'].cancel({context:cancelContext});
  assert.equal(stopped.termination_confirmed,true);assert(stopped.effects.changed_paths.includes('effect.txt'));
});

test('output schema rejection keeps the settled resource effects for its exact error receipt',async t=>{
  const f=await fixture(t,{run:()=>reply({exit_code:0,stdout:JSON.stringify({done:'wrong'}),stderr:''})});
  let failure;
  await assert.rejects(f.runner.execute(f.contract,{},f.context,{receiptOnError:true}),error=>{failure=error;return Boolean(error.host_tool_receipt);});
  assert.equal(failure.host_tool_receipt.status,'cancelled');
  assert.equal(failure.host_tool_receipt.reconciliation.termination_confirmed,true);
  assert(failure.host_tool_receipt.effects.changed_paths.includes('effect.txt'));
  assert.equal(failure.host_tool_receipt.effects.changed_paths.some(path=>path.startsWith('.scratch/')),false,'temporary cleanup settled before effect audit');
});

test('cancellation waits for the exact resource adapter cleanup before confirming effects',async t=>{
  const reached=deferred(),release=deferred(),cancelReached=deferred();
  const f=await fixture(t,{quiesce:async count=>{
    if(count===1){reached.release();await release.promise;}
    else cancelReached.release();
    return {quiescent:true,error:null};
  }});
  const controller=new AbortController();let settled=false;
  const execution=f.runner.execute(f.contract,{},f.context,{signal:controller.signal,receiptOnError:true}).then(result=>{settled=true;return result;});
  await reached.promise;controller.abort(new Error('exact cancellation'));
  await cancelReached.promise;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);
  assert.throws(()=>f.registry['workflow-resource-program'][PROGRAM_EXECUTION_RELEASE]({context:f.context}),{code:'WORKFLOW_RESOURCE_STOP'});
  release.release();const result=await execution;
  assert.equal(result.receipt.status,'cancelled');assert(result.receipt.effects.changed_paths.includes('effect.txt'));
  assert.equal(result.receipt.effects.changed_paths.some(path=>path.startsWith('.scratch/')),false);
});

test('successful Host validation acknowledges and releases the settled resource owner',async t=>{
  const f=await fixture(t),result=await f.runner.execute(f.contract,{},f.context,{receiptOnError:true});
  assert.equal(result.receipt.status,'succeeded');assert(result.receipt.effects.changed_paths.includes('effect.txt'));
  assert.throws(()=>f.registry['workflow-resource-program'][PROGRAM_EXECUTION_RELEASE]({context:f.context}),{code:'WORKFLOW_RESOURCE_STOP'});
});
