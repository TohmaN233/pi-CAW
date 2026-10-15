import {open,readFile,lstat,readdir,rename,unlink} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {canonicalJSON} from './workflow-revisions.mjs';
import {ensureDirectory,noSymlinks,requireValue} from './workflow-paths.mjs';
import {retireOwnedFile,retirementErrorDetails} from './owned-file-retirement.mjs';

const pause=()=>new Promise(resolve=>setTimeout(resolve,25));
const ticketPattern=/^ticket-([a-f0-9-]{36})\.json$/;
const exactPath=(a,b)=>typeof a==='string'&&(process.platform==='win32'
 ?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b));
const failure=(code,message,path,owner={})=>Object.assign(new Error(message),{
 code,ticket_path:path,...(owner.pid?{owner_pid:owner.pid}:{}),...(owner.created_at?{created_at:owner.created_at}:{})});
async function ticketReadObservation(path){
 // Evidence only: a denied peer read is not a grant to retry, remove a ticket
 // or replay admission. Never reread its body or disclose its ownership token.
 try{
  const info=await lstat(path);
  return {ticket_exists:true,ticket_kind:info.isSymbolicLink()?'symlink':info.isFile()?'file':info.isDirectory()?'directory':'other',
   ticket_bytes:info.size,ticket_links:info.nlink};
 }catch(error){
  return error?.code==='ENOENT'&&exactPath(error?.path,path)?{ticket_exists:false}
   :{ticket_exists:null,inspection_error_code:error?.code??'UNKNOWN'};
 }
}
async function ticketAt(path,{initializationMs=250,allowUnsettled=false,captureIdentity=false}={}){
 await noSymlinks(path);let info=await lstat(path);
 // Queue names are mutable: choosing number=0 is atomically published as a
 // numbered ticket. Refresh a retired lookup exactly once, then apply every
 // original file/body check. Ownership-sensitive callers still verify the
 // exact token and record; invalid replacements and disk errors stay visible.
 const retiredLookup=info.isFile()&&info.nlink===0;
 if(retiredLookup)info=await lstat(path);
 requireValue(info.isFile()&&info.nlink===1&&info.size<=4096,'RUN_ADMISSION_QUEUE_FILE','Admission ticket must be one bounded regular file',
  {phase:'ticket_metadata',ticket_path:path,ticket_bytes:info.size,ticket_links:info.nlink,
   ...(retiredLookup?{retired_lookup:true}:{})});
 let bytes,identity;
 try{
  if(!captureIdentity)bytes=await readFile(path);
  else{
   // Explicit recovery binds the physical file before its bounded body read.
   // Ordinary queue census keeps its existing inexpensive observation path.
   identity=await lstat(path,{bigint:true});const handle=await open(path,'r');
   const same=(a,b)=>b.isFile()&&b.nlink===1n&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
   try{
    requireValue(identity.isFile()&&identity.nlink===1n&&identity.size<=4096n&&same(identity,await handle.stat({bigint:true})),
     'RUN_ADMISSION_QUEUE_OWNERSHIP','Admission ticket identity changed before recovery inspection');
    const buffer=Buffer.alloc(Number(identity.size)+1);let length=0;
    while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
    await noSymlinks(path);
    requireValue(length===Number(identity.size)&&same(identity,await handle.stat({bigint:true}))&&same(identity,await lstat(path,{bigint:true})),
     'RUN_ADMISSION_QUEUE_OWNERSHIP','Admission ticket identity changed during recovery inspection');bytes=buffer.subarray(0,length);
   }finally{await handle.close();}
  }
 }
 catch(error){
  if(['EPERM','EACCES','EBUSY'].includes(error?.code)&&exactPath(error?.path,path))
   error.details={phase:'ticket_read_failed',ticket_path:path,cause_code:error.code,...await ticketReadObservation(path)};
  throw error;
 }
 requireValue(bytes.length<=4096,'RUN_ADMISSION_QUEUE_FILE','Admission ticket grew beyond its limit');
 if(!bytes.length){
  const created=info.birthtimeMs>0?info.birthtimeMs:info.ctimeMs;
  if(Date.now()-created>=initializationMs)throw failure('RUN_ADMISSION_QUEUE_INITIALIZATION','Admission ticket initialization did not complete',path);
  return {initializing:true,path};
 }
 let ticket;try{ticket=JSON.parse(bytes);}catch{throw failure('RUN_ADMISSION_QUEUE_MALFORMED','Admission ticket JSON is malformed',path);}
 requireValue(ticket&&Object.keys(ticket).every(k=>['id','pid','token','created_at','number'].includes(k))
  &&typeof ticket.id==='string'&&ticketPattern.test(`ticket-${ticket.id}.json`)
  &&path.endsWith(`ticket-${ticket.id}.json`)&&Number.isSafeInteger(ticket.pid)&&ticket.pid>0
  &&typeof ticket.token==='string'&&/^[a-f0-9-]{36}$/.test(ticket.token)
  &&typeof ticket.created_at==='string'&&Number.isFinite(Date.parse(ticket.created_at))
  &&Number.isSafeInteger(ticket.number)&&ticket.number>=0,
 'RUN_ADMISSION_QUEUE_MALFORMED','Admission ticket has invalid ownership or ordering');
 // A complete chooser has a verifiable live owner. Peers wait under their
 // own admission deadline; only an ownerless empty file uses initializationMs.
 return {ticket,bytes,path,...(captureIdentity?{identity}:{})};
}
async function entries(directory,options){
 const result=[];
 const inventory=await readdir(directory,{withFileTypes:true});
 requireValue(inventory.length<=1025,'RUN_ADMISSION_QUEUE_LIMIT','Admission queue exceeds its bounded entry count');
 for(const entry of inventory){
  const path=join(directory,entry.name);
  if(entry.name==='.pending'){await noSymlinks(path);continue;}
  requireValue(entry.isFile()&&!entry.isSymbolicLink()&&ticketPattern.test(entry.name),
   'RUN_ADMISSION_QUEUE_ENTRY','Unexpected admission queue entry');
  try{result.push(await ticketAt(path,options));}
  catch(error){if(error?.code!=='ENOENT'||!exactPath(error?.path,path))throw error;}
 }
 return result;
}
async function requireLive(entry){
 if(!entry.ticket||entry.ticket.pid===process.pid)return;
 try{process.kill(entry.ticket.pid,0);}
 catch(cause){
  let current;try{current=await readFile(entry.path);}catch(error){if(error?.code==='ENOENT'&&exactPath(error?.path,entry.path))return;throw error;}
  if(!current.equals(entry.bytes))return;
  const code=cause?.code==='ESRCH'?'RUN_ADMISSION_QUEUE_ORPHANED':'RUN_ADMISSION_QUEUE_OWNER_UNVERIFIED';
  const message=code==='RUN_ADMISSION_QUEUE_ORPHANED'
   ?`Admission queue owner PID ${entry.ticket.pid} has exited; inspect_run_admission and explicitly recover the inspected record before writing`
   :`Admission queue owner PID ${entry.ticket.pid} liveness cannot be verified (${cause?.code??'UNKNOWN'}); inspect_run_admission before recovery`;
  throw Object.assign(failure(code,message,entry.path,entry.ticket),{cause});
 }
}
async function publish(path,value){
 // Queue positions coordinate live processes; the existing writer record is
 // the durable ownership boundary. Do not flush two transient ticket files
 // for every journal read. Writes and close still complete before visibility.
 const file=await open(path,'wx',0o600);try{await file.writeFile(canonicalJSON(value));}finally{await file.close();}
}
async function removeOwn(path,expected,{allowChoosing=false,onRetired=()=>{},expectedIdentity}={}){
 const entry=await ticketAt(path,{allowUnsettled:true});
 requireValue(entry.ticket?.id===expected.id&&entry.ticket?.token===expected.token
  &&entry.ticket?.pid===expected.pid&&(entry.ticket?.number===expected.number||allowChoosing&&entry.ticket?.number===0),
  'RUN_ADMISSION_QUEUE_OWNERSHIP','Admission ticket ownership changed; preserve it for inspection');
 if(basename(dirname(path))==='.pending'){
  // This uniquely named unpublished choice is never opened by queue peers.
  await unlink(path);return;
 }
 await retireOwnedFile(path,{stagingRoot:join(dirname(path),'.pending'),onRetired,expectedIdentity,validate:bytes=>{
  const ticket=JSON.parse(bytes);
  requireValue(canonicalJSON(ticket)===canonicalJSON(expected)
   ||allowChoosing&&ticket.number===0&&canonicalJSON(ticket)===canonicalJSON({...expected,number:0}),
   'RUN_ADMISSION_QUEUE_OWNERSHIP','Admission ticket ownership changed; preserve it for inspection');
  return ticket.pid;
 }});
}

// Windows may temporarily deny replacing a file held by a reader. Retry only
// this exact unpublished choice, while its immutable owner is still proved.
// The existing admission deadline covers publication; no callback is replayed.
export async function commitAdmissionChoice(path,temporary,ticket,{remaining,onWait=async()=>{},renameFile=rename,platform=process.platform}){
 let blocked=false;
 for(;;){
  remaining();
  const previous=await ticketAt(path,{allowUnsettled:true}),pending=await ticketAt(temporary,{allowUnsettled:true});
  requireValue(previous.ticket?.id===ticket.id&&previous.ticket.token===ticket.token
    &&previous.ticket.pid===ticket.pid&&previous.ticket.number===0
    &&canonicalJSON(pending.ticket)===canonicalJSON(ticket),
    'RUN_ADMISSION_QUEUE_OWNERSHIP','Admission choice publication ownership changed');
  try{await renameFile(temporary,path);return;}
  catch(error){
   if(platform!=='win32'||error?.code!=='EPERM')throw error;
   if(!blocked){await onWait({phase:'publication_blocked',ticket_path:path,owner_pid:ticket.pid,cause_code:error.code});blocked=true;}
   try{remaining();}catch(deadlineError){throw Object.assign(new AggregateError([error,deadlineError],
     'Admission choice publication remained blocked until its deadline'),{code:'RUN_ADMISSION_QUEUE_PUBLICATION_TIMEOUT'});}
   await pause();
  }
 }
}

// Bakery ordering separates queue position from the existing exclusive writer.
// Choose without waiting for other choosers; wait for them only before entry.
// Removing a ticket after writer acquisition preserves the original mutex.
export async function queuedRunAdmission(root,options,enter){
 const started=performance.now(),deadline=started+options.timeoutMs;
 const directory=join(root,'.admission-queue');await ensureDirectory(directory);await ensureDirectory(join(directory,'.pending'));
 const ticket={id:randomUUID(),pid:process.pid,token:randomUUID(),created_at:new Date().toISOString(),number:0};
 const path=join(directory,`ticket-${ticket.id}.json`),temporary=join(directory,'.pending',`ticket-${ticket.id}.json`);
 let published=false,removed=false,error,result,failed=false,waitingFor=null;
 const remaining=()=>{
  const ms=Math.floor(deadline-performance.now());
  if(ms<=0)throw Object.assign(failure('RUN_STORE_ADMISSION_TIMEOUT','Run admission timed out in its ordered queue',path,waitingFor?.ticket??{}),{phase:'ordered_queue',waited_ms:Math.floor(performance.now()-started)});
  return ms;
 };
 try{
  remaining();await publish(path,ticket);published=true;
  const choosing=await entries(directory,options);
  for(const entry of choosing)await requireLive(entry);
  const max=Math.max(0,...choosing.map(e=>e.ticket?.number??0));
  requireValue(max<Number.MAX_SAFE_INTEGER,'RUN_ADMISSION_QUEUE_EXHAUSTED','Admission queue ordering is exhausted');
  ticket.number=max+1;
  await publish(temporary,ticket);
  await commitAdmissionChoice(path,temporary,ticket,{remaining,onWait:options.onWait});
  let reported=false;
  for(;;){
   remaining();const current=await entries(directory,options);
   for(const entry of current)await requireLive(entry);
   const own=current.find(e=>e.ticket?.id===ticket.id);
   requireValue(own?.ticket.token===ticket.token&&own.ticket.number===ticket.number,
    'RUN_ADMISSION_QUEUE_OWNERSHIP','The caller admission ticket disappeared or changed');
   const ahead=current.find(e=>e.initializing||e.ticket.number===0||e.ticket.number<ticket.number
    ||e.ticket.number===ticket.number&&e.ticket.id<ticket.id);
   waitingFor=ahead??null;
   if(!ahead)break;
   if(!reported){await options.onWait({phase:'queued',ticket_path:path,owner_pid:ahead.ticket?.pid??null,
    created_at:ahead.ticket?.created_at??null,waited_ms:Math.floor(performance.now()-started)});reported=true;}
   await pause();
  }
  result=await enter({...options,timeoutMs:remaining(),
   onWait:trace=>options.onWait({...trace,waited_ms:Math.floor(performance.now()-started)}),
   onAcquired:async()=>{remaining();await removeOwn(path,ticket,{onRetired:()=>{removed=true;}});}});
 }catch(cause){
  if(cause?.code==='RUN_STORE_ADMISSION_TIMEOUT')cause.waited_ms=Math.floor(performance.now()-started);
  error=cause;failed=true;
 }
 const cleanup=[];
 if(published&&!removed)try{await removeOwn(path,ticket,{allowChoosing:true,onRetired:()=>{removed=true;}});}catch(cause){cleanup.push(cause);}
 try{await removeOwn(temporary,ticket);}catch(cause){if(cause?.code!=='ENOENT'||!exactPath(cause?.path,temporary))cleanup.push(cause);}
 if(cleanup.length){const failures=[...(failed?[error]:[]),...cleanup];
  throw Object.assign(new AggregateError(failures,'Admission queue ownership cleanup failed'),
   {code:'RUN_ADMISSION_QUEUE_CLEANUP',details:retirementErrorDetails(failures)});}
 if(failed)throw error;return result;
}

export async function inspectRunAdmissionQueue(root){
 return (await entries(join(root,'.admission-queue'),{allowUnsettled:true})).map(e=>e.ticket);
}
export async function recoverRunAdmissionTicket(root,id,token){
 requireValue(typeof id==='string'&&ticketPattern.test(`ticket-${id}.json`),'RUN_ADMISSION_QUEUE_ID','Exact admission ticket identity is required');
 const path=join(root,'.admission-queue',`ticket-${id}.json`),entry=await ticketAt(path,{allowUnsettled:true,captureIdentity:true});
 requireValue(entry.ticket?.token===token,'RUN_ADMISSION_QUEUE_OWNERSHIP','Admission ticket recovery token does not match');
 try{process.kill(entry.ticket.pid,0);throw failure('RUN_ADMISSION_QUEUE_OWNER_ACTIVE','Admission waiter is still alive',path,entry.ticket);}
 catch(error){if(error?.code!=='ESRCH')throw error;}
 const temporary=join(root,'.admission-queue','.pending',`ticket-${id}.json`);let pending;
 try{pending=await ticketAt(temporary,{allowUnsettled:true,captureIdentity:true});}
 catch(error){if(error?.code!=='ENOENT'||!exactPath(error?.path,temporary))throw error;}
 if(pending)requireValue(pending.ticket?.token===token&&pending.ticket?.pid===entry.ticket.pid,
  'RUN_ADMISSION_QUEUE_OWNERSHIP','Pending admission ticket differs from its exact owner');
 await removeOwn(path,entry.ticket,{expectedIdentity:entry.identity});
 if(pending)await retireOwnedFile(temporary,{stagingRoot:join(root,'.admission-queue','.pending'),expectedIdentity:pending.identity,validate:bytes=>{
  requireValue(bytes.equals(pending.bytes),'RUN_ADMISSION_QUEUE_OWNERSHIP','Pending admission ticket changed after inspection');return pending.ticket.pid;
 }});
}
