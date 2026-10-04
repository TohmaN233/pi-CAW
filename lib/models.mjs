import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { requireValue } from '../core/workflow-paths.mjs';

export function modelIdentity(model) {
  return { provider: model.provider, model_id: model.id };
}
export function modelFingerprint(model) {
  // The executable model contract is frozen, but credentials never enter it.
  const { provider, id, api, baseUrl, reasoning, input, contextWindow, maxTokens, compat } = model;
  return digest(canonicalJSON(JSON.parse(JSON.stringify({ provider, id, api, baseUrl, reasoning, input, contextWindow, maxTokens, compat: compat ?? null }))));
}
export function availableModels(context, supportedThinking) {
  const registry = context.modelRegistry;
  const error = registry.getError?.();
  requireValue(!error, 'PI_MODEL_CATALOG', error);
  const scoped = context.scopedModels ?? [];
  return registry.getAvailable().filter(model => !scoped.length || scoped.some(item => {
    const candidate = item.model ?? item;
    return candidate.provider === model.provider && candidate.id === model.id;
  })).map(model => ({
    ...modelIdentity(model), name: model.name ?? model.id,
    thinking_levels: [...supportedThinking(model)], fingerprint: modelFingerprint(model),
  }));
}
export function resolveBinding(binding, catalog) {
  requireValue(binding && typeof binding.provider === 'string' && binding.provider
    && typeof binding.model_id === 'string' && binding.model_id && typeof binding.thinking === 'string',
  'PI_MODEL_BINDING_REQUIRED', 'Choose a Pi provider, model and thinking level explicitly. No default is configured.');
  const matches = catalog.filter(model => model.provider === binding.provider && model.model_id === binding.model_id);
  requireValue(matches.length === 1, 'PI_MODEL_UNAVAILABLE', `Pi model is unavailable in this session: ${binding.provider}/${binding.model_id}`);
  const model = matches[0];
  requireValue(model.thinking_levels.includes(binding.thinking), 'PI_THINKING_UNSUPPORTED',
    `Pi model ${binding.provider}/${binding.model_id} does not support ${binding.thinking}`);
  requireValue(!binding.fingerprint || model.fingerprint === binding.fingerprint, 'PI_MODEL_CHANGED', 'The pinned Pi model contract changed; rebind explicitly.');
  return { provider: model.provider, model_id: model.model_id, thinking: binding.thinking, fingerprint: model.fingerprint };
}
export function coreProvider(provider) {
  return { id: provider.id, name: provider.name, enabled: provider.enabled, kind: 'native_agent',
    description: provider.description ?? '', requires_user_approval: provider.requires_user_approval ?? false,
    capabilities: provider.capabilities ?? { read: true, write: true, background: true },
    config: { role: 'advisor', agent_type: 'default', ...provider.binding,
      model: provider.binding?.model_id ?? null, reasoning_effort: provider.binding?.thinking ?? null } };
}
