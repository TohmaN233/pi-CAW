import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDraft } from '../core/workflow-schema.mjs';
import { PiCawService } from '../lib/service.mjs';
import { digest, canonicalJSON } from '../core/workflow-revisions.mjs';
export const binding = { provider: 'fixture', model_id: 'worker', thinking: 'off' };
export const catalog = [{ ...binding, name: 'Fixture worker', thinking_levels: ['off'], fingerprint: 'a'.repeat(64) }];
export const settings = { schema_version: 1, providers: [{ id: 'worker', name: 'Worker', enabled: true, binding }], roles: [], routing: {} };
export function agent(id, executor = { kind: 'provider', provider_id: 'worker' }) {
  return { id, type: 'agent', executor, role: executor.kind === 'main' ? 'finalizer' : 'advisor', access: 'read_only',
    prompt_template: 'Read the declared task input and produce a concise result.', approval: { required: false }, retry: { max_attempts: 3 },
    input_bindings: { task: '/inputs/task' }, outputs_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
}
export function workflow(workers = [agent('work')]) {
  const graph = { ...createDraft('example', 'Pi fixture'), status: 'ready', inputs_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    outputs_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    skill_policy: { mode: 'cooperative', implicit: 'allow', ambient_allow: [], shadowed_skill_paths: [] }, finalization: { required: true, node_id: 'final' } };
  graph.nodes = [{ id: 'start', type: 'start' }, ...workers, agent('final', { kind: 'main' }), { id: 'end', type: 'end' }];
  graph.edges = graph.nodes.slice(0, -1).map((node, index) => ({ id: `edge-${index}`, source: node.id, target: graph.nodes[index + 1].id }));
  return graph;
}
export async function fixture(t, { resultFor = () => ({ text: 'done' }), models = catalog } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-test-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const requests = [], mainRequests = [], notifications = [], mainSession = randomUUID();
  const host = { capabilities: { strict_resources: true, isolated_main: true, host_tools: [] }, catalog: () => models,
    getContext: () => ({cwd:workspace}),
    mainIdentity: () => ({ session_id: mainSession, session_file: join(root, 'parent.jsonl') }),
    async createMainTask(request) { mainRequests.push(request); const isolated=request.context_mode==='isolated'; const id=isolated?randomUUID():mainSession; return Object.assign(await this.createTask({ ...request, session_id:id, session_file:join(root,id+'.jsonl') }), isolated?{main_actor:mainSession,context_mode:'isolated',observed_model:binding}:{}); },
    async createTask(request) {
      if (request.kind !== 'main') requests.push(request); const id = request.session_id ?? randomUUID();
      return { session_id: id, session_file: request.session_file ?? join(root, `${id}.jsonl`),
        async run(input) {
          const result = await resultFor(request, input);
          const turn_id = randomUUID();
          return { result, summary: 'Fixture completed', session_id: id, turn_id, result_sha256: digest(canonicalJSON(result)), changed_paths: [],
            evidence: { kind: 'pi_session', thread_id: id, turn_id, observed: 'completed' } };
        }, abort: async () => {}, close: async () => {},
      };
    }, releaseTask: async task => task.close(), close: async () => {},
  };
  const service = await new PiCawService({ directory: join(root, 'state'), host, notify: event => notifications.push(event) }).initialize();
  const initial = await service.call('settings');
  await service.call('save_settings', { settings: structuredClone(settings), expected_revision: initial.revision }, { human: true });
  await service.refreshContext();
  t.after(async () => { await service.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe fixture cleanup'); await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 }); });
  return { root, workspace, service, host, requests, mainRequests, notifications, mainSession };
}
export async function settle(service, runId) { const owner = service.active.get(runId); if (owner) await owner.completion; return service.call('run_snapshot', { run_id: runId }); }
