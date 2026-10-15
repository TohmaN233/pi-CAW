import test from 'node:test';
import assert from 'node:assert/strict';
import { PiCawService } from '../lib/service.mjs';
test('unconfirmed history shutdown preserves its error while still closing owned execution',async()=>{
  let hostClosed=false,bridgeClosed=false,observerSettled=false;
  const service=new PiCawService({directory:process.cwd(),host:{close:async()=>{hostClosed=true;}}});
  const failure=Object.assign(new Error('Retain exact history worker claim'),{code:'HISTORY_STOP_PENDING'});
  service.retention.close=async()=>{throw failure;};
  service.parentBridges.set('owned',{close:async()=>{bridgeClosed=true;}});
  service.progressPending=Promise.resolve().then(()=>{observerSettled=true;});
  await assert.rejects(service.close(),error=>error instanceof AggregateError&&error.errors.includes(failure));
  assert(hostClosed);assert(bridgeClosed);assert(observerSettled);assert(service.closing);
});
