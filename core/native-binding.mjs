export function nativeBindingIssue(provider) {
  if (provider?.kind !== 'native_agent') return null;
  const config = provider.config ?? {};
  if (config.agent_type === undefined || config.agent_type === 'default') return null;
  return { code: 'NATIVE_PROVIDER_AGENT_TYPE', provider_id: provider.id,
    message: `Provider ${provider.id} must use the generic native Agent. Choose behavior through a Workbench Role, not a second Agent definition.`,
    expected: { agent_type: 'default' }, actual: { agent_type: config.agent_type ?? null } };
}

