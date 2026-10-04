import { randomUUID } from 'node:crypto';
import { requireValue } from './workflow-paths.mjs';
import { canonicalJSON } from './workflow-revisions.mjs';
import { validateData } from './workflow-data-schema.mjs';

const RESULT_LIMIT = 256 * 1024;
const PATCH_VALUE_LIMIT = 4096;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function bytes(value) { return Buffer.byteLength(canonicalJSON(value)); }

function keysOf(value) {
  return object(value) ? Object.keys(value).slice(0, 20).join(', ') : Array.isArray(value) ? `array:${value.length}` : typeof value;
}

function stagedError(staged) {
  const error = new Error(`PI_RESULT_STAGED ${staged.id}: ${staged.error} Staged only, not an official result. Top-level keys: ${keysOf(staged.result)}. Do not resend the body. Submit { summary, stage_id: "${staged.id}", patch } only. patch ops: wrap {op,key}, unwrap {op,key}, set {op,path,value}, remove {op,path}, reset. A patch that validates is promoted; reset restores the first staged body.`);
  error.code = 'PI_RESULT_STAGED';
  error.stage_id = staged.id;
  throw error;
}

function remember(state, result, summary, error) {
  requireValue(bytes(result) <= RESULT_LIMIT, 'PI_RESULT_SIZE', 'Semantic result exceeds the durable result limit; keep detailed artifacts on disk');
  const body = structuredClone(result);
  if (!state.staged) state.staged = { id: randomUUID(), base: structuredClone(body), result: body, summary, error: error.message };
  else {
    state.staged.result = body;
    state.staged.summary = summary;
    state.staged.error = error.message;
  }
  stagedError(state.staged);
}

function pointer(value, path, { remove = false, next } = {}) {
  requireValue(typeof path === 'string' && /^\/[^/]+(?:\/[^/]+)*$/.test(path) && path.length <= 256, 'PI_RESULT_PATCH', 'Patch path must be a non-root JSON pointer');
  const segments = path.slice(1).split('/');
  let parent = value;
  for (const segment of segments.slice(0, -1)) {
    requireValue(object(parent) && Object.hasOwn(parent, segment), 'PI_RESULT_PATCH', `Patch path is missing: ${segment}`);
    parent = parent[segment];
  }
  const leaf = segments.at(-1);
  requireValue(object(parent), 'PI_RESULT_PATCH', 'Patch path must address an object property');
  if (remove) {
    requireValue(Object.hasOwn(parent, leaf), 'PI_RESULT_PATCH', `Patch path is missing: ${leaf}`);
    delete parent[leaf];
    return value;
  }
  parent[leaf] = next;
  return value;
}

function applyOp(value, op) {
  requireValue(object(op) && typeof op.op === 'string', 'PI_RESULT_PATCH', 'Patch operation must name an op');
  if (op.op === 'wrap') {
    requireValue(typeof op.key === 'string' && op.key.length > 0 && op.key.length <= 128, 'PI_RESULT_PATCH', 'wrap requires a short key');
    return { [op.key]: value };
  }
  if (op.op === 'unwrap') {
    requireValue(typeof op.key === 'string' && object(value) && Object.hasOwn(value, op.key), 'PI_RESULT_PATCH', 'unwrap requires an existing key');
    return value[op.key];
  }
  if (op.op === 'remove') return pointer(structuredClone(value), op.path, { remove: true });
  if (op.op === 'set') {
    requireValue(bytes(op.value) <= PATCH_VALUE_LIMIT, 'PI_RESULT_PATCH', 'Patch value must stay a small correction, not another copy of the body');
    return pointer(structuredClone(value), op.path, { next: structuredClone(op.value) });
  }
  requireValue(false, 'PI_RESULT_PATCH', `Unsupported patch op: ${op.op}`);
}

function promote(state, result, summary, fromStage) {
  const submission = { result: structuredClone(result), summary };
  requireValue(bytes(submission) <= RESULT_LIMIT, 'PI_RESULT_SIZE', 'Semantic result exceeds the durable result limit; keep detailed artifacts on disk');
  requireValue(!state.submission || canonicalJSON(state.submission) === canonicalJSON(submission), 'PI_RESULT_CONFLICT', 'This task already submitted a different official result');
  state.submission = submission;
  const stage_id = fromStage ? state.staged?.id ?? null : null;
  state.staged = null;
  return { promoted: fromStage === true, stage_id };
}

const objectSchema = schema => schema && schema.type !== 'array' && !Array.isArray(schema) && (schema.type === 'object' || schema.properties || schema.required);

// The workflow result envelope often requires one object wrapper. If the
// submitted body already validates as that missing property, the host inserts
// the wrapper. This is not a model retry and does not regenerate the body.
export function hostLiftRequiredWrapper(value, schema) {
  try { validateData(value, schema); return { value, lifted: false }; }
  catch (error) {
    if (error.code !== 'DATA_INVALID' || !objectSchema(schema) || !object(value)) throw error;
    const missing = (schema.required ?? []).filter(key => !Object.hasOwn(value, key));
    if (missing.length !== 1) throw error;
    const key = missing[0], child = schema.properties?.[key];
    if (!objectSchema(child)) throw error;
    try { validateData(value, child); }
    catch { throw error; }
    const lifted = { [key]: structuredClone(value) };
    validateData(lifted, schema);
    return { value: lifted, lifted: true, key };
  }
}

// A failed semantic body stays on the task until a small patch validates.
// A missing required object wrapper is lifted by the host before any model retry.
export async function acceptSemanticResult(state, params, validate, schema) {
  requireValue(typeof params?.summary === 'string' && params.summary.length > 0 && params.summary.length <= 4000, 'PI_RESULT_SUMMARY', 'Result requires a bounded summary');
  const correcting = params.stage_id !== undefined || params.patch !== undefined;
  if (correcting) {
    requireValue(state.staged && params.stage_id === state.staged.id, 'PI_RESULT_STAGE_MISSING', 'No matching staged result. Do not invent or resend a body.');
    requireValue(params.result === undefined, 'PI_RESULT_STAGE_RESEND', 'Do not resend the staged body. Submit only stage_id and patch.');
    requireValue(Array.isArray(params.patch) && params.patch.length > 0 && params.patch.length <= 8, 'PI_RESULT_PATCH', 'A staged correction needs 1 to 8 patch operations');
    let candidate = structuredClone(state.staged.result);
    for (const op of params.patch) {
      if (op?.op === 'reset') candidate = structuredClone(state.staged.base);
      else candidate = applyOp(candidate, op);
    }
    try { await validate(candidate); }
    catch (error) { remember(state, candidate, params.summary, error); }
    return promote(state, candidate, params.summary, true);
  }
  requireValue(params.result !== undefined, 'PI_RESULT_BODY', 'Submit result once, or a patch against the staged result');
  if (state.staged && [state.staged.result, state.staged.base].some(body => canonicalJSON(body) === canonicalJSON(params.result))) stagedError(state.staged);
  let body = params.result, lifted = false;
  if (schema) {
    try { const promotion = hostLiftRequiredWrapper(params.result, schema); body = promotion.value; lifted = promotion.lifted; }
    catch (error) { remember(state, params.result, params.summary, error); }
  }
  try { await validate(body); }
  catch (error) { remember(state, body, params.summary, error); }
  return promote(state, body, params.summary, lifted);
}
