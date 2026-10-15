import { mkdir, lstat, readFile, open, rm, readdir, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkflowStore, syncDirectory } from './workflow-store.mjs';
import { ensureDirectory, canonicalNoLinks, insideRoot, noSymlinks, requireValue, workflowId } from './workflow-paths.mjs';
import { retireOwnedFile, retirementErrorDetails } from './owned-file-retirement.mjs';
import { canonicalJSON, digest, LIMITS } from './workflow-revisions.mjs';
import { appendEvent, readEvents, VerifiedJournalReader, replayEvents, statePatch, recoverEventTail, writeDurableJSON } from './workflow-events.mjs';

const runState = globalThis[Symbol.for('pi-caw.run-store.operations.v1')] ??= {
  scopes: new AsyncLocalStorage(), foreground: new AsyncLocalStorage(), activity: new Map(), listeners: new Map(),
};
const operationKey = root => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
export const EXECUTOR_RESULT_MAX_BYTES = 256 * 1024;
async function journalStarted(directory) {
  try { await lstat(join(directory, 'events.jsonl')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function scopedOperation(root, kind, action) {
  const key = operationKey(await canonicalNoLinks(root)), ancestors = runState.scopes.getStore() ?? [];
  if (ancestors.some(owner => owner.active && owner.key === key)) return action();
  requireValue(!ancestors.some(owner => owner.active && owner.kind === 'run'), 'RUN_STORE_LOCK_ORDER',
    'A Run journal transaction cannot acquire a different Run or ancestor store transaction');
  const owner = { key, kind, active: true };
  try { return await runState.scopes.run([...ancestors, owner], action); }
  finally { owner.active = false; }
}

// Store admission covers only a short filesystem census/create/maintenance
// transaction. Model/tool effects must settle outside this boundary.
export async function withRunStoreOperation(root, name, action) {
  requireValue(isAbsolute(root) && typeof action === 'function' && /^[a-z_]{1,32}$/.test(name),
    'RUN_STORE_OPERATION', 'Run store operation requires exact root, typed name and callback');
  const directory = join(root, '.run-locks', '.store-operation');
  const key = operationKey(await canonicalNoLinks(directory));
  if ((runState.scopes.getStore() ?? []).some(owner => owner.active && owner.key === key)) return action();
  requireValue(!(runState.scopes.getStore() ?? []).some(owner => owner.active && owner.kind === 'run'),
    'RUN_STORE_LOCK_ORDER', 'A Run journal transaction cannot wait for ancestor store admission');
  await ensureDirectory(directory);
  return new WorkflowStore(directory).withRunAdmission(() => scopedOperation(directory, 'store', action), { operation: name });
}

export function runStoreForegroundActivity(root) { return { active: runState.activity.get(operationKey(root)) ?? 0 }; }
export function onRunStoreForegroundChange(root, callback) {
  requireValue(typeof callback === 'function', 'RUN_STORE_FOREGROUND_LISTENER', 'Foreground observer must be callable');
  const key = operationKey(root), listeners = runState.listeners.get(key) ?? new Set();
  listeners.add(callback); runState.listeners.set(key, listeners);
  return () => { listeners.delete(callback); if (!listeners.size) runState.listeners.delete(key); };
}
export function onRunStoreForegroundIdle(root, callback) {
  return onRunStoreForegroundChange(root, value => { if (!value.active) return callback(value); });
}
async function changeActivity(root, delta) {
  const key = operationKey(root), active = (runState.activity.get(key) ?? 0) + delta;
  requireValue(active >= 0, 'RUN_STORE_FOREGROUND_IDENTITY', 'Foreground activity counter underflow');
  if (active) runState.activity.set(key, active); else runState.activity.delete(key);
  const errors = [];
  for (const callback of runState.listeners.get(key) ?? []) try { await callback({ active }); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Foreground activity observers failed');
}
const foregroundDirectory = root => join(root, '.run-locks', '.foreground-activity');
const claimPattern = /^activity-[a-f0-9-]{36}\.json$/;
async function foregroundClaim(path) {
  await noSymlinks(path); const info = await lstat(path);
  requireValue(info.isFile() && info.nlink === 1 && info.size <= 4096, 'RUN_STORE_FOREGROUND_FILE', 'Foreground claim must be bounded regular ownership record');
  const bytes = await readFile(path); requireValue(bytes.length <= 4096, 'RUN_STORE_FOREGROUND_FILE', 'Foreground claim grew beyond limit');
  const owner = JSON.parse(bytes);
  requireValue(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string'
    && /^[a-f0-9-]{36}$/.test(owner.token) && typeof owner.created_at === 'string' && Number.isFinite(Date.parse(owner.created_at))
    && Object.keys(owner).every(key => ['pid', 'token', 'created_at'].includes(key)),
    'RUN_STORE_FOREGROUND_IDENTITY', 'Foreground claim identity is invalid');
  return { bytes, owner };
}
export async function readRunStoreForegroundActivity(root) {
  const directory = foregroundDirectory(root); let entries;
  try { await noSymlinks(directory); entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return { active: 0, orphaned: 0, unverified: 0 }; throw error; }
  requireValue(entries.length <= 1025, 'RUN_STORE_FOREGROUND_LIMIT', 'Foreground ownership census exceeds limit');
  let active = 0, orphaned = 0, unverified = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.name === '.pending') { await noSymlinks(path); continue; }
    requireValue(entry.isFile() && !entry.isSymbolicLink() && claimPattern.test(entry.name), 'RUN_STORE_FOREGROUND_ENTRY', 'Unexpected foreground ownership entry');
    let claim;
    try { claim = await foregroundClaim(path); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    active++;
    try { process.kill(claim.owner.pid, 0); }
    catch (error) { if (error?.code === 'ESRCH') orphaned++; else unverified++; }
  }
  return { active, orphaned, unverified };
}
export async function recoverRunStoreForegroundActivity(root, id, token) {
  requireValue(claimPattern.test(`activity-${id}.json`), 'RUN_STORE_FOREGROUND_IDENTITY', 'Exact foreground claim ID is required');
  const directory = foregroundDirectory(root), path = join(directory, `activity-${id}.json`), claim = await foregroundClaim(path);
  requireValue(claim.owner.token === token, 'RUN_STORE_FOREGROUND_IDENTITY', 'Foreground recovery requires inspected token');
  let absent = false;
  try { process.kill(claim.owner.pid, 0); } catch (error) { if (error?.code === 'ESRCH') absent = true; else throw error; }
  requireValue(absent, 'RUN_STORE_FOREGROUND_ACTIVE', 'Foreground owner is alive; no automatic takeover');
  await retireOwnedFile(path, { stagingRoot: join(directory, '.pending'), validate: bytes => {
    requireValue(bytes.equals(claim.bytes), 'RUN_STORE_FOREGROUND_IDENTITY', 'Foreground ownership changed before recovery'); return claim.owner.pid;
  } });
}
export async function withRunStoreForegroundActivity(root, action) {
  const key = operationKey(await canonicalNoLinks(root)), parent = runState.foreground.getStore();
  if (parent?.active && parent.key === key) return action();
  const directory = foregroundDirectory(root); await ensureDirectory(join(directory, '.pending'));
  const id = randomUUID(), path = join(directory, `activity-${id}.json`), temporary = join(directory, '.pending', `activity-${id}.json`);
  const bytes = Buffer.from(canonicalJSON({ pid: process.pid, token: randomUUID(), created_at: new Date().toISOString() }));
  const file = await open(temporary, 'wx', 0o600); let claimIdentity;
  try { claimIdentity = await file.stat({ bigint: true }); await file.writeFile(bytes); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) {
    try { await unlink(temporary); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Foreground publication and cleanup failed'); } throw error;
  }
  const owner = { key, active: true }; let result, failure, failed = false;
  try { await changeActivity(root, 1); result = await runState.foreground.run(owner, action); }
  catch (error) { failed = true; failure = error; }
  owner.active = false; const cleanup = [];
  try { await retireOwnedFile(path, { stagingRoot: join(directory, '.pending'), expectedIdentity: claimIdentity, validate: current => {
    requireValue(current.equals(bytes), 'RUN_STORE_FOREGROUND_IDENTITY', 'Foreground ownership changed'); return process.pid;
  } }); } catch (error) { cleanup.push(error); }
  try { await changeActivity(root, -1); } catch (error) { cleanup.push(error); }
  if (cleanup.length) { const errors = [...(failed ? [failure] : []), ...cleanup];
    throw Object.assign(new AggregateError(errors, 'Foreground operation and ownership cleanup failed'), { details: retirementErrorDetails(errors) }); }
  if (failed) throw failure; return result;
}

export class WorkflowRunStore {
  #journalReader = new VerifiedJournalReader();
  #activePins = new Map();
  constructor(root) {
    requireValue(isAbsolute(root), 'ABSOLUTE_PATH_REQUIRED', 'Run store root must be absolute');
    this.root = resolve(root); this.writer = new WorkflowStore(this.root);
  }
  async initialize() { await this.writer.initialize(); return this; }
  directory(id) { return join(this.root, `run-${workflowId(id)}.run`); }
  async withRunWriter(id, action) {
    const root = this.directory(id);
    await noSymlinks(root); // Admission must never recreate a missing Run.
    const key = operationKey(await canonicalNoLinks(root));
    if ((runState.scopes.getStore() ?? []).some(owner => owner.active && owner.key === key)) return Promise.resolve().then(action);
    requireValue(!(runState.scopes.getStore() ?? []).some(owner => owner.active && owner.kind === 'run'),
      'RUN_STORE_LOCK_ORDER', 'A Run journal transaction cannot acquire a different Run writer');
    return new WorkflowStore(root).withRunAdmission(() => scopedOperation(root, 'run', action), { operation: 'journal' });
  }

  async saveArtifact(id, label, value) {
    workflowId(label); const bytes = Buffer.from(value); const sha256 = digest(bytes);
    requireValue(bytes.length <= 32 * 1024 * 1024, 'RUN_ARTIFACT_LIMIT', 'Run artifact exceeds its bounded size');
    const artifact = `artifact-${label}-${sha256}.bin`; const path = insideRoot(this.directory(id), join(this.directory(id), artifact));
    // Caller may already own the Run journal writer. Content addressing and wx
    // handle concurrent artifact publication without nesting the writer lock.
    try {
      await noSymlinks(this.directory(id)); const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(this.directory(id));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await this.readArtifact(id, { artifact, sha256, bytes: bytes.length });
    }
    return { artifact, sha256, bytes: bytes.length };
  }

  async readArtifact(id, reference) {
    requireValue(reference && /^artifact-[a-z0-9._-]+-[a-f0-9]{64}\.bin$/.test(reference.artifact) && /^[a-f0-9]{64}$/.test(reference.sha256) && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && reference.bytes <= 32 * 1024 * 1024, 'RUN_ARTIFACT_REFERENCE', 'Artifact reference needs its exact bounded identity');
    const path = insideRoot(this.directory(id), join(this.directory(id), reference.artifact)); await noSymlinks(path);
    const info = await lstat(path); requireValue(info.isFile() && info.nlink === 1 && info.size === reference.bytes, 'RUN_ARTIFACT_CORRUPT', 'Artifact size/type differs from its reference');
    const bytes = await readFile(path); requireValue(bytes.length === reference.bytes && digest(bytes) === reference.sha256, 'RUN_ARTIFACT_CORRUPT', 'Artifact bytes differ from their committed hash'); return bytes;
  }

  async saveExecutorResult(id, attemptId, result) {
    workflowId(attemptId); const bytes = canonicalJSON(result);
    requireValue(Buffer.byteLength(bytes) <= EXECUTOR_RESULT_MAX_BYTES, 'EXECUTOR_RESULT_LIMIT', 'Executor result exceeds the durable artifact limit');
    const sha256 = digest(bytes); const artifact = `executor-${attemptId}-${sha256}.json`;
    const root = this.directory(id); const path = insideRoot(root, join(root, artifact));
    await this.withRunWriter(id, async () => {
      await noSymlinks(root);
      try {
        await noSymlinks(path); requireValue(digest(await readFile(path)) === sha256, 'EXECUTOR_RESULT_CORRUPT', 'Existing result artifact differs'); return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(root);
    });
    return { artifact, sha256 };
  }

  async readExecutorResult(id, attemptId, sha256) {
    workflowId(attemptId); requireValue(/^[a-f0-9]{64}$/.test(sha256), 'EXECUTOR_RESULT_ID', 'Result needs an exact content pin');
    const path = join(this.directory(id), `executor-${attemptId}-${sha256}.json`); await noSymlinks(path);
    const stat = await lstat(path); requireValue(stat.isFile() && stat.nlink === 1 && stat.size <= EXECUTOR_RESULT_MAX_BYTES, 'EXECUTOR_RESULT_LIMIT', 'Result artifact must be a bounded regular file');
    const bytes = await readFile(path); requireValue(digest(bytes) === sha256, 'EXECUTOR_RESULT_CORRUPT', 'Result artifact differs from its journal pin');
    return JSON.parse(bytes.toString('utf8'));
  }

  async create(id, pins, blobs, state) {
    const pinsHash = digest(canonicalJSON(pins));
    requireValue(state.run_id === id && state.pins_hash === pinsHash, 'RUN_IDENTITY', 'Initial state does not match its pinned inputs');
    requireValue(Buffer.byteLength(canonicalJSON(pins)) <= 16 * 1024 * 1024, 'RUN_PINS_LIMIT', 'Pinned metadata is too large');
    requireValue(Array.isArray(pins.resources) && pins.resources.length <= LIMITS.files, 'RUN_RESOURCE', 'Run needs a bounded resource manifest');
    for (const resource of pins.resources) {
      const bytes = blobs.get(resource.sha256);
      requireValue(bytes && bytes.length === resource.bytes && digest(bytes) === resource.sha256, 'RUN_RESOURCE', 'Every pinned resource must have verified bytes before publication');
    }
    return this.writer.withRunAdmission(async () => {
      const destination = insideRoot(this.root, this.directory(id));
      try {
        const existing = await lstat(destination);
        requireValue(existing.isDirectory() && !existing.isSymbolicLink(), 'RUN_STORE_ENTRY', 'Run initialization target must be one exact directory');
        try { await lstat(join(destination, '.recovery.lock'));
          throw Object.assign(new Error('Run initialization has retained recovery ownership; inspect it before reclamation'), { code: 'RUN_INITIALIZATION_RECOVERY_REQUIRED' });
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (await journalStarted(destination) || await this.retained(id)) throw Object.assign(new Error('Run already exists'), { code: 'RUN_EXISTS' });
        await rm(destination, { recursive: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(destination);
      try {
        await mkdir(join(destination, 'objects'));
        let total = 0;
        for (const [hash, value] of blobs) {
          const bytes = Buffer.from(value); total += bytes.length;
          requireValue(/^[a-f0-9]{64}$/.test(hash) && digest(bytes) === hash && bytes.length <= LIMITS.resource && total <= 256 * 1024 * 1024, 'RUN_RESOURCE', 'Invalid or oversized pinned resource');
          const file = await open(join(destination, 'objects', hash), 'wx', 0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        }
        await writeDurableJSON(join(destination, 'pins.json'), pins);
        const event = await appendEvent(join(destination, 'events.jsonl'), [], 'started', { state });
        await syncDirectory(join(destination, 'objects')); await syncDirectory(destination); await syncDirectory(this.root);
        return { state: structuredClone(state), pins: structuredClone(pins), sequence: 1, events: [event] };
      } catch (error) {
        try { await rm(destination, { recursive: true, maxRetries: 3, retryDelay: 100 }); }
        catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Run creation and cleanup failed'); }
        throw error;
      }
    });
  }

  async read(id, options = {}) {
    // Runtime child transitions inspect ancestors while owning the child
    // journal. Acquiring/waiting on a second journal would invert lock order.
    // Such evidence reads stay strict (torn/missing/corrupt bytes fail).
    const key = operationKey(await canonicalNoLinks(this.directory(id)));
    if ((runState.scopes.getStore() ?? []).some(owner => owner.active && owner.kind === 'run' && owner.key !== key)) {
      return this.#read(id, options);
    }
    return this.withRunWriter(id, () => this.#read(id, options));
  }
  // Lease/progress operations run under the same exclusive writer, using the
  // Host-owned append-only tail. Explicit reads/recovery retain full validation.
  async readActive(id) {
    return this.read(id, { verify_resources: false, incremental: true });
  }
  // Ordinary state reads are not whole-package resource audits. Executable
  // consumers verify their actual selected bytes; audit() is the explicit lane.
  async audit(id) { return this.read(id, {verify_resources:true}); }
  async #read(id, {verify_resources=false,incremental=false}={}, {allow_retiring=false}={}) {
    const root = this.directory(id); await noSymlinks(root);
    const retained = await this.retained(id);
    requireValue(!retained || allow_retiring && retained.cleanup_complete === false,
      'RUN_RETIRED', 'Run process data was cleaned; its saved result remains available and cannot be replayed');
    const { events } = await this.#journalReader.read(join(root, 'events.jsonl'), {incremental});
    // replayEvents references later patches; callers receive mutable state, not
    // aliases into the reader's immutable verified event evidence.
    const state = structuredClone(replayEvents(events));
    requireValue(state.run_id === id, 'RUN_IDENTITY', 'Run journal identity mismatch');
    const pinPath = join(root, 'pins.json'); await noSymlinks(pinPath);
    const pinInfo = await lstat(pinPath, {bigint:true});
    requireValue(pinInfo.isFile() && pinInfo.size <= 16n * 1024n * 1024n, 'RUN_PINS_LIMIT', 'Pinned metadata must be a bounded regular file');
    const identity = [pinInfo.dev,pinInfo.ino,pinInfo.size,pinInfo.mtimeNs,pinInfo.ctimeNs].join('/');
    const prior = this.#activePins.get(id);
    let pins;
    if(incremental && prior?.identity === identity && prior.hash === state.pins_hash) pins=structuredClone(prior.pins);
    else {
      const pinBytes = await readFile(pinPath);
      requireValue(pinBytes.length <= 16 * 1024 * 1024, 'RUN_PINS_LIMIT', 'Pinned metadata grew beyond limit');
      pins=JSON.parse(pinBytes.toString('utf8'));
      requireValue(digest(canonicalJSON(pins)) === state.pins_hash, 'RUN_PINS_CORRUPT', 'Run pins differ from the committed start');
      this.#activePins.delete(id);this.#activePins.set(id,{identity,hash:state.pins_hash,pins:structuredClone(pins)});
      while(this.#activePins.size>16)this.#activePins.delete(this.#activePins.keys().next().value);
    }
    for (const resource of verify_resources ? pins.resources ?? [] : []) {
      requireValue(/^[a-f0-9]{64}$/.test(resource.sha256), 'RUN_RESOURCE', 'Invalid resource digest');
      const path = join(root, 'objects', resource.sha256); await noSymlinks(path);
      const info = await lstat(path);
      requireValue(info.isFile() && info.size <= LIMITS.resource, 'RUN_RESOURCE', 'Pinned resource must be a bounded regular file');
      const bytes = await readFile(path);
      requireValue(bytes.length === resource.bytes && digest(bytes) === resource.sha256, 'RUN_RESOURCE_CORRUPT', 'Pinned resource is missing or modified');
    }
    return { state, pins, events, sequence: events.length };
  }
  // Observation never joins writer admission or retires an owner. Journals are
  // append-only and pins immutable: validate the actual bytes read, including
  // strict hash-chain/tail checks, even if a prior writer requires recovery.
  // Execution and destructive cleanup retain their exclusive read contract.
  async observe(id) { return this.#read(id,{verify_resources:false}); }
  async observeProgress(id) { return this.#read(id,{verify_resources:false,incremental:true}); }

  // Storage maintenance may inspect an interrupted trim only while the original
  // strict journal/pins still exist. A compact retained result cannot authorize
  // admission recovery, and this lane never releases execution or repairs data.
  async observeAdmission(id) { return this.#read(id,{verify_resources:false},{allow_retiring:true}); }

  async mutate(id, kind, mutate, { expected_sequence } = {}) {
    const root = this.directory(id);
    return this.withRunWriter(id, async () => {
      const current = await this.#read(id, { verify_resources: false, incremental: true });
      if (expected_sequence !== undefined) requireValue(current.sequence === expected_sequence, 'RUN_SEQUENCE_CONFLICT', 'Run changed since it was read');
      const next = structuredClone(current.state);
      const result = await mutate(next, current.pins, current);
      requireValue(next.run_id === id && next.pins_hash === current.state.pins_hash, 'RUN_IDENTITY', 'A transition cannot change Run identity/pins');
      const patch = statePatch(current.state, next);
      if (Object.values(patch).every(values => !Object.keys(values).length)) return { ...current, result, idempotent: true };
      const event = await appendEvent(join(root, 'events.jsonl'), current.events, kind, { patch });
      return { state: next, pins: current.pins, sequence: event.sequence, result, events: [...current.events, event] };
    });
  }

  async retained(id) {
    const path=join(this.directory(id),'retained.json');
    let value; try { await noSymlinks(path);value=JSON.parse(await readFile(path,'utf8')); } catch(error){if(error.code==='ENOENT')return null;throw error;}
    requireValue(value.schema_version===1 && value.state?.run_id===id && ['succeeded','failed','cancelled'].includes(value.state.status),
      'RUN_RETAINED_IDENTITY','Retained result must identify one terminal Run');
    return value;
  }

  async recover(id, repairState = () => {}, authorizeRecovery = () => {}) {
    const root = this.directory(id); const writer = new WorkflowStore(root);
    return scopedOperation(root, 'run', async () => {
    const owner = await writer.inspectWriter();
    if (owner) await writer.recoverWriter(owner.token); // Only a confirmed absent owner can be recovered.
    return writer.withRunAdmission(async () => {
      const committed = await readEvents(join(root, 'events.jsonl'), { allowTornTail: true });
      await authorizeRecovery(replayEvents(committed.events));
      const repaired = await recoverEventTail(join(root, 'events.jsonl'));
      const current = await this.read(id); const next = structuredClone(current.state);
      await repairState(next, current.pins, current);
      const patch = statePatch(current.state, next);
      let event = current.events.at(-1);
      if (repaired.recovered || Object.values(patch).some(value => Object.keys(value).length)) {
        event = await appendEvent(join(root, 'events.jsonl'), current.events, 'recover', { patch, journal_recovery: repaired.recovered });
      }
      return { state: next, pins: current.pins, sequence: event.sequence };
    });
    });
  }

  // Successful authoring Runs pin the private source bundle.  Once a reviewed
  // source-free conversion is committed, retain neither the journal nor its
  // resource objects.  Exact pinned identities prevent this internal cleanup
  // primitive from becoming a general Run-deletion API.
  async purge(id, { expected_workflow_id, expected_revision, expected_source_workflow_id, expected_source_revision, allow_missing = false } = {}) {
    requireValue(typeof allow_missing === 'boolean', 'RUN_PURGE_POLICY', 'Run purge missing policy must be explicit');
    const root = this.directory(id);
    return this.writer.withWriter(async () => {
      let current;
      let identity;
      try {
        await this.withRunWriter(id, async () => {
          current = await this.read(id);
          const provenance = current.pins.root.provenance;
          requireValue(current.state.status === 'succeeded' && provenance?.kind === 'authoring_workflow_run',
            'RUN_PURGE_STATE', 'Only a succeeded current authoring Run can be permanently purged');
          requireValue(current.pins.root.workflow.id === expected_workflow_id && current.pins.root.revision_hash === expected_revision,
            'RUN_PURGE_IDENTITY', 'Run-pinned authoring Workflow identity changed before purge');
          requireValue(provenance.source_workflow_id === expected_source_workflow_id && provenance.source_revision === expected_source_revision,
            'RUN_PURGE_SOURCE', 'Run-pinned source identity changed before purge');
          await noSymlinks(root); const info = await lstat(root);
          requireValue(info.isDirectory() && !info.isSymbolicLink(), 'RUN_PURGE_TARGET', 'Run purge target must be one exact Run directory');
          identity = info;
          // Fence future journal entry before releasing this exact writer. The
          // root creation writer remains held until erasure settles. Interrupted
          // purge retains this recovery marker and never permits a new callback.
          await mkdir(join(root, '.recovery.lock'));
        });
      } catch (error) {
        if (allow_missing && error?.code === 'ENOENT' && !current) return { run_id: id, purged: false, missing: true };
        throw error;
      }
      await noSymlinks(root); const beforeDelete = await lstat(root);
      requireValue(beforeDelete.dev === identity.dev && beforeDelete.ino === identity.ino, 'RUN_PURGE_TARGET', 'Run purge directory identity changed');
      await rm(insideRoot(this.root, root), { recursive: true });
      await syncDirectory(this.root);
      return { run_id: id, purged: true, sequence: current.sequence };
    });
  }

  async list() {
    await noSymlinks(this.root); const runs = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (['.pending', '.trash', '.writer.lock', '.recovery.lock', '.run-locks', '.admission-queue'].includes(entry.name)) { await noSymlinks(join(this.root, entry.name)); continue; }
      requireValue(entry.isDirectory() && !entry.isSymbolicLink() && /^run-.+\.run$/.test(entry.name), 'RUN_STORE_ENTRY', 'Unexpected Run store entry');
      if(await this.retained(entry.name.slice(4,-4)))continue;
      if(!await journalStarted(join(this.root, entry.name)))continue;
      const { state, sequence } = await this.observe(entry.name.slice(4, -4));
      runs.push({ run_id: state.run_id, workflow_id: state.workflow_id, status: state.status, sequence });
    }
    return runs.sort((a, b) => a.run_id < b.run_id ? -1 : 1);
  }
}
