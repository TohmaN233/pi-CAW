import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { watch } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireValue, noSymlinks, insideRoot, workflowId } from '../core/workflow-paths.mjs';
import { readEvents, replayEvents, writeDurableJSON } from '../core/workflow-events.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { syncDirectory } from '../core/workflow-store.mjs';

const modulePath = fileURLToPath(import.meta.url), MAX_RPC = 8 * 1024 * 1024;
const terminal = phase => ['succeeded', 'cancelled', 'stopped', 'failed'].includes(phase);
const error = (code, message) => Object.assign(new Error(message), { code });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function writeOwnerJSON(path, value) {
  const deadline = Date.now() + 1000; let retry = 0;
  for (;;) {
    try { return await writeDurableJSON(path, value); }
    catch (cause) {
      // Windows can briefly deny an atomic replacement while another process
      // reads this same status. Retry only that bounded sharing violation;
      // exhaustion still rejects the publication and leaves ownership fenced.
      if (process.platform !== 'win32' || !['EBUSY', 'EACCES', 'EPERM'].includes(cause.code) || Date.now() >= deadline) throw cause;
      if (!retry++) process.stderr.write(`${JSON.stringify({ code: 'OWNER_DURABLE_RETRY', operation: 'atomic_publication', cause: cause.code })}\n`);
      await delay(10);
    }
  }
}
function diagnostic(cause) {
  return { code: cause?.code ?? 'OWNER_FAILURE', message: String(cause?.message ?? cause)
    .replace(/\bBearer\s+\S+/ig, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie|secret)\s*[:=]\s*)\S+/ig, '$1[redacted]').slice(0, 2000) };
}
function endpoint(value) {
  const parsed = new URL(value.url);
  requireValue(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.pathname === '/owner-rpc'
    && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.port
    && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)
    && typeof value.owner_id === 'string' && value.owner_id, 'OWNER_ENDPOINT', 'Owner endpoint must have exact private loopback identity');
  return parsed;
}
export function assertOwnerDescriptor(value) { endpoint(value); return structuredClone(value); }

function notificationEntries(state) {
  const events = state.outcome?.parent_notification?.events ?? [];
  requireValue(Array.isArray(events) && events.length <= 10000, 'OWNER_NOTIFICATION_EVENTS', 'Queued parent notifications must be bounded original events');
  const seen = new Set();
  return events.flatMap(event => {
    requireValue(event && typeof event.status === 'string' && (typeof event.run_id === 'string' || typeof event.role_run_id === 'string'),
      'OWNER_NOTIFICATION_IDENTITY', 'Queued notification needs its original Run or Role identity');
    const hash = digest(canonicalJSON({ owner_id: state.owner_id, event }));
    if (seen.has(hash)) return []; seen.add(hash);
    return [{ owner_id: state.owner_id, main_actor: state.main_actor, hash, event: structuredClone(event) }];
  });
}

async function withNotificationLog(directory, state, mutate, assertCurrent) {
  const path = join(directory, 'notifications.private.jsonl'), lockPath = path + '.lock';
  await noSymlinks(directory); const deadline = Date.now() + 1000; let lock;
  for (;;) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; requireValue(Date.now() < deadline, 'OWNER_NOTIFICATION_BUSY', 'Exact notification acknowledgment journal is busy; inspect ownership before retrying'); await delay(10); }
  }
  try {
    await assertCurrent(); let bytes = Buffer.alloc(0);
    try { await noSymlinks(path); const info = await lstat(path); requireValue(info.isFile() && info.size <= MAX_RPC, 'OWNER_NOTIFICATION_LIMIT', 'Private delivery journal must be a bounded file'); bytes = await readFile(path); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    requireValue(!bytes.length || bytes.at(-1) === 10, 'OWNER_NOTIFICATION_CORRUPT', 'Delivery journal has an uncommitted tail');
    const records = bytes.length ? bytes.toString('utf8').slice(0, -1).split('\n').map(line => JSON.parse(line)) : [], acknowledged = new Map();
    let previous = null;
    for (const [index, record] of records.entries()) {
      const { record_hash, ...content } = record;
      requireValue(content.sequence === index + 1 && content.previous === previous && digest(canonicalJSON(content)) === record_hash
        && content.run_id === state.run_id && content.owner_id === state.owner_id && content.main_actor === state.main_actor
        && content.event && digest(canonicalJSON({ owner_id: state.owner_id, event: content.event })) === content.hash
        && !acknowledged.has(content.hash), 'OWNER_NOTIFICATION_CORRUPT', 'Delivery journal has invalid exact-owner acknowledgment evidence');
      acknowledged.set(content.hash, content); previous = record_hash;
    }
    const result = await mutate(acknowledged);
    if (result.append) {
      const content = { sequence: records.length + 1, previous, run_id: state.run_id, owner_id: state.owner_id, main_actor: state.main_actor,
        hash: result.append.hash, event: result.append.event, at: new Date().toISOString() };
      const record = { ...content, record_hash: digest(canonicalJSON(content)) }, appended = canonicalJSON(record) + '\n';
      requireValue(bytes.length + Buffer.byteLength(appended) <= MAX_RPC, 'OWNER_NOTIFICATION_LIMIT', 'Delivery acknowledgment journal is full');
      const file = await open(path, 'a', 0o600);
      try { await file.writeFile(appended); await file.sync(); } finally { await file.close(); }
      await syncDirectory(directory);
    }
    return result.value;
  } finally { await lock.close(); await unlink(lockPath); }
}

// This transport is shared with the active Pi chat bridge. Descriptors are Host
// credentials, never model tool results or public owner status.
export async function createOwnerRpcServer({ token = randomBytes(32).toString('hex'), run_id, owner_id = randomUUID(), handle }) {
  requireValue(typeof handle === 'function', 'OWNER_RPC_HANDLER', 'Owner RPC needs an explicit handler');
  endpoint({ url: 'http://127.0.0.1:1/owner-rpc', token, owner_id });
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      const supplied = request.headers.authorization ?? '', expected = `Bearer ${token}`;
      requireValue(request.method === 'POST' && request.url === '/owner-rpc' && !request.headers.origin
        && Buffer.byteLength(supplied) === Buffer.byteLength(expected)
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)), 'OWNER_RPC_AUTH', 'Private owner authentication failed');
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; requireValue(bytes <= MAX_RPC, 'OWNER_RPC_SIZE', 'Owner request exceeds its bounded transport'); chunks.push(chunk); }
      const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requireValue(packet.owner_id === owner_id && (run_id === undefined || packet.run_id === run_id), 'OWNER_RPC_IDENTITY', 'Owner request belongs to another exact owner or Run');
      requireValue(typeof packet.operation === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(packet.operation)
        && packet.args && typeof packet.args === 'object' && !Array.isArray(packet.args), 'OWNER_RPC_REQUEST', 'Owner RPC requires an explicit operation and arguments');
      const result = await handle(packet.operation, packet.args, { run_id: packet.run_id, owner_id });
      requireValue(result !== undefined, 'OWNER_RPC_RESULT', 'Owner operation returned no explicit result');
      const body = JSON.stringify({ ok: true, result });
      requireValue(Buffer.byteLength(body) <= MAX_RPC, 'OWNER_RPC_SIZE', 'Owner response exceeds its bounded transport');
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(body);
    } catch (cause) {
      if (!response.destroyed) { response.writeHead(cause.code === 'OWNER_RPC_AUTH' ? 403 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ ok: false, error: diagnostic(cause) })); }
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListening(); }); });
  const descriptor = { url: `http://127.0.0.1:${server.address().port}/owner-rpc`, token, owner_id, ...(run_id ? { run_id } : {}) };
  let closing;
  return { descriptor, close() { if (!closing) { closing = new Promise((resolveClosed, reject) => server.close(cause => cause ? reject(cause) : resolveClosed())); for (const socket of sockets) socket.destroy(); } return closing; } };
}

export function ownerRpc(descriptor, operation, args = {}, { timeoutMs = 30000, signal } = {}) {
  const target = endpoint(descriptor);
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0, 'OWNER_RPC_TIMEOUT', 'Owner RPC deadline must be explicit nonnegative milliseconds');
  const body = JSON.stringify({ run_id: descriptor.run_id, owner_id: descriptor.owner_id, operation, args });
  requireValue(Buffer.byteLength(body) <= MAX_RPC, 'OWNER_RPC_SIZE', 'Owner request exceeds its bounded transport');
  return new Promise((resolveResult, reject) => {
    const request = httpRequest(target, { method: 'POST', headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, signal }, response => {
      let bytes = 0; const chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_RPC) request.destroy(error('OWNER_RPC_SIZE', 'Owner response exceeds its bounded transport')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (value.ok !== true) throw Object.assign(error(value.error?.code ?? 'OWNER_RPC_FAILURE', value.error?.message ?? 'Owner operation failed'), {rpc_application_error:true}); resolveResult(value.result); }
        catch (cause) { reject(cause); }
      });
    });
    const timer = timeoutMs ? setTimeout(() => request.destroy(error('OWNER_RPC_TIMEOUT', 'Owner did not complete this exact request before its deadline')), timeoutMs) : null;
    request.on('close', () => clearTimeout(timer)); request.on('error', reject); request.end(body);
  });
}

export class DetachedOwnerRegistry {
  constructor({ directory, handshakeMs = 15000, heartbeatMs = 5000 } = {}) {
    requireValue(isAbsolute(directory) && Number.isSafeInteger(handshakeMs) && handshakeMs >= 100
      && Number.isSafeInteger(heartbeatMs) && heartbeatMs >= 20 && heartbeatMs <= 60000, 'OWNER_CONFIGURATION', 'Detached owners need absolute state and bounded lifecycle intervals');
    this.root = join(resolve(directory), 'detached-owners'); this.handshakeMs = handshakeMs; this.heartbeatMs = heartbeatMs;
  }
  paths(runId) { const directory = insideRoot(this.root, join(this.root, `run-${workflowId(runId)}.owner`)); return { directory, status: join(directory, 'status.json'), private: join(directory, 'owner.private.json') }; }
  async list() { let entries;
    try { await noSymlinks(this.root); entries = await readdir(this.root, { withFileTypes: true }); } catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    const states = await Promise.all(entries.filter(entry => /^run-[a-z0-9][a-z0-9._-]{0,63}\.owner$/.test(entry.name)).map(async entry => {
      requireValue(entry.isDirectory() && !entry.isSymbolicLink(), 'OWNER_IDENTITY', 'Current owner entry must be an owned directory');
      return this.read(entry.name.slice(4, -6));
    })); return states.filter(Boolean); }
  async history(runId) { const directory = insideRoot(this.root, join(this.root, `run-${workflowId(runId)}.history`)); let entries;
    try { await noSymlinks(directory); entries = await readdir(directory, { withFileTypes: true }); } catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
    return Promise.all(entries.map(async entry => { requireValue(entry.isDirectory() && /^owner-[a-f0-9-]{36}\.owner$/.test(entry.name), 'OWNER_HISTORY_IDENTITY', 'Unexpected owned generation history entry');
      const path = insideRoot(directory, join(directory, entry.name, 'status.json')); await noSymlinks(path); const state = JSON.parse(await readFile(path, 'utf8')); requireValue(state.run_id === runId && state.termination?.confirmed && terminal(state.phase), 'OWNER_HISTORY_IDENTITY', 'History must retain exact confirmed terminal ownership'); return state; })); }
  async read(runId) {
    let value; try { await noSymlinks(this.paths(runId).status); value = JSON.parse(await readFile(this.paths(runId).status, 'utf8')); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    requireValue(value.run_id === runId && typeof value.owner_id === 'string' && Number.isSafeInteger(value.revision), 'OWNER_IDENTITY', 'Owner journal belongs to another identity');
    if (terminal(value.phase)) return value;
    if (Date.now() - Date.parse(value.heartbeat_at ?? value.at) > Math.max(this.handshakeMs, this.heartbeatMs * 3))
      return { ...value, phase: 'stale', error: { code: 'OWNER_HEARTBEAT_STALE', message: 'Detached owner stopped publishing heartbeat; exact recovery is required' } };
    if (value.pid) try { process.kill(value.pid, 0); }
    catch (cause) {
      if (cause.code !== 'ESRCH' && cause.code !== 'EPERM') throw cause;
      if (cause.code === 'ESRCH') { const latest = JSON.parse(await readFile(this.paths(runId).status, 'utf8')); requireValue(latest.owner_id === value.owner_id && latest.pid === value.pid, 'OWNER_IDENTITY', 'Owner changed during exit observation');
        return terminal(latest.phase) ? latest : { ...latest, phase: 'orphaned', termination: { confirmed: false }, error: { code: 'OWNER_EXIT_UNCONFIRMED', message: 'Detached owner exited without a quiescence receipt; no replay was released' } }; }
    }
    return value;
  }
  async descriptor(runId) { const state = await this.read(runId), path = this.paths(runId).private; await noSymlinks(path); const value = JSON.parse(await readFile(path, 'utf8'));
    requireValue(state && value.run_id === runId && value.owner_id === state.owner_id && value.pid === state.pid, 'OWNER_IDENTITY', 'Private endpoint does not belong to the exact journaled owner'); endpoint(value); return value; }
  async private(runId) { return this.descriptor(runId); }
  async notificationState(runId) { const state = await this.read(runId);
    requireValue(state && terminal(state.phase) && state.termination?.confirmed === true, 'OWNER_NOTIFICATION_STATE', 'Notification delivery requires confirmed terminal ownership'); return state; }
  async pendingNotifications(runId) { const state = await this.notificationState(runId), entries = notificationEntries(state);
    return withNotificationLog(this.paths(runId).directory, state, async acknowledged => ({ value: entries.filter(entry => !acknowledged.has(entry.hash)) }),
      async () => requireValue((await this.notificationState(runId)).owner_id === state.owner_id, 'OWNER_NOTIFICATION_OWNER', 'Owner generation changed before delivery')); }
  async ackNotifications(runId, { owner_id, hash }) { const state = await this.notificationState(runId);
    requireValue(owner_id === state.owner_id, 'OWNER_NOTIFICATION_OWNER', 'Delivery acknowledgment belongs to another exact owner');
    requireValue(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'OWNER_NOTIFICATION_HASH', 'Delivery acknowledgment needs an exact notification hash');
    return withNotificationLog(this.paths(runId).directory, state, async acknowledged => {
      if (acknowledged.has(hash)) return { value: { owner_id, hash, acknowledged: true, already_acknowledged: true } };
      const entry = notificationEntries(state).find(item => item.hash === hash);
      requireValue(entry, 'OWNER_NOTIFICATION_HASH', 'No original queued notification has this exact hash');
      return { append: entry, value: { owner_id, hash, acknowledged: true, already_acknowledged: false } };
    }, async () => requireValue((await this.notificationState(runId)).owner_id === owner_id, 'OWNER_NOTIFICATION_OWNER', 'Owner generation changed before acknowledgment')); }
  async isAlive(runId) { const state = await this.read(runId); if (!state || state.termination?.confirmed && terminal(state.phase)) return false;
    const descriptor = await this.descriptor(runId), observed = await ownerRpc(descriptor, 'owner_read');
    requireValue(observed.run_id === runId && observed.owner_id === descriptor.owner_id && observed.pid === descriptor.pid, 'OWNER_IDENTITY', 'Live endpoint did not attest the exact persisted owner'); return true; }
  async launch({ run_id, controller_hash, main_actor, controller_journal, runtime_entry, boot = {}, parent_bridge }) {
    const paths = this.paths(run_id);
    requireValue(/^[a-f0-9]{64}$/.test(controller_hash) && typeof main_actor === 'string' && main_actor && isAbsolute(controller_journal), 'OWNER_AUTHORITY', 'Detached launch requires exact controller and chat identity');
    if (parent_bridge) { endpoint(parent_bridge); requireValue(parent_bridge.run_id === run_id && parent_bridge.main_actor === main_actor,
      'OWNER_REATTACH_IDENTITY', 'Initial parent bridge must belong to this exact Run and original chat'); }
    const entry = runtime_entry?.startsWith('file:') ? fileURLToPath(runtime_entry) : runtime_entry;
    requireValue(typeof entry === 'string' && isAbsolute(entry), 'OWNER_RUNTIME_ENTRY', 'Detached owner needs one explicit local runtime entry'); await noSymlinks(entry);
    const current = replayEvents((await readEvents(controller_journal)).events);
    requireValue(current.run_id === run_id && current.control_hash === controller_hash && current.main_actor === main_actor
      && !['cancelled', 'failed', 'interrupted', 'succeeded'].includes(current.status), 'OWNER_AUTHORITY', 'Launch does not match the exact active controller journal');
    const prior = await this.read(run_id);
    if (prior) {
      const authorityStopped = prior.phase === 'stopped' && prior.termination?.reason === 'authority_revoked'
        && prior.controller_hash === controller_hash && current.status === 'running';
      requireValue(terminal(prior.phase) && prior.termination?.confirmed === true && (prior.controller_hash !== controller_hash || authorityStopped),
        'OWNER_EXISTS', 'Existing ownership needs confirmed quiescence and controller rotation or an exact reconciled authority stop');
      const previous = await this.descriptor(run_id);
      requireValue(previous.controller_hash === prior.controller_hash, 'OWNER_RECOVERY_AUTHORITY', 'Prior terminal generation has no exact controller identity');
      const history = insideRoot(this.root, join(this.root, `run-${workflowId(run_id)}.history`)); await mkdir(history, { recursive: true }); await noSymlinks(history);
      const archived = insideRoot(history, join(history, `owner-${prior.owner_id}.owner`)); await noSymlinks(paths.directory);
      const deadline = Date.now() + 1000;
      for (;;) { try { await rename(paths.directory, archived); break; } catch (cause) { if (!['EBUSY', 'EACCES', 'EPERM'].includes(cause.code) || Date.now() >= deadline) throw cause; await delay(10); } }
    }
    await mkdir(this.root, { recursive: true }); await noSymlinks(this.root); await mkdir(paths.directory); await noSymlinks(paths.directory);
    const owner_id = randomUUID(), started_at = new Date().toISOString();
    const starting = { schema_version: 1, run_id, owner_id, controller_hash, main_actor, generation: (prior?.generation ?? 0) + 1,
      pid: null, phase: 'starting', status: 'starting', revision: 1, started_at, at: started_at, heartbeat_at: started_at };
    await writeOwnerJSON(paths.status, starting);
    const log = await open(join(paths.directory, 'owner.log'), 'a', 0o600); let child;
    try { child = spawn(process.execPath, [modulePath, '--serve', paths.directory], { cwd: paths.directory, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] }); }
    finally { await log.close(); }
    let spawnError; const captureSpawnError = cause => { spawnError = cause; }; child.on('error', captureSpawnError);
    await writeOwnerJSON(paths.status, { ...starting, pid: child.pid ?? null });
    try {
      if (spawnError) throw spawnError;
      await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(error('OWNER_START_TIMEOUT', 'Detached owner did not acknowledge exact startup; inspect its journal without replay')); }, this.handshakeMs);
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', rejectStart); child.off('exit', exited); };
        const message = packet => { if (packet?.type === 'ready' && packet.run_id === run_id && packet.owner_id === owner_id && packet.pid === child.pid) { cleanup(); resolveReady(); }
          else if (packet?.type === 'failed') { cleanup(); reject(error(packet.error?.code ?? 'OWNER_START_FAILED', packet.error?.message ?? 'Detached owner failed before readiness')); } };
        const rejectStart = cause => { cleanup(); reject(cause); }, exited = () => rejectStart(error('OWNER_START_EXIT', 'Detached owner exited before exact readiness'));
        child.on('message', message); child.once('error', rejectStart); child.once('exit', exited);
        child.send({ run_id, owner_id, controller_hash, main_actor, controller_journal, runtime_entry: entry, boot, parent_bridge, heartbeatMs: this.heartbeatMs }, cause => { if (cause) rejectStart(cause); });
      });
      if (child.connected) child.disconnect(); child.unref(); child.off('error', captureSpawnError); return { ...await this.read(run_id), detached: true };
    } catch (cause) { if (child.connected) child.disconnect(); child.unref(); child.off('error', captureSpawnError); throw cause; }
  }
  async call(runId, operation, args = {}, options) { return ownerRpc(await this.descriptor(runId), operation, args, options); }
  async wait(runId, { after_revision = 0, timeoutMs = 30000 } = {}) { const state = await this.read(runId); if (!state || state.revision > after_revision || terminal(state.phase)) return state;
    return this.call(runId, 'owner_wait', { after_revision, timeoutMs }, { timeoutMs: timeoutMs + 1000 }); }
  async stop(runId, reason = 'requested') { const state = await this.read(runId); if (state?.termination?.confirmed && terminal(state.phase)) return state;
    return this.call(runId, 'owner_stop', { reason }, { timeoutMs: 0 }); }
  async reattach(runId, { parent_bridge, main_actor, controller_hash }) { return this.call(runId, 'owner_reattach', { parent_bridge, main_actor, controller_hash }); }
}

async function serveOwner(directory) {
  requireValue(process.send && isAbsolute(directory), 'OWNER_BOOT', 'Detached runtime requires private launch IPC');
  const launch = await new Promise(resolveLaunch => process.once('message', resolveLaunch));
  const statusPath = join(directory, 'status.json'), privatePath = join(directory, 'owner.private.json');
  let state = JSON.parse(await readFile(statusPath, 'utf8'));
  requireValue(state.run_id === launch.run_id && state.owner_id === launch.owner_id && state.pid === process.pid, 'OWNER_IDENTITY', 'Bootstrap does not own this exact starting journal');
  let publication = Promise.resolve(), runtime, rpc, watcher, heartbeat, checking = false, tornSince = null, stopping, revoked = false, initializing = false, activeCalls = 0, knownTerminal;
  const authority = new AbortController(), waiters = new Set();
  const publish = patch => { const next = publication.then(async () => {
    state = { ...state, ...patch, revision: state.revision + 1, at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
    await writeOwnerJSON(statusPath, state); for (const notify of waiters) notify(); return structuredClone(state);
  }); publication = next; return next; };
  const readAuthority = async () => {
    const current = replayEvents((await readEvents(launch.controller_journal)).events);
    requireValue(current.run_id === launch.run_id, 'OWNER_AUTHORITY_IDENTITY', 'Authority journal belongs to another Run');
    return current;
  };
  const assertAuthority = async () => {
    requireValue(!revoked && !authority.signal.aborted, 'OWNER_AUTHORITY_REVOKED', 'Detached owner effect authority was revoked');
    const current = await readAuthority();
    if (current.control_hash !== launch.controller_hash || current.main_actor !== launch.main_actor || ['cancelled', 'failed', 'interrupted', 'succeeded'].includes(current.status)) {
      const cause = error('OWNER_AUTHORITY_REVOKED', 'Controller, chat identity or Run status revoked this exact owner');
      revoked = true; authority.abort(cause);
      if (runtime) {
        const changed = current.control_hash !== launch.controller_hash || current.main_actor !== launch.main_actor;
        const reason = changed ? 'authority_revoked' : current.status === 'cancelled' ? 'cancelled' : current.status === 'succeeded' ? 'execution_settled' : 'authority_revoked';
        const phase = changed ? 'stopped' : current.status === 'cancelled' ? 'cancelled' : current.status === 'succeeded' ? 'succeeded' : 'stopped';
        // The effect check fences immediately; quiescence may wait for this
        // caller to unwind, so it must never be awaited from that same check.
        const stopped = phase === 'succeeded' ? settleTerminal(phase) : stop(reason, phase);
        stopped.catch(failure => process.stderr.write(`${JSON.stringify(diagnostic(failure))}\n`));
      }
      throw cause;
    }
    return current;
  };
  const stop = (reason, phase = 'stopped', cause) => {
    if (stopping) return stopping;
    revoked = true; authority.abort(error('OWNER_AUTHORITY_REVOKED', `Detached owner stopped: ${reason}`)); watcher?.close(); clearInterval(heartbeat);
    stopping = (async () => {
      try {
        requireValue(runtime?.stop, 'OWNER_STOP_UNCONFIRMED', 'Runtime has not supplied a quiescence hook');
        const receipt = await runtime.stop(reason);
        requireValue(receipt?.quiescent === true, 'OWNER_STOP_UNCONFIRMED', 'Runtime did not confirm every owned effect producer is quiescent');
        const result = await publish({ phase, status: phase, termination: { confirmed: true, reason }, ...(cause ? { error: diagnostic(cause) } : {}) });
        // Let the exact stop requester receive its durable acknowledgement.
        setTimeout(() => { void rpc.close().catch(closeError => { process.exitCode = 1; process.stderr.write(`${JSON.stringify(diagnostic(closeError))}\n`); }); }, 20);
        return result;
      } catch (stopError) { await publish({ phase: 'failed', status: 'failed', termination: { confirmed: false, reason }, error: diagnostic(stopError) }); throw stopError; }
    })(); stopping.catch(cause => { stopping = undefined; process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`); }); return stopping;
  };
  const settleTerminal = async phase => { while (activeCalls) await delay(10); return stop('execution_settled', phase); };
  const report = async outcome => {
    requireValue(outcome && typeof outcome.status === 'string', 'OWNER_OUTCOME', 'Runtime must report an explicit outcome');
    if (stopping) {
      // stop() awaits the driver, and that driver may still await its delivery
      // metadata publication. This update must never wait on its own stop.
      if (Object.hasOwn(outcome, 'parent_notification')) {
        requireValue(!state.termination?.confirmed, 'OWNER_NOTIFICATION_CLOSED', 'Confirmed quiescence cannot publish new delivery metadata');
        return publish({ outcome: { ...(state.outcome ?? { status: knownTerminal ?? outcome.status }), parent_notification: structuredClone(outcome.parent_notification) } });
      }
      return structuredClone(state);
    }
    if (['succeeded', 'cancelled', 'failed'].includes(outcome.status)) {
      knownTerminal = outcome.status; revoked = true;
      authority.abort(error('OWNER_AUTHORITY_REVOKED', 'Runtime reported its terminal publication boundary'));
    }
    const reported = structuredClone(outcome);
    if (!Object.hasOwn(reported, 'parent_notification') && state.outcome?.parent_notification)
      reported.parent_notification = structuredClone(state.outcome.parent_notification);
    await publish({ outcome: reported, status: outcome.status });
    if (knownTerminal) void settleTerminal(knownTerminal).catch(cause => process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`));
    return structuredClone(state);
  };
  try {
    await assertAuthority();
    rpc = await createOwnerRpcServer({ run_id: launch.run_id, owner_id: launch.owner_id, handle: async (operation, args) => {
      if (operation === 'owner_read') return structuredClone(state);
      if (operation === 'owner_wait') {
        requireValue(Number.isSafeInteger(args.after_revision) && Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= 0 && args.timeoutMs <= 60000, 'OWNER_WAIT', 'Owner wait needs exact revision and a bounded deadline');
        if (state.revision > args.after_revision || terminal(state.phase)) return structuredClone(state);
        await new Promise(resolveWait => { let timer; const notify = () => { clearTimeout(timer); waiters.delete(notify); resolveWait(); }; waiters.add(notify); timer = setTimeout(notify, args.timeoutMs); }); return structuredClone(state);
      }
      if (operation === 'owner_stop') return stop(String(args.reason ?? 'requested').slice(0, 200));
      await assertAuthority();
      requireValue(runtime, 'OWNER_STARTING', 'Exact runtime has not completed registration');
      if (operation === 'owner_reattach') {
        requireValue(args.main_actor === launch.main_actor && args.controller_hash === launch.controller_hash && args.parent_bridge, 'OWNER_REATTACH_IDENTITY', 'Reattach must keep the original current chat and controller identity');
        endpoint(args.parent_bridge); requireValue(args.parent_bridge.run_id === launch.run_id && args.parent_bridge.main_actor === launch.main_actor,
          'OWNER_REATTACH_IDENTITY', 'Replacement bridge belongs to another Run or chat');
        requireValue(typeof runtime.reattach === 'function', 'OWNER_REATTACH_UNSUPPORTED', 'Runtime must explicitly register a replacement current-chat bridge');
        await runtime.reattach(args.parent_bridge); context.parent_bridge = args.parent_bridge;
        return publish({ reattached_at: new Date().toISOString() });
      }
      requireValue(typeof runtime.call === 'function', 'OWNER_OPERATION_UNSUPPORTED', 'Runtime has no registered operation handler');
      activeCalls++;
      try { return await runtime.call(operation, args); } finally { activeCalls--; }
    } });
    await writeOwnerJSON(privatePath, { ...rpc.descriptor, pid: process.pid, controller_hash: launch.controller_hash, main_actor: launch.main_actor });
    const context = { run_id: launch.run_id, controller_hash: launch.controller_hash, main_actor: launch.main_actor, boot: launch.boot,
      parent_bridge: launch.parent_bridge, signal: authority.signal, assertAuthority, report, owner_descriptor: rpc.descriptor,
      ownerEndpoint: rpc.descriptor.url, ownerToken: rpc.descriptor.token, ownerId: launch.owner_id };
    const module = await import(pathToFileURL(launch.runtime_entry).href), createRuntime = module.createOwnerRuntime ?? module.default;
    requireValue(typeof createRuntime === 'function', 'OWNER_RUNTIME_ENTRY', 'Runtime entry must export createOwnerRuntime');
    initializing = true; runtime = await createRuntime(context); initializing = false;
    requireValue(runtime && typeof runtime.stop === 'function' && runtime.completion?.then, 'OWNER_RUNTIME_CONTRACT', 'Runtime must own a completion promise and confirmed-stop hook');
    await assertAuthority(); await publish({ phase: 'running', status: 'running' });
    const check = async () => {
      if (checking || stopping) return; checking = true;
      try {
        const current = await readAuthority(); tornSince = null;
        if (current.control_hash !== launch.controller_hash || current.main_actor !== launch.main_actor) await stop('authority_revoked', 'stopped');
        else if (current.status === 'succeeded') { knownTerminal = 'succeeded'; revoked = true; authority.abort(error('OWNER_AUTHORITY_REVOKED', 'Run reached its accepted terminal boundary')); await settleTerminal('succeeded'); }
        else if (['cancelled', 'failed', 'interrupted'].includes(current.status))
          await stop(current.status === 'cancelled' ? 'cancelled' : 'authority_revoked', current.status === 'cancelled' ? 'cancelled' : 'stopped');
        else await publish({});
      } catch (cause) {
        if (cause.code === 'RUN_JOURNAL_TORN' && (tornSince ??= Date.now()) + 1000 > Date.now()) return;
        if (cause.code === 'ENOENT' && activeCalls) { while (activeCalls) await delay(10); }
        if (cause.code === 'ENOENT' && knownTerminal) { await settleTerminal(knownTerminal); return; }
        await stop('authority_read_failed', 'stopped', cause);
      } finally { checking = false; }
    };
    watcher = watch(dirname(launch.controller_journal), (_event, name) => { if (!name || String(name) === basename(launch.controller_journal)) void check().catch(cause => process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`)); });
    watcher.on('error', cause => { void stop('authority_watch_failed', 'stopped', cause); });
    heartbeat = setInterval(() => { void check().catch(cause => process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`)); }, launch.heartbeatMs);
    if (process.connected) process.send({ type: 'ready', run_id: launch.run_id, owner_id: launch.owner_id, pid: process.pid }, cause => { if (cause) process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`); });
    Promise.resolve(runtime.completion).then(outcome => report(outcome), cause => stop('runtime_failed', 'failed', cause)).catch(cause => process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`));
  } catch (cause) {
    if (runtime) await stop('startup_failed', 'failed', cause);
    else {
      revoked = true; authority.abort(cause);
      // A runtime factory can fail after allocating effect producers. Only its
      // explicit cleanup attestation may release that uncertain ownership.
      const confirmed = !initializing || cause.quiescent === true;
      await publish({ phase: 'failed', status: 'failed', error: diagnostic(cause), termination: { confirmed,
        reason: !initializing ? 'startup_failed_before_runtime' : confirmed ? 'startup_cleanup_confirmed' : 'startup_registration_unconfirmed' } });
      if (rpc && confirmed) await rpc.close();
    }
    if (process.connected) process.send({ type: 'failed', error: diagnostic(cause) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath && process.argv[2] === '--serve') {
  serveOwner(resolve(process.argv[3])).catch(cause => { process.stderr.write(`${JSON.stringify(diagnostic(cause))}\n`); process.exitCode = 1; });
}
