import { randomUUID } from 'node:crypto';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { requireValue } from '../core/workflow-paths.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { HostToolRunner, hostToolContractsCompatible, requireHostToolBindings, requireHostToolExecutionScope, validateHostToolContract, validateHostStorageCapabilities } from '../core/execution/host-tool-runner.mjs';
import { ownerRpc } from './detached-owner.mjs';

// Only these public qualification fields cross the private bootstrap. Registry
// closures, extra adapter state and credentials always stay in the parent.
export function externalHostToolDescriptors(registry = {}) {
  const entries = registry instanceof Map ? [...registry] : Object.entries(registry);
  return entries.map(([id, tool]) => {
    const identity = tool?.identity, a = tool?.attestation;
    requireValue(/^[a-z][a-z0-9_-]{0,127}$/.test(id) && identity
      && typeof identity.name === 'string' && identity.name.length > 0 && identity.name.length <= 256
      && typeof identity.version === 'string' && identity.version.length > 0 && identity.version.length <= 128
      && /^[a-f0-9]{64}$/.test(identity.sha256)
      && Object.keys(identity).every(key => ['name', 'version', 'sha256'].includes(key))
      && typeof tool.execute === 'function' && typeof tool.cancel === 'function'
      && a?.qualified === true && a.cancellable === true && a.effect_observation === true
      && canonicalJSON(a.tool_identity) === canonicalJSON(identity)
      && typeof a.broker_id === 'string' && a.broker_id.length > 0 && /^[a-f0-9]{64}$/.test(a.evidence_sha256),
    'PI_EXTERNAL_HOST_TOOL', 'External Host tools require exact qualified cancellable implementations');
    const contract = tool.contract === undefined ? undefined : validateHostToolContract(tool.contract);
    if (contract) requireValue(contract.id === id && canonicalJSON(contract.identity) === canonicalJSON(identity),
      'PI_EXTERNAL_HOST_PIN', 'Registered contract must have the exact tool ID and implementation identity');
    const descriptor = { id, identity: structuredClone(identity), attestation: { qualified: true, cancellable: true,
      effect_observation: true, tool_identity: structuredClone(identity), broker_id: a.broker_id, evidence_sha256: a.evidence_sha256 } };
    if (a.storage_capabilities !== undefined) descriptor.attestation.storage_capabilities = validateHostStorageCapabilities(a.storage_capabilities);
    if (contract) descriptor.contract = contract;
    requireValue(!/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie|secret)\s*[:=]|\bBearer\s+\S+/i.test(canonicalJSON(descriptor)),
      'PI_EXTERNAL_HOST_SECRET', 'External Host descriptor contains credential-shaped text');
    return descriptor;
  });
}

export function mergeHostTools(builtins, registry = {}) {
  const descriptors = externalHostToolDescriptors(registry), external = registry instanceof Map ? Object.fromEntries(registry) : registry;
  const names = new Set([...Object.keys(builtins), ...Object.values(builtins).map(tool => tool.identity?.name)]);
  for (const descriptor of descriptors) {
    requireValue(!names.has(descriptor.id) && !names.has(descriptor.identity.name),
      'PI_HOST_TOOL_COLLISION', `External Host tool ID or implementation name is registered twice: ${descriptor.id}`);
    names.add(descriptor.id); names.add(descriptor.identity.name);
  }
  return { ...builtins, ...external };
}

// The core runner still performs all standard schema, qualification, scope and
// effect checks. Add trusted context only at this integration boundary.
export function executeExternalHostTool(registry, contract, input, context, { signal, authorize } = {}) {
  const pinned = validateHostToolContract(contract), tool = registry[pinned.id] ?? registry[pinned.identity.name];
  if (tool?.contract) requireValue(hostToolContractsCompatible(pinned, tool.contract),
    'PI_EXTERNAL_HOST_PIN', 'Workflow tool interface is incompatible with the registered Host tool');
  const invoke = request => ({ ...request, contract: pinned, authorize: async () => {
    requireValue(!request.signal?.aborted, 'PI_TASK_ABORTED', 'Exact domain effect authority was revoked');
    requireValue(typeof authorize === 'function', 'PI_EXTERNAL_HOST_AUTHORITY', 'External Host execution needs an owner authorization callback');
    await authorize();
  },
    context: { ...request.context, node_permissions: structuredClone(context.permissions) } });
  const bound = { ...tool, execute: async request => { const trusted = invoke(request); await trusted.authorize();
    const result = await tool.execute(trusted); await trusted.authorize(); return result; }, cancel: request => tool.cancel(invoke(request)) };
  return new HostToolRunner({ registry: { [pinned.id]: bound } }).execute(pinned, input, context, { signal });
}

const attemptKey = context => {
  requireValue(context && ['run_id', 'node_id', 'attempt_id'].every(key => typeof context[key] === 'string' && context[key]),
    'PI_EXTERNAL_ATTEMPT', 'Domain execution requires an exact Run/node/attempt');
  return canonicalJSON([context.run_id, context.node_id, context.attempt_id]);
};
const unavailable = cause => Object.assign(new Error('The exact parent domain tool is unavailable; reconcile this attempt before replay'),
  { code: 'PI_EXTERNAL_HOST_DISCONNECTED', cause, quiescent: false });
function confirmedCancellation(result) {
  requireValue(result?.termination_confirmed === true && Array.isArray(result.evidence) && result.evidence.length > 0
    && result.evidence.length <= 32 && result.evidence.every(item => typeof item.kind === 'string' && /^[a-f0-9]{64}$/.test(item.sha256))
    && result.effects?.observed === true && Array.isArray(result.effects.changed_paths)
    && Array.isArray(result.effects.outside_paths) && Array.isArray(result.effects.artifacts),
  'PI_EXTERNAL_HOST_SHUTDOWN', 'Parent domain tool did not confirm exact termination and observed effects');
  return result;
}

export function createExternalHostToolBridge({ run_id, main_actor, authority, getHostTools }) {
  const attempts = new Map();
  const registered = args => {
    const contract = validateHostToolContract(args.contract), registry = getHostTools();
    requireHostToolBindings({ host_tools: [contract] }, registry);
    const tool = registry instanceof Map ? registry.get(args.tool_id) : registry[args.tool_id];
    const descriptor = externalHostToolDescriptors({ [args.tool_id]: tool })[0];
    if (tool.contract) requireValue(hostToolContractsCompatible(contract, tool.contract),
      'PI_EXTERNAL_HOST_PIN', 'Workflow tool interface is incompatible with the registered Host tool');
    requireValue(contract.id === args.tool_id && canonicalJSON(descriptor) === canonicalJSON(args.descriptor),
      'PI_EXTERNAL_HOST_PIN', 'Parent tool identity or qualification changed');
    requireValue(args.main_actor === main_actor && args.context.run_id === run_id
      && args.owner_descriptor?.run_id === run_id && typeof args.operation_id === 'string',
    'PI_EXTERNAL_HOST_ACTOR', 'Domain tool must retain its original actor, Run and exact owner callback');
    return { contract, tool };
  };
  const cancel = entry => entry.cancellation ??= (async () => {
    entry.controller.abort(new Error('Exact domain attempt revoked'));
    const result = await entry.tool.cancel({ context: entry.context, contract: entry.contract,
      reason: entry.controller.signal.reason, signal: entry.controller.signal });
    confirmedCancellation(result);
    // Broker termination is not enough if its execute promise still owns work.
    if (entry.execution) await Promise.allSettled([entry.execution]);
    entry.cancelled = true; entry.cancelResult = result; return result;
  })();
  return {
    async call(operation, args) {
      const { contract, tool } = registered(args), key = attemptKey(args.context);
      const signature = canonicalJSON({ descriptor: args.descriptor, contract, context: args.context,
        operation_id: args.operation_id, owner_descriptor: args.owner_descriptor });
      let entry = attempts.get(key);
      if (entry) requireValue(entry.signature === signature, 'PI_EXTERNAL_HOST_REPLAY', 'Exact attempt cannot change its tool, contract or owner');
      if (operation === 'cancel_host_tool') {
        if (!entry) { entry = { signature, contract, tool, context: args.context, controller: new AbortController() }; attempts.set(key, entry); }
        return cancel(entry);
      }
      requireValue(operation === 'execute_host_tool', 'PI_EXTERNAL_HOST_OPERATION', 'Unknown domain bridge operation');
      authority();
      const permissions = requireHostToolExecutionScope(contract, args.context.node_permissions);
      requireValue(canonicalJSON(args.permissions) === canonicalJSON(permissions) && canonicalJSON(args.argv) === canonicalJSON(contract.argv),
        'PI_EXTERNAL_HOST_SCOPE', 'Domain execution must retain exact pinned arguments and effective permissions');
      validateData(args.input, contract.input_schema);
      const inputHash = digest(canonicalJSON(args.input));
      if (entry) {
        requireValue(entry.inputHash === inputHash && entry.execution && !entry.cancelled,
          'PI_EXTERNAL_HOST_REPLAY', 'A revoked or different domain attempt cannot execute again');
        return entry.execution;
      }
      entry = { signature, inputHash, contract, tool, context: args.context, controller: new AbortController() };
      attempts.set(key, entry);
      const authorize = async () => {
        authority(); requireValue(!entry.controller.signal.aborted, 'PI_TASK_ABORTED', 'Exact domain attempt was revoked');
        const result = await ownerRpc(args.owner_descriptor, 'host_tool_authorize', { operation_id: args.operation_id,
          run_id, node_id: args.context.node_id, attempt_id: args.context.attempt_id, contract_sha256: digest(canonicalJSON(contract)) });
        requireValue(result?.authorized === true, 'PI_EXTERNAL_HOST_AUTHORITY', 'Exact owner did not authorize the domain effect');
      };
      entry.execution = Promise.resolve().then(async () => {
        await authorize();
        const context = { ...args.context, ...(args.context.resources ? { resources: args.context.resources.map(resource => ({ ...resource,
          ...(resource.bytes ? { bytes: Buffer.from(resource.bytes.content, resource.bytes.encoding) } : {}) })) } : {}) };
        for (const resource of context.resources ?? []) if (resource.bytes) requireValue(digest(resource.bytes) === resource.sha256,
          'PI_RESOURCE_DRIFT', 'Domain resource bytes differ from their immutable pin');
        const result = await tool.execute({ input: structuredClone(args.input), argv: [...contract.argv],
          env: Object.fromEntries(contract.env_allow.filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])),
          permissions, context, contract, authorize, signal: entry.controller.signal });
        entry.result = result; entry.settled = Number.isInteger(result?.exit_code) && result?.effects?.observed === true;
        await authorize(); return result;
      });
      void entry.execution.catch(() => {});
      return entry.execution;
    },
    async close() {
      const results = await Promise.allSettled([...attempts.values()].filter(entry => !entry.cancelled && (!entry.settled || entry.cancellation)).map(cancel));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw Object.assign(new AggregateError(failures, 'Parent domain shutdown is unconfirmed'), { quiescent: false });
      return { quiescent: true };
    },
  };
}

export function createRemoteHostTools({ descriptors = [], run_id, main_actor, owner_descriptor, waitForBridge, assertAuthority, operations }) {
  const entries = new Map();
  const registry = Object.fromEntries(descriptors.map(descriptor => [descriptor.id, { ...descriptor,
    async execute(request) {
      const key = attemptKey(request.context);
      requireValue(!entries.has(key), 'PI_EXTERNAL_HOST_REPLAY', 'Domain attempt was already dispatched; reconcile instead of replaying');
      await assertAuthority();
      const target = await waitForBridge(request.signal), operation_id = randomUUID();
      await assertAuthority();
      requireValue(!request.signal.aborted, 'PI_TASK_ABORTED', 'Domain attempt was revoked before dispatch');
      const { prepareRuntimeEnvironment: _prepare, resources, ...wireContext } = request.context;
      if (resources) wireContext.resources = resources.map(resource => ({ ...resource,
        ...(resource.bytes ? { bytes: { encoding: 'base64', content: Buffer.from(resource.bytes).toString('base64') } } : {}) }));
      const packet = { tool_id: descriptor.id, descriptor, contract: request.contract,
        context: wireContext, main_actor, owner_descriptor, operation_id };
      const entry = { target, packet, closed: false }; entries.set(key, entry);
      operations.set(operation_id, { authorize: async metadata => {
        await assertAuthority();
        requireValue(!request.signal.aborted && metadata.run_id === request.context.run_id
          && metadata.node_id === request.context.node_id && metadata.attempt_id === request.context.attempt_id
          && metadata.contract_sha256 === digest(canonicalJSON(request.contract)),
        'PI_EXTERNAL_HOST_AUTHORITY', 'Parent authorization does not match the live pinned attempt');
        await request.authorize();
      } });
      try {
        const result = await ownerRpc(target, 'execute_host_tool', { ...packet, input: request.input, argv: request.argv,
          permissions: request.permissions }, { timeoutMs: 0, signal: request.signal });
        entry.closed = true; entry.result = result; return result;
      } catch (cause) { throw unavailable(cause); }
    },
    async cancel(request) {
      const entry = entries.get(attemptKey(request.context));
      if (!entry) {
        // No request reached a parent. This exact observation is safe to attest.
        return { termination_confirmed: true, evidence: [{ kind: 'domain_not_dispatched', sha256: digest(attemptKey(request.context)) }],
          effects: { observed: true, changed_paths: [], outside_paths: [], artifacts: [] } };
      }
      try {
        const result = await ownerRpc(entry.target, 'cancel_host_tool', entry.packet, { timeoutMs: 0 });
        confirmedCancellation(result);
        entry.closed = true; entry.cancelResult = result; return result;
      } catch (cause) { throw unavailable(cause); }
    },
  }]));
  return { registry, async close() {
    const results = await Promise.allSettled([...entries.values()].filter(entry => !entry.closed).map(async entry => {
      const result = await ownerRpc(entry.target, 'cancel_host_tool', entry.packet, { timeoutMs: 0 });
      confirmedCancellation(result);
      entry.closed = true; entry.cancelResult = result;
    }));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw Object.assign(new AggregateError(failures, 'Detached domain shutdown remains unconfirmed'), { quiescent: false });
    for (const entry of entries.values()) operations.delete(entry.packet.operation_id);
    return { quiescent: true };
  } };
}
