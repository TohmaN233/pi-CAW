import test from 'node:test';
import assert from 'node:assert/strict';
import { admissionFailureDetails } from '../core/admission-diagnostics.mjs';
import { createOwnerRpcServer, ownerRpc } from '../lib/detached-owner.mjs';
import { fixture, workflow, settle } from './fixtures.mjs';
import { compactRun } from '../lib/run-retention.mjs';

function failure() {
  return Object.assign(new Error('Admission did not finish'), {code:'RUN_STORE_ADMISSION_TIMEOUT',phase:'process_wait',lock_path:'C:/fixture/.writer.lock',owner_pid:1234,waited_ms:5000,token:'private-token-must-not-escape',args:{secret:'private-task'}});
}

test('admission causes retain bounded ownership evidence without tokens or arbitrary error fields', () => {
  const cause=failure(), result=admissionFailureDetails(new AggregateError([cause,cause,new Error('unrelated')],'Workers failed'));
  assert.deepEqual(result,{admission_failures:[{code:cause.code,phase:cause.phase,lock_path:cause.lock_path,owner_pid:1234,waited_ms:5000}]});
  assert(!JSON.stringify(result).includes('private-'));
});

test('private RPC preserves admission evidence and application error classification', async t => {
  const cause=failure(),server=await createOwnerRpcServer({run_id:'fixture',handle:async()=>{throw cause;}});t.after(()=>server.close());
  await assert.rejects(ownerRpc(server.descriptor,'inspect'),error=>{
    assert.equal(error.rpc_application_error,true);assert.deepEqual(admissionFailureDetails(error),admissionFailureDetails(cause));return true;
  });
});

test('failed worker admission evidence survives node persistence and terminal compaction', async t => {
  const cause=failure(),f=await fixture(t,{resultFor:()=>{throw new AggregateError([cause],'Workers failed');}});
  await f.service.call('create_workflow',{workflow:workflow()});
  const run=await f.service.call('run',{workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'Fixture failure'}});
  const snapshot=await settle(f.service,run.run_id);
  assert.deepEqual(snapshot.state.nodes.work.error.admission_failures,admissionFailureDetails(cause).admission_failures);
  const compact=compactRun(await f.service.runtime.runs.read(run.run_id));
  assert.deepEqual(compact.nodes.work.error.admission_failures,admissionFailureDetails(cause).admission_failures);
});
