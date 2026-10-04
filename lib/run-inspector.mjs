import { open } from 'node:fs/promises';
import { noSymlinks, requireValue } from '../core/workflow-paths.mjs';
import { runFeedback } from './run-feedback.mjs';

const WINDOW_BYTES = 1024 * 1024;
const PAGE_MESSAGES = 40;
const excerpt = value => {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text === undefined ? null : { text: text.slice(0, 64000), truncated: text.length > 64000 };
};

/** Read only the exact receipt-bound native session. No caller-supplied path. */
export async function readExecutionSession(receipt, { run_id, node_id, before } = {}) {
  requireValue(typeof receipt.session_file === 'string' && typeof receipt.thread_id === 'string',
    'INSPECT_SESSION_RECEIPT', 'Execution has no exact native session receipt');
  await noSymlinks(receipt.session_file);
  const file = await open(receipt.session_file, 'r');
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.nlink === 1, 'INSPECT_SESSION_FILE', 'Execution session must be a regular unlinked file');
    const head = Buffer.alloc(Math.min(stat.size, WINDOW_BYTES));
    const headRead = await file.read(head, 0, head.length, 0);
    const headText = head.subarray(0, headRead.bytesRead).toString('utf8');
    const headLines = headText.slice(0, headText.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
    requireValue(headLines[0]?.type === 'session' && headLines[0].id === receipt.thread_id,
      'INSPECT_SESSION_IDENTITY', 'Native session identity differs from its execution receipt');
    const task = headLines.find(entry => entry.type === 'custom' && entry.customType === 'pi-caw:task')?.data;
    // Continued threads retain the original node binding, but always the same Run.
    requireValue(task?.run_id === run_id && (task.node_id === node_id || receipt.continued_thread === true),
      'INSPECT_SESSION_BINDING', 'Native session is not bound to this Run and node');
    const end = before === undefined ? stat.size : before;
    requireValue(Number.isSafeInteger(end) && end >= 0 && end <= stat.size, 'INSPECT_CURSOR', 'Invalid execution transcript cursor');
    const start = Math.max(0, end - WINDOW_BYTES), buffer = Buffer.alloc(end - start);
    const read = await file.read(buffer, 0, buffer.length, start);
    let data = buffer.subarray(0, read.bytesRead), offset = start;
    if (start) { const cut = data.indexOf(10); data = cut < 0 ? Buffer.alloc(0) : data.subarray(cut + 1); offset += cut < 0 ? read.bytesRead : cut + 1; }
    const complete = data.lastIndexOf(10), pending = complete < data.length - 1;
    if (complete < 0) return { messages: [], before: start || null, pending, prompt: null };
    const rows = [], windowStart = offset;
    for (const line of data.subarray(0, complete + 1).toString('utf8').split('\n')) {
      const position = offset; offset += Buffer.byteLength(line) + 1;
      if (!line) continue;
      const entry = JSON.parse(line);
      if (entry.type !== 'message' || !['user', 'assistant', 'toolResult', 'bashExecution'].includes(entry.message?.role)) continue;
      const message = structuredClone(entry.message);
      // Provider signatures/auth payloads are not needed for a read-only card.
      if (Array.isArray(message.content)) message.content = message.content.map(block => {
        if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking };
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'toolCall') return { type: 'toolCall', id: block.id, name: block.name, input: block.arguments ?? block.input };
        if (block.type === 'image') return { type: 'text', text: '[图片附件：在执行会话中保存]' };
        return { type: 'text', text: `[${block.type}]` };
      });
      delete message.details;
      rows.push({ position, id: entry.id, message });
    }
    const selected = rows.slice(-PAGE_MESSAGES);
    const prompt = receipt.continued_thread ? rows.findLast(entry => entry.message.role === 'user')?.message.content
      : headLines.find(entry => entry.type === 'message' && entry.message?.role === 'user')?.message.content;
    const promptText = typeof prompt === 'string' ? prompt : prompt?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return { messages: selected.map(({ id, message }) => ({ id, message })),
      before: rows.length > PAGE_MESSAGES ? selected[0].position : start ? windowStart : null,
      pending, prompt: excerpt(promptText) };
  } finally { await file.close(); }
}

/** Portable, read-only projection: no controller tokens, provider config or leases. */
export async function inspectRun(service, args) {
  requireValue(Object.keys(args).every(key => ['run_id', 'node_id', 'attempt_id', 'session_index', 'before'].includes(key)),
    'INSPECT_ARGUMENTS', 'Unknown Run inspector argument');
  await service.assertReadableRunDirectory(args.run_id);
  const retained = await service.runtime.runs.retained(args.run_id);
  const record = retained ? { state: retained.state } : await service.runtime.runs.observe(args.run_id);
  requireValue(record.state.main_actor === service.host.mainIdentity().session_id,
    'INSPECT_ACTOR', 'Run inspector requires the initiating conversation');
  if (retained) return { schema_version: 1, run_id: args.run_id, process_cleaned: true,
    workflow_name: retained.workflow_name, status: record.state.status, nodes: [],
    result: excerpt(record.state.output ?? record.state.outputs), cleaned_at: retained.cleaned_at };
  const feedback = runFeedback(record);
  const response = { ...feedback, process_cleaned: false, loops: Object.entries(record.state.loops ?? {}).map(([id, loop]) => ({ id, status: loop.status, round: loop.round })) };
  if (!args.node_id) return response;
  const node = record.state.nodes[args.node_id], definition = record.pins.root.workflow.nodes.find(item => item.id === args.node_id);
  requireValue(node && definition, 'INSPECT_NODE', 'Node does not belong to this Run');
  const attempt = args.attempt_id ? node.attempts.find(item => item.id === args.attempt_id) : node.attempts.find(item => item.id === node.active_attempt_id) ?? node.attempts.at(-1);
  requireValue(!args.attempt_id || attempt, 'INSPECT_ATTEMPT', 'Attempt does not belong to this node');
  const receipt = attempt?.dispatch?.receipt;
  const current = attempt?.id === node.active_attempt_id || attempt === node.attempts.at(-1);
  const completion = attempt?.result_proposal ? await service.runtime.runs.readExecutorResult(args.run_id, attempt.id, attempt.result_proposal.sha256) : attempt?.completion;
  const sessions = receipt?.sessions ?? (receipt?.thread_id && receipt?.session_file && receipt.executor !== 'pi-current-chat-main'
    ? [{ thread_id: receipt.thread_id, session_file: receipt.session_file }] : []);
  const sessionIndex = args.session_index ?? 0;
  requireValue(Number.isInteger(sessionIndex) && sessionIndex >= 0 && (sessions.length === 0 ? sessionIndex === 0 : sessionIndex < sessions.length),
    'INSPECT_SESSION_INDEX', 'Invalid execution session selection');
  const detail = { node_id: args.node_id, attempt_id: attempt?.id ?? null,
    attempts: node.attempts.map(item => ({ id: item.id, status: item.status, started_at: item.started_at, finished_at: item.finished_at,
      rounds: Object.entries(item.loop_rounds??{}).map(([id,loop])=>({id,round:loop.round})) })),
    session_count: sessions.length, session_index: sessionIndex,
    instruction: excerpt(definition.prompt_template), instruction_kind: 'template',
    resources: definition.resources ?? [], events: attempt?.executor_events ?? [],
    events_total: attempt?.executor_event_count ?? 0,
    host_tool: attempt?.host_tool ? { tool: attempt.host_tool.tool, phase: attempt.host_tool.phase, input_summary: attempt.host_tool.input_summary,
      status: attempt.host_tool.receipt?.status } : null,
    result: excerpt(completion?.summary ?? completion?.structured_output ?? (current ? node.output : null)), error: completion?.error ?? (current ? node.error : null),
    child_run_id: attempt?.child_run_id ?? null, transcript: null };
  if (sessions.length) {
    try {
      detail.transcript = await readExecutionSession({ ...sessions[sessionIndex], continued_thread: definition.executor?.kind === 'thread' && definition.executor.lifecycle === 'continue' },
        { run_id: args.run_id, node_id: args.node_id, before: args.before });
    } catch(error) {
      const events=(attempt.executor_events??[]).filter(event=>event.metadata?.execution_session_id===sessions[sessionIndex].thread_id);
      const firstReplyPending=['claimed','running'].includes(attempt.status) && events.some(event=>event.metadata.phase==='dispatch_started')
        && !events.some(event=>event.metadata.phase==='message_completed') && !attempt.completion;
      if(error.code!=='ENOENT'||!firstReplyPending||args.before!==undefined)throw error;
      // Pi deliberately delays creating JSONL until its first assistant ends.
      // This known native state is visible; missing completed sessions still fail.
      detail.transcript={messages:[],before:null,pending:true,prompt:null,unpersisted:true};
    }
    if (detail.transcript.prompt) { detail.instruction = detail.transcript.prompt; detail.instruction_kind = 'actual'; }
  }
  return { ...response, detail };
}
