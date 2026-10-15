import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopedTaskBroker } from '../lib/task-broker.mjs';

async function fixture(t) {
  const workspace=await mkdtemp(join(tmpdir(),'pi-task-effects-')), events=[], mutations=new Map();
  await mkdir(join(workspace,'out'));
  const broker=await scopedTaskBroker({workspace,access:'bounded_write',allowed_paths:['out'],resources:[],
    runtime_environment:{status:'ready',tools:[{name:'node',path:process.execPath,status:'found'}]},
    onOperation:async event=>events.push(event)},mutations,async()=>{});
  t.after(async()=>{try{await broker.close();}catch(error){if(error.code!=='PI_PROGRAM_SCOPE')throw error;}await rm(workspace,{recursive:true,maxRetries:3});});
  return {broker,events,mutations};
}
const value=result=>JSON.parse(result.content[0].text);
test('asynchronous task program observes effects once at settlement and fences premature completion',async t=>{
  const {broker,events,mutations}=await fixture(t);
  let result=value(await broker.execute('run_workspace_program',{program:'node',args:['-e',"setTimeout(()=>require('node:fs').writeFileSync('out/page.html','<html>real</html>'),150)"],yield_time_ms:0},'start'));
  assert.equal(result.status,'running');assert.throws(()=>broker.assertScope(),{code:'PI_PROGRAM_ACTIVE'});
  while(result.has_more)result=value(await broker.execute('continue_workspace_command',{session_id:result.session_id,yield_time_ms:1000},'wait'));
  assert.equal(result.exit_code,0);broker.assertScope();
  assert(mutations.has('out/page.html'));
  const effects=events.filter(event=>event.phase==='effects');assert.equal(effects.length,1);
  assert.deepEqual(effects[0].changed_paths,['out/page.html']);assert(effects[0].process_id);
});
test('asynchronous program outside-scope write remains terminal after process completion',async t=>{
  const {broker,events}=await fixture(t);
  await assert.rejects(broker.execute('run_workspace_program',{program:'node',args:['-e',"require('node:fs').writeFileSync('outside.txt','changed')"]},'outside'),{code:'PI_PROGRAM_SCOPE'});
  assert.throws(()=>broker.assertScope(),{code:'PI_PROGRAM_SCOPE'});
  assert.equal(events.filter(event=>event.phase==='effects').length,1);
});
test('legacy blocking programs retain one effect observation including nonzero exits',async t=>{
  const {broker,events,mutations}=await fixture(t);
  const result=value(await broker.execute('run_task_program',{program:'node',args:['-e',"require('node:fs').writeFileSync('out/partial.txt','partial');process.exitCode=7"],cwd:'workspace'},'legacy'));
  assert.equal(result.exit_code,7);assert(mutations.has('out/partial.txt'));
  assert.equal(events.filter(event=>event.phase==='effects').length,1);broker.assertScope();
});
