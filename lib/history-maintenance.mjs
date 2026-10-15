import { fork } from 'node:child_process';
import { open, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureDirectory, noSymlinks, requireValue } from '../core/workflow-paths.mjs';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { syncDirectory } from '../core/workflow-store.mjs';
import { retireOwnedFile } from '../core/owned-file-retirement.mjs';
import { readRunStoreForegroundActivity, runStoreForegroundActivity, onRunStoreForegroundIdle, onRunStoreForegroundChange } from '../core/workflow-run-store.mjs';

const managers = new Map();
export const HISTORY_MAINTENANCE_INTERVAL_MS = 60_000;
const failure = (code,message) => Object.assign(new Error(message),{code});
const diagnostic = (error,depth=0) => {
  const code=typeof error?.code==='string'?error.code:error instanceof SyntaxError?'SyntaxError':'HISTORY_MAINTENANCE_FAILED',message=String(error?.message??error);
  return {code,message:`History maintenance error: ${code}`,message_bytes:error?.message_bytes??Buffer.byteLength(message),message_sha256:error?.message_sha256??createHash('sha256').update(message).digest('hex'),
    ...(depth<3&&error instanceof AggregateError?{causes:error.errors.slice(0,4).map(cause=>diagnostic(cause,depth+1))}:{}),...(depth<3&&error?.cause?{cause:diagnostic(error.cause,depth+1)}:{})};
};
const same = (a,b) => a?.job_id===b?.job_id && a?.token===b?.token && a?.pid===b?.pid&&a?.created_at===b?.created_at&&a?.schema_version===b?.schema_version;
async function record(path,optional=false) {
  try { await noSymlinks(path); const stat=await lstat(path); requireValue(stat.isFile()&&stat.nlink===1&&stat.size<=16384,'HISTORY_OWNER_RECORD','Maintenance evidence must be a bounded regular file'); return JSON.parse(await readFile(path,'utf8')); }
  catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
}
export function historyMaintenance(directory,options={}) {
  const root=resolve(directory),key=process.platform==='win32'?root.toLowerCase():root;
  let manager=managers.get(key);if(!manager||manager.closed){manager=new HistoryMaintenance(root,options);managers.set(key,manager);}return manager;
}

// One portable, filesystem-only worker per exact Host storage root. The Host
// owns effect shutdown and prepares durable deletion intent before worker jobs.
export class HistoryMaintenance {
  constructor(directory,{settlementMs=1000,launchWorker=launchHistoryWorker}={}) {
    requireValue(Number.isInteger(settlementMs)&&settlementMs>0&&settlementMs<=5000,'HISTORY_OPTIONS','Shutdown settlement must be bounded');
    this.root=directory;this.runRoot=join(directory,'runs');this.directory=join(directory,'.history-maintenance');
    this.lockPath=join(this.directory,'.writer.lock');this.receiptPath=join(this.directory,'latest.json');
    this.settlementMs=settlementMs;this.launchWorker=launchWorker;this.pending=null;this.closed=false;this.owner=null;this.worker=null;this.error=null;this.deferred=null;this.latest=null;this.references=0;
  }
  acquire() {
    requireValue(!this.closed,'HISTORY_CLOSED','Cannot register a closed history manager');this.references++;let released=false;
    return async()=>{if(released)return;released=true;this.references--;if(!this.references)await this.close();};
  }
  schedule(action) {
    if(this.closed||this.pending)return;
    const operation=Promise.resolve().then(async()=>{
      if(this.closed)return;
      const activity=await readRunStoreForegroundActivity(this.runRoot);
      if(this.closed)return;
      if(activity.active||activity.orphaned||activity.unverified){
        if(!this.deferred){this.deferred={action,local:false,cancel:()=>{}};this.deferred.cancel=onRunStoreForegroundIdle(this.runRoot,()=>{const d=this.deferred;if(!d||this.pending)return;this.deferred=null;d.cancel();this.schedule(d.action);});}
        this.deferred.local=runStoreForegroundActivity(this.runRoot).active>0;return;
      }
      this.deferred?.cancel();this.deferred=null;
      const saved=await record(this.receiptPath,true);
      if(this.closed)return;
      if(saved?.outcome==='failed'||saved?.due_at>Date.now())return;
      return this.execute(action,{automatic:true});
    }).catch(error=>{this.error=error;console.error('[pi-CAW] background history maintenance failed',diagnostic(error));}).finally(()=>{if(this.pending===operation)this.pending=null;if(!this.pending&&this.deferred?.local&&!this.closed&&!runStoreForegroundActivity(this.runRoot).active){const deferred=this.deferred;this.deferred=null;deferred.cancel();this.schedule(deferred.action);}});
    this.pending=operation;
  }
  async run(action) {
    // Manual requests retain their own retention policy and are never lost to
    // an older automatic request. Every queue caller receives its own errors.
    const prior=this.pending;
    const operation=(prior?prior.then(()=>undefined,()=>undefined):Promise.resolve()).then(()=>this.execute(action));
    this.pending=operation;try{return await operation;}finally{if(this.pending===operation)this.pending=null;}
  }
  async execute(action,{automatic=false}={}) {
    requireValue(!this.closed,'HISTORY_CLOSED','History maintenance is closed');
    await ensureDirectory(this.directory);await noSymlinks(this.directory);
    const existing=await record(this.lockPath,true);
    if(existing){
      requireValue(existing.schema_version===1&&typeof existing.token==='string'&&/^[a-f0-9-]{36}$/.test(existing.token)&&Number.isSafeInteger(existing.pid)&&existing.pid>0&&typeof existing.job_id==='string'&&/^[a-f0-9-]{36}$/.test(existing.job_id)&&Number.isFinite(Date.parse(existing.created_at)),'HISTORY_OWNER_RECORD','Maintenance owner is malformed');
      // Neither stale PID nor uncertain peer shutdown authorizes takeover.
      if(automatic)return {coalesced:true,owner_pid:existing.pid};
      throw failure('HISTORY_OWNER_PENDING','Existing history maintenance ownership requires exact inspection');
    }
    const owner={schema_version:1,job_id:randomUUID(),token:randomUUID(),pid:process.pid,created_at:new Date().toISOString()};
    let handle;
    try{handle=await open(this.lockPath,'wx',0o600);}catch(error){if(automatic&&error.code==='EEXIST')return {coalesced:true};throw error;}
    try{await handle.writeFile(JSON.stringify(owner));await handle.sync();}finally{await handle.close();}
    await syncDirectory(this.directory);this.owner=owner;
    const receipt={...owner,phase:'running',outcome:'pending'};this.latest=receipt;
    const jobPath=join(this.directory,`job-${owner.job_id}.json`);
    const save=async changes=>{
      requireValue(same(await record(this.lockPath),owner),'HISTORY_OWNER_CHANGED','Maintenance ownership changed; retain evidence');
      this.latest={...this.latest,...changes};await writeDurableJSON(jobPath,this.latest);await writeDurableJSON(this.receiptPath,this.latest);
    };
    let result,error,quiescent=false,unsubscribe=()=>{};
    try {
      await save({});
      if(this.closed)throw failure('HISTORY_CANCELLED','History maintenance cancelled before worker launch');
      this.worker=await this.launchWorker({directory:this.root,owner,automatic,onReady:pid=>save({worker_pid:pid})});
      if(automatic)unsubscribe=onRunStoreForegroundChange(this.runRoot,activity=>{if(activity.active)this.worker?.cancel();});
      if(this.closed){this.worker.cancel();throw failure('HISTORY_CANCELLED','History maintenance cancelled before Host preparation');}
      result=await action(this.worker);
    } catch(cause){error=cause;if(!this.worker&&cause.worker_quiescent!==true)quiescent=false;}
    finally {
      unsubscribe();
      if(this.worker){try{await this.worker.close();quiescent=true;}catch(cause){error=error?new AggregateError([error,cause],'Maintenance operation and worker settlement failed'):cause;}}
      else quiescent=!error||error.worker_quiescent===true||!this.latest.worker_pid;
    }
    if(!quiescent){await save({phase:'stopping',outcome:'stop_pending',error:diagnostic(error)});throw error;}
    const cancelled=error?.code==='HISTORY_CANCELLED';
    await save({phase:'settled',worker_quiescent:true,outcome:error?(cancelled?'cancelled':'failed'):'succeeded',finished_at:new Date().toISOString(),due_at:Date.now()+HISTORY_MAINTENANCE_INTERVAL_MS,...(this.worker?.diagnostics?{worker_diagnostics:this.worker.diagnostics()}:{}),...(error?{error:diagnostic(error)}:{})});
    await retireOwnedFile(this.lockPath,{stagingRoot:join(this.directory,'.pending'),validate:bytes=>{requireValue(same(JSON.parse(bytes),owner),'HISTORY_OWNER_CHANGED','Maintenance claim changed before retirement');return owner.pid;}});
    await syncDirectory(this.directory);this.owner=null;this.worker=null;this.error=error??null;
    if(error)throw error;return result;
  }
  async status() {
    try {const owner=await record(this.lockPath,true),saved=await record(this.receiptPath,true);const visible=owner?(same(owner,saved)?{...saved,owner_present:true}:{...owner,phase:'claimed',outcome:'pending',owner_present:true}):saved;
      const {token,...details}=visible??{phase:'idle',outcome:'pending'};return {...details,automatic_deferred:Boolean(this.deferred),...(this.error?{error:diagnostic(this.error)}:{})};}
    catch(error){return {phase:'blocked',outcome:'failed',error:diagnostic(error)};}
  }
  async close() {
    this.closed=true;this.deferred?.cancel();this.deferred=null;this.worker?.cancel();
    const pending=this.pending;if(!pending)return;
    let timer;const settled=await Promise.race([pending.then(()=>true,()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),this.settlementMs);})]).finally(()=>clearTimeout(timer));
    if(!settled)throw failure('HISTORY_STOP_PENDING','History worker shutdown is unconfirmed; exact owner evidence remains');
  }
}

export async function launchHistoryWorker({directory,owner,automatic=false,onReady}) {
  const child=fork(fileURLToPath(new URL('./history-maintenance-worker.mjs',import.meta.url)),[],{windowsHide:true,execArgv:[],stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH??'',SystemRoot:process.env.SystemRoot??'',TEMP:process.env.TEMP??'',TMP:process.env.TMP??''}});
  let next=0,pending=new Map(),exited=false,closed=false,cancelRequested=false,stderrBytes=0,workerError;const stderrDigest=createHash('sha256');
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;stderrDigest.update(chunk);});
  const exit=new Promise(resolve=>child.once('close',(code,signal)=>{exited=true;workerError??=code!==0||signal?failure('HISTORY_WORKER_EXIT','History worker did not settle cleanly'):null;for(const item of pending.values())item.reject(workerError??failure('HISTORY_WORKER_EXIT','History worker exited before reply'));pending.clear();resolve();}));
  child.on('error',error=>{workerError=error;});
  child.on('message',message=>{
    if(!message||message.schema_version!==1||message.job_id!==owner.job_id||message.worker_pid!==child.pid||!Number.isSafeInteger(message.id)||Buffer.byteLength(JSON.stringify(message))>32*1024*1024){workerError=failure('HISTORY_WORKER_PROTOCOL','History worker response differs from exact bounded launch');for(const item of pending.values())item.reject(workerError);pending.clear();if(child.connected)child.disconnect();return;}
    const item=pending.get(message.id);if(!item){workerError=failure('HISTORY_WORKER_PROTOCOL','History worker repeated an unknown reply');if(child.connected)child.disconnect();return;}
    pending.delete(message.id);
    if(message.error)item.reject(Object.assign(new Error(message.error.message),{code:message.error.code,message_bytes:message.error.message_bytes,message_sha256:message.error.message_sha256}));else item.resolve(message.result);
  });
  const call=(operation,args={})=>new Promise((resolve,reject)=>{
    if(exited||(closed||cancelRequested)&&operation!=='close'){reject(failure('HISTORY_CANCELLED','History worker is closed'));return;}
    if(Buffer.byteLength(JSON.stringify(args))>32*1024*1024){reject(failure('HISTORY_WORKER_LIMIT','History worker request exceeds its bounded transport'));return;}
    const id=++next;pending.set(id,{resolve,reject});child.send({id,operation,args},error=>{if(error){pending.delete(id);reject(error);}});
  });
  try {
    let timer;
    await Promise.race([Promise.resolve().then(async()=>{await onReady(child.pid);await call('initialize',{directory,owner,automatic});}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('HISTORY_WORKER_HANDSHAKE','History worker initialization did not settle')),5000);})]).finally(()=>clearTimeout(timer));
  } catch(error) {
    if(child.connected){child.send({operation:'cancel'},()=>{});void call('close').catch(()=>{});}
    let timer;error.worker_quiescent=await Promise.race([exit.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]).finally(()=>clearTimeout(timer));throw error;
  }
  return {call,get cancelled(){return cancelRequested;},diagnostics:()=>({stderr_bytes:stderrBytes,...(stderrBytes?{stderr_sha256:stderrDigest.copy().digest('hex')}:{})}),cancel(){cancelRequested=true;if(!exited&&child.connected)child.send({operation:'cancel'},error=>{if(error)workerError??=error;});},async close(){
    if(!closed){closed=true;void call('close').catch(error=>{workerError??=error;});}
    let timer;const settled=await Promise.race([exit.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]).finally(()=>clearTimeout(timer));
    if(!settled)throw failure('HISTORY_STOP_PENDING','History worker remains unconfirmed');if(workerError)throw workerError;
  }};
}
