import { canonicalJSON } from '../workflow-revisions.mjs';
import { requireValue } from '../workflow-paths.mjs';
import { projectFanoutInputs } from './fanout-input-projection.mjs';
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export const SHARED_PREFIX_SCHEMA = Object.freeze({
  type: 'object', required: ['common_inputs'], additionalProperties: false,
  properties: { common_inputs: { type: 'array', maxItems: 32, uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z][A-Za-z0-9_-]*$' } } },
});

export function sharedPrefixDeclarationIssue(node, workflowMode) {
  const declaration = node.fanout?.shared_prefix;
  if (declaration === undefined) return null;
  if (node.type !== 'agent' || node.executor?.kind !== 'main'
    || node.executor.mode !== 'worker' || (node.skill_policy?.mode ?? workflowMode) !== 'cooperative'
    || node.fanout.result_mode !== 'per_item')
    return 'Shared prefix requires a Cooperative Main worker with per-item fan-out results';
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)
    || Object.keys(declaration).length !== 1 || !Object.hasOwn(declaration, 'common_inputs')
    || !Array.isArray(declaration.common_inputs) || declaration.common_inputs.length > 32
    || new Set(declaration.common_inputs).size !== declaration.common_inputs.length
    || declaration.common_inputs.some(name => typeof name !== 'string' || !namePattern.test(name)
      || name === node.fanout.input || name === node.fanout.item_name
      || !Object.hasOwn(node.input_bindings ?? {}, name)))
    return 'Shared prefix common_inputs must be up to 32 unique declared bindings, excluding the item list and assigned item';
  return null;
}

export function sharedPrefixInputProjection(envelope, items, declaration) {
  const names = declaration?.common_inputs;
  requireValue(Array.isArray(items) && items.length > 0 && Array.isArray(names) && names.length <= 32
    && new Set(names).size === names.length && names.every(name => typeof name === 'string' && Object.hasOwn(envelope.inputs, name)),
    'HOST_MAIN_PREFIX_INPUT', 'Shared prefix must name unique bound inputs in a nonempty item plan');
  const projected = items.map(item => projectFanoutInputs(envelope.inputs, items, [item])), common = {};
  for (const name of names) {
    requireValue(projected.every(input => canonicalJSON(input[name]) === canonicalJSON(projected[0][name])),
      'HOST_MAIN_PREFIX_INPUT', `Shared input ${name} differs between item projections`);
    common[name] = structuredClone(projected[0][name]);
  }
  for (const name of ['task', 'context', 'verification']) if (Object.hasOwn(envelope.inputs, name)
    && new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(envelope.prompt_template ?? ''))
    requireValue(names.includes(name), 'HOST_MAIN_PREFIX_TEMPLATE', `Shared template input ${name} must be explicitly common`);
  return common;
}
