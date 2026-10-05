import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeDurableJSON } from '../core/workflow-events.mjs';
import { noSymlinks, requireValue } from '../core/workflow-paths.mjs';
import { executionSessionRoot, executionSessionDirectory, sessionCleanupIntent, deleteSessionIntent, removeEmptySessionDirectory } from './execution-sessions.mjs';

// Keep failures and uncertain owners. Only a durably saved successful result
// and confirmed task shutdown authorize deleting a private Role transcript.
export class RoleRetention {
  constructor(service) { this.service=service; this.pending=null; }
  async sweep() {
    // A new completed Role must get a scan after any already-running scan.
    const prior=this.pending;
    const operation=(prior?prior.then(()=>undefined,()=>undefined):Promise.resolve()).then(()=>this.execute());this.pending=operation;
    try{return await operation;}finally{if(this.pending===operation)this.pending=null;}
  }
  async execute() {
    const s=this.service,directory=join(s.directory,'role-runs'),root=executionSessionRoot(s.directory),deleted=[];
    let entries;
    try{await noSymlinks(directory);entries=await readdir(directory);}
    catch(error){if(error.code==='ENOENT')return deleted;throw error;}
    for(const name of entries){
      if(!/^role-[a-f0-9-]+\.json$/.test(name))continue;
      const path=join(directory,name);await noSymlinks(path);
      let journal=JSON.parse(await readFile(path,'utf8'));
      if(journal.status!=='completed' || journal.closed!==true || journal.session_storage!=='private' || journal.cleanup_complete===true)continue;
      requireValue(name===`${journal.id}.json` && journal.result, 'ROLE_CLEANUP_IDENTITY', 'Role result journal differs from its exact identity');
      if(s.host.tasks?.has(journal.session_id))continue;
      const ownedRoot=executionSessionDirectory(root,journal.id);
      if(!journal.cleanup_intent){
        const file=await sessionCleanupIntent(ownedRoot,{session_file:journal.session_file,thread_id:journal.session_id},{run_id:journal.id,privateSession:true});
        journal={...journal,cleanup_intent:{files:file?[file]:[]}};
        await writeDurableJSON(path,journal);
      }
      let bytes=0;
      for(const file of journal.cleanup_intent.files){bytes+=await deleteSessionIntent(ownedRoot,file);await removeEmptySessionDirectory(root,file.path);}
      await writeDurableJSON(path,{...journal,cleanup_complete:true,cleaned_at:new Date().toISOString()});
      const evidence={role_run_id:journal.id,session_id:journal.session_id,bytes};deleted.push(evidence);
      console.info('[pi-CAW] Role execution session retired',evidence);
    }
    return deleted;
  }
}
