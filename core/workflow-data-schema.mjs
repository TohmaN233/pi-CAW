import { canonicalJSON } from './workflow-revisions.mjs';
import { requireValue } from './workflow-paths.mjs';

// Finite JSON Schema vocabulary: unsupported keywords fail definition validation.
const WORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const', 'minimum', 'exclusiveMinimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'uniqueItems', 'pattern', 'title', 'description', 'default', 'examples']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const DATA_SCHEMA_CAPABILITIES = Object.freeze({
  schema: 'pi-caw-data-schema-capabilities-v1',
  validation_version: 2,
  keywords: Object.freeze([...WORDS].sort()),
  type_array: 'nonempty unique JSON Schema types, including nullable unions',
  combinators: Object.freeze(['anyOf']),
});

function safePattern(pattern) {
  if (/[|\\{}]/.test(pattern)) return false;
  let depth=0;
  for(let index=0;index<pattern.length;index++){
    if(pattern[index]==='('){depth++;if(depth>1)return false;}
    if(pattern[index]===')'){if(depth!==1 || ['*','+'].includes(pattern[index+1]))return false;depth--;}
  }
  return depth===0;
}
export function validateDataSchema(schema, depth = 0) {
  requireValue(depth < 32 && object(schema), 'DATA_SCHEMA', 'Data schema must be a bounded object');
  for (const key of Object.keys(schema)) requireValue(WORDS.has(key), 'DATA_SCHEMA_KEYWORD', `Unsupported data schema keyword: ${key}`);
  if (schema.type !== undefined) {
    const validType = type => typeof type === 'string' && TYPES.has(type);
    const valid = typeof schema.type === 'string'
      ? validType(schema.type)
      : Array.isArray(schema.type) && schema.type.length > 0 && schema.type.every(validType) && new Set(schema.type).size === schema.type.length;
    requireValue(valid, 'DATA_SCHEMA', 'Schema type must be a supported type or a nonempty array of unique supported types');
  }
  if (schema.properties !== undefined) {
    requireValue(object(schema.properties), 'DATA_SCHEMA', 'properties must be an object');
    for (const child of Object.values(schema.properties)) validateDataSchema(child, depth + 1);
  }
  if (schema.required !== undefined) requireValue(Array.isArray(schema.required) && schema.required.every(key => typeof key === 'string') && new Set(schema.required).size === schema.required.length, 'DATA_SCHEMA', 'required must contain unique property names');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') validateDataSchema(schema.additionalProperties, depth + 1);
  if (schema.items !== undefined) validateDataSchema(schema.items, depth + 1);
  if (schema.anyOf !== undefined) {
    requireValue(Array.isArray(schema.anyOf) && schema.anyOf.length > 0, 'DATA_SCHEMA', 'anyOf must contain at least one schema');
    for (const branch of schema.anyOf) validateDataSchema(branch, depth + 1);
  }
  if (schema.enum !== undefined) requireValue(Array.isArray(schema.enum) && schema.enum.length > 0, 'DATA_SCHEMA', 'enum must be nonempty');
  for (const key of ['minimum', 'exclusiveMinimum', 'maximum']) if (schema[key] !== undefined) requireValue(Number.isFinite(schema[key]), 'DATA_SCHEMA', `${key} must be finite`);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) if (schema[key] !== undefined) requireValue(Number.isInteger(schema[key]) && schema[key] >= 0, 'DATA_SCHEMA', `${key} must be a nonnegative integer`);
  if (schema.uniqueItems !== undefined) requireValue(typeof schema.uniqueItems==='boolean','DATA_SCHEMA','uniqueItems must be boolean');
  if (schema.pattern !== undefined) {
    requireValue(typeof schema.pattern==='string' && schema.pattern.length>0 && schema.pattern.length<=512 && safePattern(schema.pattern),'DATA_SCHEMA_PATTERN','pattern must use the bounded linear subset without nesting, alternation, escapes, counted repetition or repeated groups');
    try { new RegExp(schema.pattern,'u'); } catch { requireValue(false,'DATA_SCHEMA_PATTERN','pattern must be a valid bounded regular expression'); }
  }
  canonicalJSON(schema);
}

export function validateData(value, schema = {}, path = '$') {
  validateDataSchema(schema);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const fail = message => requireValue(false, 'DATA_INVALID', `${path}: ${message}`);
  const matchesType = type => type === 'integer'
    ? Number.isInteger(value)
    : type === 'number'
      ? typeof value === 'number'
      : type === 'object'
        ? object(value)
        : type === 'array'
          ? Array.isArray(value)
          : type === actual;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(matchesType)) fail(`expected ${types.join(' or ')}, received ${actual}`);
  }
  if (schema.anyOf !== undefined) {
    let matched = false;
    for (const branch of schema.anyOf) {
      try {
        validateData(value, branch, path);
        matched = true;
        break;
      } catch (error) {
        if (error?.code !== 'DATA_INVALID') throw error;
      }
    }
    if (!matched) fail('value does not match any anyOf branch');
  }
  if (Object.hasOwn(schema, 'const') && canonicalJSON(value) !== canonicalJSON(schema.const)) fail('value differs from const');
  if (schema.enum && !schema.enum.some(item => canonicalJSON(item) === canonicalJSON(value))) fail('value is not in enum');
  if (object(value)) {
    const propertyCount = Object.keys(value).length;
    if (schema.minProperties !== undefined && propertyCount < schema.minProperties || schema.maxProperties !== undefined && propertyCount > schema.maxProperties) fail('object property count is outside bounds');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`required property is missing: ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateData(child, schema.properties[key], `${path}/${key}`);
      else if (schema.additionalProperties === false) fail(`unexpected property: ${key}`);
      else if (object(schema.additionalProperties)) validateData(child, schema.additionalProperties, `${path}/${key}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) fail('array length is outside bounds');
    if (schema.uniqueItems && new Set(value.map(item=>canonicalJSON(item))).size!==value.length) fail('array items are not unique');
    if (schema.items) value.forEach((item, index) => validateData(item, schema.items, `${path}/${index}`));
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) fail('string length is outside bounds');
    if (schema.pattern !== undefined && !new RegExp(schema.pattern,'u').test(value)) fail('string does not match pattern');
  }
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.maximum !== undefined && value > schema.maximum)) fail('number is outside bounds');
}
