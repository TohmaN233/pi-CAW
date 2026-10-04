// Meter the exact observed Pi turns. Missing metering stays explicitly unknown.
export function usageFromEntries(entries) {
  const turns = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant');
  const values = turns.map(entry => entry.message.usage);
  const sum = key => values.reduce((total, value) => total + (value?.[key] ?? 0), 0);
  const known = values.length > 0 && values.every(value => value && Number.isFinite(value.cost?.total) && value.cost.total >= 0);
  return { input_tokens: sum('input'), output_tokens: sum('output'), cached_input_tokens: sum('cacheRead'), cache_write_input_tokens: sum('cacheWrite'),
    ...(known ? { cost_micros: Math.round(values.reduce((total, value) => total + value.cost.total, 0) * 1000000) } : {}), unknown: !known };
}
export function aggregateUsage(values) {
  const fields = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens', 'visual_input_units'];
  const known = values.length > 0 && values.every(value => value && value.unknown === false);
  return { ...Object.fromEntries(fields.filter(key => values.some(value => value?.[key] !== undefined)).map(key => [key, values.reduce((sum, value) => sum + (value?.[key] ?? 0), 0)])),
    ...(known ? { cost_micros: values.reduce((sum, value) => sum + value.cost_micros, 0) } : {}), unknown: !known };
}
