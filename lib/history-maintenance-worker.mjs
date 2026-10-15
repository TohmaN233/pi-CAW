import { readdir,readFile,lstat,rmdir,rename,unlink,mkdir } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute,dirname } from 'node:path';
import { WorkflowRunStore } from '../core/workflow-run-store.mjs';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { insideRoot,noSymlinks,requireValue } from '../core/workflow-paths.mjs';
import { canonicalJSON,digest } from '../core/workflow-revisions.mjs';
import { randomUUID } from 'node:crypto';
import { readRunStoreForegroundActivity } from '../core/workflow-run-store.mjs';
import { executionSessionRoot,containsSession,sessionCleanupIntent,removeEmptySessionDirectory } from './execution-sessions.mjs';
import { pendingRunAdmission } from './run-admission-recovery.mjs';

let directory,runs,owner,cancelled=false,automatic=false,closing=false;
const cancelledError=()=>Object.assign(new Error('History maintenance stopped before filesystem mutation'),{code:'HISTORY_CANCELLED'});
async function guard() {
  if(cancelled||closing)throw cancelledError();
  const ownerPath=join(directory,'.history-maintenance','.writer.lock');await noSymlinks(ownerPath);const actual=JSON.parse(await readFile(ownerPath,'utf8'));
  requireValue(actual.job_id===owner.job_id&&actual.token===owner.token&&actual.pid===owner.pid&&actual.created_at===owner.created_at&&actual.schema_version===owner.schema_version,'HISTORY_OWNER_CHANGED','Worker lost exact maintenance claim');
  if(automatic){const activity=await readRunStoreForegroundActivity(runs.root);if(activity.active||activity.orphaned||activity.unverified)throw cancelledError();}
  if(cancelled||closing)throw cancelledError();
}
async function retireData(path,hash) {
  await noSymlinks(path);const original=await lstat(path,{bigint:true});
  requireValue(original.isFile()&&original.nlink===1n,'RUN_CLEANUP_FILE','Retirement requires one regular unlinked file');
  const staging=join(directory,'.history-maintenance',`data-${owner.job_id}-${randomUUID()}`);
  await mkdir(staging);const retired=join(staging,'data'),intent=join(staging,'intent.json');
  // Exact durable file intent precedes the sole canonical rename. A crash or
  // cancellation after retirement leaves this evidence and owned data intact.
  const durableIntent={schema_version:1,job_id:owner.job_id,owner_pid:owner.pid,owner_token:owner.token,owner_created_at:owner.created_at,worker_pid:process.pid,path,sha256:hash,bytes:Number(original.size),dev:String(original.dev),ino:String(original.ino),retired_path:retired,complete:false};
  await writeDurableJSON(intent,durableIntent);
  await guard();await rename(path,retired);
  const actual=await lstat(retired,{bigint:true});
  requireValue(actual.dev===original.dev&&actual.ino===original.ino&&digest(await readFile(retired))===hash,'RUN_CLEANUP_CHANGED','Retired file identity changed; preserve evidence');
  await guard();await unlink(retired);
  await writeDurableJSON(intent,{...durableIntent,complete:true});
  await unlink(intent);await rmdir(staging);
}
async function recoverData(root,files=[]) {
  let bytes=0;const permitted=new Set(files.map(file=>resolve(file.path)));
  for(const name of await readdir(join(directory,'.history-maintenance'))){
    if(!/^data-[a-f0-9-]+$/.test(name))continue;
    const staging=join(directory,'.history-maintenance',name),intentPath=join(staging,'intent.json');
    await noSymlinks(intentPath);const intent=JSON.parse(await readFile(intentPath,'utf8'));
    requireValue(typeof intent.path==='string'&&typeof intent.job_id==='string'&&/^[a-f0-9]{64}$/.test(intent.sha256)&&Number.isSafeInteger(intent.bytes),'HISTORY_DATA_INTENT','Data retirement intent is malformed');
    if(!containsSession(root,intent.path)&&!permitted.has(resolve(intent.path)))continue;
    requireValue(name.startsWith(`data-${intent.job_id}-`)&&intent.retired_path===join(staging,'data'),'HISTORY_DATA_INTENT','Data retirement path differs from its exact staging directory');
    const previous=JSON.parse(await readFile(join(directory,'.history-maintenance',`job-${intent.job_id}.json`),'utf8'));
    requireValue(previous.schema_version===1&&previous.job_id===intent.job_id&&previous.pid===intent.owner_pid&&previous.token===intent.owner_token&&previous.created_at===intent.owner_created_at&&previous.worker_pid===intent.worker_pid&&previous.phase==='settled'&&previous.worker_quiescent===true,'HISTORY_DATA_OWNER_PENDING','Previous filesystem owner shutdown is unconfirmed; retain its staged data');
    const retired=intent.retired_path;let info;
    try{await noSymlinks(retired);info=await lstat(retired,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    if(info){
      requireValue(info.isFile()&&info.nlink===1n&&String(info.dev)===intent.dev&&String(info.ino)===intent.ino&&Number(info.size)===intent.bytes&&digest(await readFile(retired))===intent.sha256,'HISTORY_DATA_CHANGED','Staged retirement identity changed; retain evidence');
      try{await lstat(intent.path);throw Object.assign(new Error('Original retirement path has a successor; retain staged evidence'),{code:'HISTORY_DATA_SUCCESSOR'});}catch(error){if(error.code!=='ENOENT')throw error;}
      await guard();await unlink(retired);bytes+=intent.bytes;
    }else if(intent.complete!==true){
      // An intent committed before rename may still own its original file.
      // Missing both names is also safe: the earlier unlink already completed.
      try{await noSymlinks(intent.path);requireValue(digest(await readFile(intent.path))===intent.sha256,'HISTORY_DATA_CHANGED','Original retirement intent changed');}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    await guard();await unlink(intentPath);await rmdir(staging);
  }
  return bytes;
}
async function materialIntent(root) {
  try{await noSymlinks(root);}catch(error){if(error.code==='ENOENT')return {root,files:[]};throw error;}
  const files=[];const visit=async(path,depth)=>{
    requireValue(depth<=32&&files.length<=4096,'HISTORY_MATERIAL_LIMIT','Execution material inventory exceeds its bound');
    for(const entry of await readdir(path,{withFileTypes:true})){
      await guard();const file=insideRoot(root,join(path,entry.name));await noSymlinks(file);const stat=await lstat(file);
      if(stat.isDirectory())await visit(file,depth+1);
      else{requireValue(files.length<4096,'HISTORY_MATERIAL_LIMIT','Execution material inventory exceeds its file bound');requireValue(stat.isFile()&&stat.nlink===1,'HISTORY_MATERIAL_FILE','Execution materials require regular unlinked files');files.push({path:file,sha256:digest(await readFile(file)),bytes:stat.size});}
    }
  };await visit(root,0);return {root,files};
}
async function cleanMaterials(intent) {
  let bytes=await recoverData(intent.root,intent.files);
  for(const file of intent.files){insideRoot(intent.root,file.path);try{await noSymlinks(file.path);const stat=await lstat(file.path);requireValue(stat.isFile()&&stat.nlink===1&&stat.size===file.bytes&&digest(await readFile(file.path))===file.sha256,'HISTORY_MATERIAL_CHANGED','Execution materials changed after durable intent');await guard();await retireData(file.path,file.sha256);bytes+=stat.size;}catch(error){if(error.code!=='ENOENT')throw error;}}
  const remove=async root=>{try{await noSymlinks(root);for(const entry of await readdir(root,{withFileTypes:true})){requireValue(entry.isDirectory(),'HISTORY_MATERIAL_SUCCESSOR','Execution material root contains an unprepared successor');await remove(insideRoot(intent.root,join(root,entry.name)));}await guard();await rmdir(root);}catch(error){if(error.code!=='ENOENT')throw error;}};
  await remove(intent.root);return bytes;
}
function outputs(state,root) {
  const keep=new Set();const scan=value=>{
    if(typeof value==='string'&&/^artifact-[a-z0-9._-]+\.bin$/.test(value))keep.add(insideRoot(root,join(root,value)));
    else if(typeof value==='string'&&isAbsolute(value)){const path=resolve(value),rel=relative(root,path);if(rel&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')&&!isAbsolute(rel))keep.add(path);}
    else if(value&&typeof value==='object')Object.values(value).forEach(scan);
  };scan(state.output);scan(state.outputs);for(const node of Object.values(state.nodes))scan(node.output);return keep;
}
async function trim(root,keep=new Set()) {
  await noSymlinks(root);let bytes=0;
  for(const entry of await readdir(root,{withFileTypes:true})){
    await guard();const path=insideRoot(root,join(root,entry.name));await noSymlinks(path);
    requireValue(!entry.isSymbolicLink(),'RUN_CLEANUP_LINK','Cleanup refuses symbolic links');if(keep.has(path))continue;
    if(entry.isDirectory()){bytes+=await trim(path,keep);if(!(await readdir(path)).length){await guard();await rmdir(path);}}
    else {
      const stat=await lstat(path);requireValue(stat.isFile()&&stat.nlink===1,'RUN_CLEANUP_FILE','Cleanup requires regular unlinked files');
      const hash=digest(await readFile(path));await guard();
      await retireData(path,hash);bytes+=stat.size;
    }
  }
  return bytes;
}
async function sessionDelete(root,file) {
  insideRoot(root,file.path);let stat,data;
  try{await noSymlinks(file.path);stat=await lstat(file.path);data=await readFile(file.path);}catch(error){if(error.code==='ENOENT')return 0;throw error;}
  requireValue(stat.isFile()&&stat.nlink===1&&digest(data)===file.sha256,'RUN_SESSION_CHANGED','Execution session changed since durable cleanup intent');
  if(data.toString('utf8').trim().split('\n').map(JSON.parse).some(entry=>entry.type==='custom'&&entry.customType==='pi-caw:task'&&entry.data?.kind==='thread'))return 0;
  await guard();await retireData(file.path,file.sha256);return stat.size;
}
async function sessions(files,legacyRoot) {
  const root=executionSessionRoot(directory);let bytes=await recoverData(root,files);
  for(const file of files??[]){const base=containsSession(root,file.path)?root:legacyRoot;bytes+=await sessionDelete(base,file);await guard();await removeEmptySessionDirectory(root,file.path);}return bytes;
}
const operations={
  async initialize(args){requireValue(!directory&&isAbsolute(args.directory),'HISTORY_WORKER_SCOPE','Worker requires an exact absolute storage root');directory=resolve(args.directory);owner=args.owner;automatic=args.automatic===true;runs=new WorkflowRunStore(join(directory,'runs'));await guard();return {pid:process.pid};},
  async list(){await guard();return runs.list();},
  async observe({id}){await guard();const {state,pins,sequence}=await runs.observe(id);return {state,pins,sequence};},
  async read({id}){await guard();const {state,pins,sequence}=await runs.read(id);return {state,pins,sequence};},
  async runEntries(){await guard();return (await readdir(runs.root)).filter(name=>/^run-.+\.run$/.test(name)).map(name=>name.slice(4,-4));},
  async sessionIntent({root,receipt,options}){await guard();return sessionCleanupIntent(root,receipt,options);},
  async cleanSessions({files,legacyRoot}){return sessions(files,legacyRoot);},
  async trim({root,keep}){return await recoverData(root)+await trim(root,new Set(keep));},
  async cleanupRun({id,summary,legacyRoot}) {
    await guard();return runs.withRunWriter(id,async()=>{
      const root=runs.directory(id),actual=await runs.retained(id);
      requireValue(canonicalJSON(actual)===canonicalJSON(summary),'RUN_CLEANUP_CHANGED','Retained intent changed before filesystem deletion');
      if(await pendingRunAdmission(root))return {bytes:0,protected:true};
      const keep=outputs(actual.state,root);for(const name of ['retained.json','.writer.lock','.pending','.admission-queue'])keep.add(join(root,name));
      let bytes=await recoverData(root,actual.execution_files);bytes+=await trim(root,keep);bytes+=await sessions(actual.execution_files,legacyRoot);
      await guard();await writeDurableJSON(join(root,'retained.json'),{...actual,cleanup_complete:true});return {bytes,protected:false};
    });
  },
  async cleanAuthoring({summary,rows}) {
    if(summary.state.status==='succeeded'||rows.some(row=>row.workflow_id===summary.state.workflow_id))return 0;
    const root=join(directory,'authoring-jobs');try{await noSymlinks(root);}catch(error){if(error.code==='ENOENT')return 0;throw error;}
    const id=summary.state.workflow_id,jobs=new WorkflowStore(root),target=insideRoot(root,join(root,`wf-${id}.pack`));
    const intentPath=join(directory,'.history-maintenance',`authoring-${digest(id)}.json`);let bytes=0;
    await jobs.withWriter(async()=>{
      let intent;try{await noSymlinks(intentPath);intent=JSON.parse(await readFile(intentPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(!intent){
        let job;try{job=await jobs.snapshot(id);}catch(error){if(error.code==='ENOENT')return;throw error;}
        requireValue(job.provenance?.kind==='authoring_workflow_run','RUN_CLEANUP_JOB','Retired job must be Host authoring process data');
        intent={schema_version:1,workflow_id:id,revision_hash:job.revision_hash,provenance_kind:job.provenance.kind,...await materialIntent(target)};
        await guard();await writeDurableJSON(intentPath,intent);
      }
      requireValue(intent.workflow_id===id&&intent.root===target&&intent.provenance_kind==='authoring_workflow_run'&&/^[a-f0-9]{64}$/.test(intent.revision_hash),'RUN_CLEANUP_JOB','Authoring retirement intent differs from its exact private Pack');
      bytes+=await cleanMaterials(intent);await guard();await unlink(intentPath);
    });
    const managed=resolve(directory,'authoring-workspaces',summary.state.run_id);
    if(resolve(summary.state.permissions.workspace)===managed){try{bytes+=await recoverData(managed)+await trim(managed,outputs(summary.state,managed));}catch(error){if(error.code!=='ENOENT')throw error;}}return bytes;
  },
  async roleEntries(){const root=join(directory,'role-runs');try{await guard();await noSymlinks(root);return (await readdir(root)).filter(name=>/^role-[a-f0-9-]+\.json$/.test(name));}catch(error){if(error.code==='ENOENT')return [];throw error;}},
  async roleRead({name}){requireValue(/^role-[a-f0-9-]+\.json$/.test(name),'ROLE_CLEANUP_IDENTITY','Role journal name is invalid');const path=join(directory,'role-runs',name);await guard();await noSymlinks(path);return JSON.parse(await readFile(path,'utf8'));},
  async roleMaterialIntent({id,root}){requireValue(root===join(directory,'role-runs',`${id}.materials`),'ROLE_MATERIAL_SCOPE','Role material root differs from its exact managed identity');return materialIntent(root);},
  async roleClean({name,journal,root}){const path=join(directory,'role-runs',name);requireValue(canonicalJSON(await operations.roleRead({name}))===canonicalJSON(journal),'ROLE_CLEANUP_CHANGED','Role journal changed before deletion');let bytes=await recoverData(root,journal.cleanup_intent.files);if(journal.cleanup_intent.materials){requireValue(journal.cleanup_intent.materials.root===join(directory,'role-runs',`${journal.id}.materials`),'ROLE_MATERIAL_SCOPE','Role material intent differs from its exact managed identity');bytes+=await cleanMaterials(journal.cleanup_intent.materials);}for(const file of journal.cleanup_intent.files){bytes+=await sessionDelete(root,file);await guard();await removeEmptySessionDirectory(executionSessionRoot(directory),file.path);}await guard();await writeDurableJSON(path,{...journal,cleanup_complete:true,cleaned_at:new Date().toISOString()});return bytes;},
};
let tail=Promise.resolve();
process.on('disconnect',()=>{cancelled=true;closing=true;});
process.on('message',message=>{
  if(message.operation==='cancel'){cancelled=true;return;}
  const close=message.operation==='close';
  tail=tail.then(async()=>{
    try {const operation=operations[message.operation];requireValue(close||typeof operation==='function','HISTORY_WORKER_PROTOCOL','Unknown filesystem worker operation');const result=close?null:await operation(message.args);process.send({schema_version:1,job_id:owner?.job_id,worker_pid:process.pid,id:message.id,result},()=>{if(close){closing=true;process.disconnect();}});}
    catch(error){process.send({schema_version:1,job_id:owner?.job_id,worker_pid:process.pid,id:message.id,error:{code:error.code??(error instanceof SyntaxError?'SyntaxError':'HISTORY_WORKER_FAILED'),message:`History filesystem operation ${message.operation} failed`,message_bytes:Buffer.byteLength(String(error.message)),message_sha256:digest(String(error.message))}},()=>{});}
  });
});
