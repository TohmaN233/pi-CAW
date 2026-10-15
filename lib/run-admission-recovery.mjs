import { lstat,open,readdir } from 'node:fs/promises';
import { join,relative } from 'node:path';
import { canonicalJSON,digest } from '../core/workflow-revisions.mjs';
import { noSymlinks,requireValue } from '../core/workflow-paths.mjs';
import { retireOwnedFile,retirementErrorDetails } from '../core/owned-file-retirement.mjs';
import { WorkflowStore } from '../core/workflow-store.mjs';

const ticketName=/^ticket-([a-f0-9-]{36})\.json$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
async function optionalStat(path){try{await noSymlinks(path);return await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function boundedRecord(path){
  await noSymlinks(path);const before=await lstat(path,{bigint:true});
  requireValue(before.isFile()&&before.nlink===1n&&before.size<=4096n,'RUN_ADMISSION_RECORD','Admission evidence must be one bounded regular single-link file');
  const handle=await open(path,'r');let bytes;
  try{
    requireValue(same(before,await handle.stat({bigint:true})),'RUN_ADMISSION_CHANGED','Admission evidence changed before reading');
    const buffer=Buffer.alloc(Number(before.size)+1);let length=0;
    while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
    await noSymlinks(path);
    requireValue(length===Number(before.size)&&same(before,await handle.stat({bigint:true}))&&same(before,await lstat(path,{bigint:true})),
      'RUN_ADMISSION_CHANGED','Admission evidence changed while reading');bytes=buffer.subarray(0,length);
  }finally{await handle.close();}
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{requireValue(false,'RUN_ADMISSION_RECORD','Admission evidence JSON is malformed');}
  return {value,bytes,info:before};
}
function ownerStatus(pid){
  try{process.kill(pid,0);return {owner_status:'active'};}
  catch(error){return error.code==='ESRCH'?{owner_status:'absent'}:{owner_status:'unverified',probe_error_code:error.code??'UNKNOWN'};}
}
async function queueInventory(root){
  const directory=join(root,'.admission-queue'),info=await optionalStat(directory);if(!info)return [];
  requireValue(info.isDirectory(),'RUN_ADMISSION_RECORD','Admission queue must be a directory');const files=[];
  for(const [suffix,kind]of [['','queue'],['.pending','queue_pending']]){
    const base=suffix?join(directory,suffix):directory;if(suffix&&!await optionalStat(base))continue;
    const inventory=await readdir(base,{withFileTypes:true});requireValue(inventory.length<=1025,'RUN_ADMISSION_RECORD','Admission evidence inventory exceeds its bound');
    for(const entry of inventory){
      if(!suffix&&entry.name==='.pending')continue;
      // Retained retirement evidence is never an automatic deletion target.
      if(suffix&&entry.isDirectory()&&/^retired-owner-[a-f0-9-]{36}$/.test(entry.name)){
        const locator='.admission-queue/.pending/'+entry.name;await noSymlinks(join(root,locator));
        const retained=await readdir(join(root,locator));requireValue(retained.length<=1&&retained.every(name=>name==='record.json'),
          'RUN_ADMISSION_RECORD','Unexpected admission retirement evidence entry');
        files.push({kind:retained.length?'retirement_evidence':'empty_retirement',locator:locator+(retained.length?'/record.json':'')});continue;
      }
      requireValue(entry.isFile()&&!entry.isSymbolicLink()&&ticketName.test(entry.name),'RUN_ADMISSION_RECORD','Unexpected admission evidence entry');
      files.push({kind,locator:'.admission-queue/'+(suffix?suffix+'/':'')+entry.name});
    }
  }
  return files;
}
// Maintenance needs only a bounded ownership census, never peer tokens or a
// recovery attempt. Any pending evidence protects the exact Run from deletion.
export async function pendingRunAdmission(root){
  return Boolean(await optionalStat(join(root,'.recovery.lock')))||(await queueInventory(root)).some(item=>item.kind!=='empty_retirement');
}
async function admissionRecords(root){
  const files=await queueInventory(root);if(await optionalStat(join(root,'.writer.lock')))files.unshift({kind:'writer',locator:'.writer.lock'});
  requireValue(files.length<=1025,'RUN_ADMISSION_RECORD','Admission evidence inventory exceeds its bound');const records=[];
  for(const entry of files){
    if(entry.kind==='empty_retirement')continue;
    const raw=await boundedRecord(join(root,entry.locator)),owner=raw.value,writer=entry.kind==='writer'||entry.kind==='retirement_evidence'&&owner?.id===undefined;
    const keys=writer?['pid','token','created_at','operation']:['id','pid','token','created_at','number'];
    requireValue(owner&&typeof owner==='object'&&!Array.isArray(owner)&&Object.keys(owner).every(key=>keys.includes(key))
      &&Number.isSafeInteger(owner.pid)&&owner.pid>0&&typeof owner.token==='string'&&uuid.test(owner.token)
      &&typeof owner.created_at==='string'&&owner.created_at.length<=64&&Number.isFinite(Date.parse(owner.created_at))
      &&(writer?owner.operation===undefined||typeof owner.operation==='string'&&/^[a-z_]{1,32}$/.test(owner.operation)
        :typeof owner.id==='string'&&uuid.test(owner.id)&&(entry.kind==='retirement_evidence'||entry.locator.endsWith(`ticket-${owner.id}.json`))&&Number.isSafeInteger(owner.number)&&owner.number>=0),
      'RUN_ADMISSION_RECORD','Admission evidence has invalid ownership');
    records.push({...raw,path:join(root,entry.locator),descriptor:{...entry,pid:owner.pid,created_at:owner.created_at,
      ...(writer?(owner.operation?{operation:owner.operation}:{}):{number:owner.number}),
      ...(entry.kind==='retirement_evidence'?{recovery_supported:false}:{}),bytes:raw.bytes.length,sha256:digest(raw.bytes),
      physical:{dev:String(raw.info.dev),ino:String(raw.info.ino),birthtime_ns:String(raw.info.birthtimeNs),mtime_ns:String(raw.info.mtimeNs),ctime_ns:String(raw.info.ctimeNs)},...ownerStatus(owner.pid)}});
  }
  return records;
}
async function authorize(service,runId){
  await service.assertReadableRunDirectory(runId);const record=await service.runtime.runs.observeAdmission(runId);
  requireValue(record.state.main_actor===service.host.mainIdentity().session_id,'RUN_ADMISSION_ACTOR','Admission inspection and recovery require the original current conversation');
  const controller=await boundedRecord(join(service.runtime.runs.directory(runId),'pi-controller.json'));
  requireValue(controller.value&&Object.keys(controller.value).length===1&&typeof controller.value.control_token==='string'
    &&digest(controller.value.control_token)===record.state.control_hash,'RUN_AUTHORITY','Admission recovery requires the exact original controller');
  return record;
}
export async function inspectRunAdmission(service,args){
  requireValue(Object.keys(args).every(key=>key==='run_id'),'RUN_ADMISSION_ARGUMENTS','Admission inspection accepts one exact Run');
  const record=await authorize(service,args.run_id),root=service.runtime.runs.directory(args.run_id);
  return {schema_version:1,run_id:args.run_id,status:record.state.status,sequence:record.sequence,
    recovery_pending:Boolean(await optionalStat(join(root,'.recovery.lock'))),records:(await admissionRecords(root)).map(item=>item.descriptor),
    empty_retirement_containers:(await queueInventory(root)).filter(item=>item.kind==='empty_retirement').map(item=>item.locator)};
}
export async function recoverRunAdmission(service,args,{human=false}={}){
  requireValue(human===true,'HUMAN_RECOVERY_REQUIRED','Admission recovery requires explicit human authorization');
  requireValue(Object.keys(args).every(key=>['run_id','records'].includes(key))&&Array.isArray(args.records)&&args.records.length>0&&args.records.length<=64
    &&args.records.every(item=>item&&typeof item.locator==='string')&&new Set(args.records.map(item=>item.locator)).size===args.records.length,
    'RUN_ADMISSION_ARGUMENTS','Recovery requires 1–64 exact previously inspected records');
  requireValue(Buffer.byteLength(canonicalJSON(args.records))<=65536,'RUN_ADMISSION_ARGUMENTS','Inspected recovery records exceed their bounded input');
  const record=await authorize(service,args.run_id),root=service.runtime.runs.directory(args.run_id);
  requireValue(!await optionalStat(join(root,'.recovery.lock')),'RUN_ADMISSION_RECOVERY_PENDING','Existing legacy recovery ownership requires separate inspection; it is never retired by this operation');
  let failedLocator=null;const evidence=[];
  const recoveryDetails=()=>({run_id:args.run_id,recovered:evidence.map(item=>item.locator),partial_evidence:evidence,failed_locator:failedLocator});
  try{
    const current=await admissionRecords(root),selected=args.records.map(expected=>{
      failedLocator=expected.locator;
      const item=current.find(item=>item.descriptor.locator===expected.locator);
      requireValue(item&&canonicalJSON(item.descriptor)===canonicalJSON(expected),'RUN_ADMISSION_CHANGED','Inspected admission ownership changed; inspect it again');
      requireValue(item.descriptor.kind!=='retirement_evidence','RUN_ADMISSION_RETAINED_EVIDENCE','Retained retirement proof is preserved; it is not a pending admission owner');
      requireValue(item.descriptor.owner_status==='absent',item.descriptor.owner_status==='active'?'RUN_ADMISSION_OWNER_ACTIVE':'RUN_ADMISSION_OWNER_UNVERIFIED',
        'Admission owner is active or unverified; preserve its evidence');return item;
    });
    // Reauthorize before the first filesystem effect. No journal repair, effect
    // reconciliation, controller adoption or driver launch belongs to this lane.
    failedLocator=null;await authorize(service,args.run_id);
    for(const item of selected){failedLocator=item.descriptor.locator;
      // The canonical writer pathname is reused. Its existing recovery mutex
      // keeps a competing recovery from moving a newly admitted successor.
      const writer=item.descriptor.kind==='writer';
      const retired=writer?await new WorkflowStore(root).recoverWriter(item.value.token,{expectedIdentity:item.info,expectedBytes:item.bytes})
        :await retireOwnedFile(item.path,{expectedIdentity:item.info,stagingRoot:join(root,'.trash'),retain:true,validate:bytes=>{
      requireValue(bytes.equals(item.bytes),'RUN_ADMISSION_CHANGED','Inspected admission ownership changed before retirement');
      requireValue(ownerStatus(item.value.pid).owner_status==='absent','RUN_ADMISSION_OWNER_UNVERIFIED','Admission owner absence changed before retirement');return item.value.pid;
    }});evidence.push({...item.descriptor,retained_locator:relative(root,writer?retired.retained_at:retired.retired_path).replaceAll('\\','/')});}
    failedLocator=null;
    return {run_id:args.run_id,status:record.state.status,sequence:record.sequence,recovered:selected.map(item=>item.descriptor.locator),evidence,business_state_changed:false,model_calls:0};
  }catch(error){error.details={...error.details,admission_recovery:recoveryDetails(),...retirementErrorDetails([error])};throw error;}
}
