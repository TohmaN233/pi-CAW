import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJSON, digest } from './workflow-revisions.mjs';
import { noSymlinks, requireValue } from './workflow-paths.mjs';
import { syncDirectory } from './workflow-store.mjs';

const MAX_JOURNAL = 128 * 1024 * 1024;
const MAX_EVENT = 4 * 1024 * 1024;
// Runtime registration is Host state. Rebinding never rewrites the initial pin.
const ENVIRONMENT_EVENTS = ['runtime_environment_attention', 'runtime_environment_rebound'];
export const EVENT_KINDS = new Set(['generation_repair', 'generation_projection', 'generation_review_recheck', 'started', 'claim', 'complete', 'fail', 'retry', 'cancel', 'pause', 'resume', 'approve', 'dispatch_intent', 'dispatch_receipt', 'host_tool_intent', 'host_tool_receipt', 'usage', 'executor_event', 'completion_turn', 'native_agent_rejection', 'native_serial_result', 'native_parallel_result', 'native_item_results', 'managed_native_results', 'recover', 'control_recovery', 'child_intent', 'child_started']);
for (const kind of ENVIRONMENT_EVENTS) EVENT_KINDS.add(kind);
for (const kind of ['pi_completion_check_intent','pi_completion_check_receipt','worker_completion_turn']) EVENT_KINDS.add(kind);
EVENT_KINDS.add('host_tool_collection');
for (const kind of ['reattach', 'connector_control', 'execution_drain', 'parent_execution_lost', 'host_main_advance_failed', 'host_main_worker_start_failed', 'workspace_input_bound', 'parallel_intent', 'parallel_base', 'parallel_branch', 'parallel_ready', 'parallel_proposal', 'parallel_apply_intent', 'parallel_integrated', 'parallel_error', 'parallel_cleanup']) EVENT_KINDS.add(kind);

export function decodeEvents(bytes, { allowTornTail = false } = {}) {
  return decodeEventSuffix(bytes, { allowTornTail });
}

// Only VerifiedJournalReader supplies a previously byte-proven prefix. The same
// validator handles complete journals and appended events, including global order.
function decodeEventSuffix(bytes, { allowTornTail = false, sequence = 0, previous = null } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  requireValue(buffer.length <= MAX_JOURNAL, 'RUN_JOURNAL_LIMIT', 'Run journal exceeds its size limit');
  const completeLength = buffer.length && buffer.at(-1) !== 10 ? buffer.lastIndexOf(10) + 1 : buffer.length;
  const tail = buffer.subarray(completeLength);
  requireValue(allowTornTail || !tail.length, 'RUN_JOURNAL_TORN', 'Run has an uncommitted journal tail; recover before mutation');
  const lines = buffer.subarray(0, completeLength).toString('utf8');
  const events = lines ? lines.slice(0, -1).split('\n').map(line => {
    requireValue(Buffer.byteLength(line) <= MAX_EVENT, 'RUN_EVENT_LIMIT', 'Run event is oversized');
    return JSON.parse(line);
  }) : [];
  for (const [index, event] of events.entries()) {
    const { hash, ...content } = event;
    requireValue(content.sequence === sequence + index + 1 && content.previous === previous && digest(canonicalJSON(content)) === hash, 'RUN_JOURNAL_CORRUPT', 'Run journal hash chain is invalid');
    requireValue(EVENT_KINDS.has(content.kind) && (sequence + index === 0 ? content.kind === 'started' : content.kind !== 'started'), 'RUN_EVENT_KIND', 'Unexpected Run event kind/order');
    previous = hash;
  }
  return { events, tail, completeLength };
}

async function readJournalBytes(path) {
  await noSymlinks(path);
  const info = await lstat(path);
  requireValue(info.isFile() && info.size <= MAX_JOURNAL, 'RUN_JOURNAL_LIMIT', 'Run journal must be a bounded regular file');
  const bytes = await readFile(path);
  requireValue(bytes.length <= MAX_JOURNAL, 'RUN_JOURNAL_LIMIT', 'Run journal grew beyond its size limit');
  return bytes;
}

export async function readEvents(path, options) {
  return decodeEvents(await readJournalBytes(path), options);
}

function freezeEvent(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeEvent(child);
  Object.freeze(value);
}

// Strict reads prove the complete prefix against actual bytes. Incremental reads
// are for Host-owned append-only authority/progress paths: inspect identity and
// read only the new tail. Explicit inspection/recovery uses strict reads. Neither
// lane accepts mutable caller objects or unvalidated appended events.
export class VerifiedJournalReader {
  #entries = new Map();
  #bytes = 0;
  constructor({ maxBytes = MAX_JOURNAL, maxEntries = 16 } = {}) {
    requireValue(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_JOURNAL
      && Number.isInteger(maxEntries) && maxEntries > 0 && maxEntries <= 16,
    'RUN_JOURNAL_CACHE_LIMIT', 'Verified journal reuse requires bounded byte and entry budgets');
    this.maxBytes = maxBytes; this.maxEntries = maxEntries;
  }
  async read(path, { incremental = false } = {}) {
    const prior = this.#entries.get(path);
    let bytes, identity, reuse = false, completeLength;
    if (incremental) {
      // This lane belongs to an already-owned append-only Host journal writer.
      // It reads only new events, not a forensic rescan of prior history.
      await noSymlinks(path);
      const file = await open(path, 'r');
      try {
        const info = await file.stat({ bigint: true });
        requireValue(info.isFile() && info.size <= BigInt(MAX_JOURNAL), 'RUN_JOURNAL_LIMIT', 'Run journal must be a bounded regular file');
        identity = { dev: info.dev, ino: info.ino, mtime: info.mtimeNs, ctime: info.ctimeNs };
        completeLength = Number(info.size);
        reuse = prior && prior.identity?.dev === info.dev && prior.identity.ino === info.ino
          && completeLength >= prior.size && (completeLength > prior.size
            || prior.identity.mtime === info.mtimeNs && prior.identity.ctime === info.ctimeNs);
        const offset = reuse ? prior.size : 0, length = completeLength - offset;
        bytes = Buffer.allocUnsafe(length);
        let received = 0;
        while (received < length) {
          const result = await file.read(bytes, received, length - received, offset + received);
          requireValue(result.bytesRead > 0, 'RUN_JOURNAL_CHANGED', 'Run journal changed during its owned read');
          received += result.bytesRead;
        }
        // The captured size is this read's snapshot boundary. A concurrent Host
        // append belongs to the next read; captured torn bytes still fail decode.
      } finally { await file.close(); }
    } else {
      bytes = await readJournalBytes(path); completeLength = bytes.length;
      let offset = 0;
      reuse = prior && bytes.length >= prior.size && prior.chunks.every(chunk => {
        const same = bytes.subarray(offset, offset + chunk.length).equals(chunk); offset += chunk.length; return same;
      });
      if (reuse) bytes = bytes.subarray(prior.size);
      if (reuse && completeLength === prior.size) identity = prior.identity;
    }
    // A strict suffix decode still rejects a torn tail even on a prefix hit.
    const decoded = decodeEventSuffix(bytes,
      reuse ? { sequence: prior.events.length, previous: prior.events.at(-1)?.hash ?? null } : {});
    for (const event of decoded.events) freezeEvent(event);
    const events = reuse && decoded.events.length === 0 ? prior.events
      : Object.freeze([...(reuse ? prior.events : []), ...decoded.events]);
    const old = this.#entries.get(path);
    if (old) { this.#entries.delete(path); this.#bytes -= old.size; }
    if (completeLength <= this.maxBytes) {
      // Copy a strict suffix out of its full-file backing buffer. Retain only
      // the new bytes, never an extra full history for each tiny append.
      const chunks = reuse ? [...prior.chunks, ...(bytes.length ? [Buffer.from(bytes)] : [])] : [bytes];
      this.#entries.set(path, { chunks, size: completeLength, identity, events }); this.#bytes += completeLength;
      while (this.#bytes > this.maxBytes || this.#entries.size > this.maxEntries) {
        const [key, entry] = this.#entries.entries().next().value;
        this.#entries.delete(key); this.#bytes -= entry.size;
      }
    }
    return { events, reused_prefix_bytes: reuse ? prior.size : 0, bytes_read: incremental ? bytes.length : completeLength, completeLength };
  }
}

export async function appendEvent(path, events, kind, payload) {
  requireValue(EVENT_KINDS.has(kind), 'RUN_EVENT_KIND', 'Unknown Run event');
  const content = { sequence: events.length + 1, previous: events.at(-1)?.hash ?? null, kind, at: new Date().toISOString(), payload };
  const event = { ...content, hash: digest(canonicalJSON(content)) };
  const bytes = canonicalJSON(event) + '\n';
  requireValue(Buffer.byteLength(bytes) <= MAX_EVENT, 'RUN_EVENT_LIMIT', 'Run event exceeds its size limit');
  await noSymlinks(dirname(path));
  let currentSize = 0;
  try { await noSymlinks(path); currentSize = (await lstat(path)).size; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  requireValue(currentSize + Buffer.byteLength(bytes) <= MAX_JOURNAL, 'RUN_JOURNAL_LIMIT', 'Run journal is full; dependent execution is blocked');
  const file = await open(path, events.length ? 'a' : 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return event;
}

export async function writeDurableJSON(path, value) {
  const temporary = path + '.write-' + randomUUID();
  await noSymlinks(dirname(path));
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(canonicalJSON(value) + '\n'); await file.sync();
    await file.close(); file = undefined;
    try { await noSymlinks(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, path); await syncDirectory(dirname(path));
  } finally {
    if (file) await file.close();
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Caller must hold the Run writer lock. Complete records are never discarded.
export async function recoverEventTail(path) {
  const decoded = await readEvents(path, { allowTornTail: true });
  if (!decoded.tail.length) return { ...decoded, recovered: null };
  const bytes = await readFile(path);
  const originalHash = digest(bytes);
  const quarantine = path + '.torn-' + randomUUID();
  const backup = await open(quarantine, 'wx', 0o600);
  try { await backup.writeFile(bytes); await backup.sync(); } finally { await backup.close(); }
  const temporary = path + '.repair-' + randomUUID();
  const replacement = await open(temporary, 'wx', 0o600);
  try { await replacement.writeFile(bytes.subarray(0, decoded.completeLength)); await replacement.sync(); } finally { await replacement.close(); }
  try {
    requireValue(digest(await readFile(path)) === originalHash, 'RUN_JOURNAL_CHANGED', 'Journal changed during recovery');
    await rename(temporary, path); await syncDirectory(dirname(path));
  } finally { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return { ...decoded, recovered: { retained_at: quarantine, sha256: originalHash, tail_bytes: decoded.tail.length } };
}

export function statePatch(previous, next) {
  const patch = { fields: {}, nodes: {}, edges: {}, approvals: {} };
  for (const key of Object.keys(previous)) requireValue(Object.hasOwn(next, key), 'RUN_STATE_SHAPE', 'Run state cannot silently drop fields');
  for (const [key, value] of Object.entries(next)) {
    if (['nodes', 'edges', 'approvals'].includes(key)) {
      for (const id of Object.keys(previous[key] ?? {})) requireValue(Object.hasOwn(value, id), 'RUN_STATE_SHAPE', 'Run state cannot silently drop entries');
      for (const [id, item] of Object.entries(value)) if (!Object.hasOwn(previous[key] ?? {}, id) || canonicalJSON(previous[key][id]) !== canonicalJSON(item)) Object.defineProperty(patch[key], id, { value: item, enumerable: true });
    } else if (!Object.hasOwn(previous, key) || canonicalJSON(previous[key]) !== canonicalJSON(value)) Object.defineProperty(patch.fields, key, { value, enumerable: true });
  }
  return patch;
}

export function replayEvents(events) {
  requireValue(events.length && events[0].kind === 'started', 'RUN_START_MISSING', 'Run has no committed start event');
  let state = structuredClone(events[0].payload.state);
  for (const event of events.slice(1)) {
    const patch = event.payload.patch;
    requireValue(patch && patch.fields && patch.nodes && patch.edges && patch.approvals, 'RUN_STATE_SHAPE', 'Run transition has no complete patch envelope');
    state = {
      ...state, ...patch.fields,
      nodes: { ...state.nodes, ...patch.nodes }, edges: { ...state.edges, ...patch.edges }, approvals: { ...state.approvals, ...patch.approvals },
    };
  }
  return state;
}
