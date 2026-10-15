import test from 'node:test';
import assert from 'node:assert/strict';
import { CurrentChatMain } from '../lib/current-chat-main.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../core/workflow-revisions.mjs';

function setup(request = {}, contextOverrides = {}) {
  const entries = [], messages = [];
  const context = { cwd: request.workspace ?? process.cwd(), model: { provider: 'pi-bound', id: 'current' }, thinkingLevel: 'high',
    sessionManager: { getSessionId: () => 'existing-pi-chat', getSessionFile: () => 'existing.jsonl', getEntries: () => entries, getBranch: () => entries },
    abort: () => queueMicrotask(() => bridge.end()), ...contextOverrides };
  const bridge = new CurrentChatMain({ getContext: () => context, deliver: message => messages.push(message) });
  const task = bridge.createTask({ run_id: 'run', node_id: 'main', workspace: process.cwd(), access: 'read_only', allowed_paths: [], resources: [], ...request });
  const run = () => task.run({ prompt: 'Main task', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const activate = async () => { while (!messages.length) await new Promise(resolve => setImmediate(resolve)); entries.push({ id: 'user', type: 'message', message: { role: 'user', content: messages[0] } }); bridge.begin(messages[0]); };
  return { bridge, task, run, activate, entries, context, messages };
}

test('current Main uses its declared Run workspace without changing its chat cwd or write scope', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-caw-main-workspace-'));
  t.after(() => rm(workspace, { recursive: true, maxRetries: 3 }));
  const chatCwd = process.cwd();
  const f = setup({ workspace, main_mode: 'orchestration', access: 'bounded_write', allowed_paths: ['result.txt'], native_tools: ['write'] }, { cwd: chatCwd });
  const completion = f.run(); await f.activate();
  assert.equal(f.bridge.packet().workspace, workspace);
  assert(f.messages[0].includes(JSON.stringify(workspace)));
  assert.equal(f.context.cwd, chatCwd);
  f.context.sessionManager.getSessionId = () => 'foreign-chat';
  assert.match((await f.bridge.guard({ toolName: 'write', input: { path: 'result.txt' } })).reason, /PI_MAIN_NOT_ACTIVE/);
  f.context.sessionManager.getSessionId = () => 'existing-pi-chat';
  const event = { toolName: 'write', input: { path: 'result.txt' } };
  assert.equal(await f.bridge.guard(event), undefined);
  assert.equal(event.input.path, join(workspace, 'result.txt'));
  assert.equal((await f.bridge.guard({ toolName: 'write', input: { path: 'outside.txt' } })).block, true);
  await f.bridge.submit({ result: { text: 'done' }, summary: 'finished' }, 'call');
  f.entries.push({ id: 'call-entry', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'caw', id: 'call' }] } },
    { id: 'result-entry', type: 'message', message: { role: 'toolResult', toolCallId: 'call', isError: false } },
    { id: 'final-turn', type: 'message', message: { role: 'assistant', content: [], stopReason: 'stop' } });
  await f.bridge.end();
  assert.equal((await completion).session_id, 'existing-pi-chat');
  await f.task.close();
});

async function activateMessage(f,index){while(f.messages.length<=index)await new Promise(resolve=>setImmediate(resolve));f.entries.push({id:`user-${index}`,type:'message',message:{role:'user',content:f.messages[index]}});f.bridge.begin(f.messages[index]);}
function stopped(f,id){f.entries.push({id,type:'message',message:{role:'assistant',content:[],stopReason:'stop'}});}
async function submitObserved(f,index,value={text:'done'}){const call=`call-${index}`;await f.bridge.submit({summary:'Semantic result',result:value},call);f.entries.push({id:`tool-${index}`,type:'message',message:{role:'assistant',content:[{type:'toolCall',name:'caw',id:call}]}},{id:`receipt-${index}`,type:'message',message:{role:'toolResult',toolCallId:call,isError:false}});stopped(f,`stop-${index}`);}

test('current Main repairs a completed protocol failure in the same pending completion using exact call syntax',async()=>{
  const corrections=[],f=setup({onSemanticCorrection:async value=>corrections.push(value)}),completion=f.run();let settled=false;completion.finally(()=>{settled=true;});await f.activate();
  assert.match(f.messages[0],/"action":"main_result"/);assert.match(f.bridge.packet().submission_protocol,/"args":\{"summary"/);
  await assert.rejects(f.bridge.submit({output:{text:'already produced'},summary:'First attempt'},'failed'),error=>error.code.startsWith('PI_RESULT_'));
  stopped(f,'rejected-stop');await f.bridge.end();assert.equal(settled,false);assert.equal(corrections.length,1);assert.equal(corrections[0].turn_id,'rejected-stop');assert.match(corrections[0].reason,/result|Submit/);assert.notEqual(f.messages[1].split('\n')[0],f.messages[0].split('\n')[0]);assert(!f.messages[1].includes('Required semantic result schema'));assert(!f.messages[1].includes('Main task'));
  await activateMessage(f,1);await submitObserved(f,1);await f.bridge.end();assert.equal((await completion).turn_id,'stop-1');assert.equal(f.bridge.pending.active,false);await f.task.close();
});

test('current Main semantic budget exhaustion preserves the last exact submission error and ends once',async()=>{
  let callbacks=0;const f=setup({onSemanticCorrection:async()=>{callbacks++;throw Object.assign(new Error('Pinned worker budget exhausted'),{code:'RETRY_LIMIT'});}}),completion=f.run();const rejected=assert.rejects(completion,error=>error.message.includes('Exact submission validation reason')&&error.code==='RETRY_LIMIT');await f.activate();
  f.bridge.pending.request.validateResult=async()=>{throw Object.assign(new Error('Exact submission validation reason'),{code:'DATA_INVALID'});};await assert.rejects(f.bridge.submit({summary:'semantic',result:{text:'bad'}},'failed'));stopped(f,'rejected-stop');await f.bridge.end();await rejected;assert.equal(callbacks,1);assert.equal(f.messages.length,1);assert.throws(f.run,{code:'PI_MAIN_DISPATCH'});await f.task.close();
});

test('current Main supports two serial runs while keeping its owner until close and blocks no inactive ordinary tools',async()=>{
  const f=setup(),first=f.run();await f.activate();await submitObserved(f,1);await f.bridge.end();assert.equal((await first).turn_id,'stop-1');assert.equal(f.bridge.pending.identity.session_id,'existing-pi-chat');assert.equal(await f.bridge.guard({toolName:'bash',input:{}}),undefined);
  let acquired=false;const waiting=f.bridge.createTask({run_id:'next',node_id:'main',workspace:process.cwd(),access:'read_only',allowed_paths:[],resources:[]}).then(task=>{acquired=true;return task;});await new Promise(resolve=>setImmediate(resolve));assert.equal(acquired,false);
  const second=f.run();await activateMessage(f,1);assert.notEqual(f.messages[0].split('\n')[0],f.messages[1].split('\n')[0]);await submitObserved(f,2,{text:'second'});await f.bridge.end();assert.equal((await second).result.text,'second');assert.equal(acquired,false);await f.task.close();await f.task.close();const next=await waiting;assert.equal(f.bridge.pending.request.run_id,'next');await f.task.close();assert.equal(f.bridge.pending.request.run_id,'next');await next.close();
});

test('current Main cancellation during semantic correction cannot dispatch another turn or release a waiting owner early',async()=>{
  let finishCorrection,enteredCorrection;const entered=new Promise(resolve=>{enteredCorrection=resolve;});const f=setup({onSemanticCorrection:async()=>{enteredCorrection();await new Promise(resolve=>{finishCorrection=resolve;});}}),completion=f.run(),rejected=assert.rejects(completion,{code:'PI_TASK_ABORTED'});await f.activate();stopped(f,'missing-stop');const ending=f.bridge.end();await entered;await f.task.abort();finishCorrection();await ending;await rejected;assert.equal(f.messages.length,1);assert(f.bridge.pending);await f.task.close();assert.equal(f.bridge.pending,null);
});

test('current Main missing submissions receive a bounded protocol turn and staged bodies survive correction boundaries',async()=>{
  const corrections=[],f=setup({onSemanticCorrection:async issue=>corrections.push(issue)}),completion=f.run();await f.activate();stopped(f,'missing-stop');await f.bridge.end();await activateMessage(f,1);
  assert.equal(corrections[0].code,'PI_MAIN_RESULT_MISSING');assert.equal(f.bridge.pending.staged,null);
  await assert.rejects(f.bridge.submit({summary:'Staged',result:{text:7}},'stage'),{code:'PI_RESULT_STAGED'});const stage=f.bridge.pending.staged;stopped(f,'staged-stop');await f.bridge.end();assert.equal(f.bridge.pending.staged,stage);assert(f.messages[2].includes(stage.id));assert(!f.messages[2].includes('Required semantic result schema'));
  await activateMessage(f,2);const call='patched';await f.bridge.submit({summary:'Patched',stage_id:stage.id,patch:[{op:'set',path:'/text',value:'fixed'}]},call);
  f.entries.push({id:'patched-call',type:'message',message:{role:'assistant',content:[{type:'toolCall',name:'caw',id:call}]}},{id:'patched-result',type:'message',message:{role:'toolResult',toolCallId:call,isError:false}});stopped(f,'patched-stop');await f.bridge.end();assert.equal((await completion).result.text,'fixed');assert.equal(corrections.length,2);await f.task.close();
});

test('current Main preserves mechanical staged validation causes without a semantic retry',async()=>{
  let corrections=0;const f=setup({onSemanticCorrection:async()=>{corrections++;},validateResult:async()=>{throw Object.assign(new Error('Exact lease changed during validation'),{code:'STALE_LEASE'});}}),completion=f.run(),rejected=assert.rejects(completion,{code:'STALE_LEASE'});await f.activate();
  await assert.rejects(f.bridge.submit({summary:'Not admitted',result:{text:'valid shape'}},'failed'));stopped(f,'mechanical-stop');await f.bridge.end();await rejected;assert.equal(corrections,0);assert.equal(f.messages.length,1);await f.task.close();
});

test('current Main denied scope with no submission stays a mechanical failure',async()=>{
  let corrections=0;const f=setup({onSemanticCorrection:async()=>{corrections++;}}),completion=f.run(),rejected=assert.rejects(completion,{code:'PI_MAIN_TOOL_SCOPE'});await f.activate();assert.equal((await f.bridge.guard({toolName:'bash',input:{}})).block,true);stopped(f,'blocked-stop');await f.bridge.end();await rejected;assert.equal(corrections,0);await f.task.close();
});

for(const missing of [false,true])test(`current Main retains ${missing?'an actual missing pinned file':'pinned resource byte drift'} after a valid observed submission`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'pi-caw-main-pin-fault-'));t.after(()=>rm(root,{recursive:true,maxRetries:3}));const object_path=join(root,'pin.txt'),original='Exact pinned source';await writeFile(object_path,original);
  let corrections=0;const f=setup({resources:[{path:'source.txt',object_path,sha256:digest(original)}],onSemanticCorrection:async()=>{corrections++;}}),completion=f.run();let failure;const rejected=assert.rejects(completion,error=>error===failure);await f.activate();
  if(missing)await rm(object_path);else await writeFile(object_path,'Unexpected replacement');
  await assert.rejects(f.bridge.readResource({path:'source.txt'}),error=>{failure=error;return error.code===(missing?'ENOENT':'PI_RESOURCE_DRIFT');});
  await submitObserved(f,7);await f.bridge.end();await rejected;assert.equal(corrections,0);assert.equal(f.messages.length,1);await f.task.close();
});

test('safe pinned resource declaration, range and size refusals allow a later valid observed submission',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pi-caw-main-pin-args-'));t.after(()=>rm(root,{recursive:true,maxRetries:3}));const object_path=join(root,'pin.txt'),text='Exact source line\n'.repeat(3000);await writeFile(object_path,text);
  let corrections=0;const f=setup({resources:[{path:'source.txt',object_path,sha256:digest(text)}],onSemanticCorrection:async()=>{corrections++;}}),completion=f.run();await f.activate();
  for(const [params,code]of [[{path:'undeclared.txt'},'PI_RESOURCE_NOT_DECLARED'],[{path:'source.txt',start_line:0,end_line:1},'PI_RESOURCE_RANGE'],[{path:'source.txt'},'PI_RESOURCE_SIZE']])await assert.rejects(f.bridge.readResource(params),{code});
  assert.equal((await f.bridge.readResource({path:'source.txt',start_line:1,end_line:1})).content,'Exact source line');await submitObserved(f,8);await f.bridge.end();assert.equal((await completion).result.text,'done');assert.equal(corrections,0);await f.task.close();
});
test('Main remains in the current Pi chat and observes its actual model; no model binding or SDK session', async () => {
  const f = setup(), completion = f.run();
  f.context.model.id = 'changed-in-chat'; await f.activate();
  assert.equal(f.task.session_id, 'existing-pi-chat');
  assert.equal(f.bridge.packet().node_id, 'main');
  await f.bridge.submit({ result: { text: 'done' }, summary: 'finished' }, 'call');
  f.entries.push({ id: 'call-entry', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'caw', id: 'call' }] } },
    { id: 'result-entry', type: 'message', message: { role: 'toolResult', toolCallId: 'call', isError: false } },
    { id: 'final-turn', type: 'message', message: { role: 'assistant', content: [], stopReason: 'stop' } });
  await f.bridge.end(); const output = await completion;
  assert.equal(output.turn_id, 'final-turn'); assert.equal(output.user_entry_id, 'user');
  assert.equal(output.evidence.model.model_id, 'changed-in-chat'); await f.task.close();
});

test('orchestration uses native Pi tools and coordinates helpers before verifying actual writes', async t => {
  const workspace=await mkdtemp(join(tmpdir(),'pi-caw-orchestration-'));t.after(()=>rm(workspace,{recursive:true,maxRetries:3}));
  const operations=[],f=setup({workspace,main_mode:'orchestration',access:'bounded_write',allowed_paths:['result.txt'],native_tools:['bash','subagent','read','write','codemode'],onOperation:async entry=>operations.push(entry)});
  const completion=f.run();await f.activate();
  for(const toolName of ['bash','subagent','codemode']) assert.equal(await f.bridge.guard({toolName,input:{}}),undefined);
  assert.equal(await f.bridge.guard({toolName:'caw',input:{action:'launch_role',args:{}}}),undefined);
  assert.equal((await f.bridge.guard({toolName:'caw',input:{action:'run',args:{}}})).block,true,'Coordination cannot recursively launch an unrelated Run');
  let releaseHelper;f.bridge.pending.helperCompletions=[new Promise(resolve=>{releaseHelper=resolve;})];
  await f.bridge.submit({result:{text:'done'},summary:'finished'},'call');
  f.entries.push({id:'call-entry',type:'message',message:{role:'assistant',content:[{type:'toolCall',name:'caw',id:'call'}]}},{id:'result-entry',type:'message',message:{role:'toolResult',toolCallId:'call',isError:false}},{id:'final-turn',type:'message',message:{role:'assistant',content:[],stopReason:'stop'}});
  let finished=false;const end=f.bridge.end().then(()=>{finished=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  await writeFile(join(workspace,'result.txt'),'Actual helper deliverable');releaseHelper();await end;
  assert.deepEqual((await completion).changed_paths,['result.txt']);
  const audit=operations.find(item=>item.tool==='orchestration_workspace_audit');assert(audit);assert.equal(audit.entries,1);
  const prompt=operations.find(item=>item.tool==='model'&&item.phase==='prompt_prepared');assert(prompt);assert.equal(prompt.bytes,Buffer.byteLength(f.messages[0]));await f.task.close();
});

test('current Main keeps native MCP discovery and dynamically exposed tools within declared server scope', async () => {
  const f = setup({ required_mcp_servers: ['selected'], native_mcp_servers: ['selected'], native_mcp_namespaces: ['mcp__selected'], native_mcp_tools: [] });
  const completion = f.run(); await f.activate();
  assert.equal(await f.bridge.guard({ toolName: 'mcp__selected__new_tool', input: {} }), undefined);
  assert.equal(await f.bridge.guard({ toolName: 'codemode', input: {} }), undefined);
  assert.equal(await f.bridge.guard({ toolName: 'tool_search', input: {} }), undefined);
  assert.equal((await f.bridge.guard({ toolName: 'mcp__unselected__tool', input: {} })).block, true);
  assert.equal(await f.bridge.guard({ toolName: 'read_mcp_resource', input: { server: 'selected' } }), undefined);
  assert.equal((await f.bridge.guard({ toolName: 'list_mcp_resources', input: {} })).block, true);
  assert.equal(await f.bridge.guard({ toolName: 'caw', input: { action: 'run_snapshot', args: { run_id: 'run' } } }), undefined);
  for (const action of ['run_snapshot', 'pause', 'cancel']) {
    assert.match((await f.bridge.guard({ toolName: 'caw', input: { action, args: { run_id: 'unrelated-run' } } })).reason, /PI_MAIN_RUN_SCOPE/);
  }
  const rejected = assert.rejects(completion, { code: 'PI_TASK_ABORTED' }); await f.task.abort(); await rejected; await f.task.close();
});
test('Main cannot complete with an invented submission or failed tool result', async () => {
  const f = setup(), completion = f.run(); const rejected = assert.rejects(completion, { code: 'PI_MAIN_RESULT_MISSING' }); await f.activate();
  await f.bridge.submit({ result: { text: 'done' }, summary: 'finished' }, 'invented');
  f.entries.push({ id: 'assistant', type: 'message', message: { role: 'assistant', content: [], stopReason: 'stop' } });
  await f.bridge.end(); await rejected; await f.task.close();
});

test('revoked controller lease blocks current-chat tools before any native effect', async () => {
  let authorized = true;
  const f = setup({ authorize: async () => {
    if (!authorized) throw Object.assign(new Error('Exact controller changed'), { code: 'LEASE_REVOKED' });
  } });
  const completion = f.run(); await f.activate();
  assert.equal(await f.bridge.guard({ toolName: 'read', input: {} }), undefined);
  authorized = false;
  const blocked = await f.bridge.guard({ toolName: 'read', input: {} });
  assert.equal(blocked.block, true); assert.match(blocked.reason, /LEASE_REVOKED/);
  const rejected = assert.rejects(completion, { code: 'PI_TASK_ABORTED' });
  await f.task.abort(); await rejected; await f.task.close();
});
test('Main scope blocks shell and write effects, and queued cancelled Main cannot execute tools', async () => {
  const f = setup(), completion = f.run(); await f.activate();
  assert.equal((await f.bridge.guard({ toolName: 'bash', input: {} })).block, true);
  assert.match((await f.bridge.guard({ toolName: 'write', input: { path: 'a.txt' } })).reason, /PI_READ_ONLY/);
  const rejected = assert.rejects(completion, { code: 'PI_TASK_ABORTED' }); await f.task.abort(); await rejected; await f.task.close();
  const queued = setup(), promise = queued.run(), aborted = assert.rejects(promise, { code: 'PI_TASK_ABORTED' });
  while (!queued.messages.length) await new Promise(resolve => setImmediate(resolve));
  await queued.task.abort(); await aborted;
  assert.match(queued.bridge.begin(queued.messages[0]), /cancelled/);
  assert.equal((await queued.bridge.guard({ toolName: 'read', input: {} })).terminate, true);
  await queued.bridge.end(); await queued.task.close();
});

test('Main ownership recognizes only dispatched prompts and actor-bound queued cancellations, before either extension hook order', async () => {
  const f = setup(), actor = 'existing-pi-chat';
  assert.equal(f.bridge.ownsPrompt('PI_CAW_MAIN invented\n', actor), false);
  assert.equal(f.bridge.ownsPrompt(`PI_CAW_MAIN ${f.bridge.pending.dispatch_id}\n`, actor), false, 'Task allocation alone is not dispatch authority');
  const completion = f.run(), rejected = assert.rejects(completion, { code: 'PI_TASK_ABORTED' });
  while (!f.messages.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.bridge.ownsPrompt(f.messages[0], actor), true);
  assert.equal(f.bridge.ownsPrompt(f.messages[0], 'another-chat'), false);
  await f.task.abort(); await rejected;
  assert.equal(f.bridge.pending.identity.session_id, actor, 'Cancelled task retains its chat owner until close');
  assert.equal(f.bridge.ownsPrompt(f.messages[0], actor), true, 'Canceled queued dispatch remains owned before begin consumes its marker');
  f.context.sessionManager.getSessionId = () => 'another-chat'; f.bridge.sessionChanged();
  assert.equal(f.bridge.ownsPrompt(f.messages[0], 'another-chat'), false);
  assert.equal(f.bridge.begin(f.messages[0]), undefined, 'A canceled marker cannot bind another conversation');
  assert.equal(await f.bridge.guard({ toolName: 'read', input: {} }), undefined);
  f.context.sessionManager.getSessionId = () => actor; f.bridge.sessionChanged();
  assert.match(f.bridge.begin(f.messages[0]), /cancelled/);
  assert.equal(f.bridge.blockCancelledActor, actor);
  assert.equal(f.bridge.ownsPrompt(undefined, actor), true, 'Cancellation stays owned after begin consumed its marker');
  assert.equal(f.bridge.ownsPrompt(undefined, 'another-chat'), false);
  await f.bridge.end();
  assert.equal(f.bridge.ownsPrompt(f.messages[0], actor), false);
  await f.task.close();
});
