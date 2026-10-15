import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,canonicalJSON} from '../core/workflow-revisions.mjs';
import {HostToolRunner,validateHostToolContract,validateHostToolReceipt} from '../core/execution/host-tool-runner.mjs';

const identity={name:'deadline-fixture',version:'1',sha256:digest('deadline-fixture')};
const effects=()=>({observed:true,changed_paths:['out/partial.txt'],outside_paths:[],artifacts:[]});
const contract=(deadline_ms=1000)=>({id:'deadline-fixture',identity,argv:[],input_schema:{type:'object',additionalProperties:false},output_schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},env_allow:[],permissions:{network:false,read_paths:[],write_paths:['out']},output_cap_bytes:1024,deadline_ms,idempotency:{mode:'safe'}});
const context=()=>({run_id:'run',node_id:'node',attempt_id:'attempt',execution_slot:'slot',deadline_ms:1,permissions:{access:'bounded_write',allowed_paths:['out']}});
const termination=()=>({termination_confirmed:true,evidence:[{kind:'settled',sha256:digest('settled')}],effects:effects()});
function registry(execute,cancel=async()=>termination()){return {[identity.name]:{identity,attestation:{qualified:true,cancellable:true,effect_observation:true,tool_identity:identity,broker_id:'fixture-broker',evidence_sha256:digest('qualified')},execute,cancel}};}
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}

test('Host invocation retains its selected registry across asynchronous validation and later registry refresh',async()=>{
 let selectedCalls=0,replacementCalls=0;
 const selected=registry(async()=>{selectedCalls++;return {exit_code:0,output:{ok:true},effects:effects()};});
 const replacement=registry(async()=>{replacementCalls++;throw new Error('Replacement must not receive this invocation');});
 const runner=new HostToolRunner({registry:replacement});
 const pending=runner.execute(contract(),{},context(),{registry:selected});
 runner.registry=registry(async()=>{replacementCalls++;throw new Error('Later refresh must not change selected implementation');});
 const result=await pending;
 assert.equal(result.receipt.status,'succeeded');assert.equal(selectedCalls,1);assert.equal(replacementCalls,0);
});

test('Host accepts the explicit one-hour bound and rejects invalid or larger deadlines',()=>{
 for(const value of [1,300000,3600000])assert.equal(validateHostToolContract(contract(value)).deadline_ms,value);
 for(const value of [0,-1,1.5,3600001,Number.MAX_SAFE_INTEGER])assert.throws(()=>validateHostToolContract(contract(value)),{code:'HOST_TOOL_CONTRACT'});
});

test('Host forwards its pinned deadline rather than caller context and settles one-hour success or failure once',async()=>{
 for(const deadline of [1000,3600000])for(const exit_code of [0,7]){
  let calls=0,cancels=0,received;
  const runner=new HostToolRunner({registry:registry(async request=>{calls++;received=request.context;return {exit_code,output:{ok:true},diagnostic:'settled',effects:effects()};},async()=>{cancels++;return termination();})});
  const result=await runner.execute(contract(deadline),{},context());
  assert.equal(received.deadline_ms,deadline);assert.equal(received.execution_slot,'slot');assert.equal(calls,1);assert.equal(cancels,0);
  assert.equal(result.receipt.status,exit_code?'failed':'succeeded');assert.equal(result.receipt.exit_code,exit_code);assert.deepEqual(result.output,exit_code?null:{ok:true});
 }
});

test('Host cancellation waits for confirmed settlement before returning its receipt',async()=>{
 const started=deferred(),stopping=deferred(),release=deferred(),controller=new AbortController();let returned=false;
 const runner=new HostToolRunner({registry:registry(async({signal})=>{started.resolve();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({exit_code:9,output:null,effects:effects()}),{once:true}));},async request=>{assert.equal(request.context.execution_slot,'slot');stopping.resolve();await release.promise;return termination();})});
 const pending=runner.execute(contract(3600000),{},context(),{signal:controller.signal}).then(result=>{returned=true;return result;});
 await started.promise;controller.abort(new Error('explicit cancellation'));await stopping.promise;assert.equal(returned,false);release.resolve();
 const result=await pending;assert.equal(result.receipt.status,'cancelled');assert.equal(result.receipt.reconciliation.termination_confirmed,true);validateHostToolReceipt(result.receipt);
});

test('receiptOnError retains the original error with validated effects and exact cancellation receipt',{timeout:2000},async()=>{
 const original=Object.assign(new Error('original broker failure'),{code:'FIXTURE_FAILURE'}),stopping=deferred(),release=deferred();let returned=false,cancels=0;
 const runner=new HostToolRunner({registry:registry(async()=>{throw original;},async request=>{cancels++;assert.equal(request.reason,original);assert.equal(request.signal.aborted,true);stopping.resolve();await release.promise;return termination();})});
 const pending=runner.execute(contract(),{},context(),{receiptOnError:true}).catch(error=>{returned=true;return error;});
 await stopping.promise;assert.equal(returned,false);release.resolve();const error=await pending;
 assert.equal(error,original);assert.equal(cancels,1);const receipt=validateHostToolReceipt(error.host_tool_receipt);
 assert.equal(receipt.status,'cancelled');assert.equal(receipt.attempt_id,'attempt');assert.equal(receipt.input_sha256,digest(canonicalJSON({})));
 assert.deepEqual(receipt.effects,effects());assert.equal(receipt.diagnostics.message,original.message);
 assert.deepEqual(validateHostToolReceipt(JSON.parse(canonicalJSON(receipt))),receipt);
});

test('receiptOnError confirms quiescence after output validation failure and remains opt-in',async()=>{
 let cancels=0;const runner=new HostToolRunner({registry:registry(async()=>({exit_code:0,output:{ok:'invalid'},effects:effects()}),async()=>{cancels++;return termination();})});
 await assert.rejects(runner.execute(contract(),{},context(),{receiptOnError:true}),error=>error.code==='DATA_INVALID'&&error.host_tool_receipt.reconciliation.termination_confirmed===true);assert.equal(cancels,1);
 const original=new Error('legacy caller failure');const legacy=new HostToolRunner({registry:registry(async()=>{throw original;},async()=>{cancels++;return termination();})});
 await assert.rejects(legacy.execute(contract(),{},context()),error=>error===original&&!error.host_tool_receipt);assert.equal(cancels,1);
});

test('short timeout requires termination and thrown cleanup or unconfirmed effects remain visible',async()=>{
 let cancels=0;const timed=new HostToolRunner({registry:registry(async()=>new Promise(()=>{}),async()=>{cancels++;return termination();})});
 const result=await timed.execute(contract(5),{},context());assert.equal(result.receipt.status,'timed_out');assert.equal(cancels,1);validateHostToolReceipt(result.receipt);
 for(const kind of ['throw','unconfirmed','outside']){
  const original=new Error('original failure'),cleanup=new Error('cleanup failed');
  const runner=new HostToolRunner({registry:registry(async()=>{throw original;},async()=>{if(kind==='throw')throw cleanup;return kind==='unconfirmed'?{...termination(),termination_confirmed:false}:{...termination(),effects:{...effects(),changed_paths:['escape.txt']}};})});
  await assert.rejects(runner.execute(contract(),{},context(),{receiptOnError:true}),error=>{
   assert(error instanceof AggregateError);assert.equal(error.errors[0],original);assert.equal(error.quiescent,false);assert.equal(original.host_tool_receipt,undefined);
   if(kind==='throw')assert.equal(error.errors[1],cleanup);else assert.equal(error.errors[1].code,kind==='unconfirmed'?'HOST_TOOL_CANCELLATION_UNCONFIRMED':'HOST_TOOL_SCOPE');return true;
  });
 }
});
