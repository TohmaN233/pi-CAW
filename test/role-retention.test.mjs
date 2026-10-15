import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, binding } from './fixtures.mjs';
import { executionSessionRoot, executionSessionDirectory } from '../lib/execution-sessions.mjs';
import { digest } from '../core/workflow-revisions.mjs';

async function roleFixture(t,{failRun=false,failClose=false}={}) {
  const f=await fixture(t),s=f.service;
  s.workbench.roleProfile=async()=>({id:'review',name:'Review',status:'ready',enabled:true,provider_available:true,
    binding,access:'read_only',revision_hash:'a'.repeat(64),instructions:'Review the declared task.'});
  f.host.tasks=new Map();
  f.host.createTask=async request=>{
    const id=randomUUID(),directory=executionSessionDirectory(executionSessionRoot(s.directory),request.run_id);
    await mkdir(directory,{recursive:true});const file=join(directory,`${id}.jsonl`);
    await writeFile(file,[{type:'session',id},{type:'custom',customType:'pi-caw:task',data:{run_id:request.run_id,node_id:request.node_id,kind:'subagent'}}].map(JSON.stringify).join('\n')+'\n');
    const task={session_id:id,session_file:file,session_storage:'private',async run(){
      if(failRun)throw new Error('Fixture model failed');return {result:{result:'Reviewed'},session_id:id};
    },async close(){assert.ok(await readFile(file));if(failClose)throw new Error('Fixture effect owner remains open');}};
    f.host.tasks.set(id,task);return task;
  };
  f.host.releaseTask=async task=>{await task.close();f.host.tasks.delete(task.session_id);};
  return f;
}

test('successful Role saves result and closes owner before retiring its private transcript',async t=>{
  const f=await roleFixture(t),s=f.service,notify=s.notify;
  s.notify=async event=>{if(event.role_run_id){
    const journal=JSON.parse(await readFile(join(s.directory,'role-runs',`${event.role_run_id}.json`),'utf8'));
    assert.equal(journal.closed,true);assert.equal(journal.result.result.result,'Reviewed');assert.ok(await readFile(journal.session_file));
  }return notify(event);};
  const launch=await s.launchRole({role_id:'review',task:'Inspect',workspace:f.workspace});
  await Promise.all(s.roleTasks.values());
  await assert.rejects(readFile(launch.session_file),{code:'ENOENT'});
  const saved=JSON.parse(await readFile(join(s.directory,'role-runs',`${launch.role_run_id}.json`),'utf8'));
  assert.equal(saved.cleanup_complete,true);assert.equal(saved.result.result.result,'Reviewed');
  assert.deepEqual(await readdir(executionSessionRoot(s.directory)),[]);
});
for(const failure of ['run','close'])test(`Role ${failure} failure keeps original evidence`,async t=>{
  const f=await roleFixture(t,{failRun:failure==='run',failClose:failure==='close'}),s=f.service;
  const launch=await s.launchRole({role_id:'review',task:'Inspect',workspace:f.workspace});
  await Promise.allSettled(s.roleTasks.values());await s.roleRetention.sweep();
  assert.ok(await readFile(launch.session_file));
  const saved=JSON.parse(await readFile(join(s.directory,'role-runs',`${launch.role_run_id}.json`),'utf8'));
  assert.equal(saved.status,'failed');assert.equal(saved.closed,failure!=='close');assert.equal(saved.cleanup_complete,undefined);
});

test('Role cleanup recovers durable intent, rejects changed bytes and never touches a parent chat',async t=>{
  const f=await fixture(t),s=f.service,id=`role-${randomUUID()}`,session=randomUUID();
  const root=executionSessionDirectory(executionSessionRoot(s.directory),id),directory=join(s.directory,'role-runs');
  await mkdir(root,{recursive:true});await mkdir(directory,{recursive:true});
  const file=join(root,'task.jsonl'),bytes=Buffer.from(JSON.stringify({type:'session',id:session})+'\n');await writeFile(file,bytes);
  const path=join(directory,`${id}.json`),journal={id,status:'completed',closed:true,session_id:session,session_file:file,session_storage:'private',
    result:{result:{result:'Saved'}},cleanup_intent:{files:[{path:file,sha256:digest(bytes),bytes:bytes.length}]}};
  await writeFile(path,JSON.stringify(journal));await writeFile(file,Buffer.concat([bytes,Buffer.from('changed')]));
  await assert.rejects(s.roleRetention.sweep(),{code:'RUN_SESSION_CHANGED'});assert.ok(await readFile(file));
  await writeFile(file,bytes);await s.roleRetention.sweep();assert.equal(JSON.parse(await readFile(path,'utf8')).cleanup_complete,true);
  await writeFile(path,JSON.stringify(journal));await s.roleRetention.sweep(); // crash after deletion, before completion
  assert.equal(JSON.parse(await readFile(path,'utf8')).cleanup_complete,true);
  await writeFile(f.host.mainIdentity().session_file,'parent');
  const escaped={...journal,cleanup_intent:{files:[{path:f.host.mainIdentity().session_file,sha256:digest(Buffer.from('parent'))}]}};
  await writeFile(path,JSON.stringify(escaped));await assert.rejects(s.roleRetention.sweep(),{code:'PATH_ESCAPE'});
  assert.equal(await readFile(f.host.mainIdentity().session_file,'utf8'),'parent');
});

test('new Role cleanup queues behind an earlier scan rather than missing its new result',async t=>{
  const f=await fixture(t),retention=f.service.roleRetention,execute=retention.execute.bind(retention);let release,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});retention.execute=async()=>{if(++calls===1)await gate;return execute();};
  const earlier=retention.sweep(),later=retention.sweep();release();await Promise.all([earlier,later]);assert.equal(calls,2);
});

test('confirmed successful Role retires exact material sidecars and rejects content drift',async t=>{
  const f=await fixture(t),s=f.service,id=`role-${randomUUID()}`,session=randomUUID(),directory=join(s.directory,'role-runs');
  const root=executionSessionDirectory(executionSessionRoot(s.directory),id),materials=join(directory,`${id}.materials`);
  await mkdir(root,{recursive:true});await mkdir(materials,{recursive:true});
  const file=join(root,'task.jsonl'),data=Buffer.from([{type:'session',id:session},{type:'custom',customType:'pi-caw:task',data:{run_id:id,kind:'subagent'}}].map(JSON.stringify).join('\n')+'\n');await writeFile(file,data);
  const spool=join(materials,'raw.stdout');await writeFile(spool,'sealed command output');
  const journal={id,status:'completed',closed:true,session_id:session,session_file:file,session_storage:'private',execution_materials_root:materials,result:{result:{result:'Saved'}}};
  const path=join(directory,`${id}.json`);await writeFile(path,JSON.stringify(journal));
  // A failed cleanup may be repaired explicitly, but never silently delete
  // material bytes that differ from the already committed original intent.
  const worker=s.roleRetention.execute.bind(s.roleRetention);let changed=false;
  s.roleRetention.execute=async current=>{
    const call=current.call.bind(current);current.call=async(operation,args)=>{const result=await call(operation,args);if(operation==='roleMaterialIntent'&&!changed){changed=true;await writeFile(spool,'unexpected successor content');}return result;};return worker(current);
  };
  await assert.rejects(s.roleRetention.sweep(),{code:'HISTORY_MATERIAL_CHANGED'});assert.ok(await readFile(file));assert.equal(await readFile(spool,'utf8'),'unexpected successor content');
  const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.cleanup_intent.materials.files[0].sha256,digest(Buffer.from('sealed command output')));assert.equal(saved.cleanup_complete,undefined);
  await writeFile(spool,'sealed command output');s.roleRetention.execute=worker;await s.roleRetention.sweep();
  await assert.rejects(readFile(spool),{code:'ENOENT'});assert.equal(JSON.parse(await readFile(path,'utf8')).cleanup_complete,true);
});

test('service close preserves a successful Role settling during shutdown for later maintenance',async t=>{
  const f=await roleFixture(t),s=f.service,create=f.host.createTask.bind(f.host);let release,started;
  const hold=new Promise(resolve=>{release=resolve;}),running=new Promise(resolve=>{started=resolve;});
  f.host.createTask=async request=>{const task=await create(request),run=task.run.bind(task);task.run=async()=>{started();await hold;return run();};return task;};
  const launch=await s.launchRole({role_id:'review',task:'Settle during shutdown',workspace:f.workspace});await running;
  const closing=s.close();assert.equal(s.closing,true);release();await closing;
  const saved=JSON.parse(await readFile(join(s.directory,'role-runs',`${launch.role_run_id}.json`),'utf8'));
  assert.equal(saved.status,'completed');assert.equal(saved.closed,true);assert.equal(saved.result.result.result,'Reviewed');
  assert.equal(saved.cleanup_complete,undefined);assert.equal(s.lastRoleError,undefined);assert.equal(s.roleTasks.size,0);assert.equal(f.host.tasks.size,0);
  assert.ok(await readFile(launch.session_file));assert.ok(saved.execution_materials_root);
});
