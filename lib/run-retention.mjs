import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkflowStore } from '../core/workflow-store.mjs';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { insideRoot, noSymlinks, requireValue } from '../core/workflow-paths.mjs';
import { historyMaintenance } from './history-maintenance.mjs';
import { executionSessionRoot, containsSession } from './execution-sessions.mjs';
import { pendingRunAdmission } from './run-admission-recovery.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled']);
export const DEFAULT_RUN_RETENTION = { schema_version: 1, completed_hours: 24 };
function ownedSessions(receipt) {
  if (!['pi-sdk-subagent','pi-isolated-main','pi-sdk-authoring-review'].includes(receipt?.executor)) return [];
  return receipt.sessions ?? (receipt.session_file ? [receipt] : []);
}
export function compactRun(record) {
  const s = record.state;
  return { run_id:s.run_id, workflow_id:s.workflow_id, main_actor:s.main_actor, status:s.status,
    created_at:s.created_at, updated_at:s.updated_at, inputs:s.inputs, permissions:s.permissions,
    ...(s.parent ? {parent:s.parent} : {}), ...(s.error ? {error:s.error} : {}), ...(s.output!==undefined?{output:s.output}:{}), ...(s.outputs!==undefined?{outputs:s.outputs}:{}),
    nodes:Object.fromEntries(Object.entries(s.nodes).map(([id,n]) => [id,{status:n.status,
      ...(n.error ? {error:n.error} : {}), ...(n.output !== undefined ? {output:n.output} : {})}])) };
}
export async function trimDirectory(root, keep = new Set()) {
  await noSymlinks(root); let bytes=0;
  for (const entry of await readdir(root,{withFileTypes:true})) {
    const path=insideRoot(root,join(root,entry.name)); await noSymlinks(path);
    requireValue(!entry.isSymbolicLink(),'RUN_CLEANUP_LINK','Cleanup refuses symbolic links');
    if (keep.has(path)) continue;
    if (entry.isDirectory()) { bytes+=await trimDirectory(path,keep); if (!(await readdir(path)).length) await rmdir(path); }
    else { const stat=await lstat(path); requireValue(stat.isFile() && stat.nlink===1,'RUN_CLEANUP_FILE','Cleanup requires a regular unlinked file'); bytes+=stat.size; await rm(path); }
  }
  return bytes;
}
export class RunRetention {
  constructor(service) { this.service=service; this.policyPath=join(service.directory,'run-retention.json'); this.pending=null; this.maintenance=historyMaintenance(service.directory); this.worker=null; this.releaseMaintenance=this.maintenance.acquire(); this.closed=false; }
  async policy(value) {
    if (value !== undefined) {
      requireValue(Number.isInteger(value.completed_hours) && value.completed_hours>=0 && value.completed_hours<=720
        && Object.keys(value).every(k=>['schema_version','completed_hours'].includes(k)), 'RUN_RETENTION_POLICY','Retention must be 0..720 hours');
      await new WorkflowStore(this.service.directory).withWriter(()=>writeDurableJSON(this.policyPath,{...DEFAULT_RUN_RETENTION,completed_hours:value.completed_hours}));
    }
    try { const p=JSON.parse(await readFile(this.policyPath,'utf8')); requireValue(p.schema_version===1 && Number.isInteger(p.completed_hours) && p.completed_hours>=0 && p.completed_hours<=720,'RUN_RETENTION_POLICY','Stored retention policy is invalid'); return p; }
    catch(e) { if(e.code==='ENOENT')return {...DEFAULT_RUN_RETENTION}; throw e; }
  }
  async reason(record, {completed_now=false,now=Date.now()}={}) {
    const s=this.service, state=record.state;
    if (!terminal.has(state.status)) return 'unfinished_or_interrupted';
    if (s.active.has(state.run_id)) return 'active_owner';
    if (record.pins.root.provenance?.kind==='authoring_workflow_run' && state.status==='succeeded') return 'authoring_publication';
    if (!await s.runQuiescent(record)) return 'unconfirmed_effect_shutdown';
    if (state.parent?.run_id && !await s.runtime.runs.retained(state.parent.run_id)) return 'retained_by_parent';
    const owner=await s.detachedOwners.read(state.run_id);
    if (owner && (owner.termination?.confirmed!==true || (await s.detachedOwners.pendingNotifications(state.run_id)).length)) return 'owner_or_notification_pending';
    const at=Date.parse(state.updated_at);
    requireValue(Number.isFinite(at),'RUN_RETENTION_DATE','Run has no valid completion timestamp');
    if (state.status==='succeeded' && !completed_now && now-at<(await this.policy()).completed_hours*3600000) return 'retention_period';
    return null;
  }
  async sessionFiles(record,references=new Map()) {
    const s=this.service, privateRoot=executionSessionRoot(s.directory);
    const legacyRoot=s.host.agentDir ? join(s.host.agentDir,'sessions') : null;
    const files=new Map();
    for(const [nodeId,n] of Object.entries(record.state.nodes))for(const a of n.attempts)for(const r of ownedSessions(a.dispatch?.receipt)){
      if(record.pins.root.workflow.nodes.find(node=>node.id===nodeId)?.executor?.kind==='thread' || a.dispatch.receipt.session_storage==='persistent')continue;
      if(!r.session_file)continue;
      const path=resolve(r.session_file);if([...references.get(path)??[]].some(id=>id!==record.state.run_id))continue;
      requireValue(r.thread_id!==record.state.main_actor,'RUN_SESSION_PARENT','Cleanup cannot remove the initiating chat');
      const privateSession=containsSession(privateRoot,path),root=privateSession?privateRoot:legacyRoot;
      if(!containsSession(root,path)){
        console.info('[pi-CAW] unmanaged execution JSONL retained',{run_id:record.state.run_id,path});continue;
      }
      requireValue(this.worker,'HISTORY_WORKER_REQUIRED','Session hashing requires its owned isolated worker');
      const intent=await this.worker.call('sessionIntent',{root,receipt:r,options:{run_id:record.state.run_id,privateSession}});
      if(intent)files.set(path,intent);
    }
    return [...files.values()];
  }
  async cleanSessions(files=[]) {
    requireValue(this.worker,'HISTORY_WORKER_REQUIRED','Session deletion requires its owned isolated worker');
    return this.worker.call('cleanSessions',{files,legacyRoot:this.service.host.agentDir?join(this.service.host.agentDir,'sessions'):null});
  }
  async cleanAuthoring(summary,rows) {
    requireValue(this.worker,'HISTORY_WORKER_REQUIRED','Authoring retirement requires its owned isolated worker');
    return this.worker.call('cleanAuthoring',{summary,rows});
  }
  async sweep(options={}) {
    if(this.pending && !options.completed_now)return this.pending;
    const prior=this.pending;
    // Each prior caller still receives its own error. A manual cleanup is a new
    // request and must not inherit an automatic sweep's different time policy.
    const operation=(prior?prior.then(()=>undefined,()=>undefined):Promise.resolve()).then(()=>this.maintenance.run(async worker=>{this.worker=worker;try{return await this.execute(options);}finally{this.worker=null;}}));
    this.pending=operation;try{return await operation;}finally{if(this.pending===operation)this.pending=null;}
  }
  schedule({automatic=true,...options}={}) {
    if(this.closed)return;
    if(!automatic)return this.sweep(options);
    this.maintenance.schedule(async worker=>{this.worker=worker;try{return await this.execute(options);}finally{this.worker=null;}});
  }
  status() { return this.maintenance.status(); }
  close() { this.closed=true;this.worker?.cancel();return this.releaseMaintenance(); }
  async ensureWriter(root) {
    const writer=new WorkflowStore(root),owner=await writer.inspectWriter();if(!owner)return true;
    // Orphan claims remain inspectable. Automatic cleanup never takes over
    // an interrupted journal writer; explicit exact recovery owns that policy.
    return false;
  }
  observe(id) { return this.worker ? this.worker.call('observe',{id}) : this.service.runtime.runs.observe(id); }
  list() { return this.worker ? this.worker.call('list') : this.service.runtime.runs.list(); }
  async finishTrim(id,summary) {
    requireValue(this.worker,'HISTORY_WORKER_REQUIRED','Filesystem retirement requires its owned isolated worker');
    if(await pendingRunAdmission(this.service.runtime.runs.directory(id)))return {bytes:0,protected:true};
    const result=await this.worker.call('cleanupRun',{id,summary,legacyRoot:this.service.host.agentDir?join(this.service.host.agentDir,'sessions'):null});
    requireValue(result&&typeof result.protected==='boolean'&&Number.isSafeInteger(result.bytes)&&result.bytes>=0,'RUN_CLEANUP_RESULT','Worker cleanup must report exact bytes and admission protection');return result;
  }
  async execute(options) {
    const s=this.service, deleted=[],protectedRuns=[]; let bytes=0;
    let rows=await this.list();
    // Recover an interrupted trim from its committed terminal summary.
    for(const id of await this.worker.call('runEntries')) {
      const summary=await s.runtime.runs.retained(id);
      if(!summary)continue;
      if(s.active.has(id)){protectedRuns.push({run_id:id,reason:'active_owner'});continue;}
      const resumedOwner=await s.detachedOwners.read(id);
      if(resumedOwner&&(resumedOwner.termination?.confirmed!==true||(await s.detachedOwners.pendingNotifications(id)).length)){protectedRuns.push({run_id:id,reason:'owner_or_notification_pending'});continue;}
      const root=s.runtime.runs.directory(id);
      if(!await this.ensureWriter(root)){protectedRuns.push({run_id:id,reason:'active_writer'});continue;}
      if(await pendingRunAdmission(root)){protectedRuns.push({run_id:id,reason:'pending_admission'});continue;}
      if(!summary.cleanup_complete){const trimmed=await this.finishTrim(id,summary);if(trimmed.protected){protectedRuns.push({run_id:id,reason:'pending_admission'});continue;}bytes+=trimmed.bytes;}
      bytes+=await this.cleanAuthoring(summary,rows);
      const owner=await s.detachedOwners.read(id);
      if(owner && !owner.retired_at) {
        requireValue(owner.termination?.confirmed===true && !(await s.detachedOwners.pendingNotifications(id)).length,'RUN_CLEANUP_OWNER','Retired owner must remain quiescent and notified');
        const paths=s.detachedOwners.paths(id);await writeDurableJSON(paths.status,{...owner,outcome:{status:summary.state.status},retired_at:summary.cleaned_at});
        bytes+=await this.worker.call('trim',{root:paths.directory,keep:[paths.status]});
      }
    }
    // Parent summaries must be committed before removing dependent child journals.
    rows=await this.list();const references=new Map(); const ordered=[]; const visit=id=>{if(ordered.includes(id))return;const row=rows.find(r=>r.run_id===id);if(row)ordered.push(id);};
    for(const row of rows){const r=await this.observe(row.run_id);if(r.state.parent?.run_id)visit(r.state.parent.run_id);visit(row.run_id);
      for(const n of Object.values(r.state.nodes))for(const a of n.attempts)for(const receipt of ownedSessions(a.dispatch?.receipt))if(receipt.session_file){const path=resolve(receipt.session_file);const ids=references.get(path)??new Set();ids.add(row.run_id);references.set(path,ids);}}
    for(const id of ordered) {
      const record=await this.observe(id), reason=await this.reason(record,options);
      if(reason){protectedRuns.push({run_id:id,reason});continue;}
      const root=s.runtime.runs.directory(id);
      if(!await this.ensureWriter(root)){protectedRuns.push({run_id:id,reason:'active_writer'});continue;}
      if(await pendingRunAdmission(root)){protectedRuns.push({run_id:id,reason:'pending_admission'});continue;}
      const bridge=s.parentBridges.get(id);if(bridge){await bridge.close();s.parentBridges.delete(id);}
      let protectedAtAdmission=false;
      await s.runtime.runs.withRunWriter(id,async()=>{
        if(await pendingRunAdmission(root)){protectedAtAdmission=true;return;}
        const current=await s.runtime.runs.read(id);
        requireValue(current.sequence===record.sequence && !await this.reason(current,options),'RUN_CLEANUP_CHANGED','Run changed during cleanup');
        const execution_files=await this.sessionFiles(current,references);
        const state=compactRun(current), summary={schema_version:1,execution_files,cleanup_complete:false,cleaned_at:new Date().toISOString(),sequence:current.sequence,
          workflow_name:current.pins.root.workflow.name,pins_identity:{pins_hash:current.state.pins_hash,root_revision_hash:current.pins.root.revision_hash,...(current.pins.root.provenance?{root_provenance:current.pins.root.provenance}:{})},state};
        // Commit the small durable result first. Interrupted deletion is resumable,
        // and cannot be confused with RUN_NOT_FOUND or authorize replay.
        requireValue(!this.worker.cancelled,'HISTORY_CANCELLED','History maintenance cancelled before terminal preparation');
        await writeDurableJSON(join(root,'retained.json'),summary);
        // Release the foreground journal transaction after durable preparation.
        // The worker reacquires the exact Run writer and verifies this summary.

      });
      if(protectedAtAdmission){protectedRuns.push({run_id:id,reason:'pending_admission'});continue;}
      const trimmed=await this.finishTrim(id,await s.runtime.runs.retained(id));if(trimmed.protected){protectedRuns.push({run_id:id,reason:'pending_admission'});continue;}bytes+=trimmed.bytes;
      const owner=await s.detachedOwners.read(id);
      if(owner){const paths=s.detachedOwners.paths(id);await writeDurableJSON(paths.status,{...owner,
        outcome:{status:record.state.status},retired_at:new Date().toISOString()});bytes+=await this.worker.call('trim',{root:paths.directory,keep:[paths.status]});}
      deleted.push({run_id:id,status:record.state.status});
      for(const ids of references.values())ids.delete(id);
      rows=rows.filter(row=>row.run_id!==id);bytes+=await this.cleanAuthoring(await s.runtime.runs.retained(id),rows);
    }
    await s.roleRetention.execute(this.worker);
    const result={deleted,protected:protectedRuns,bytes,at:new Date().toISOString()};
    if(deleted.length || bytes>0){await writeDurableJSON(join(s.directory,'run-cleanup-latest.json'),result);console.info('[pi-CAW] run retention',result);}
    return result;
  }
}
