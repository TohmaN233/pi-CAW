import { join } from 'node:path';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { noSymlinks, requireValue } from '../core/workflow-paths.mjs';
import { historyMaintenance } from './history-maintenance.mjs';
import { executionSessionRoot, executionSessionDirectory } from './execution-sessions.mjs';

// Keep failures and uncertain owners. Only a durably saved successful result
// and confirmed task shutdown authorize deleting a private Role transcript.
export class RoleRetention {
  constructor(service) { this.service=service; this.pending=null; this.maintenance=historyMaintenance(service.directory); }
  async sweep() {
    // A new completed Role must get a scan after any already-running scan.
    const prior=this.pending;
    const operation=(prior?prior.then(()=>undefined,()=>undefined):Promise.resolve()).then(()=>this.maintenance.run(async worker=>{this.worker=worker;try{return await this.execute(worker);}finally{this.worker=null;}}));this.pending=operation;
    try{return await operation;}finally{if(this.pending===operation)this.pending=null;}
  }
  async execute(worker=this.worker) {
    requireValue(worker,'HISTORY_WORKER_REQUIRED','Role filesystem retirement requires its owned worker');
    const s=this.service,directory=join(s.directory,'role-runs'),root=executionSessionRoot(s.directory),deleted=[];
    let entries;
    try{await noSymlinks(directory);entries=await worker.call('roleEntries');}
    catch(error){if(error.code==='ENOENT')return deleted;throw error;}
    for(const name of entries){
      if(!/^role-[a-f0-9-]+\.json$/.test(name))continue;
      const path=join(directory,name);await noSymlinks(path);
      let journal=await worker.call('roleRead',{name});
      if(journal.status!=='completed' || journal.closed!==true || journal.session_storage!=='private' || journal.cleanup_complete===true)continue;
      requireValue(name===`${journal.id}.json` && journal.result, 'ROLE_CLEANUP_IDENTITY', 'Role result journal differs from its exact identity');
      if(s.host.tasks?.has(journal.session_id))continue;
      const ownedRoot=executionSessionDirectory(root,journal.id);
      if(!journal.cleanup_intent){
        const receipt={session_file:journal.session_file,thread_id:journal.session_id},options={run_id:journal.id,privateSession:true};
        const file=await worker.call('sessionIntent',{root:ownedRoot,receipt,options});
        const materials=journal.execution_materials_root?await worker.call('roleMaterialIntent',{id:journal.id,root:journal.execution_materials_root}):undefined;
        journal={...journal,cleanup_intent:{files:file?[file]:[],...(materials?{materials}:{})}};
        requireValue(!worker.cancelled,'HISTORY_CANCELLED','History maintenance cancelled before Role preparation');
        await writeDurableJSON(path,journal);
      }
      const bytes=await worker.call('roleClean',{name,journal,root:ownedRoot});
      const evidence={role_run_id:journal.id,session_id:journal.session_id,bytes};deleted.push(evidence);
      console.info('[pi-CAW] Role execution session retired',evidence);
    }
    return deleted;
  }
}
