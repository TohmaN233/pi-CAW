import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,workflow,settle} from './fixtures.mjs';
import {runFeedback,feedbackText} from '../lib/run-feedback.mjs';
import {WorkflowStore} from '../core/workflow-store.mjs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

async function finished(t) {
 const f=await fixture(t);await f.service.call('create_workflow',{workflow:workflow()});
 const r=await f.service.call('run',{workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'test'}});
 await settle(f.service,r.run_id);const record=await f.service.runtime.runs.read(r.run_id),a=record.state.nodes.final.attempts.at(-1);
 await f.service.call('accept_final',{run_id:r.run_id,accepted:true,proposal_sha256:a.result_proposal.sha256},{human:true});await settle(f.service,r.run_id);
 return {...f,id:r.run_id};
}
test('completed retention defaults to 24h; manual cleanup keeps exact result and blocks replay',async t=>{
 const f=await finished(t),s=f.service,root=s.runtime.runs.directory(f.id);
 assert.equal((await s.retention.policy()).completed_hours,24);
 assert.equal((await s.retention.sweep()).deleted.length,0);
 const before=await s.call('get',{run_id:f.id});const output=join(root,'delivered.tex');await writeFile(output,'formal source');
 await s.runtime.runs.mutate(f.id,'recover',state=>{state.nodes.final.output={source:{path:output,sha256:'a'.repeat(64)}};});
 const result=await s.call('cleanup_run_history',{completed_now:true},{human:true});
 assert.equal(result.deleted.length,1);assert.ok(result.bytes>0);
 assert.deepEqual(await readdir(root),['delivered.tex','retained.json']);assert.equal(await readFile(output,'utf8'),'formal source');
 const after=await s.call('get',{run_id:f.id});assert.equal(after.main_actor,before.main_actor);assert.equal(after.status,'succeeded');assert.equal(after.process_cleaned,true);
 assert.equal((await s.call('runs')).length,0);await assert.rejects(s.call('continue',{run_id:f.id}),{code:'RUN_RETIRED'});
 assert.equal((await s.retention.sweep({completed_now:true})).deleted.length,0);
});
test('interrupted and awaiting-human runs are protected; failed with uncertain shutdown cannot be removed',async t=>{
 const f=await fixture(t);await f.service.call('create_workflow',{workflow:workflow()});
 const r=await f.service.call('run',{workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'test'}});await settle(f.service,r.run_id);
 const first=await f.service.retention.sweep({completed_now:true});assert.equal(first.deleted.length,0);
 await f.service.runtime.runs.mutate(r.run_id,'recover',s=>{s.status='interrupted';});
 assert.equal((await f.service.retention.sweep({completed_now:true})).protected[0].reason,'unfinished_or_interrupted');
 await f.service.runtime.runs.mutate(r.run_id,'fail',s=>{s.status='failed';s.nodes.work.attempts[0].executor_events=[];});
 assert.equal((await f.service.retention.sweep({completed_now:true})).protected[0].reason,'unconfirmed_effect_shutdown');
});
test('confirmed failures clean immediately; terminal summary recovers an interrupted trim',async t=>{
 const f=await finished(t),s=f.service;await s.runtime.runs.mutate(f.id,'fail',state=>{state.status='failed';});
 const r=await s.retention.sweep();assert.equal(r.deleted.length,1);
 const root=s.runtime.runs.directory(f.id),path=join(root,'retained.json'),summary=JSON.parse(await readFile(path,'utf8'));
 summary.cleanup_complete=false;await writeFile(path,JSON.stringify(summary));await mkdir(join(root,'objects'));await writeFile(join(root,'objects','leftover'),'large duplicated context');
 await s.retention.sweep();assert.deepEqual(await readdir(root),['retained.json']);assert.equal(JSON.parse(await readFile(path,'utf8')).cleanup_complete,true);
});
test('feedback has readable status and artifact links, no prompt or context dump; progress deduplicates',async t=>{
 const f=await finished(t),events=[];f.host.emit=(name,event)=>events.push({name,event});
 const r=await f.service.runtime.runs.read(f.id);r.state.nodes.final.output={taskId:'task',kind:'deck',succeeded:true,files:[{path:join(f.workspace,'lesson.tex'),sha256:'a'.repeat(64)}]};
 const feedback=runFeedback(r),text=feedbackText(feedback);assert.match(text,/已完成/);assert.match(text,/lesson.tex/);assert.equal(JSON.stringify(feedback).includes('prompt_template'),false);
 await f.service.publishProgress();await f.service.publishProgress();assert.equal(events.length,1);
});
test('owned SDK cleanup verifies physical thread rather than logical actor and keeps the parent chat',async t=>{
 const f=await finished(t),s=f.service;f.host.agentDir=join(f.root,'agent');const dir=join(f.host.agentDir,'sessions');await mkdir(dir,{recursive:true});
 const file=join(dir,'child.jsonl'),parent=join(dir,'parent.jsonl');await writeFile(file,JSON.stringify({type:'session',id:'physical-child'})+'\n');await writeFile(parent,'parent chat');
 await s.runtime.runs.mutate(f.id,'recover',state=>{const r=state.nodes.work.attempts[0].dispatch.receipt;Object.assign(r,{session_file:file,thread_id:'physical-child',session_id:'logical-parent'});});
 const result=await s.retention.sweep({completed_now:true});assert.equal(result.deleted.length,1);assert.equal(await readFile(parent,'utf8'),'parent chat');await assert.rejects(readFile(file),{code:'ENOENT'});
});
test('a terminal cleanup recovers only an absent writer; orphan failed authoring jobs clean without touching installed workflows',async t=>{
 const f=await finished(t),s=f.service;await s.runtime.runs.mutate(f.id,'fail',state=>{state.status='failed';});
 const child=spawn(process.execPath,['-e',''],{windowsHide:true});await new Promise((done,reject)=>{child.on('error',reject);child.on('exit',done);});
 await writeFile(join(s.runtime.runs.directory(f.id),'.writer.lock'),JSON.stringify({pid:child.pid,token:randomUUID(),created_at:new Date().toISOString()}));
 const jobs=await new WorkflowStore(join(s.directory,'authoring-jobs'),{validationContext:s.runtime.context}).initialize();
 await jobs.create(workflow(),{provenance:{kind:'authoring_workflow_run'}});
 const result=await s.retention.sweep();assert.equal(result.deleted.length,1);
 await assert.rejects(jobs.snapshot('example'),{code:'ENOENT'});assert.equal((await s.store.snapshot('example')).workflow.id,'example');
});
test('manual immediate cleanup queues after an automatic sweep and keeps its own policy',async t=>{
 const f=await finished(t),retention=f.service.retention,original=retention.execute.bind(retention);let release;
 const gate=new Promise(done=>{release=done;});let first=true;
 retention.execute=async options=>{if(first){first=false;await gate;}return original(options);};
 const automatic=retention.sweep(),manual=retention.sweep({completed_now:true});release();
 assert.equal((await automatic).deleted.length,0);assert.equal((await manual).deleted.length,1);
});
