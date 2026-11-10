import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import * as ai from '@earendil-works/pi-ai/compat';
import { PiSdkHost } from '../lib/pi-sdk-host.mjs';
import { resolveBinding } from '../lib/models.mjs';

const sdkEntryDirectory = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const legacyMcpEntries = ['extensions/mcp/config.js', 'core/mcp-servers.js', 'extensions/mcp/oauth.js', 'core/auth-storage.js']
  .map(path => join(sdkEntryDirectory, path));
const runtimeBinding = ['loadMcpConfig', 'validateMcpServerConfig', 'mcpNamespace', 'McpOAuthCredentialStore', 'FileAuthStorageBackend']
  .every(name => typeof sdk[name] === 'function') ? {} : { mcp_entries: legacyMcpEntries };

const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const submit = (result = { text: 'Done' }) => ai.fauxToolCall('caw_submit_result', { result, summary: 'Done' });
const toolTurn = (...calls) => ai.fauxAssistantMessage(calls, { stopReason: 'toolUse' });

async function fixture(t, { enabled = true, previousDecision, missingHook = false, boundary, validateResult, resultSchema = schema } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-caw-semantic-')), cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], retry: { enabled: false } }));
  const faux = ai.fauxProvider({ provider: `semantic-${randomUUID()}`, models: [{ id: 'worker', reasoning: false }], tokensPerSecond: 0 });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
  const parent = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  const context = { cwd, sessionManager: parent, modelRegistry: new sdk.ModelRegistry(runtime), isProjectTrusted: () => false };
  let session, previousCalls = 0, boundaries = 0, requests = 0;
  const activeSdk = { ...sdk,
    DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
      constructor(options) { super({ ...options, extensionFactories: [...options.extensionFactories, { name: 'completion-boundary-test', factory: pi => {
        pi.on('turn_end', async () => { await Promise.resolve(); boundaries++; await boundary?.(); });
      } }] }); }
    },
    createAgentSession: async options => {
      const created = await sdk.createAgentSession(options); session = created.session;
      if (missingHook) delete session.agent.finishTurn;
      else {
        const previous = session.agent.finishTurn;
        session.agent.finishTurn = async (turn, signal) => {
          const decision = await previous?.(turn, signal);
          previousCalls++;
          assert.equal(boundaries, previousCalls, 'extension boundary completed before previous hook');
          return previousDecision?.(previousCalls) ?? decision;
        };
      }
      return created;
    },
  };
  const host = new PiSdkHost({ sdk: activeSdk, Type: ai.Type, supportedThinking: ai.getSupportedThinkingLevels, runtimeBinding, agentDir,
    getContext: () => context, endOnSemanticSubmission: enabled });
  host.modelRuntimes.set(faux.getModel().provider, runtime);
  t.after(() => host.close());
  const binding = resolveBinding({ provider: faux.getModel().provider, model_id: 'worker', thinking: 'off' }, host.catalog());
  const create = () => host.createTask({ kind: 'subagent', run_id: 'semantic-fixture', node_id: 'work', name: 'Offline completion', binding,
    workspace: cwd, access: 'read_only', resources: [], strict: true, schema: resultSchema, validateResult });
  const respond = responses => faux.setResponses(responses.map(response => async context => { requests++; return typeof response === 'function' ? await response(context) : response; }));
  return { create, respond, counts: () => ({ requests, previousCalls, boundaries }), entries: () => session.sessionManager.getEntries(),
    run: async responses => { respond(responses); return (await create()).run({ prompt: 'Submit result.', schema: resultSchema }); } };
}

for (const enabled of [true, false]) test(`real SDK semantic completion enabled=${enabled}`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { enabled });
  const result = await f.run([toolTurn(submit()), ai.fauxAssistantMessage('Submitted.')]);
  const expected = enabled ? 1 : 2;
  assert.deepEqual(f.counts(), { requests: expected, previousCalls: expected, boundaries: expected });
  assert.equal(result.completion_mode, enabled ? 'semantic-submission' : 'assistant-stop');
  assert.equal(result.evidence.assistant_stop_reason, enabled ? 'toolUse' : 'stop');
  assert.equal(result.usage.cost_micros, 0);
  const entries = f.entries();
  const assistants = entries.filter(e => e.message?.role === 'assistant');
  assert.equal(result.usage.input_tokens, assistants.reduce((sum, e) => sum + (e.message.usage?.input ?? 0), 0));
  assert.equal(result.usage.output_tokens, assistants.reduce((sum, e) => sum + (e.message.usage?.output ?? 0), 0));
  assert.equal(entries.find(e => e.id === result.turn_id).message.stopReason, enabled ? 'toolUse' : 'stop');
  if (enabled) assert.equal(entries.find(e => e.id === result.evidence.submit_tool_result_entry_id).message.toolCallId, result.evidence.submit_tool_call_id);
});

test('staged result continues and validated patch ends naturally', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const result = await f.run([toolTurn(submit({ text: 4 })), context => {
    const text = JSON.stringify(context), stage = text.match(/PI_RESULT_STAGED ([a-f0-9-]+)/)?.[1];
    assert.ok(stage);
    return toolTurn(ai.fauxToolCall('caw_submit_result', { summary: 'Done', stage_id: stage, patch: [{ op: 'set', path: '/text', value: 'Fixed' }] }));
  }]);
  assert.equal(f.counts().requests, 2); assert.deepEqual(result.result, { text: 'Fixed' }); assert.equal(result.completion_mode, 'semantic-submission');
});

test('staged patch traverses nested arrays using Host diagnostic paths', { timeout: 30000 }, async t => {
  const resultSchema = {
    type: 'object',
    properties: {
      decision: {
        type: 'object',
        properties: {
          drafts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                prose: { type: 'string' },
                timeUpdate: {
                  type: 'object',
                  properties: {
                    year: { type: 'integer' }, month: { type: 'integer' }, day: { type: 'integer' },
                    hour: { type: 'integer' }, minute: { type: 'integer' },
                  },
                  required: ['year', 'month', 'day', 'hour', 'minute'],
                  additionalProperties: false,
                },
                choices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { id: { type: 'string' }, text: { type: 'string' } },
                    required: ['id', 'text'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['prose', 'timeUpdate', 'choices'],
              additionalProperties: false,
            },
          },
        },
        required: ['drafts'],
        additionalProperties: false,
      },
    },
    required: ['decision'],
    additionalProperties: false,
  };
  const f = await fixture(t, { resultSchema });
  const result = await f.run([
    toolTurn(ai.fauxToolCall('caw_submit_result', {
      summary: 'Staged root-level timestamp',
      result: {
        decision: {
          drafts: [{ prose: 'A complete scene.', choices: [0, 1, 2, 3].map(index => ({
            id: `choice-${index}`, text: `Choice ${index}`, source: 'unwanted', occurrence: index,
          })) }],
          timeUpdate: { year: 1000 },
        },
      },
    })),
    context => {
      const stage = JSON.stringify(context).match(/PI_RESULT_STAGED ([a-f0-9-]+)/)?.[1];
      assert.ok(stage);
      return toolTurn(ai.fauxToolCall('caw_submit_result', {
        summary: 'Move the valid timestamp into its draft',
        stage_id: stage,
        patch: [
          { op: 'set', path: '$/decision/drafts/0/timeUpdate', value: { year: 1000, month: 1, day: 2, hour: 3, minute: 4 } },
          { op: 'remove', path: '$/decision/timeUpdate' },
          ...[0, 1, 2, 3].flatMap(index => [
            { op: 'remove', path: `$/decision/drafts/0/choices/${index}/source` },
            { op: 'remove', path: `$/decision/drafts/0/choices/${index}/occurrence` },
          ]),
        ],
      }));
    },
  ]);
  assert.equal(f.counts().requests, 2);
  assert.deepEqual(result.result, {
    decision: {
      drafts: [{
        prose: 'A complete scene.',
        timeUpdate: { year: 1000, month: 1, day: 2, hour: 3, minute: 4 },
        choices: [0, 1, 2, 3].map(index => ({ id: `choice-${index}`, text: `Choice ${index}` })),
      }],
    },
  });
  assert.equal(result.completion_mode, 'semantic-submission');
});

test('misplaced nested metadata reports current paths and accepts a semantics-preserving corrected body', { timeout: 30000 }, async t => {
  const actor = (actorId, localRef, displayName) => ({
    ...(actorId ? { actorId } : {}), localRef, displayName, aliases: [], present: true, channel: 'dialogue', quote: `${displayName}在场。`,
  });
  const actors = [
    actor('@actor:0', 'protagonist', 'Lina'),
    actor('@actor:1', 'scribe', 'Mira'),
    actor('@actor:2', 'merchant', 'Oren'),
    actor(undefined, 'guard', 'Guard'),
    actor(undefined, 'porter', 'Porter'),
  ];
  const initial = {
    decision: {
      drafts: [{
        prose: 'Lina records the sealed parcel and asks Mira to witness the handoff.',
        choices: [{ id: 'choice-1', text: 'Ask the scribe to confirm the seal.' }],
        turnSummary: 'The parcel remains sealed.',
        timeUpdate: { year: 1042, month: 4, day: 2, hour: 9, minute: 15 },
      }],
      sceneActors: actors,
    },
  };
  const resultSchema = {
    type: 'object', required: ['decision'], additionalProperties: false,
    properties: { decision: {
      type: 'object', required: ['drafts'], additionalProperties: false,
      properties: { drafts: { type: 'array', items: {
        type: 'object', required: ['prose', 'choices', 'turnSummary', 'timeUpdate', 'sceneActors'], additionalProperties: false,
        properties: {
          prose: { type: 'string' },
          choices: { type: 'array', items: { type: 'object', required: ['id', 'text'], additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' } } } },
          turnSummary: { type: 'string' },
          timeUpdate: { type: 'object', required: ['year', 'month', 'day', 'hour', 'minute'], additionalProperties: false,
            properties: { year: { type: 'integer' }, month: { type: 'integer' }, day: { type: 'integer' }, hour: { type: 'integer' }, minute: { type: 'integer' } } },
          sceneActors: { type: 'array', items: { type: 'object', required: ['localRef', 'displayName', 'aliases', 'present', 'channel', 'quote'],
            additionalProperties: false, properties: { actorId: { type: 'string' }, localRef: { type: 'string' }, displayName: { type: 'string' },
              aliases: { type: 'array', items: { type: 'string' } }, present: { type: 'boolean' }, channel: { type: 'string' }, quote: { type: 'string' } } } },
        },
      } } },
    } },
  };
  const corrected = { decision: { drafts: [{ ...initial.decision.drafts[0], sceneActors: structuredClone(actors) }] } };
  const f = await fixture(t, { resultSchema });
  const result = await f.run([
    toolTurn(ai.fauxToolCall('caw_submit_result', { summary: 'Initial draft', result: initial })),
    context => {
      const serialized = JSON.stringify(context);
      assert.match(serialized, /Current staged JSON paths/u);
      assert.match(serialized, /required property is missing: sceneActors/u);
      assert.match(serialized, /\/decision\/drafts\/0\/prose/u);
      assert.match(serialized, /\/decision\/sceneActors\/4\/localRef/u);
      assert.match(serialized, /Submit either a corrected complete result or a patch/u);
      assert.doesNotMatch(serialized, /Do not resend the body/u);
      const stage = serialized.match(/PI_RESULT_STAGED ([a-f0-9-]+)/)?.[1];
      assert.ok(stage);
      return toolTurn(ai.fauxToolCall('caw_submit_result', {
        summary: 'Remove misplaced parent field', stage_id: stage, patch: [{ op: 'remove', path: '/decision/sceneActors' }],
      }));
    },
    context => {
      const serialized = JSON.stringify(context);
      const currentStage = serialized.slice(serialized.lastIndexOf('PI_RESULT_STAGED'));
      assert.match(currentStage, /Current staged JSON paths/u);
      assert.match(currentStage, /required property is missing: sceneActors/u);
      assert.match(currentStage, /\/decision\/drafts\/0\/prose/u);
      assert.doesNotMatch(currentStage, /\/decision\/sceneActors\/0/u);
      assert.match(currentStage, /Submit either a corrected complete result or a patch/u);
      return toolTurn(ai.fauxToolCall('caw_submit_result', { summary: 'Corrected draft', result: corrected }));
    },
  ]);
  assert.equal(f.counts().requests, 3);
  assert.equal(result.completion_mode, 'semantic-submission');
  assert.deepEqual(result.result, corrected);
  assert.equal(result.result.decision.drafts[0].prose, initial.decision.drafts[0].prose);
  assert.deepEqual(result.result.decision.drafts[0].sceneActors, actors);
  assert.equal(Object.hasOwn(result.result.decision, 'sceneActors'), false);
});

test('a normal text stop continues only while a schema-format result is staged', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const corrected = { text: 'Recovered result' };
  const result = await f.run([
    toolTurn(submit({ text: 4 })),
    ai.fauxAssistantMessage('I will correct the staged result.', { stopReason: 'stop' }),
    toolTurn(submit(corrected)),
  ]);
  assert.equal(f.counts().requests, 3);
  assert.deepEqual(result.result, corrected);
  assert.equal(result.completion_mode, 'semantic-submission');
});

test('staged semantic validation errors do not trigger a format continuation', { timeout: 30000 }, async t => {
  const f = await fixture(t, { validateResult: () => { throw new Error('Business meaning needs review'); } });
  await assert.rejects(f.run([
    toolTurn(submit()),
    ai.fauxAssistantMessage('The staged result needs review.', { stopReason: 'stop' }),
    toolTurn(submit()),
  ]));
  assert.equal(f.counts().requests, 2);
});

test('a staged format continuation preserves provider errors and cancellation', { timeout: 30000 }, async t => {
  const failed = await fixture(t);
  await assert.rejects(failed.run([
    toolTurn(submit({ text: 4 })),
    ai.fauxAssistantMessage('Provider failed.', { stopReason: 'error', errorMessage: 'Offline provider failure' }),
    toolTurn(submit({ text: 'must not dispatch' })),
  ]));
  assert.equal(failed.counts().requests, 2);

  const controller = new AbortController();
  let boundaries = 0;
  const cancelled = await fixture(t, { boundary: () => { if (++boundaries === 2) controller.abort(); } });
  cancelled.respond([
    toolTurn(submit({ text: 4 })),
    ai.fauxAssistantMessage('I will correct the staged result.', { stopReason: 'stop' }),
    toolTurn(submit({ text: 'must not dispatch' })),
  ]);
  const task = await cancelled.create();
  await assert.rejects(task.run({ prompt: 'Submit result.', schema, signal: controller.signal }));
  assert.equal(cancelled.counts().requests, 2);
});

test('failed submission does not end', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([toolTurn(ai.fauxToolCall('caw_submit_result', { summary: 'Missing' })), ai.fauxAssistantMessage('Cannot submit.')]), { code: 'PI_RESULT_MISSING' });
  assert.equal(f.counts().requests, 2);
});

test('Host validation failure stays staged until the validator accepts repair', { timeout: 30000 }, async t => {
  const f = await fixture(t, { validateResult: result => { if (result.text !== 'Validated') throw new Error('Host requires validated text'); } });
  const result = await f.run([toolTurn(submit()), context => {
    const stage = JSON.stringify(context).match(/PI_RESULT_STAGED ([a-f0-9-]+)/)?.[1];
    assert.ok(stage);
    return toolTurn(ai.fauxToolCall('caw_submit_result', { summary: 'Done', stage_id: stage, patch: [{ op: 'set', path: '/text', value: 'Validated' }] }));
  }]);
  assert.equal(f.counts().requests, 2); assert.equal(result.result.text, 'Validated');
  assert.equal(result.completion_mode, 'semantic-submission');
});

test('sibling tool failure prevents semantic completion', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const result = await f.run([toolTurn(submit(), ai.fauxToolCall('caw_read_resource', { path: 'undeclared' })), ai.fauxAssistantMessage('Finished with failed read.')]);
  assert.equal(f.counts().requests, 2); assert.equal(result.completion_mode, 'assistant-stop');
});

test('truncated tool arguments never produce semantic completion', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([ai.fauxAssistantMessage([submit()], { stopReason: 'length' }), ai.fauxAssistantMessage('No result.')]), { code: 'PI_RESULT_MISSING' });
  assert.equal(f.counts().requests, 2);
});

test('prior explicit continuation is preserved', { timeout: 30000 }, async t => {
  const f = await fixture(t, { previousDecision: count => count === 1 ? { action: 'continue' } : undefined });
  const result = await f.run([toolTurn(submit()), ai.fauxAssistantMessage('Boundary requested this.')]);
  assert.equal(f.counts().requests, 2); assert.equal(result.completion_mode, 'assistant-stop');
});

test('actual cancellation during awaited boundary is not successful completion', { timeout: 30000 }, async t => {
  const controller = new AbortController();
  const f = await fixture(t, { boundary: () => controller.abort() });
  f.respond([toolTurn(submit()), ai.fauxAssistantMessage('Must not run.')]);
  const task = await f.create();
  await assert.rejects(task.run({ prompt: 'Submit result.', schema, signal: controller.signal }), { code: 'PI_TASK_ABORTED' });
  assert.equal(f.counts().requests, 1);
});

test('opt-in without public hook fails before dispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t, { missingHook: true });
  await assert.rejects(f.create(), { code: 'PI_FINISH_TURN_UNSUPPORTED' });
  assert.equal(f.counts().requests, 0);
});
