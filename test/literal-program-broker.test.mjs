import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiToolBroker } from '../lib/host-tools.mjs';

const value=result=>JSON.parse(result.contentItems[0].text);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const environment={status:'ready',tools:[{name:'node',path:process.execPath,status:'found'}]};
async function fixture(t,extra={}) {
  const workspace=await mkdtemp(join(tmpdir(),'pi-literal-program-')),operations=[];
  await mkdir(join(workspace,'output'));
  const broker=await createPiToolBroker({workspace,access:'bounded_write',allowedPaths:['output'],
    runtimeEnvironment:environment,authorize:async()=>{},onOperation:async event=>operations.push(structuredClone(event)),...extra});
  t.after(async()=>{await broker.quiesce();await rm(workspace,{recursive:true,maxRetries:3,retryDelay:100});});
  return {workspace,broker,operations};
}
async function drain(broker,result) {
  let output=result.output;
  const ids=[];
  while(result.has_more){
    ids.push(result.session_id);
    result=value(await broker.call('continue_workspace_command',{session_id:result.session_id,yield_time_ms:1000},`continue-${ids.length}`));
    output+=result.output;
  }
  return {result,output,ids};
}

test('literal program delivers multiline UTF-8 stdin then EOF with exact argv and workspace cwd',async t=>{
  const {workspace,broker,operations}=await fixture(t);
  const stdin='标题\nline two\r\n😀\n\u0000end';
  const script="const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input:Buffer.concat(chunks).toString('utf8'),args:process.argv.slice(1),cwd:process.cwd()})))";
  const result=value(await broker.call('run_workspace_program',{program:process.execPath,args:['-e',script,'@WORKSPACE@','@TASK_ROOT@','$(literal); | &'],stdin,workdir:'output',yield_time_ms:30000},'stdin-roundtrip'));
  assert.equal(result.status,'completed');assert.equal(result.exit_code,0);assert.equal(result.has_more,false);
  assert.deepEqual(JSON.parse(result.output),{input:stdin,args:['@WORKSPACE@','@TASK_ROOT@','$(literal); | &'],cwd:join(workspace,'output')});
  const started=operations.find(event=>event.call_id==='stdin-roundtrip'&&event.phase==='started');
  const completed=operations.find(event=>event.call_id==='stdin-roundtrip'&&event.phase==='completed');
  assert.equal(started.executable,process.execPath);assert.equal(started.stdin_bytes,Buffer.byteLength(stdin));
  assert.equal(started.process_id,completed.process_id);assert.equal(completed.output_evidence.output_id,result.output_ref.output_id);
  assert.deepEqual(await broker.quiesce(),{quiescent:true,error:null});
});

test('literal alias and discovered path use the same refreshed Host binding',async t=>{
  let refreshes=0;
  const {broker}=await fixture(t,{prepareRuntimeEnvironment:async()=>{refreshes++;return {environment};}});
  for(const program of ['node',process.execPath]){
    const result=value(await broker.call('run_workspace_program',{program,args:['-e',"process.stdout.write(process.execPath)"]},`program-${refreshes}`));
    assert.equal(result.output,process.execPath);assert.equal(result.exit_code,0);
  }
  assert.equal(refreshes,2);
});

test('read-only broker exposes literal execution with the actual node workspace',async t=>{
  const {workspace,broker}=await fixture(t,{access:'read_only',allowedPaths:[]});
  assert(broker.tools().some(tool=>tool.name==='run_workspace_program'));
  assert(broker.tools().some(tool=>tool.name==='continue_workspace_command'));
  const result=value(await broker.call('run_workspace_program',{program:'node',args:['-e','process.stdout.write(process.cwd())']},'read-only-program'));
  assert.equal(result.output,workspace);assert.equal(broker.isQuiescent(),true);
});

test('background literal program yields and continues the same handle with lossless bounded output',async t=>{
  const {broker,operations}=await fixture(t);
  const expected='开头😀\n'+('x\\\"\n😀'.repeat(8000))+'\n末尾';
  // Use stdin to avoid putting large payloads into the bounded argv contract.
  const source="let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{process.stdout.write(text.slice(0,5));setTimeout(()=>process.stdout.write(text.slice(5)),200)})";
  const initial=value(await broker.call('run_workspace_program',{program:'node',args:['-e',source],stdin:expected,yield_time_ms:0},'background'));
  assert.equal(initial.status,'running');assert.equal(initial.exit_code,null);assert(initial.session_id);
  assert.equal(broker.isQuiescent(),false);
  const {result,output,ids}=await drain(broker,initial);
  assert.equal(output,expected);assert.equal(result.exit_code,0);assert(ids.every(id=>id===initial.session_id));
  assert.equal(operations.filter(event=>event.call_id==='background'&&event.phase==='started').length,1);
  assert(operations.filter(event=>event.tool==='continue_workspace_command').every(event=>event.process_id===initial.session_id));
  let bytes=Buffer.alloc(0),offset=0,chunk;
  do{
    chunk=value(await broker.call('read_program_output',{output_id:result.output_ref.output_id,stream:'stdout',start_byte:offset,max_bytes:12000},`read-${offset}`));
    bytes=Buffer.concat([bytes,Buffer.from(chunk.data_base64,'base64')]);offset=chunk.next_byte;
  }while(!chunk.complete);
  assert.equal(bytes.toString('utf8'),expected);
  assert.deepEqual(await broker.quiesce(),{quiescent:true,error:null});
});

test('literal nonzero exit retains stderr and the final exit code',async t=>{
  const {broker,operations}=await fixture(t);
  const result=value(await broker.call('run_workspace_program',{program:'node',args:['-e',"process.stderr.write('失败\\n');process.exitCode=7"]},'nonzero'));
  assert.equal(result.status,'completed');assert.equal(result.exit_code,7);assert.equal(result.output,'失败\n');
  const stderr=value(await broker.call('read_program_output',{output_id:result.output_ref.output_id,stream:'stderr',start_byte:0,max_bytes:100},'read-stderr'));
  assert.equal(stderr.text,'失败\n');assert.equal(operations.find(event=>event.call_id==='nonzero'&&event.phase==='completed').exit_code,7);
  const next=value(await broker.call('run_workspace_program',{program:'node',args:['-e',"process.stdout.write('next')"]},'after-nonzero'));
  assert.equal(next.exit_code,0);assert.equal(next.output,'next');
});

test('a settled background failure rejects the next program before any new process effect',async t=>{
  const {broker,workspace,operations}=await fixture(t,{programDeadlineMs:150});
  const initial=value(await broker.call('run_workspace_program',{program:'node',args:['-e',"process.stdout.write('before timeout');setTimeout(()=>{},5000)"],yield_time_ms:0},'background-timeout'));
  const deadline=Date.now()+10000;
  while(!broker.isQuiescent()){
    assert(Date.now()<deadline,'background timeout must settle');await delay(10);
  }
  const marker=join(workspace,'output','after-failure.txt');
  await assert.rejects(broker.call('run_workspace_program',{program:'node',args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`]},'after-timeout'),{code:'PI_EXECUTION_TIMEOUT'});
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  assert.equal(operations.some(event=>event.call_id==='after-timeout'&&event.phase==='started'),false);
  await assert.rejects(broker.call('continue_workspace_command',{session_id:initial.session_id},'timeout-continuation'),{code:'PI_EXECUTION_TIMEOUT'});
  const failed=operations.find(event=>event.call_id==='background-timeout'&&event.phase==='failed');
  assert.equal(failed.quiescent,true);
  const output=value(await broker.call('read_program_output',{output_id:failed.output_ref.output_id,stream:'stdout',start_byte:0,max_bytes:100},'timeout-output'));
  assert.equal(output.text,'before timeout');
});

test('a known background failure blocks workspace writes while durable failure observation is pending',async t=>{
  let observed,release;
  const failed=new Promise(resolve=>{observed=resolve;}),observationGate=new Promise(resolve=>{release=resolve;});
  const {broker,workspace}=await fixture(t,{programDeadlineMs:150,onOperation:async event=>{
    if(event.call_id==='pending-failure'&&event.phase==='failed'){observed();await observationGate;}
  }});
  value(await broker.call('run_workspace_program',{program:'node',args:['-e','setTimeout(()=>{},5000)'],yield_time_ms:0},'pending-failure'));
  try{
    await failed;
    await assert.rejects(broker.call('write_workspace',{path:'output/after-failure.txt',text:'unexpected',expected_sha256:null},'write-after-failure'),{code:'PI_EXECUTION_TIMEOUT'});
    await assert.rejects(readFile(join(workspace,'output','after-failure.txt')),{code:'ENOENT'});
  }finally{release();}
});

test('literal Ctrl-C stops its exact owned handle and closes cleanly',async t=>{
  const {workspace,broker}=await fixture(t);
  const late=join(workspace,'output','late.txt');
  const initial=value(await broker.call('run_workspace_program',{program:'node',args:['-e',`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late'),1200);setTimeout(()=>{},2500)`],yield_time_ms:0},'cancel-start'));
  const stopped=value(await broker.call('continue_workspace_command',{session_id:initial.session_id,chars:'\u0003',yield_time_ms:1000},'cancel-stop'));
  assert.equal(stopped.status,'completed');assert.equal(stopped.exit_code,130);assert.equal(stopped.has_more,false);
  assert.deepEqual(await broker.quiesce(),{quiescent:true,error:null});
  await delay(1400);await assert.rejects(readFile(late),{code:'ENOENT'});
});

test('quiesce cancels a background literal program and preserves cancellation evidence',async t=>{
  const {broker,operations}=await fixture(t);
  let progress=value(await broker.call('run_workspace_program',{program:'node',args:['-e',"process.stdout.write('ready');setTimeout(()=>{},2500)"],yield_time_ms:0},'close-background'));
  while(!progress.output.includes('ready')){
    await delay(10);
    progress=value(await broker.call('continue_workspace_command',{session_id:progress.session_id,yield_time_ms:0},'wait-until-launched'));
  }
  const result=await broker.quiesce();
  assert.equal(result.quiescent,true);
  assert.equal(result.error?.code,'PI_EXECUTION_CANCELLED');
  assert.equal(operations.find(event=>event.call_id==='close-background'&&event.phase==='failed').quiescent,true);
});

test('literal program rejects undeclared executables, escaped workdirs and stdin continuation',async t=>{
  const {broker}=await fixture(t,{recoverToolErrors:true});
  for(const args of [{program:join(tmpdir(),'undeclared-node.exe'),args:[]},{program:'node',args:[],workdir:'..'}]){
    const result=await broker.call('run_workspace_program',args,'bad-program');
    assert.equal(result.success,false);assert.equal(value(result).error.code,'PI_EXECUTION_ARGUMENTS');
  }
  const initial=value(await broker.call('run_workspace_program',{program:'node',args:['-e','setTimeout(()=>{},300)'],yield_time_ms:0},'closed-stdin'));
  const rejected=await broker.call('continue_workspace_command',{session_id:initial.session_id,chars:'extra'},'extra-stdin');
  assert.equal(rejected.success,false);assert.equal(value(rejected).error.code,'PI_EXECUTION_ARGUMENTS');
  await drain(broker,initial);
});
