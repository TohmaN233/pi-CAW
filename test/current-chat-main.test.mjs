import test from 'node:test';
import assert from 'node:assert/strict';
import { CurrentChatMain } from '../lib/current-chat-main.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(request = {}) {
  const entries = [], messages = [];
  const context = { cwd: request.workspace ?? process.cwd(), model: { provider: 'pi-bound', id: 'current' }, thinkingLevel: 'high',
    sessionManager: { getSessionId: () => 'existing-pi-chat', getSessionFile: () => 'existing.jsonl', getEntries: () => entries, getBranch: () => entries },
    abort: () => queueMicrotask(() => bridge.end()) };
  const bridge = new CurrentChatMain({ getContext: () => context, deliver: message => messages.push(message) });
  const task = bridge.createTask({ run_id: 'run', node_id: 'main', workspace: process.cwd(), access: 'read_only', allowed_paths: [], resources: [], ...request });
  const run = () => task.run({ prompt: 'Main task', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const activate = async () => { while (!messages.length) await new Promise(resolve => setImmediate(resolve)); entries.push({ id: 'user', type: 'message', message: { role: 'user', content: messages[0] } }); bridge.begin(messages[0]); };
  return { bridge, task, run, activate, entries, context, messages };
}
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
  assert.deepEqual((await completion).changed_paths,['result.txt']);assert.equal(operations[0].tool,'orchestration_workspace_audit');assert.equal(operations[0].entries,1);await f.task.close();
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
  assert.equal(f.bridge.pending, null);
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
