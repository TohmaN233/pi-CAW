import { join } from 'node:path';
import { writeDurableJSON } from '../../core/workflow-events.mjs';

// A genuine detached process publishes a settled driver failure, then remains
// available for the registry's explicit stop and quiescence acknowledgment.
export async function createOwnerRuntime(context) {
  const started_at=new Date().toISOString(),outcome={run_id:context.run_id,status:'attention',error:context.boot.error};
  await writeDurableJSON(join(context.boot.run_directory,'pi-worker.json'),{...outcome,process_id:process.pid,
    session_id:context.main_actor,started_at,settled_at:new Date().toISOString()});
  await context.report(outcome);
  return {completion:Promise.resolve(outcome),call:async()=>{throw new Error('Stopped authoring fixture has no execution commands');},stop:async()=>({quiescent:true})};
}
