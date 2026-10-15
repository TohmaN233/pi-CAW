import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,readFile,readdir,writeFile,rename,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture,workflow } from './fixtures.mjs';
import { canonicalJSON,digest } from '../core/workflow-revisions.mjs';
import { WorkflowStore } from '../core/workflow-store.mjs';

async function setup(t){
  const f=await fixture(t);await f.service.call('create_workflow',{workflow:workflow()});
  const run=await f.service.runtime.start({workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'Admission fixture'},main_actor:f.mainSession});
  await writeFile(join(f.service.runtime.runs.directory(run.run_id),'pi-controller.json'),canonicalJSON({control_token:run.control_token}));
  const {stdout}=await promisify(execFile)(process.execPath,['-e','process.stdout.write(String(process.pid))'],{windowsHide:true});
  const pid=Number(stdout);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  const root=f.service.runtime.runs.directory(run.run_id),queue=join(root,'.admission-queue');await mkdir(join(queue,'.pending'),{recursive:true});
  const owner={id:randomUUID(),pid,token:randomUUID(),created_at:new Date().toISOString(),number:1};
  const path=join(queue,`ticket-${owner.id}.json`);await writeFile(path,canonicalJSON(owner));
  return {...f,run,root,queue,owner,path};
}
const inspect=f=>f.service.call('inspect_run_admission',{run_id:f.run.run_id},{human:true});
const recover=(f,records)=>f.service.call('recover_run_admission',{run_id:f.run.run_id,records},{human:true});

test('admission inspection and human exact recovery work behind orphan tickets without business replay or token leakage',async t=>{
  const f=await setup(t),journal=await readFile(join(f.root,'events.jsonl')),pins=await readFile(join(f.root,'pins.json'));
  const report=await f.service.call('inspect_run_admission',{run_id:f.run.run_id});assert.equal(report.records.length,1);const item=report.records[0];
  assert.equal(item.pid,f.owner.pid);assert.equal(item.owner_status,'absent');assert.equal(item.locator,`.admission-queue/ticket-${f.owner.id}.json`);
  assert.equal(item.sha256,digest(canonicalJSON(f.owner)));assert.equal(item.bytes,Buffer.byteLength(canonicalJSON(f.owner)));assert(item.physical.ino);
  const serialized=JSON.stringify(report);assert(!serialized.includes(f.owner.token));assert(!serialized.includes(f.run.control_token));
  const result=await recover(f,report.records);assert.deepEqual(result.recovered,[item.locator]);assert.equal(result.business_state_changed,false);assert.equal(result.model_calls,0);
  assert.deepEqual(await readFile(join(f.root,'events.jsonl')),journal);assert.deepEqual(await readFile(join(f.root,'pins.json')),pins);
  assert.equal(f.service.active.has(f.run.run_id),false);assert.equal(f.requests.length,0);assert.deepEqual((await inspect(f)).records,[]);
});

test('admission recovery requires human authorization and both operations require the original current actor and controller',async t=>{
  const f=await setup(t),bytes=await readFile(f.path);
  await assert.rejects(f.service.call('recover_run_admission',{run_id:f.run.run_id,records:[]}),{code:'HUMAN_RECOVERY_REQUIRED'});
  const identity=f.host.mainIdentity;f.host.mainIdentity=()=>({...identity(),session_id:'other-actor'});
  await assert.rejects(inspect(f),{code:'RUN_ADMISSION_ACTOR'});f.host.mainIdentity=identity;
  await writeFile(join(f.root,'pi-controller.json'),canonicalJSON({control_token:'wrong'}));await assert.rejects(inspect(f),{code:'RUN_AUTHORITY'});
  assert.deepEqual(await readFile(f.path),bytes);
});

test('admission recovery preserves live, changed, corrupt claims and torn journals',async t=>{
  const f=await setup(t),report=await inspect(f),original=canonicalJSON(f.owner);
  await writeFile(f.path,canonicalJSON({...f.owner,number:2}));await assert.rejects(recover(f,report.records),{code:'RUN_ADMISSION_CHANGED'});assert.equal(await readFile(f.path,'utf8'),canonicalJSON({...f.owner,number:2}));
  await writeFile(f.path,canonicalJSON({...f.owner,pid:process.pid}));const live=await inspect(f);assert.equal(live.records[0].owner_status,'active');
  await assert.rejects(recover(f,live.records),{code:'RUN_ADMISSION_OWNER_ACTIVE'});assert.equal((await inspect(f)).records[0].pid,process.pid);
  await writeFile(f.path,'{corrupt');await assert.rejects(inspect(f),{code:'RUN_ADMISSION_RECORD'});assert.equal(await readFile(f.path,'utf8'),'{corrupt');
  await writeFile(f.path,original);const journal=join(f.root,'events.jsonl'),bytes=await readFile(journal);await writeFile(journal,Buffer.concat([bytes,Buffer.from('{torn')]));
  await assert.rejects(recover(f,report.records),{code:'RUN_JOURNAL_TORN'});assert.equal(await readFile(f.path,'utf8'),original);assert.deepEqual(await readFile(journal),Buffer.concat([bytes,Buffer.from('{torn')]));
});

test('recovery removes only selected absent records while preserving an active writer and paired pending proof',async t=>{
  const f=await setup(t),writer={pid:process.pid,token:randomUUID(),created_at:new Date().toISOString()};await writeFile(join(f.root,'.writer.lock'),canonicalJSON(writer));
  const pending=join(f.queue,'.pending',`ticket-${f.owner.id}.json`);await writeFile(pending,canonicalJSON(f.owner));
  const report=await inspect(f);assert.equal(report.records.length,3);const dead=report.records.filter(item=>item.owner_status==='absent');
  await recover(f,dead);assert.equal(await readFile(join(f.root,'.writer.lock'),'utf8'),canonicalJSON(writer));assert.deepEqual(await readdir(join(f.queue,'.pending')),[]);
});

test('readonly service runs bypass notification effects and configuration refresh while orphan writers remain fenced',async t=>{
  const f=await setup(t);f.service.flushTerminalNotifications=()=>{assert.fail('readonly query flushed notifications');};f.service.refreshContext=()=>{assert.fail('readonly query refreshed context');};
  const rows=await f.service.call('runs',{workflow_id:'example',limit:8});assert.equal(rows[0].run_id,f.run.run_id);
  await assert.rejects(f.service.runtime.runs.mutate(f.run.run_id,'pause',state=>{state.status='paused';}),{code:'RUN_ADMISSION_QUEUE_ORPHANED'});
  assert.equal(await readFile(f.path,'utf8'),canonicalJSON(f.owner));
});

test('unverified owner probes and same-byte physical replacements never authorize retirement',async t=>{
  const f=await setup(t),kill=process.kill;
  try{
    process.kill=(pid,...args)=>{if(pid===f.owner.pid)throw Object.assign(new Error('Owner probe denied'),{code:'EACCES'});return kill(pid,...args);};
    const report=await inspect(f);assert.equal(report.records[0].owner_status,'unverified');assert.equal(report.records[0].probe_error_code,'EACCES');
    await assert.rejects(recover(f,report.records),{code:'RUN_ADMISSION_OWNER_UNVERIFIED'});assert.equal(await readFile(f.path,'utf8'),canonicalJSON(f.owner));
  }finally{process.kill=kill;}
  const report=await inspect(f),replacement=join(f.queue,'replacement');await writeFile(replacement,canonicalJSON(f.owner));await rename(replacement,f.path);
  await assert.rejects(recover(f,report.records),{code:'RUN_ADMISSION_CHANGED'});assert.equal(await readFile(f.path,'utf8'),canonicalJSON(f.owner));
});

test('dead writer recovery retains exact private evidence and never repairs or resumes business state',async t=>{
  const f=await setup(t);const owner={pid:f.owner.pid,token:randomUUID(),created_at:new Date().toISOString()};await writeFile(join(f.root,'.writer.lock'),canonicalJSON(owner));
  const report=await inspect(f),journal=await readFile(join(f.root,'events.jsonl')),result=await recover(f,report.records);
  assert.equal(result.evidence.length,2);assert(!JSON.stringify(result).includes(owner.token));
  const writerEvidence=result.evidence.find(item=>item.kind==='writer');assert.equal(await readFile(join(f.root,writerEvidence.retained_locator),'utf8'),canonicalJSON(owner));
  assert.deepEqual(await readFile(join(f.root,'events.jsonl')),journal);assert.deepEqual((await inspect(f)).records,[]);
});

test('empty retirement containers do not block real-ticket inspection and retained record evidence stays protected',async t=>{
  const f=await setup(t),empty=join(f.queue,'.pending','retired-owner-'+randomUUID());await mkdir(empty);
  const report=await inspect(f);assert.equal(report.records.length,1);assert.equal(report.empty_retirement_containers.length,1);await recover(f,report.records);
  assert.deepEqual(await readdir(empty),[]);
  const retained=join(f.queue,'.pending','retired-owner-'+randomUUID());await mkdir(retained);await writeFile(join(retained,'record.json'),canonicalJSON(f.owner));
  const evidence=await inspect(f);assert.equal(evidence.records[0].kind,'retirement_evidence');assert.equal(evidence.records[0].recovery_supported,false);
  await assert.rejects(recover(f,evidence.records),{code:'RUN_ADMISSION_RETAINED_EVIDENCE'});assert.equal(await readFile(join(retained,'record.json'),'utf8'),canonicalJSON(f.owner));
});

test('pending terminal retention can recover storage ownership using original strict evidence while execution stays retired',async t=>{
  const f=await setup(t),record=await f.service.runtime.runs.observe(f.run.run_id);
  // This fixture retains the original full journal/pins. The compact retained
  // result deliberately omits controller identity and cannot authorize recovery.
  await writeFile(join(f.root,'retained.json'),canonicalJSON({schema_version:1,state:{run_id:f.run.run_id,status:'failed'},sequence:record.sequence,cleanup_complete:false}));
  await assert.rejects(f.service.runtime.runs.observe(f.run.run_id),{code:'RUN_RETIRED'});
  const report=await inspect(f),result=await recover(f,report.records);assert.equal(result.business_state_changed,false);assert.equal(report.status,record.state.status);
  await assert.rejects(f.service.runtime.runs.read(f.run.run_id),{code:'RUN_RETIRED'});
  await writeFile(join(f.root,'retained.json'),canonicalJSON({schema_version:1,state:{run_id:f.run.run_id,status:'failed'},sequence:record.sequence,cleanup_complete:true}));
  await assert.rejects(inspect(f),{code:'RUN_RETIRED'});
});

test('partial batch recovery reports retired proof and failed locator without deleting changed successors',async t=>{
  const f=await setup(t),pending=join(f.queue,'.pending',`ticket-${f.owner.id}.json`);await writeFile(pending,canonicalJSON(f.owner));
  const report=await inspect(f),replacement=canonicalJSON({...f.owner,number:2});
  const module=new URL('../lib/run-admission-recovery.mjs',import.meta.url).href,store=new URL('../core/workflow-run-store.mjs',import.meta.url).href;
  const script=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
    const rename=fs.rename;fs.rename=async(source,target)=>{await rename(source,target);if(source===process.argv[3])await fs.writeFile(process.argv[4],process.argv[5]);};syncBuiltinESMExports();
    const {WorkflowRunStore}=await import(${JSON.stringify(store)}),{recoverRunAdmission}=await import(${JSON.stringify(module)});
    const service={runtime:{runs:new WorkflowRunStore(process.argv[1])},host:{mainIdentity:()=>({session_id:process.argv[6]})},assertReadableRunDirectory:async()=>{}};
    await assert.rejects(recoverRunAdmission(service,{run_id:process.argv[2],records:JSON.parse(process.argv[7])},{human:true}),error=>{
      assert.equal(error.code,'RUN_ADMISSION_CHANGED');assert.deepEqual(error.details.admission_recovery.recovered,[JSON.parse(process.argv[7])[0].locator]);
      assert.equal(error.details.admission_recovery.failed_locator,JSON.parse(process.argv[7])[1].locator);assert.equal(error.details.admission_recovery.partial_evidence.length,1);
      assert(!JSON.stringify(error).includes(process.argv[8]));return true;});assert.equal(await fs.readFile(process.argv[4],'utf8'),process.argv[5]);`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script,f.service.runtime.runs.root,f.run.run_id,f.path,pending,replacement,f.mainSession,JSON.stringify(report.records),f.owner.token],{windowsHide:true});
  assert.equal(await readFile(pending,'utf8'),replacement);
});

test('concurrent writer recovery uses the existing mutex and a stale inspection never retires its live successor',async t=>{
  const f=await setup(t);await recover(f,(await inspect(f)).records);
  const owner={pid:f.owner.pid,token:randomUUID(),created_at:new Date().toISOString()},path=join(f.root,'.writer.lock');await writeFile(path,canonicalJSON(owner));const report=await inspect(f);
  const module=new URL('../lib/run-admission-recovery.mjs',import.meta.url).href,store=new URL('../core/workflow-run-store.mjs',import.meta.url).href,writerModule=new URL('../core/workflow-store.mjs',import.meta.url).href;
  const script=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
    let entered,release;const enteredPromise=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),rename=fs.rename;
    fs.rename=async(source,target)=>{if(source===process.argv[3]){entered();await gate;}return rename(source,target);};syncBuiltinESMExports();
    const {WorkflowRunStore}=await import(${JSON.stringify(store)}),{WorkflowStore}=await import(${JSON.stringify(writerModule)}),{recoverRunAdmission}=await import(${JSON.stringify(module)});
    const service={runtime:{runs:new WorkflowRunStore(process.argv[1])},host:{mainIdentity:()=>({session_id:process.argv[4]})},assertReadableRunDirectory:async()=>{}},args={run_id:process.argv[2],records:JSON.parse(process.argv[5])};
    const first=recoverRunAdmission(service,args,{human:true});await enteredPromise;
    await assert.rejects(recoverRunAdmission(service,args,{human:true}),{code:'RUN_ADMISSION_RECOVERY_PENDING'});release();await first;
    const root=service.runtime.runs.directory(args.run_id);let acquired,finish;const acquiredPromise=new Promise(resolve=>acquired=resolve),finishPromise=new Promise(resolve=>finish=resolve);
    const live=new WorkflowStore(root).withRunAdmission(async()=>{acquired();await finishPromise;});await acquiredPromise;
    const before=await fs.readFile(process.argv[3]);await assert.rejects(recoverRunAdmission(service,args,{human:true}),{code:'RUN_ADMISSION_CHANGED'});
    assert.deepEqual(await fs.readFile(process.argv[3]),before);finish();await live;`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script,f.service.runtime.runs.root,f.run.run_id,path,f.mainSession,JSON.stringify(report.records)],{windowsHide:true,timeout:10000});
});

test('legacy ownerless recovery markers are reported without blocking observation and remain explicitly unsupported',async t=>{
  const f=await setup(t);await mkdir(join(f.root,'.recovery.lock'));
  const report=await inspect(f);assert.equal(report.recovery_pending,true);assert.equal(report.records.length,1);
  assert.equal((await f.service.call('runs'))[0].run_id,f.run.run_id);await assert.rejects(recover(f,report.records),{code:'RUN_ADMISSION_RECOVERY_PENDING'});
  assert.deepEqual(await readdir(join(f.root,'.recovery.lock')),[]);assert.equal(await readFile(f.path,'utf8'),canonicalJSON(f.owner));
});

test('legacy writer recovery optional inspection proof preserves malformed bytes and same-byte replacement identity',async t=>{
  const f=await setup(t),path=join(f.root,'.writer.lock'),owner={pid:f.owner.pid,token:randomUUID(),created_at:new Date().toISOString()},bytes=Buffer.from(canonicalJSON(owner));await writeFile(path,bytes);
  const identity=await lstat(path,{bigint:true}),writer=new WorkflowStore(f.root),malformed='{private:'+owner.token;await writeFile(path,malformed);
  await assert.rejects(writer.recoverWriter(owner.token,{expectedIdentity:identity,expectedBytes:bytes}),error=>{assert.equal(error.code,'LOCK_OWNERSHIP');assert(!error.message.includes(owner.token));return true;});assert.equal(await readFile(path,'utf8'),malformed);
  await writeFile(path,bytes);const original=await lstat(path,{bigint:true}),replacement=join(f.root,'writer-replacement');await writeFile(replacement,bytes);await rename(replacement,path);
  await assert.rejects(writer.recoverWriter(owner.token,{expectedIdentity:original,expectedBytes:bytes}),{code:'OWNED_FILE_RETIREMENT_IDENTITY'});assert.deepEqual(await readFile(path),bytes);
});
