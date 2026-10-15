import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryMaintenance,historyMaintenance } from '../lib/history-maintenance.mjs';
import { withRunStoreForegroundActivity } from '../core/workflow-run-store.mjs';
import { fixture,workflow,settle } from './fixtures.mjs';

async function directory(){const root=await mkdtemp(join(tmpdir(),'pi-history-'));await mkdir(join(root,'runs'));return root;}
const gate=()=>{let release;const pending=new Promise(resolve=>{release=resolve;});return {pending,release};};
const fake=async({onReady})=>{await onReady(process.pid);return {cancel(){},async close(){}};};

for(const afterMicrotask of [false,true])test(`closing a scheduled automatic request prevents launch (${afterMicrotask?'during admission read':'before admission read'})`,async()=>{
  const root=await directory();let launched=0,executed=0;
  const manager=new HistoryMaintenance(root,{launchWorker:async options=>{launched++;return fake(options);}});
  manager.schedule(async()=>{executed++;});
  if(afterMicrotask)await Promise.resolve();
  await manager.close();
  assert.equal(launched,0);assert.equal(executed,0);assert.equal(manager.error,null);
  assert.equal(manager.deferred,null);assert.equal(manager.owner,null);
});

test('shared managers coalesce recreated runtimes and exact disk ownership coalesces other sessions',async()=>{
  const root=await directory();assert.equal(historyMaintenance(root),historyMaintenance(root));
  const first=new HistoryMaintenance(root,{launchWorker:fake}),second=new HistoryMaintenance(root,{launchWorker:fake}),hold=gate(),started=gate();let peers=0;
  const pending=first.run(async()=>{started.release();await hold.pending;});await started.pending;
  second.schedule(async()=>{peers++;});await second.pending;assert.equal(peers,0);assert.equal((await second.status()).pid,process.pid);
  hold.release();await pending;assert.equal((await first.status()).outcome,'succeeded');await first.close();await second.close();
});

test('automatic maintenance defers while foreground activity owns admission; manual policy runs independently',async()=>{
  const root=await directory(),manager=new HistoryMaintenance(root,{launchWorker:fake});let automatic=0,manual=0;
  await withRunStoreForegroundActivity(join(root,'runs'),async()=>{
    manager.schedule(async()=>{automatic++;});await manager.pending;
    assert.equal((await manager.status()).automatic_deferred,true);assert.equal(automatic,0);
    await manager.run(async()=>{manual++;});assert.equal(manual,1);
  });
  // The manual result owns this maintenance interval; the deferred opportunity
  // still inspects that receipt and does not repeat the filesystem sweep.
  await manager.pending;assert.equal(automatic,0);await manager.close();
});

test('selected startup does not await a hung unrelated background history callback',async t=>{
  const f=await fixture(t),hold=gate(),started=gate(),retention=f.service.retention,execute=retention.execute;
  retention.execute=async()=>{started.release();await hold.pending;return {deleted:[],protected:[],bytes:0};};
  retention.schedule();await started.pending;
  await f.service.call('create_workflow',{workflow:workflow()});
  const result=await Promise.race([f.service.call('run',{workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'Synthetic startup'}}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Selected startup waited on history maintenance')),2500))]);
  assert.ok(result.run_id);hold.release();await retention.maintenance.pending;retention.execute=execute;
});

test('worker cancellation prevents subsequent prepared filesystem deletions',async()=>{
  const root=await directory(),data=join(root,'disposable');await mkdir(data);const file=join(data,'file');await writeFile(file,'retained cancellation evidence');
  const manager=new HistoryMaintenance(root);
  await assert.rejects(manager.run(async worker=>{worker.cancel();await worker.call('trim',{root:data,keep:[]});}),{code:'HISTORY_CANCELLED'});
  assert.equal(await readFile(file,'utf8'),'retained cancellation evidence');assert.equal((await manager.status()).outcome,'cancelled');await manager.close();
});

test('corrupt history remains inspectable and its durable failure blocks automatic repeat',async t=>{
  const f=await fixture(t),s=f.service;await s.call('create_workflow',{workflow:workflow()});
  const result=await s.call('run',{workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'Synthetic corruption'}});
  const root=s.runtime.runs.directory(result.run_id),pins=join(root,'pins.json');await settle(s,result.run_id);
  const data=await readFile(pins);await writeFile(pins,Buffer.from('invalid history pins'));
  s.retention.schedule();await s.retention.maintenance.pending;
  const status=await s.retention.status();assert.equal(status.outcome,'failed');assert.equal(status.error.code,'SyntaxError');
  assert.equal(await readFile(pins,'utf8'),'invalid history pins');assert.ok((await readdir(root)).includes('events.jsonl'));
  const recreated=new HistoryMaintenance(s.directory);let repeats=0;recreated.schedule(async()=>{repeats++;});await recreated.pending;assert.equal(repeats,0);await recreated.close();await writeFile(pins,data);
});

test('bounded shutdown retains exact owner evidence while callback settlement is uncertain',async()=>{
  const root=await directory(),manager=new HistoryMaintenance(root,{settlementMs:25,launchWorker:fake}),hold=gate(),started=gate();
  const pending=manager.run(async()=>{started.release();await hold.pending;});await started.pending;
  const before=await readFile(manager.lockPath,'utf8');await assert.rejects(manager.close(),{code:'HISTORY_STOP_PENDING'});
  assert.equal(await readFile(manager.lockPath,'utf8'),before);assert.equal((await manager.status()).job_id,JSON.parse(before).job_id);
  hold.release();await pending;await assert.rejects(readFile(manager.lockPath),{code:'ENOENT'});
});

test('peer and orphan foreground claims stay deferred without a process-local rescan loop',async()=>{
  const {spawn}=await import('node:child_process'),{randomUUID}=await import('node:crypto');
  const child=spawn(process.execPath,['-e',''],{windowsHide:true});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  for(const pid of [process.pid,child.pid]){
    const root=await directory(),claims=join(root,'runs','.run-locks','.foreground-activity');await mkdir(claims,{recursive:true});
    await writeFile(join(claims,`activity-${randomUUID()}.json`),JSON.stringify({pid,token:randomUUID(),created_at:new Date().toISOString()}));
    const manager=new HistoryMaintenance(root,{launchWorker:fake});let launches=0;
    manager.schedule(async()=>{launches++;});await manager.pending;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(manager.pending,null);assert.equal(launches,0);assert.equal((await manager.status()).automatic_deferred,true);
    await assert.rejects(readFile(manager.lockPath),{code:'ENOENT'});await manager.close();
  }
});

test('recreated Host registration survives an older service closing its shared manager lease',async()=>{
  const root=await directory(),manager=historyMaintenance(root,{launchWorker:fake}),releaseOld=manager.acquire(),releaseCurrent=manager.acquire();
  await releaseOld();assert.equal(manager.closed,false);await manager.run(async()=>{});await releaseCurrent();assert.equal(manager.closed,true);
});

test('restart recovery removes only exact staged content after confirmed previous worker settlement',async()=>{
  const {randomUUID}=await import('node:crypto'),{rename,lstat}=await import('node:fs/promises'),{digest}=await import('../core/workflow-revisions.mjs');
  for(const confirmed of [true,false]){
    const root=await directory(),data=join(root,'disposable');await mkdir(data);const path=join(data,'source');await writeFile(path,'exact staged bytes');const info=await lstat(path,{bigint:true});
    const old=randomUUID(),oldToken=randomUUID(),oldCreated=new Date().toISOString(),staging=join(root,'.history-maintenance',`data-${old}-${randomUUID()}`);await mkdir(staging,{recursive:true});const retired=join(staging,'data');await rename(path,retired);
    await writeFile(join(staging,'intent.json'),JSON.stringify({schema_version:1,job_id:old,owner_pid:process.pid,owner_token:oldToken,owner_created_at:oldCreated,worker_pid:process.pid,path,sha256:digest('exact staged bytes'),bytes:Number(info.size),dev:String(info.dev),ino:String(info.ino),retired_path:retired,complete:false}));
    await writeFile(join(root,'.history-maintenance',`job-${old}.json`),JSON.stringify({schema_version:1,job_id:old,pid:process.pid,token:oldToken,created_at:oldCreated,worker_pid:process.pid,phase:'settled',worker_quiescent:confirmed,outcome:'cancelled'}));
    const manager=new HistoryMaintenance(root),cleanup=()=>manager.run(worker=>worker.call('trim',{root:data,keep:[]}));
    if(confirmed){assert.equal(await cleanup(),Number(info.size));await assert.rejects(readFile(retired),{code:'ENOENT'});assert.deepEqual(await readdir(data),[]);}
    else{await assert.rejects(cleanup(),{code:'HISTORY_DATA_OWNER_PENDING'});assert.equal(await readFile(retired,'utf8'),'exact staged bytes');assert.ok(await readFile(join(staging,'intent.json')));}
    await manager.close();
  }
});

test('automatic settlement does not clear a newer queued manual maintenance owner',async()=>{
  const root=await directory(),manager=new HistoryMaintenance(root,{launchWorker:fake}),automaticHold=gate(),manualHold=gate(),automaticStarted=gate(),manualStarted=gate();let repeats=0;
  manager.schedule(async()=>{automaticStarted.release();await automaticHold.pending;});await automaticStarted.pending;
  const manual=manager.run(async()=>{manualStarted.release();await manualHold.pending;});automaticHold.release();await manualStarted.pending;
  assert.equal(manager.pending!==null,true);manager.schedule(async()=>{repeats++;});assert.equal(repeats,0);
  manualHold.release();await manual;await manager.close();
});
