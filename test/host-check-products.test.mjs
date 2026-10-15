import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,open } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture,workflow,agent } from './fixtures.mjs';
import { canonicalJSON,digest } from '../core/workflow-revisions.mjs';
import { executeCompletionCheck } from '../lib/runtime-completion-checks.mjs';
import { completionProductPaths,completionWorkspaceSnapshot,readCompletionCheckArtifact,requireHostCompletionProof } from '../core/execution/host-completion-check.mjs';

const effects={observed:true,changed_paths:[],outside_paths:[],artifacts:[]};
async function checked(t,{products=[],complete=true}={}){
  const f=await fixture(t);let calls=0;
  const identity={name:'product-check',version:'1',sha256:digest('product check')};
  const contract={id:'product_check',identity,argv:['product_check'],env_allow:[],
    input_schema:{type:'object',properties:{inputs:{},output:{}},required:['inputs','output'],additionalProperties:false},
    output_schema:{type:'object',properties:{complete:{type:'boolean'},diagnostic:{type:'string'}},required:['complete','diagnostic'],additionalProperties:false},
    permissions:{network:false,read_paths:['.'],write_paths:['.']},output_cap_bytes:4096,deadline_ms:1000,idempotency:{mode:'reconcile_required'}};
  f.host.getHostTools=()=>({[contract.id]:{identity,contract,attestation:{qualified:true,cancellable:true,effect_observation:true,tool_identity:identity,broker_id:'product-fixture',evidence_sha256:digest('product qualification')},
    execute:async()=>{calls++;return {exit_code:0,output:{complete,diagnostic:'Fixture verdict'},effects,diagnostic:'Checked'};},
    cancel:async()=>({termination_confirmed:true,evidence:[{kind:'stop',sha256:digest('stop')}],effects})}});
  await f.service.refreshContext();
  const definition={...agent('checked',{kind:'main',mode:'worker'}),access:'bounded_write',path_scope:{binding:'run.allowed_paths'},
    required_artifacts:products.map((path,index)=>({requirement_id:'product_'+index,path})),
    completion_contract:{on_missing:'block',outcome:'artifact',host_check:{tool:contract.id,success_field:'complete',correction_field:'diagnostic'}}};
  const graph=workflow([definition]);graph.host_tools=[contract];await f.service.call('create_workflow',{workflow:graph});
  const run=await f.service.runtime.start({workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],inputs:{task:'Fixture'},main_actor:f.mainSession});
  const envelope=await f.service.runtime.claimHostMain(run.run_id,{control_token:run.control_token,node_id:'checked',owner:f.mainSession,request_id:'product-check-lease'});
  const args={control_token:run.control_token,node_id:'checked',attempt_id:envelope.attempt_id,lease_token:envelope.lease_token};
  const options={definition,envelope,output:{text:'Semantic result, no inferred product'},turn:{session_id:'product-session',turn_id:'product-turn'},resources:[]};
  async function execute(){return executeCompletionCheck(f.service,run.run_id,args,options);}
  async function proof(reference,record=undefined){record??=await f.service.runtime.runs.read(run.run_id);return requireHostCompletionProof(f.service.runtime,run.run_id,record,definition,record.state.nodes.checked.attempts[0],options.output,reference);}
  return {...f,run,args,options,definition,execute,proof,calls:()=>calls};
}
async function payload(f,reference){const record=await f.service.runtime.runs.read(f.run.run_id),slot=record.state.nodes.checked.attempts[0].completion_checks[reference.slot_id];
  return {record,slot,stored:await readCompletionCheckArtifact(f.service.runtime,f.run.run_id,f.args.attempt_id,slot.receipt.output_ref)};}
async function retainedPayload(f,record,slot,stored){
  const payload_ref=await f.service.runtime.runs.saveArtifact(f.run.run_id,'legacy-product-fixture',Buffer.from(canonicalJSON(stored)));
  const wrapper={kind:'pi_host_completion_check',identity:stored.identity,payload_ref};
  const ref=await f.service.runtime.runs.saveExecutorResult(f.run.run_id,f.args.attempt_id,wrapper);
  slot.receipt.output_ref={...ref,bytes:Buffer.byteLength(canonicalJSON(wrapper))};return record;
}

test('declared products survive unrelated runtime bookkeeping but reject changed product bytes on proof and replay',async t=>{
  const f=await checked(t,{products:['product.txt']});await writeFile(join(f.workspace,'product.txt'),'original');await writeFile(join(f.workspace,'bookkeeping.json'),'before');
  const result=await f.execute();await writeFile(join(f.workspace,'bookkeeping.json'),'after');await f.proof(result.reference);
  assert.equal((await f.execute()).accepted,true);assert.equal(f.calls(),1);
  await writeFile(join(f.workspace,'product.txt'),'changed');await assert.rejects(f.proof(result.reference),{code:'HOST_CHECK_SNAPSHOT_STALE'});
  await assert.rejects(f.execute(),{code:'HOST_CHECK_SNAPSHOT_STALE'});assert.equal(f.calls(),1);
});

test('no declared products create no snapshot and ignore all workspace changes',async t=>{
  const f=await checked(t);await mkdir(join(f.workspace,'unrelated'));await writeFile(join(f.workspace,'unrelated','state.json'),'before');
  const result=await f.execute(),{stored}=await payload(f,result.reference);assert.equal(Object.hasOwn(stored,'workspace_snapshot'),false);
  await writeFile(join(f.workspace,'unrelated','state.json'),'after');await f.proof(result.reference);assert.equal((await f.execute()).accepted,true);assert.equal(f.calls(),1);
});

test('rejected checks do not seal nonexistent declared products',async t=>{
  const f=await checked(t,{products:['not-yet-produced.txt'],complete:false}),result=await f.execute();assert.equal(result.accepted,false);
  const {stored}=await payload(f,result.reference);assert.equal(Object.hasOwn(stored,'workspace_snapshot'),false);
  await assert.rejects(f.proof(result.reference),{code:'HOST_CHECK_REJECTED'});assert.equal((await f.execute()).accepted,false);assert.equal(f.calls(),1);
});

test('immutable legacy plain maps supply only exact current declared product hashes',async t=>{
  const f=await checked(t,{products:['product.txt']});await writeFile(join(f.workspace,'product.txt'),'original');const result=await f.execute();
  const {record,slot,stored}=await payload(f,result.reference);stored.workspace_snapshot={'product.txt':digest('original'),'bookkeeping.json':digest('before')};
  await retainedPayload(f,record,slot,stored);const old=await f.service.runtime.runs.readArtifact(f.run.run_id,(await f.service.runtime.runs.readExecutorResult(f.run.run_id,f.args.attempt_id,slot.receipt.output_ref.sha256)).payload_ref);
  await writeFile(join(f.workspace,'bookkeeping.json'),'after');await f.proof(result.reference,record);
  assert.equal(Buffer.from(old).toString(),canonicalJSON(stored));
  for(const snapshot of [{}, {'product.txt':null}, {'product.txt':'corrupt'}]){
    const next=structuredClone(record),nextSlot=next.state.nodes.checked.attempts[0].completion_checks[result.reference.slot_id];
    await retainedPayload(f,next,nextSlot,{...stored,workspace_snapshot:snapshot});await assert.rejects(f.proof(result.reference,next),{code:'HOST_CHECK_SNAPSHOT_REQUIRED'});
  }
  const missing=structuredClone(record),withoutProof={...stored};delete withoutProof.workspace_snapshot;
  await retainedPayload(f,missing,missing.state.nodes.checked.attempts[0].completion_checks[result.reference.slot_id],withoutProof);
  await assert.rejects(f.proof(result.reference,missing),{code:'HOST_CHECK_SNAPSHOT_REQUIRED'});
  await writeFile(join(f.workspace,'product.txt'),'changed');await assert.rejects(f.proof(result.reference,record),{code:'HOST_CHECK_SNAPSHOT_STALE'});assert.equal(f.calls(),1);
});

test('Windows legacy snapshots retain case-insensitive file identity and reject conflicting proof', {skip:process.platform!=='win32'},async t=>{
  const f=await checked(t,{products:['readme.md']});await writeFile(join(f.workspace,'README.md'),'original');const result=await f.execute();
  const {record,slot,stored}=await payload(f,result.reference);
  stored.workspace_snapshot={'README.md':digest('original'),'bookkeeping.json':digest('before')};
  await retainedPayload(f,record,slot,stored);const legacy=canonicalJSON(stored);
  await writeFile(join(f.workspace,'bookkeeping.json'),'after');await f.proof(result.reference,record);
  assert.equal(canonicalJSON(stored),legacy);assert.equal(f.calls(),1);
  for(const secondHash of [digest('conflicting'),null,'corrupt']){
    const ambiguous=structuredClone(record),ambiguousSlot=ambiguous.state.nodes.checked.attempts[0].completion_checks[result.reference.slot_id];
    await retainedPayload(f,ambiguous,ambiguousSlot,{...stored,workspace_snapshot:{'README.md':digest('original'),'readme.md':secondHash}});
    await assert.rejects(f.proof(result.reference,ambiguous),{code:'HOST_CHECK_SNAPSHOT_REQUIRED'});
  }
  const aliases=structuredClone(record),aliasSlot=aliases.state.nodes.checked.attempts[0].completion_checks[result.reference.slot_id];
  await retainedPayload(f,aliases,aliasSlot,{...stored,workspace_snapshot:{'README.md':digest('original'),'readme.md':digest('original')}});
  await f.proof(result.reference,aliases);
  await writeFile(join(f.workspace,'README.md'),'changed');await assert.rejects(f.proof(result.reference,record),{code:'HOST_CHECK_SNAPSHOT_STALE'});assert.equal(f.calls(),1);
  await assert.rejects(f.proof(result.reference,aliases),{code:'HOST_CHECK_SNAPSHOT_STALE'});
});

test('no-product legacy receipts ignore excessive seals while retaining exact input and receipt proof',async t=>{
  const f=await checked(t),result=await f.execute(),{record,slot,stored}=await payload(f,result.reference);
  await retainedPayload(f,record,slot,{...stored,workspace_snapshot:{'old-runtime-state':digest('before')}});
  await writeFile(join(f.workspace,'old-runtime-state'),'after');await f.proof(result.reference,record);
  for(const field of ['run_id','node_id','attempt_id','input_sha256','tool']){
    const wrong=structuredClone(record);wrong.state.nodes.checked.attempts[0].completion_checks[result.reference.slot_id].receipt[field]=field.endsWith('sha256')?digest('wrong'):'wrong';
    await assert.rejects(f.proof(result.reference,wrong),{code:'HOST_CHECK_INTENT'});
  }
  const readArtifact=f.service.runtime.runs.readArtifact.bind(f.service.runtime.runs);
  f.service.runtime.runs.readArtifact=async(run,ref)=>ref.sha256===stored.input_ref.sha256?Buffer.from('{broken'):readArtifact(run,ref);
  await assert.rejects(f.proof(result.reference,record),SyntaxError);assert.equal(f.calls(),1);
  f.service.runtime.runs.readArtifact=async(run,ref)=>ref.sha256===stored.input_ref.sha256?Buffer.from(canonicalJSON({inputs:{task:'wrong'},output:f.options.output})):readArtifact(run,ref);
  await assert.rejects(f.proof(result.reference,record),{code:'HOST_CHECK_OUTPUT_CORRUPT'});
  const denied=Object.assign(new Error('Denied durable check input'),{code:'EACCES'});
  f.service.runtime.runs.readArtifact=async(run,ref)=>{if(ref.sha256===stored.input_ref.sha256)throw denied;return readArtifact(run,ref);};
  await assert.rejects(f.proof(result.reference,record),error=>error===denied);
});

test('product selection uses pinned node paths relative to the actual isolated item workspace and exact grant',()=>{
  const workspace=process.cwd(),definition={fanout:{},required_artifacts:[{path:'one/render.txt'},{path:'two/render.txt'}]},envelope={workspace};
  assert.deepEqual(completionProductPaths(definition,envelope,{workspace:join(workspace,'one'),allowed_paths:['.']}),['render.txt']);
  assert.throws(()=>completionProductPaths(definition,envelope,{workspace:join(workspace,'one'),allowed_paths:['other.txt']}),{code:'HOST_CHECK_SCOPE'});
  assert.throws(()=>completionProductPaths({required_artifacts:[{path:'../outside.txt'}]},envelope,{workspace,allowed_paths:['.']}),{code:'PATH_SCOPE'});
});

test('product snapshots reject directories, escapes and oversized files',async t=>{
  const f=await checked(t);await mkdir(join(f.workspace,'directory'));
  await assert.rejects(completionWorkspaceSnapshot(f.workspace,['directory']),{code:'HOST_CHECK_SCOPE'});
  await assert.rejects(completionWorkspaceSnapshot(f.workspace,['../outside']),{code:'HOST_CHECK_SCOPE'});
  const handle=await open(join(f.workspace,'oversized'),'w');try{await handle.truncate(256*1024*1024+1);}finally{await handle.close();}
  await assert.rejects(completionWorkspaceSnapshot(f.workspace,['oversized']),{code:'HOST_CHECK_SNAPSHOT_LIMIT'});
});

test('no-product snapshots perform no tree traversal and file reads preserve denied-read errors',()=>{
  const module=new URL('../core/execution/host-completion-check.mjs',import.meta.url).href;
  const script=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
    const denied=Object.assign(new Error('Denied exact product'),{code:'EACCES'});let reads=0;
    fs.readdir=async()=>{throw new Error('Tree traversal is forbidden');};fs.open=async()=>{reads++;throw denied;};fs.readFile=async()=>{reads++;throw denied;};
    fs.lstat=async()=>({isSymbolicLink:()=>false,isFile:()=>true,nlink:1,size:1});syncBuiltinESMExports();
    const {completionWorkspaceSnapshot}=await import(${JSON.stringify(module)});
    await completionWorkspaceSnapshot(process.cwd(),[]);assert.equal(reads,0);
    await assert.rejects(completionWorkspaceSnapshot(process.cwd(),['exact-product.txt']),error=>error===denied);assert.equal(reads,1);`;
  execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'});
});

test('stable product reads reject hard links, link ancestors, replacement, growth and metadata drift without unbounded IO',()=>{
  const module=new URL('../core/execution/host-completion-check.mjs',import.meta.url).href;
  const script=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
    let mode,reads,closed;const metadata=()=>({isSymbolicLink:()=>mode==='symlink',isFile:()=>true,nlink:mode==='hardlink'?2:1,size:3,dev:1,ino:1,mtimeMs:1,ctimeMs:1});
    fs.lstat=async()=>metadata();fs.open=async()=>({stat:async()=>({...metadata(),...(reads&&mode==='replace'?{ino:2}:{}),...(reads&&mode==='mtime'?{mtimeMs:2}:{}),...(reads&&mode==='ctime'?{ctimeMs:2}:{})}),
      read:async(buffer,offset,length)=>{reads++;assert(buffer.length===4);assert(length<=4);const count=mode==='growth'?4:3;buffer.fill(97,offset,Math.min(offset+count,buffer.length));return {bytesRead:offset?0:count};},close:async()=>{closed++;}});
    syncBuiltinESMExports();const {completionWorkspaceSnapshot}=await import(${JSON.stringify(module)});
    for(mode of ['hardlink','symlink','replace','growth','mtime','ctime']){reads=0;closed=0;
      await assert.rejects(completionWorkspaceSnapshot(process.cwd(),['exact-product']),{code:mode==='hardlink'?'HOST_CHECK_SCOPE':mode==='symlink'?'WORKFLOW_SYMLINK':'HOST_CHECK_SNAPSHOT_STALE'});
      assert.equal(closed,mode==='hardlink'||mode==='symlink'?0:1);assert(reads<=2);}
    mode='stable';reads=0;closed=0;const snapshot=await completionWorkspaceSnapshot(process.cwd(),['exact-product']);assert.equal(snapshot.entries[0].bytes,3);assert.equal(closed,1);`;
  execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'});
});
