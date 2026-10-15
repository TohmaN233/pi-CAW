import { prepareOwnedCommandTemp } from './owned-command-temp.mjs';
import { createProgramOutput, PROGRAM_DISK_BYTES, programTextResult } from './program-output.mjs';
import { augmentedRuntimeEnvironment } from '../runtime-environment-state.mjs';
import { spawn, execFile } from 'node:child_process';
import { lstat, readFile, readdir, open, rename, unlink, realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { resourcePath, requireValue, noSymlinks, ensureDirectory, insideRoot, canonicalNoLinks } from '../workflow-paths.mjs';
import { pathBoundaries } from '../workflow-bindings.mjs';
import { digest } from '../workflow-revisions.mjs';
import { verifyRuntimeEnvironment } from '../runtime-environment.mjs';

const MAX_FILE = 1024 * 1024;
const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (root, path) => key(path) === key(root) || key(path).startsWith(key(root) + sep);
const textResult = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const errorResult = (code, message) => ({ success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: { code, message } }) }] });
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const RECOVERABLE_TOOL_ERRORS = new Set([
  'PI_TOOL_ARGUMENTS', 'PI_TOOL_PATH', 'INVALID_RESOURCE_PATH', 'PI_TOOL_PATH_DENIED',
  'PI_TOOL_WRITE_DENIED', 'PI_TOOL_DIRECTORY', 'PI_TOOL_DIRECTORY_LIMIT', 'PI_TOOL_FILE',
  'PI_TOOL_ENCODING', 'PI_RESOURCE_DENIED', 'PI_RESOURCE_RANGE', 'PI_RESOURCE_RANGE_LIMIT',
  'PI_RESOURCE_CHUNK',
  'PI_PROGRAM_OUTPUT_ARGUMENTS', 'PI_PROGRAM_OUTPUT_DENIED',
  'PI_TOOL_WRITE_ARGUMENTS', 'PI_TOOL_WRITE_CONFLICT',
]);
function windowsPathToWsl(path) {
  const match = typeof path === 'string' ? path.match(/^([A-Za-z]):[\\/](.*)$/) : null;
  requireValue(match, 'PI_EXECUTION_PATH', 'The inherited WSL execution binding requires Windows drive paths');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}
export function qualifiedExecutionBinding(binding) {
  if (binding === undefined) return null;
  requireValue(binding && binding.kind === 'wsl' && typeof binding.launcher === 'string' && isAbsolute(binding.launcher)
    && basename(binding.launcher).toLowerCase() === 'wsl.exe'
    && win32.dirname(binding.launcher).replaceAll('/', '\\').toLowerCase().endsWith('\\windows\\system32')
    && /^[A-Za-z0-9._-]{1,64}$/.test(binding.distribution)
    && typeof binding.sandbox === 'string' && /^\/(?:[^/\0]+\/)*[^/\0]+$/.test(binding.sandbox)
    && binding.programs && typeof binding.programs === 'object' && !Array.isArray(binding.programs),
  'PI_EXECUTION_BINDING', 'The host execution binding is invalid');
  const programs = Object.entries(binding.programs);
  requireValue(programs.length > 0 && programs.length <= 32 && programs.every(([name, path]) => /^[a-z][a-z0-9_-]{0,31}$/.test(name)
    && typeof path === 'string' && /^\/(?:[^/\0]+\/)*[^/\0]+$/.test(path)), 'PI_EXECUTION_BINDING', 'The host execution programs are invalid');
  const runtimeRoots = binding.runtime_roots ?? ['/usr','/lib','/lib64','/bin','/sbin'];
  requireValue(Array.isArray(runtimeRoots) && runtimeRoots.length > 0 && runtimeRoots.length <= 32
    && runtimeRoots.every(path => typeof path === 'string' && /^\/(?:[^/\0]+\/)*[^/\0]+$/.test(path)
      && !['/mnt','/home','/root','/tmp'].some(blocked => path === blocked || path.startsWith(blocked + '/')))
    && programs.every(([,program]) => runtimeRoots.some(root => program === root || program.startsWith(root + '/'))),
  'PI_EXECUTION_BINDING', 'Every bound program must live under an explicit non-user runtime dependency root');
  const commandTimeoutMs = binding.command_timeout_ms ?? 300000;
  requireValue(Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs >= 1000 && commandTimeoutMs <= 600000, 'PI_EXECUTION_BINDING', 'The host execution deadline is invalid');
  return { ...structuredClone(binding), runtime_roots: [...new Set(runtimeRoots)].sort(), command_timeout_ms: commandTimeoutMs };
}
function nativeExecutionBinding(environment) {
  if (!environment?.tools?.length) return null;
  requireValue(environment.status === 'ready' && environment.tools.every(item => item.status === 'found'
    && /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,99}$/.test(item.name) && typeof item.path === 'string' && isAbsolute(item.path)),
  'PI_EXECUTION_BINDING', 'Discovered task programs must have absolute resolved paths');
  return { kind: 'native', programs: Object.fromEntries(environment.tools.map(item => [item.name, item.path])), command_timeout_ms: 300000 };
}
async function liveNativeProcessGroup(pid) {
  const listing = await new Promise((resolveListing, rejectListing) => {
    execFile('/bin/ps', ['-eo', 'pid=,pgid=,stat='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) rejectListing(error); else resolveListing(stdout);
    });
  });
  const members = [];
  for (const line of listing.split('\n').filter(value => value.trim())) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    requireValue(match, 'PI_EXECUTION_STOP_UNCONFIRMED', 'Cannot parse native process-group ownership');
    // Zombies have exited and cannot produce effects. Some hosts do not reap
    // orphaned zombies promptly, so kill(0) alone cannot confirm effect quiescence.
    if (Number(match[2]) === pid && !match[3].startsWith('Z')) members.push(Number(match[1]));
  }
  return members;
}

// execFile's callback runs after its child has closed, including timeout/error
// paths. Retain a failed stop as uncertainty; neither parent closure nor a
// nonzero taskkill reply establishes ownership of all descendants.
export async function stopNativeWindowsTree(pid, { executor = execFile, timeoutMs = 5000, parentState = () => ({}) } = {}) {
  requireValue(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000,
    'PI_EXECUTION_STOP_ARGUMENTS', 'Windows tree stop requires an exact PID and a bounded Host deadline');
  const started = Date.now();
  return new Promise((resolveStop, rejectStop) => {
    executor(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
      { shell: false, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8192, encoding: 'utf8' },
      (cause, stdout, stderr) => {
        const state = parentState();
        const details = { pid, helper_exit_code: typeof cause?.code === 'number' ? cause.code : cause ? null : 0,
          helper_cause_code: typeof cause?.code === 'string' ? cause.code : null,
          helper_duration_ms: Date.now() - started, helper_timeout_ms: timeoutMs, helper_killed: cause?.killed === true,
          parent_exited: state.exited === true, parent_closed: state.closed === true,
          helper_stdout: String(stdout ?? '').slice(0, 1000), helper_stderr: String(stderr ?? '').slice(0, 1000) };
        if (cause) rejectStop(Object.assign(new Error('Windows native task tree stop failed', { cause }), { code: 'PI_EXECUTION_STOP_UNCONFIRMED', details }));
        else resolveStop(details);
      });
  });
}
// Launcher, signaler and inspector are trusted lifecycle-test seams, never
// Workflow inputs. POSIX tasks own a distinct process group without a sandbox.
export async function executeNativeProgram(binding, request, roots, {
  signal, onHandle, env = process.env, processLauncher = spawn,
  processSignaler = process.kill.bind(process), inspectProcessGroup = liveNativeProcessGroup, outputSink,
} = {}) {
  requireValue(binding?.kind === 'native' && Object.hasOwn(binding.programs, request.program)
    && Array.isArray(request.args) && request.args.length <= 256
    && request.args.every(value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0'))
    && ['workspace', 'task_root'].includes(request.cwd) && (request.cwd !== 'task_root' || roots.task_root),
  'PI_EXECUTION_ARGUMENTS', 'Native task program arguments must match the discovered Host binding');
  requireValue(request.literal || roots.task_root || !request.args.some(value => value.includes('@TASK_ROOT@')), 'PI_EXECUTION_ARGUMENTS',
    'Task-root path substitution needs a declared task_root input');
  if (signal?.aborted) throw signal.reason ?? executionError('PI_EXECUTION_CANCELLED', 'Native program was cancelled before launch');
  const program = binding.programs[request.program];
  const args = request.literal ? request.args : request.args.map(value => value.replaceAll('@WORKSPACE@', roots.workspace)
    .replaceAll('@TASK_ROOT@', roots.task_root ?? ''));
  const cwd = request.workdir ?? (request.cwd === 'workspace' ? roots.workspace : roots.task_root);
  requireValue(!request.literal || typeof request.stdin==='string' && Buffer.byteLength(request.stdin,'utf8')<=1024*1024
    && within(roots.workspace,resolve(cwd)), 'PI_EXECUTION_ARGUMENTS', 'Literal program input and cwd must match the workspace contract');
  const posix = process.platform !== 'win32';
  const child = processLauncher(program, args, { cwd, env, shell: false, windowsHide: true, detached: posix, stdio: [request.literal ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let closed = false, exited = false, quiescent = false, stopReason = null, timer, abort, bytes = 0, stopPromise = null, settled = false;
  let exitCode = null, exitSignal = null, stopDiagnostic = null;
  const stdout = [], stderr = [];
  let resolveClose, rejectClose;
  const done = new Promise((resolveDone, rejectDone) => { resolveClose = resolveDone; rejectClose = rejectDone; });
  let closeObserved;
  const closeSeen = new Promise(resolveSeen => { closeObserved = resolveSeen; });
  const settle = (callback, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer); if (signal && abort) signal.removeEventListener('abort', abort);
    callback(value);
  };
  const confirmStop = async () => {
    const deadline = Date.now() + 5000;
    if (posix && Number.isInteger(child.pid)) {
      try { processSignaler(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      while ((await inspectProcessGroup(child.pid)).length) {
        requireValue(Date.now() < deadline, 'PI_EXECUTION_STOP_UNCONFIRMED', 'Native task process group still has live members after stop');
        await wait(10);
      }
    } else if (!posix && !exited && !closed && Number.isInteger(child.pid)) {
      stopDiagnostic = await stopNativeWindowsTree(child.pid, { parentState: () => ({ exited, closed }) });
    }
    if (!posix && !closed && !exited) child.kill('SIGKILL');
    let stopTimer;
    try { await Promise.race([closeSeen, new Promise((_, reject) => {
      stopTimer = setTimeout(() => reject(executionError('PI_EXECUTION_STOP_UNCONFIRMED', 'Native task program did not close after stop')), 5000);
    })]); }
    finally { clearTimeout(stopTimer); }
    quiescent = true;
  };
  const finish = reason => {
    if (reason) stopReason ??= reason;
    if (quiescent) return Promise.resolve();
    if (!stopPromise) stopPromise = confirmStop().then(() => {
      if (stopReason) {
        if (stopDiagnostic) stopReason.details = { ...(stopReason.details ?? {}), ...stopDiagnostic };
        settle(rejectClose, stopReason);
      }
      else settle(resolveClose, { exit_code: exitCode, signal: exitSignal,
        ...(outputSink ? {} : { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        output: Buffer.concat([...stdout, ...stderr]).toString('utf8') }) });
    }).catch(cause => {
      const error = Object.assign(new AggregateError([...(stopReason ? [stopReason] : []), cause],
        'Native task stopped without confirmed process-group quiescence'), { code: 'PI_EXECUTION_STOP_UNCONFIRMED',
        details: { pid: child.pid ?? null, process_group: posix ? child.pid ?? null : null, cause_code: cause.code ?? null,
          ...(cause.details ?? {}) } });
      settle(rejectClose, error); throw error;
    }).finally(() => { stopPromise = null; });
    return stopPromise;
  };
  const stop = reason => finish(reason ?? executionError('PI_EXECUTION_CANCELLED', 'Native task program was stopped'));
  const requestStop = reason => { void stop(reason).catch(error => settle(rejectClose, error)); };
  const handle = { done, stop, isQuiescent: () => quiescent };
  onHandle?.(handle);
  const collect = (target, stream) => chunk => {
    try {
      if (outputSink) { outputSink.write(stream, chunk); return; }
      bytes += chunk.length;
      requireValue(bytes <= PROGRAM_DISK_BYTES, 'PI_EXECUTION_OUTPUT', 'Native program output exceeded its finite capture limit');
      target.push(chunk);
    } catch (error) { requestStop(error); }
  };
  child.stdout.on('data', collect(stdout, 'stdout')); child.stderr.on('data', collect(stderr, 'stderr'));
  child.once('error', cause => { stopReason ??= Object.assign(new Error(cause.message, {cause}), {
    code: 'PI_EXECUTION_LAUNCH', details: {dependency:request.program,cause_code:cause.code,child_started:Number.isInteger(child.pid)},
  }); });
  child.once('exit', (code, signalName) => {
    exited = true; exitCode = Number.isInteger(code) ? code : null; exitSignal = signalName ?? null;
    // Descendants may retain the pipes or use independent stdio. Parent exit
    // initiates group cleanup; neither exit nor pipe closure releases ownership.
    void finish().catch(error => settle(rejectClose, error));
  });
  child.once('close', (code, signalName) => {
    closed = true; exitCode = Number.isInteger(code) ? code : exitCode; exitSignal = signalName ?? exitSignal;
    closeObserved(); void finish().catch(error => settle(rejectClose, error));
  });
  abort = () => requestStop(signal?.reason ?? executionError('PI_EXECUTION_CANCELLED', 'Native task program was cancelled'));
  if (signal) signal.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  timer = setTimeout(() => requestStop(executionError('PI_EXECUTION_TIMEOUT', 'Native task program exceeded its Host deadline')), binding.command_timeout_ms);
  if (request.literal) {
    child.stdin.on('error', cause => requestStop(Object.assign(new Error('Native program stdin delivery failed', { cause }), {
      code: 'PI_EXECUTION_STDIN', details: { cause_code: cause.code ?? null },
    })));
    child.stdin.end(Buffer.from(request.stdin ?? '', 'utf8'));
  }
  return done;
}
function mountParents(paths) {
  const result=new Set();
  for(const path of paths) {
    const parts=path.split('/').filter(Boolean);parts.pop();let current='';
    for(const part of parts){current+='/'+part;result.add(current);}
  }
  return [...result].sort((left,right)=>left.split('/').length-right.split('/').length||left.localeCompare(right));
}
async function sandboxMasks(roots,explicitDenied=[]) {
  const masks=new Map();let seen=0;
  const visit=async path=>{
    const entries=await readdir(path,{withFileTypes:true});
    requireValue((seen+=entries.length)<=200000,'PI_EXECUTION_SCOPE','Execution workspace is too large to establish the denied-path mask');
    for(const entry of entries){
      const child=join(path,entry.name),lower=entry.name.toLowerCase();
      if(entry.isSymbolicLink()&&(['.git','.pi','.codex','.agents','.skills','skill.md'].includes(lower)))requireValue(false,'PI_EXECUTION_SCOPE','A denied runtime path cannot be represented by a symlink');
      if(entry.isDirectory()&&['.git','.pi','.codex','.agents','.skills'].includes(lower)){masks.set(child,'directory');continue;}
      if(entry.isFile()&&lower==='skill.md'){masks.set(child,'file');continue;}
      if(entry.isDirectory()&&!entry.isSymbolicLink())await visit(child);
    }
  };
  for(const root of [...new Set(roots)])await visit(root);
  for(const path of explicitDenied)for(const root of roots)if(within(root,path)){
    let type='directory';try{type=(await lstat(path)).isDirectory()?'directory':'file';}catch(error){if(error.code==='ENOENT')continue;throw error;}
    masks.set(path,type);
  }
  return [...masks].map(([path,type])=>({path:windowsPathToWsl(path),type}));
}
async function requireWritableTreeWithoutLinks(boundary) {
  await noSymlinks(boundary);
  const rootInfo=await lstat(boundary);
  if(rootInfo.isFile()){
    requireValue(rootInfo.nlink===1,'PI_EXECUTION_SCOPE','Writable program files cannot be hard linked');
    return;
  }
  requireValue(rootInfo.isDirectory(),'PI_EXECUTION_SCOPE','Writable program boundaries must be regular files or directories');
  let seen=0;
  const visit=async directory=>{
    const entries=await readdir(directory,{withFileTypes:true});
    requireValue((seen+=entries.length)<=200000,'PI_EXECUTION_SCOPE','Writable program scope is too large to verify safely');
    for(const entry of entries){
      const child=join(directory,entry.name);
      requireValue(!entry.isSymbolicLink(),'PI_EXECUTION_SCOPE','Writable program scope cannot contain symbolic links');
      const info=await lstat(child);
      if(info.isDirectory()){await visit(child);continue;}
      requireValue(info.isFile()&&info.nlink===1,'PI_EXECUTION_SCOPE','Writable program scope cannot contain hard-linked or special files');
    }
  };
  await visit(boundary);
}
export function boundProgramArgv(binding, { program, args, cwd, literal, workdir }, roots, {masks = [], writable = [], executionId = ''} = {}) {
  requireValue(Object.hasOwn(binding.programs, program) && Array.isArray(args) && args.length <= 256
    && args.every(value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0'))
    && ['workspace', 'task_root'].includes(cwd), 'PI_EXECUTION_ARGUMENTS', 'Execution arguments must match the inherited host binding');
  const workspace = windowsPathToWsl(roots.workspace); const taskRoot = windowsPathToWsl(roots.task_root);
  const writablePaths=[...new Set(writable.map(windowsPathToWsl))];
  requireValue(writablePaths.every(path=>path===workspace||path.startsWith(workspace+'/')),
    'PI_EXECUTION_SCOPE','Bound program writable paths must stay inside the workspace');
  const wholeWorkspace=writablePaths.includes(workspace),nestedWritable=wholeWorkspace?[]:writablePaths;
  const directory = workdir ? windowsPathToWsl(workdir) : cwd === 'workspace' ? workspace : taskRoot;
  const resolvedArgs=literal ? args : args.map(value=>value.replaceAll('@TASK_ROOT@',taskRoot).replaceAll('@WORKSPACE@',workspace));
  const runtimeRoots=binding.runtime_roots;
  const path = [...new Set(Object.values(binding.programs).map(value => dirname(value)))].join(':');
  const parents=[...new Set([...mountParents([...runtimeRoots,workspace,taskRoot,...nestedWritable,...masks.map(item=>item.path)]),...runtimeRoots,workspace,taskRoot])]
    .sort((left,right)=>left.split('/').length-right.split('/').length||left.localeCompare(right));
  return ['-d', binding.distribution, '--exec', binding.sandbox, '--unshare-net','--unshare-pid','--as-pid-1','--die-with-parent','--tmpfs','/',
    ...parents.flatMap(item=>['--dir',item]),...runtimeRoots.flatMap(item=>['--ro-bind-try',item,item]),
    '--ro-bind', taskRoot, taskRoot, wholeWorkspace?'--bind':'--ro-bind', workspace, workspace,
    ...nestedWritable.flatMap(path=>['--bind',path,path]),'--proc', '/proc', '--dev', '/dev','--tmpfs','/tmp',
    ...masks.flatMap(item=>item.type==='directory'?['--tmpfs',item.path]:['--ro-bind','/dev/null',item.path]),'--chdir', directory,
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TASK_ROOT', taskRoot,
    ...(executionId?['--setenv','PI_EXECUTION_ID',executionId]:[]),
    '--setenv', 'WORKSPACE', workspace, '--setenv', 'PATH', path, '--setenv', 'PYTHONNOUSERSITE', '1', binding.programs[program], ...resolvedArgs];
}
const wait=milliseconds=>new Promise(resolveWait=>setTimeout(resolveWait,milliseconds));
const executionError=(code,message)=>Object.assign(new Error(message),{code});
const supervisorScript='identity=$1; token=$2; shift 2; umask 077; printf "%s %s\\n" "$$" "$token" > "$identity"; exec "$@"';
const stopScript='pid=$1; token=$2; case "$pid" in ""|*[!0-9]*) exit 65;; esac; if [ ! -e "/proc/$pid" ]; then exit 0; fi; /usr/bin/grep -a -F -q -- "$token" "/proc/$pid/cmdline" || exit 66; kill -KILL "$pid" 2>/dev/null || true; i=0; while [ -e "/proc/$pid" ] && [ "$i" -lt 200 ]; do sleep 0.01; i=$((i+1)); done; [ ! -e "/proc/$pid" ]';

async function prepareBoundExecution(binding,request,roots,{masks,writable}){
  const executionId=randomUUID(),controlRoot=await mkdtemp(join(tmpdir(),'pi-bound-execution-')),identityPath=join(controlRoot,'identity');
  try{
    const base=boundProgramArgv(binding,request,roots,{masks,writable,executionId});
    requireValue(base[0]==='-d'&&base[1]===binding.distribution&&base[2]==='--exec','PI_EXECUTION_BINDING','Bound execution launcher arguments are malformed');
    return {binding,executionId,controlRoot,identityPath,literal:request.literal,stdin:request.stdin,argv:['-d',binding.distribution,'--exec','/bin/sh','-eu','-c',supervisorScript,'pi-bound-supervisor',windowsPathToWsl(identityPath),executionId,...base.slice(3)]};
  }catch(error){await rm(controlRoot,{recursive:true,force:true});throw error;}
}
async function executionIdentity(prepared,isClosed){
  for(let attempt=0;attempt<200;attempt++){
    try{
      const text=await readFile(prepared.identityPath,'utf8'),match=text.trim().match(/^(\d+) ([0-9a-f-]+)$/i);
      requireValue(match&&match[2]===prepared.executionId,'PI_EXECUTION_IDENTITY','Bound execution identity is invalid');
      return {pid:Number(match[1]),token:match[2]};
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(isClosed())return null;
    await wait(10);
  }
  throw executionError('PI_EXECUTION_STOP_UNCONFIRMED','Bound execution did not publish an exact Linux process identity');
}
async function stopLinuxExecution(prepared,identity,processLauncher){
  if(!identity)return;
  const child=processLauncher(prepared.binding.launcher,['-d',prepared.binding.distribution,'--exec','/bin/sh','-eu','-c',stopScript,'pi-bound-kill',String(identity.pid),identity.token],{shell:false,windowsHide:true,stdio:'ignore'});
  const code=await new Promise((resolveStop,rejectStop)=>{
    let settled=false,timer;
    const finish=callback=>value=>{if(settled)return;settled=true;clearTimeout(timer);callback(value);};
    child.once('error',finish(rejectStop));child.once('close',finish(resolveStop));
    timer=setTimeout(()=>{child.kill();finish(rejectStop)(executionError('PI_EXECUTION_STOP_UNCONFIRMED','Exact Linux stop helper exceeded its host deadline'));},3000);
  });
  requireValue(code===0,'PI_EXECUTION_STOP_UNCONFIRMED','Exact Linux execution unit could not be confirmed stopped');
}
function launchBoundExecution(prepared,{signal,onHandle,processLauncher,removeControl,outputSink}){
  const child=processLauncher(prepared.binding.launcher,prepared.argv,{shell:false,windowsHide:true,stdio:[prepared.literal?'pipe':'ignore','pipe','pipe']});
  const stdout=[],stderr=[];let bytes=0,closed=false,quiescent=false,controlCleaned=false,exitCode=null,exitSignal=null,launchError=null,stopReason=null,stopPromise=null,cleanupPromise=null,timer,abort,doneSettled=false;
  let closeObserved;const closeSeen=new Promise(resolveClose=>{closeObserved=resolveClose;});
  let resolveDone,rejectDone;const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const settleDone=(callback,value)=>{if(doneSettled)return;doneSettled=true;clearTimeout(timer);if(signal&&abort)signal.removeEventListener('abort',abort);callback(value);};
  const stopFailure=error=>Object.assign(new AggregateError([
    stopReason??launchError??executionError('PI_EXECUTION_CANCELLED','Bound execution stopped'),error,
  ],'Bound execution stopped without a confirmed quiescent Linux unit'),{code:'PI_EXECUTION_STOP_UNCONFIRMED'});
  const cleanupControl=()=>{
    if(controlCleaned)return Promise.resolve();
    if(!cleanupPromise)cleanupPromise=removeControl(prepared.controlRoot,{recursive:true,force:true}).then(()=>{controlCleaned=true;}).finally(()=>{if(!controlCleaned)cleanupPromise=null;});
    return cleanupPromise;
  };
  const stop=reason=>{
    if(reason&&!stopReason)stopReason=reason;
    if(quiescent)return cleanupControl();
    if(!stopPromise)stopPromise=(async()=>{
      if(closed){quiescent=true;await cleanupControl();return;}
      const identity=await executionIdentity(prepared,()=>closed);
      try{await stopLinuxExecution(prepared,identity,processLauncher);}catch(error){
        if(closed){quiescent=true;await cleanupControl();return;}
        throw error;
      }
      if(!closed)child.kill();
      await Promise.race([closeSeen,wait(2000).then(()=>{throw executionError('PI_EXECUTION_STOP_UNCONFIRMED','Windows WSL proxy did not close after the exact Linux execution unit stopped');})]);
      quiescent=true;await cleanupControl();
    })().finally(()=>{stopPromise=null;});
    return stopPromise;
  };
  // Process exit and Host control-state cleanup are one externally confirmed
  // lifecycle. A failed control cleanup keeps this handle retryable even though
  // the Linux unit itself has already stopped.
  const handle={done,stop,isQuiescent:()=>quiescent&&controlCleaned};
  if(onHandle)onHandle(handle);
  const requestStop=reason=>{void stop(reason).catch(error=>settleDone(rejectDone,stopFailure(error)));};
  const collect=(target,stream)=>chunk=>{
    try {
      if(outputSink){outputSink.write(stream,chunk);return;}
      bytes+=chunk.length;requireValue(bytes<=PROGRAM_DISK_BYTES,'PI_EXECUTION_OUTPUT','Bound program output exceeded its finite capture limit');target.push(chunk);
    }catch(error){requestStop(error);}
  };
  child.stdout.on('data',collect(stdout,'stdout'));child.stderr.on('data',collect(stderr,'stderr'));
  child.once('error',error=>{launchError=Object.assign(error,{code:'PI_EXECUTION_LAUNCH'});requestStop(launchError);});
  child.once('exit',(code,signalName)=>{exitCode=Number.isInteger(code)?code:null;exitSignal=signalName??null;});
  child.once('close',()=>{closed=true;quiescent=true;closeObserved();void(async()=>{
    try{
      await cleanupControl();
      if(stopReason)settleDone(rejectDone,stopReason);else if(launchError)settleDone(rejectDone,launchError);else{
        const stdoutText=Buffer.concat(stdout).toString('utf8'),stderrText=Buffer.concat(stderr).toString('utf8');
        settleDone(resolveDone,{exit_code:exitCode,signal:exitSignal,...(outputSink?{}:{stdout:stdoutText,stderr:stderrText,output:stdoutText+stderrText})});
      }
    }catch(cleanupError){settleDone(rejectDone,Object.assign(new AggregateError([stopReason??launchError??cleanupError,cleanupError],'Bound execution ended but its host control state could not be cleaned'),{code:'PI_EXECUTION_CLEANUP'}));}
  })();});
  abort=()=>requestStop(signal?.reason instanceof Error?signal.reason:executionError('PI_EXECUTION_CANCELLED','Bound program was cancelled'));
  if(signal)signal.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  timer=setTimeout(()=>requestStop(executionError('PI_EXECUTION_TIMEOUT','Bound program exceeded its host deadline')),prepared.binding.command_timeout_ms);
  if(prepared.literal){
    child.stdin.on('error',cause=>requestStop(Object.assign(new Error('Bound program stdin delivery failed',{cause}),{code:'PI_EXECUTION_STDIN'})));
    child.stdin.end(Buffer.from(prepared.stdin??'','utf8'));
  }
  return handle;
}
// processLauncher/removeControl are trusted in-process lifecycle-test seams.
// Workflow data never reaches them; production uses Node's process/filesystem.
export async function executeBoundProgram(binding,request,roots,{signal,masks=[],writable=[],beforeSpawn,onHandle,processLauncher=spawn,removeControl=rm,outputSink}={}){
  const prepared=await prepareBoundExecution(binding,request,roots,{masks,writable});let launched=false;
  try{
    if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:executionError('PI_EXECUTION_CANCELLED','Bound program was cancelled before launch');
    if(beforeSpawn)await beforeSpawn();
    if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:executionError('PI_EXECUTION_CANCELLED','Bound program was cancelled before launch');
    const handle=launchBoundExecution(prepared,{signal,onHandle,processLauncher,removeControl,outputSink});launched=true;return await handle.done;
  }finally{if(!launched)await rm(prepared.controlRoot,{recursive:true,force:true});}
}
function safeDiagnostic(error) {
  return String(error?.message ?? 'Workspace tool request was rejected')
    .replace(/\bBearer\s+\S+/ig, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie|secret)\s*[:=]\s*)\S+/ig, '$1[redacted]')
    .slice(0, 1000);
}
function argsShape(args, names, required = names) {
  requireValue(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(name=>names.includes(name)) && required.every(name => Object.hasOwn(args, name)), 'PI_TOOL_ARGUMENTS', 'Tool arguments must match the declared schema');
}

// All file access is performed by this host broker. No shell or arbitrary-path
// dynamic reader is exposed. This is an application boundary, not an OS ACL.
export async function createPiToolBroker({ workspace, access, allowedPaths = [], deniedPaths = [], resources = [],
  inputRoots = [], executionBinding, programEnvironment, runtimeEnvironment, prepareRuntimeEnvironment, authorize, onOperation, recoverToolErrors = false,
  programOutputMode = 'model', commandTempBase, prepareCommandTemp = prepareOwnedCommandTemp,
  programOutputDirectory, retainProgramOutput = false, programDeadlineMs,
}) {
  requireValue(['read_only', 'bounded_write'].includes(access) && typeof authorize === 'function' && typeof onOperation === 'function', 'PI_BROKER_AUTHORITY', 'The broker requires explicit access, a live lease check and a durable operation sink');
  requireValue(['model','actual'].includes(programOutputMode), 'PI_BROKER_OUTPUT_MODE', 'Program output mode must be a Host-qualified model or actual operation');
  requireValue(programDeadlineMs === undefined || Number.isSafeInteger(programDeadlineMs) && programDeadlineMs > 0 && programDeadlineMs <= 3600000,
    'PI_BROKER_DEADLINE', 'A trusted Host program deadline must be between 1ms and one hour');
  requireValue(typeof retainProgramOutput==='boolean' && (!retainProgramOutput || typeof programOutputDirectory==='string' && isAbsolute(programOutputDirectory)),
    'PI_BROKER_OUTPUT_SCOPE', 'Retained program output requires an exact absolute Host-owned material directory');
  requireValue(programOutputDirectory===undefined || typeof programOutputDirectory==='string' && isAbsolute(programOutputDirectory),
    'PI_BROKER_OUTPUT_SCOPE', 'Program output directory must be an absolute Host path');
  await noSymlinks(workspace); const root = await realpath(workspace);
  const boundaries = pathBoundaries(allowedPaths).map(path => join(root, ...path.split('/')));
  requireValue(access !== 'bounded_write' || boundaries.length > 0, 'PI_BROKER_SCOPE', 'Write tools require concrete narrowed path boundaries');
  const denied = await Promise.all([...deniedPaths,...(programOutputDirectory?[programOutputDirectory]:[])].map(path => canonicalNoLinks(path)));
  requireValue(Array.isArray(inputRoots) && inputRoots.length <= 32, 'PI_INPUT_ROOTS', 'Input roots must be a bounded array');
  const inputs = new Map();
  for (const item of inputRoots) {
    requireValue(item && /^[a-z][a-z0-9_-]{0,63}$/.test(item.name) && typeof item.path === 'string' && isAbsolute(item.path) && !inputs.has(item.name), 'PI_INPUT_ROOTS', 'Each input root needs a unique portable name and absolute path');
    const path = await canonicalNoLinks(item.path);
    requireValue(!denied.some(value => within(value, path)), 'PI_INPUT_ROOTS', 'An input root cannot expose executor-owned or denied state');
    inputs.set(item.name, path);
  }
  const qualifiedExecution = qualifiedExecutionBinding(executionBinding);
  const withDeadline = binding => binding && programDeadlineMs !== undefined ? { ...binding, command_timeout_ms: programDeadlineMs } : binding;
  let execution = withDeadline((access === 'bounded_write' ? qualifiedExecution : null) ?? nativeExecutionBinding(runtimeEnvironment));
  if (execution?.kind === 'wsl') requireValue(inputs.has('task_root'), 'PI_EXECUTION_BINDING', 'Inherited WSL task execution requires a task_root input');
  const pinned = new Map();
  requireValue(resources.filter(item=>item.material_kind!=='pi_node_input').length <= 512
    &&resources.filter(item=>item.material_kind==='pi_node_input').length<=4096, 'PI_RESOURCE_LIMIT', 'Too many node resources or Host-prepared input materials');
  let totalResourceBytes = 0,totalMaterialBytes=0;
  for (const item of resources) {
    const path = resourcePath(item.path); const bytes = Buffer.from(item.bytes);
    const material=item.material_kind==='pi_node_input';
    if(material)totalMaterialBytes+=bytes.length;else totalResourceBytes += bytes.length;
    requireValue(bytes.length <= (material?16*MAX_FILE:MAX_FILE) && totalResourceBytes <= 16 * MAX_FILE
      &&totalMaterialBytes<=64*MAX_FILE && !pinned.has(path) && digest(bytes) === item.sha256, 'PI_RESOURCE_PIN', 'Resource or input material is duplicated, oversized or differs from its pin');
    pinned.set(path, { bytes, sha256: item.sha256 });
  }
  function locate(path, write = false, directory = false) {
    requireValue(typeof path === 'string', 'PI_TOOL_PATH', 'Tool path must be workspace-relative');
    const parts = directory && path === '.' ? [] : resourcePath(path).split('/');
    requireValue(!parts.some(part => ['.git', '.pi', '.codex', '.agents', '.skills'].includes(part.toLowerCase()) || part.toLowerCase() === 'skill.md'), 'PI_TOOL_PATH_DENIED', 'Runtime configuration, Git internals and ambient Skills are not workspace tool inputs');
    const absolute = parts.length ? insideRoot(root, join(root, ...parts)) : root;
    requireValue(!denied.some(item => within(item, absolute)), 'PI_TOOL_PATH_DENIED', 'Path belongs to executor-owned or explicitly denied state');
    if (write) requireValue(access === 'bounded_write' && boundaries.some(item => within(item, absolute)), 'PI_TOOL_WRITE_DENIED', 'Write is outside this node permission intersection');
    return absolute;
  }
  function locateInput(name, path, directory = false) {
    requireValue(inputs.has(name) && typeof path === 'string', 'PI_INPUT_DENIED', 'Input path is outside the declared read roots');
    const parts = directory && path === '.' ? [] : resourcePath(path).split('/');
    requireValue(!parts.some(part => ['.git', '.pi', '.codex', '.agents', '.skills'].includes(part.toLowerCase()) || part.toLowerCase() === 'skill.md'), 'PI_TOOL_PATH_DENIED', 'Runtime configuration, Git internals and ambient Skills are not task inputs');
    const inputRoot = inputs.get(name); const absolute = parts.length ? insideRoot(inputRoot, join(inputRoot, ...parts)) : inputRoot;
    requireValue(!denied.some(item => within(item, absolute)), 'PI_TOOL_PATH_DENIED', 'Input path belongs to executor-owned or explicitly denied state');
    return absolute;
  }
  async function regular(path, { allowMissing = false } = {}) {
    let stat;
    try { await noSymlinks(path); stat = await lstat(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (allowMissing) return null;
      requireValue(false, 'PI_TOOL_FILE', 'Only bounded regular files without hard links are supported');
    }
    requireValue(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE, 'PI_TOOL_FILE', 'Only bounded regular files without hard links are supported');
    return stat;
  }
  async function directory(path) {
    let stat;
    try { await noSymlinks(path); stat = await lstat(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; requireValue(false, 'PI_TOOL_DIRECTORY', 'Expected an existing workspace directory'); }
    requireValue(stat.isDirectory(), 'PI_TOOL_DIRECTORY', 'Expected an existing workspace directory');
    return stat;
  }
  function decode(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw Object.assign(new Error('File is not valid UTF-8 text'), { code: 'PI_TOOL_ENCODING' }); }
  }
  const tools = [
    { name: 'list_workspace', description: 'List one workspace directory, excluding runtime internals and ambient Skills. Use . for its root.', inputSchema: schema({ path: string }) },
    { name: 'read_workspace', description: 'Read a bounded UTF-8 workspace file and its SHA-256 for a later compare-and-swap write.', inputSchema: schema({ path: string }) },
    ...(access === 'bounded_write' ? [{ name: 'write_workspace', description: 'Atomically write UTF-8 text inside the node scope. expected_sha256 must match the current file; null creates a new file. Parent directory must exist.', inputSchema: schema({ path: string, text: string, expected_sha256: { type: ['string', 'null'] } }) }] : []),
    ...(inputs.size ? [
      { name: 'list_input', description: 'List one directory beneath a host-authorized read-only task input root. Use root=task_root and path=. to start.', inputSchema: schema({ root: { type: 'string', enum: [...inputs.keys()] }, path: string }) },
      { name: 'read_input', description: 'Read one bounded UTF-8 file beneath a host-authorized read-only task input root.', inputSchema: schema({ root: { type: 'string', enum: [...inputs.keys()] }, path: string }) },
    ] : []),
    ...(execution ? [{ name: 'run_task_program', description: 'Run one Host-resolved task program without a shell. Use this for CodeGraph, Git inspection and tests. cwd is a logical root; @WORKSPACE@ and, when available, @TASK_ROOT@ expand to exact paths. Inspect the exit code and output before reporting success.', inputSchema: schema({ program: { type: 'string', enum: Object.keys(execution.programs) }, args: { type: 'array', items: string, maxItems: 256 }, cwd: { type: 'string', enum: inputs.has('task_root') ? ['workspace', 'task_root'] : ['workspace'] } }) }] : []),
    ...(execution ? [{name:'run_workspace_program',description:'Run a discovered executable path or exact alias with literal arguments in the node workspace. Optional stdin is exact UTF-8 and then closed. yield_time_ms defaults to 10000; 0 starts background work. Continue a returned session with continue_workspace_command. Inspect the final exit code before reporting success.',inputSchema:schema({program:string,args:{type:'array',items:string,maxItems:256},stdin:string,workdir:string,yield_time_ms:{oneOf:[{const:0},{type:'integer',minimum:10000,maximum:30000}]},max_output_tokens:{type:'integer',minimum:1,maximum:200000}},['program','args'])},
      {name:'continue_workspace_command',description:'Wait for an owned program session and read the next bounded output chunk. Literal-program stdin is closed; chars may only be empty or Ctrl-C to stop the exact owned process. Final output_ref supports exact byte reads with read_program_output.',inputSchema:schema({session_id:string,chars:string,yield_time_ms:{type:'integer',minimum:0,maximum:30000},max_output_tokens:{type:'integer',minimum:1,maximum:200000}},['session_id'])}] : []),
    ...(execution ? [{ name: 'read_program_output', description: 'Read exact captured stdout or stderr owned by this broker. Start at byte 0 and follow next_byte. Every reply is bounded after JSON serialization; data_base64 preserves every byte, text contains complete UTF-8 characters when available.', inputSchema: schema({output_id:string,stream:{type:'string',enum:['stdout','stderr']},start_byte:{type:'integer',minimum:0},max_bytes:{type:'integer',minimum:1,maximum:12000}}) }] : []),
    ...(access === 'bounded_write' ? [{ name: 'mkdir_workspace', description: 'Create a workspace directory within this node\'s exact write scope before writing new files.', inputSchema: schema({ path: string }) }] : []),
    ...(pinned.size ? [{ name: 'read_workflow_resource', description: 'Read a small immutable resource pinned to this node. Large results may exceed the model transport; use read_workflow_resource_chunk for complete sequential reading.', inputSchema: schema({ path: { type: 'string', enum: [...pinned.keys()] } }) },
      {name:'read_workflow_resource_chunk',description:'Read a transport-safe UTF-8 byte chunk from an immutable pinned resource. Begin at start_byte 0, use max_bytes at most 12000, then follow next_byte exactly until complete is true.',inputSchema:schema({path:{type:'string',enum:[...pinned.keys()]},start_byte:{type:'integer',minimum:0},max_bytes:{type:'integer',minimum:1,maximum:12000}})},
      {name:'read_workflow_resource_range',description:'Read 1–200 numbered lines of an immutable pinned UTF-8 resource. Reports total lines; partial content is not a full-file audit.',inputSchema:schema({path:{type:'string',enum:[...pinned.keys()]},start_line:{type:'integer',minimum:1},end_line:{type:'integer',minimum:1}})}] : []),
    ...(pinned.size && access === 'bounded_write' ? [{ name: 'materialize_workflow_resource', description: 'Atomically copy an exact pinned UTF-8 Workflow resource into a permitted workspace path without sending its contents through the model. Parent directory must exist; expected_sha256 is null for a new file.', inputSchema: schema({ path: { type: 'string', enum: [...pinned.keys()] }, destination: string, expected_sha256: { type: ['string', 'null'] } }) }] : []),
  ];
  let queue = Promise.resolve(); let revoked = false,programFailure=null; const executionAbort=new AbortController();let executionHandle=null;
  const brokerId=randomUUID(), outputs=new Map(), outputReads=new Set(), sessions=new Map();let preparingCommandState=null,spoolOwner=null,tempOwner=null;
  async function commandState() {
    if(!preparingCommandState)preparingCommandState=(async()=>{
      if(programOutputDirectory){await ensureDirectory(programOutputDirectory);await checkAuthority();}
      spoolOwner=await prepareCommandTemp({workspace:root,brokerId,base:programOutputDirectory??commandTempBase,prefix:'pi-program-output-'});
      await checkAuthority();
      if(execution.kind==='native')tempOwner=await prepareCommandTemp({workspace:root,spool:spoolOwner.path,brokerId,base:commandTempBase});
      await onOperation({tool:'run_task_program',phase:'temp_prepared',broker_id:brokerId,spool:spoolOwner.summary,...(tempOwner?{runtime_temp:tempOwner.summary}:{})});
    })();
    await preparingCommandState;await checkAuthority();await spoolOwner.assertOwned();if(tempOwner)await tempOwner.assertOwned();await checkAuthority();
  }
  async function checkAuthority({allowProgramFailure=false}={}) {
    requireValue(!revoked, 'PI_BROKER_REVOKED', 'Workspace broker was revoked');
    if(programFailure&&!allowProgramFailure)throw programFailure;
    await authorize(); requireValue(!revoked, 'PI_BROKER_REVOKED', 'Workspace broker was revoked during authorization');
    if(programFailure&&!allowProgramFailure)throw programFailure;
  }
  function validateYield(args, initial) {
    const milliseconds=args.yield_time_ms??(initial?10000:args.chars?250:5000);
    requireValue(Number.isInteger(milliseconds) && (initial ? milliseconds===0 || milliseconds>=10000 && milliseconds<=30000 : milliseconds>=0 && milliseconds<=30000), 'PI_EXECUTION_ARGUMENTS', 'Program yield_time_ms is outside its bounded contract');
    requireValue(args.max_output_tokens===undefined || Number.isInteger(args.max_output_tokens) && args.max_output_tokens>=1 && args.max_output_tokens<=200000, 'PI_EXECUTION_ARGUMENTS', 'max_output_tokens is outside its compatibility range');
    return milliseconds;
  }
  async function prepareProgram(args,name) {
    requireValue(!executionHandle || executionHandle.isQuiescent(), 'PI_EXECUTION_BUSY', 'Only one exact task program may own this broker');
    requireValue(![...sessions.values()].some(session=>!session.settled), 'PI_EXECUTION_BUSY', 'A program session still owns this broker');
    requireValue(Array.isArray(args.args) && args.args.length <= 256 && args.args.every(value => typeof value === 'string'
      && value.length <= 8192 && !value.includes('\0')), 'PI_EXECUTION_ARGUMENTS', 'Task program arguments must be bounded strings');
    if (execution.kind === 'native') {
      if (prepareRuntimeEnvironment) {
        const prepared = await prepareRuntimeEnvironment();
        execution = withDeadline(nativeExecutionBinding(prepared.environment ?? prepared));
      } else {
        await verifyRuntimeEnvironment(runtimeEnvironment.requirements ?? {executables:runtimeEnvironment.tools.map(tool=>tool.name)},runtimeEnvironment);
      }
      await checkAuthority();
    }
    if (name === 'run_workspace_program') {
      requireValue(typeof args.program === 'string' && args.program.length > 0 && args.program.length <= 32768 && !args.program.includes('\0'), 'PI_EXECUTION_ARGUMENTS', 'Program must identify a discovered executable');
      const alias = Object.hasOwn(execution.programs,args.program) ? args.program
        : Object.keys(execution.programs).find(alias=>execution.programs[alias]===args.program);
      requireValue(alias !== undefined, 'PI_EXECUTION_ARGUMENTS', 'Program is not an exact discovered Host executable or alias');
      requireValue(args.stdin === undefined || typeof args.stdin === 'string' && Buffer.byteLength(args.stdin,'utf8') <= 1024*1024, 'PI_EXECUTION_ARGUMENTS', 'Program stdin must be at most 1 MiB of UTF-8');
      requireValue(args.workdir === undefined || typeof args.workdir === 'string' && args.workdir.length > 0 && !args.workdir.includes('\0'), 'PI_EXECUTION_ARGUMENTS', 'Program workdir must be inside the node workspace');
      const workdir = resolve(root,args.workdir??'.');
      requireValue(within(root,workdir), 'PI_EXECUTION_ARGUMENTS', 'Program workdir leaves the node workspace');
      await directory(workdir);
      return {program:alias,args:args.args,cwd:'workspace',literal:true,stdin:args.stdin??'',workdir};
    }
    requireValue(Object.hasOwn(execution.programs,args.program) && ['workspace','task_root'].includes(args.cwd) && (args.cwd!=='task_root'||inputs.has('task_root')), 'PI_EXECUTION_ARGUMENTS', 'Task program must match the discovered Host binding and declared cwd');
    return args;
  }
  async function runProgram(args,callId,name,session=null) {
    const started = Date.now(); const argvEvidence = { args_sha256: digest(JSON.stringify(args.args)), arg_count: args.args.length,
      ...(session?{process_id:session.id,executable:execution.programs[args.program],workdir:args.workdir,stdin_sha256:digest(Buffer.from(args.stdin,'utf8')),stdin_bytes:Buffer.byteLength(args.stdin,'utf8')}:{}) };
    let capture=null,launchedHandle=null;
    try{
      await onOperation({ call_id: callId, tool: name, program: args.program, cwd: args.cwd, ...argvEvidence, command_timeout_ms: execution.command_timeout_ms, phase: 'started' });
      if (execution.kind === 'wsl') for(const boundary of boundaries)await requireWritableTreeWithoutLinks(boundary);
      const masks=execution.kind === 'wsl' ? await sandboxMasks([root,inputs.get('task_root')],denied) : [];
      await commandState();
      capture=createProgramOutput(spoolOwner);outputs.set(capture.outputId,capture);
      if(session)session.capture=capture;
      requireValue(!executionHandle || executionHandle.isQuiescent(), 'PI_EXECUTION_BUSY', 'Only one exact task program may own this broker');
      const options={signal:executionAbort.signal,outputSink:session?{write(stream,chunk){capture.write(stream,chunk);session.pendingText+=session.decoders[stream].write(chunk);}}:capture,onHandle:handle=>{requireValue(!executionHandle||executionHandle.isQuiescent(),'PI_EXECUTION_BUSY','Only one exact bound execution may own this broker');executionHandle=handle;launchedHandle=handle;if(session){session.handle=handle;session.onLaunched?.();}}};
      const roots={workspace:root,task_root:inputs.get('task_root')};
      let result;
      try{result=execution.kind === 'wsl'
        ? await executeBoundProgram(execution,args,roots,{...options,masks,writable:boundaries,beforeSpawn:checkAuthority})
        : await (async()=>{await tempOwner.assertOwned();await spoolOwner.assertOwned();await checkAuthority();return executeNativeProgram(execution,args,roots,{...options,env:{...augmentedRuntimeEnvironment(programEnvironment??process.env,{tools:Object.entries(execution.programs).map(([name,path])=>({name,path,status:'found'}))},{workspace:root}),TEMP:tempOwner.path,TMP:tempOwner.path,TMPDIR:tempOwner.path}});})();}
      catch(error){if(session?.stopRequested && error.code==='PI_EXECUTION_CANCELLED' && launchedHandle?.isQuiescent())result={exit_code:130,signal:'SIGINT'};else throw error;}
      capture.finish({call_id:callId,program:args.program,...argvEvidence,exit_code:result.exit_code,signal:result.signal});
      await onOperation({ call_id: callId, tool: name, program: args.program, cwd: args.cwd, ...argvEvidence,
        phase: 'completed', exit_code: result.exit_code, signal: result.signal, duration_ms: Date.now() - started, output_ref:capture.reference(), output_evidence:capture.evidence() });
      return session ? {...result,output_ref:capture.reference()} : textResult(programOutputMode==='actual'?await capture.actual(result):await capture.carrier(result));
    }catch(error){
      if(capture&&(!launchedHandle||launchedHandle.isQuiescent())){
        try{capture.finish({call_id:callId,program:args.program,...argvEvidence,error_code:error.code??'PI_EXECUTION_FAILED'});}
        catch(sealingError){if(sealingError!==error)error=Object.assign(new AggregateError([error,sealingError],'Program failure and output sealing both failed'),{code:sealingError.code??'PI_PROGRAM_OUTPUT_SEAL',retained_at:sealingError.retained_at});}
        error.program_output=capture.reference();
      }
      // Zero-yield sessions settle outside the tool queue. Retain the failure
      // before awaiting its durable observation so no new effect can pass it.
      if(session)programFailure??=error;
      await onOperation({call_id:callId,tool:name,...(session?{process_id:session.id}:{}),phase:'failed',quiescent:!launchedHandle||launchedHandle.isQuiescent(),code:error.code??'PI_EXECUTION_FAILED',diagnostic:safeDiagnostic(error),
        ...(error.details?{execution_diagnostic:{pid:error.details.pid??null,process_group:error.details.process_group??null,cause_code:error.details.cause_code??null,
          helper_exit_code:error.details.helper_exit_code??null,helper_cause_code:error.details.helper_cause_code??null,helper_duration_ms:error.details.helper_duration_ms??null,
          helper_timeout_ms:error.details.helper_timeout_ms??null,helper_killed:error.details.helper_killed??null,
          helper_stdout:safeDiagnostic({message:error.details.helper_stdout??''}),helper_stderr:safeDiagnostic({message:error.details.helper_stderr??''}),
          parent_exited:error.details.parent_exited??null,parent_closed:error.details.parent_closed??null}}:{}),
        ...(error.program_output?{output_ref:error.program_output}:{})});
      throw error;
    }finally{if(launchedHandle?.isQuiescent()&&executionHandle===launchedHandle)executionHandle=null;}
  }
  async function awaitProgram(session,milliseconds) {
    if(!session.settled && milliseconds>0){
      let timer;
      try{await Promise.race([session.completion,new Promise(resolve=>{timer=setTimeout(resolve,milliseconds);})]);}
      finally{clearTimeout(timer);}
    }
    if(session.error)throw session.error;
    let end=Math.min(session.pendingText.length,12000);
    const envelope=text=>({status:session.settled?'completed':'running',exit_code:session.settled?session.result.exit_code:null,
      output:text,has_more:!session.settled||text.length<session.pendingText.length,
      ...(!session.settled||text.length<session.pendingText.length?{session_id:session.id}:{}),
      ...(session.settled?{signal:session.result.signal,output_ref:session.result.output_ref}:{})});
    if(end>0 && /^[\uDC00-\uDFFF]$/.test(session.pendingText[end]??'') && /^[\uD800-\uDBFF]$/.test(session.pendingText[end-1]))end--;
    while(Buffer.byteLength(JSON.stringify(textResult(envelope(session.pendingText.slice(0,end)))))>32768){
      end=Math.floor(end/2);
      if(end>0 && /^[\uDC00-\uDFFF]$/.test(session.pendingText[end]??'') && /^[\uD800-\uDBFF]$/.test(session.pendingText[end-1]))end--;
      requireValue(end>0,'PI_PROGRAM_REPLY_SIZE','Program session metadata exceeds the transport budget');
    }
    const result=envelope(session.pendingText.slice(0,end));session.pendingText=session.pendingText.slice(end);
    if(!result.has_more)session.exhausted=true;
    return textResult(result);
  }
  async function perform(name, args, callId) {
    requireValue(tools.some(tool => tool.name === name) && typeof callId === 'string' && callId.length <= 256, 'PI_TOOL_DENIED', 'Tool is outside this node broker');
    await checkAuthority({allowProgramFailure:name==='read_program_output'||name==='continue_workspace_command'});
    if(name==='run_workspace_program')argsShape(args,['program','args','stdin','workdir','yield_time_ms','max_output_tokens'],['program','args']);
    else if(name==='continue_workspace_command')argsShape(args,['session_id','chars','yield_time_ms','max_output_tokens'],['session_id']);
    else argsShape(args, name === 'write_workspace' ? ['path', 'text', 'expected_sha256'] : name === 'materialize_workflow_resource' ? ['path', 'destination', 'expected_sha256'] : name === 'run_task_program' ? ['program', 'args', 'cwd'] : name === 'read_program_output' ? ['output_id','stream','start_byte','max_bytes'] : name==='read_workflow_resource_range'?['path','start_line','end_line']:name==='read_workflow_resource_chunk'?['path','start_byte','max_bytes']:['list_input','read_input'].includes(name)?['root','path']:['path']);
    if(name==='read_program_output'){
      const capture=outputs.get(args.output_id);requireValue(capture,'PI_PROGRAM_OUTPUT_DENIED','Program output belongs to another broker or attempt');
      const result=await capture.chunk(args.stream,args.start_byte,args.max_bytes);
      await checkAuthority({allowProgramFailure:true});
      await onOperation({call_id:callId,tool:name,phase:'read',broker_id:brokerId,output_id:args.output_id,stream:args.stream,start_byte:args.start_byte,next_byte:result.next_byte,total_bytes:result.total_bytes,sha256:result.sha256});
      return programTextResult(result);
    }
    if(name==='continue_workspace_command'){
      const milliseconds=validateYield(args,false),session=sessions.get(args.session_id);
      requireValue(session && !session.exhausted,'PI_EXECUTION_SESSION','Unknown or exhausted program session');
      requireValue(args.chars===undefined || args.chars==='' || args.chars==='\u0003','PI_EXECUTION_ARGUMENTS','Program stdin was already closed after its exact initial input');
      await onOperation({call_id:callId,tool:name,phase:'continued',process_id:session.id,args_sha256:digest(JSON.stringify(args))});
      if(args.chars==='\u0003'&&!session.settled){
        session.stopRequested=true;
        // Launch preparation can still be in flight after a zero-yield start.
        await session.launched;
        if(!session.settled)await session.handle.stop(executionError('PI_EXECUTION_CANCELLED','Owned program session was interrupted'));
      }
      return awaitProgram(session,milliseconds);
    }
    if(name==='run_task_program'||name==='run_workspace_program'){
      const milliseconds=name==='run_workspace_program'?validateYield(args,true):null;
      const request=await prepareProgram(args,name);
      if(name==='run_task_program')return runProgram(request,callId,name);
      const session={id:randomUUID(),pendingText:'',decoders:{stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')},settled:false,exhausted:false,stopRequested:false};
      sessions.set(session.id,session);
      let resolveLaunched;
      session.launched=new Promise(resolve=>{resolveLaunched=resolve;});
      session.completion=runProgram(request,callId,name,session).then(result=>{session.result=result;},error=>{session.error=error;programFailure??=error;throw error;}).finally(()=>{
        session.pendingText+=session.decoders.stdout.end()+session.decoders.stderr.end();session.settled=true;resolveLaunched();
      });
      // A background rejection remains owned and is reported on continuation
      // and quiesce; observing it here prevents an unhandled rejection.
      void session.completion.catch(()=>{});
      session.onLaunched=resolveLaunched;
      return awaitProgram(session,milliseconds);
    }
    if(name==='read_workflow_resource_range') {
      const item=pinned.get(args.path);requireValue(item,'PI_RESOURCE_DENIED','Resource is outside the pinned node manifest');
      const lines=decode(item.bytes).split('\n');
      requireValue(Number.isInteger(args.start_line)&&Number.isInteger(args.end_line)&&args.start_line>=1&&args.start_line<=lines.length&&args.end_line>=args.start_line&&args.end_line-args.start_line<200,'PI_RESOURCE_RANGE','Use a valid starting line and at most 200 lines');
      const end=Math.min(args.end_line,lines.length);
      const text=lines.slice(args.start_line-1,end).map((line,index)=>`${args.start_line+index}: ${line}`).join('\n');
      requireValue(Buffer.byteLength(text)<=32768,'PI_RESOURCE_RANGE_LIMIT','Selected lines exceed 32 KiB; select a smaller range');
      await onOperation({call_id:callId,tool:name,path:args.path,phase:'read',sha256:item.sha256,start_line:args.start_line,end_line:end,total_lines:lines.length,bytes:Buffer.byteLength(text)});
      return textResult({path:args.path,sha256:item.sha256,start_line:args.start_line,end_line:end,total_lines:lines.length,text});
    }
    if(name==='read_workflow_resource_chunk') {
      const item=pinned.get(args.path);requireValue(item,'PI_RESOURCE_DENIED','Resource is outside the pinned node manifest');
      decode(item.bytes);
      requireValue(Number.isInteger(args.start_byte)&&Number.isInteger(args.max_bytes)&&args.start_byte>=0&&args.start_byte<item.bytes.length&&args.max_bytes>=1&&args.max_bytes<=12000&&(args.start_byte===0||(item.bytes[args.start_byte]&0xc0)!==0x80),'PI_RESOURCE_CHUNK','Use byte 0 or the exact next_byte from the previous chunk, with max_bytes from 1 through 12000');
      let end=Math.min(args.start_byte+args.max_bytes,item.bytes.length);
      while(end>args.start_byte&&end<item.bytes.length&&(item.bytes[end]&0xc0)===0x80)end--;
      requireValue(end>args.start_byte,'PI_RESOURCE_CHUNK','Chunk boundary did not contain one complete UTF-8 character');
      const bytes=item.bytes.subarray(args.start_byte,end),text=decode(bytes),complete=end===item.bytes.length;
      await onOperation({call_id:callId,tool:name,path:args.path,phase:'read',sha256:item.sha256,start_byte:args.start_byte,end_byte:end,total_bytes:item.bytes.length,bytes:bytes.length,complete});
      return textResult({path:args.path,sha256:item.sha256,start_byte:args.start_byte,end_byte:end,total_bytes:item.bytes.length,next_byte:end,complete,text});
    }
    if (name === 'read_workflow_resource') {
      const item = pinned.get(args.path); requireValue(item, 'PI_RESOURCE_DENIED', 'Resource is outside the pinned node manifest');
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'read', sha256: item.sha256 });
      return textResult({ path: args.path, sha256: item.sha256, text: decode(item.bytes) });
    }
    if (name === 'list_input') {
      const path = locateInput(args.root, args.path, true); await directory(path);
      const entries = await readdir(path, { withFileTypes: true });
      requireValue(entries.length <= 2000, 'PI_TOOL_DIRECTORY_LIMIT', 'Directory exceeds the qualified entry limit');
      const visible = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) continue;
        const child = relative(inputs.get(args.root), join(path, entry.name)).split(sep).join('/');
        try { locateInput(args.root, child); } catch (error) { if (['PI_TOOL_PATH_DENIED', 'INVALID_RESOURCE_PATH'].includes(error.code)) continue; throw error; }
        visible.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
      }
      await onOperation({ call_id: callId, tool: name, root: args.root, path: args.path, phase: 'read', entries: visible.length });
      return textResult({ root: args.root, entries: visible.sort((a, b) => a.name.localeCompare(b.name, 'en')) });
    }
    if (name === 'read_input') {
      const path = locateInput(args.root, args.path); await regular(path); const bytes = await readFile(path);
      requireValue(bytes.length <= MAX_FILE, 'PI_TOOL_FILE', 'File grew beyond the read limit');
      const text = decode(bytes); const sha256 = digest(bytes);
      await onOperation({ call_id: callId, tool: name, root: args.root, path: args.path, phase: 'read', sha256 });
      return textResult({ root: args.root, path: args.path, sha256, text });
    }
    let source_sha256;
    if (name === 'materialize_workflow_resource') {
      const item = pinned.get(args.path);
      requireValue(item, 'PI_RESOURCE_DENIED', 'Resource is outside the pinned node manifest');
      source_sha256 = item.sha256;
      args = { path: args.destination, text: decode(item.bytes), expected_sha256: args.expected_sha256 };
    }
    const path = locate(args.path, name === 'write_workspace' || name === 'materialize_workflow_resource' || name === 'mkdir_workspace', name === 'list_workspace' || name === 'mkdir_workspace');
    if (name === 'mkdir_workspace') {
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'intent' }); await checkAuthority();
      await ensureDirectory(path);
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'committed' });
      return textResult({ path: args.path });
    }
    if (name === 'list_workspace') {
      await directory(path);
      const entries = await readdir(path, { withFileTypes: true });
      requireValue(entries.length <= 2000, 'PI_TOOL_DIRECTORY_LIMIT', 'Directory exceeds the qualified entry limit');
      const visible = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) continue;
        const child = relative(root, join(path, entry.name)).split(sep).join('/');
        try { locate(child); } catch (error) { if (['PI_TOOL_PATH_DENIED', 'INVALID_RESOURCE_PATH'].includes(error.code)) continue; throw error; }
        visible.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
      }
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'read', entries: visible.length });
      return textResult({ entries: visible.sort((a, b) => a.name.localeCompare(b.name, 'en')) });
    }
    if (name === 'read_workspace') {
      await regular(path); const bytes = await readFile(path);
      requireValue(bytes.length <= MAX_FILE, 'PI_TOOL_FILE', 'File grew beyond the read limit');
      const text = decode(bytes); const sha256 = digest(bytes);
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'read', sha256 });
      return textResult({ path: args.path, sha256, text });
    }
    requireValue(typeof args.text === 'string' && Buffer.byteLength(args.text) <= MAX_FILE && (args.expected_sha256 === null || /^[a-f0-9]{64}$/.test(args.expected_sha256)), 'PI_TOOL_WRITE_ARGUMENTS', 'Write needs bounded text and an exact prior content hash or null');
    const parent = dirname(path); await noSymlinks(parent);
    const prior = await regular(path, { allowMissing: true });
    const previous = prior ? digest(await readFile(path)) : null;
    if (source_sha256 && previous === source_sha256) {
      await onOperation({ call_id: callId, tool: name, path: args.path, phase: 'unchanged', source_sha256 });
      return textResult({ path: args.path, sha256: source_sha256, unchanged: true });
    }
    requireValue(previous === args.expected_sha256, 'PI_TOOL_WRITE_CONFLICT', 'Workspace file changed since the caller observed it');
    const sha256 = digest(args.text); const operation = { call_id: callId, tool: name, path: args.path, before_sha256: previous, after_sha256: sha256,
      ...(source_sha256 ? { source_sha256 } : {}) };
    await onOperation({ ...operation, phase: 'intent' }); await checkAuthority();
    const temporary = join(parent, '.sol-write-' + randomUUID()); let committed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(args.text); await handle.sync(); } finally { await handle.close(); }
      await noSymlinks(parent);
      // Revalidate after the asynchronous durable intent. This serializes our
      // writer; concurrent external editors still need the worktree gate.
      const observed = await regular(path, { allowMissing: true });
      const current = observed ? digest(await readFile(path)) : null;
      requireValue(current === previous, 'PI_TOOL_WRITE_CONFLICT', 'Workspace changed while preparing the write');
      await checkAuthority(); await rename(temporary, path); committed = true;
      await onOperation({ ...operation, phase: 'committed' });
      return textResult({ path: args.path, sha256 });
    } catch (error) {
      if (!committed) try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Workspace write and temporary cleanup failed'); }
      if (committed) { error.committed = true; error.operation = operation; }
      throw error;
    }
  }
  const revoke=()=>{revoked=true;if(!executionAbort.signal.aborted)executionAbort.abort(executionError('PI_EXECUTION_CANCELLED','Bound execution authority was revoked'));};
  return { tools: () => structuredClone(tools), revoke,
    programOutputEvidence:()=>({broker_id:brokerId,retained:retainProgramOutput,spool_owner:spoolOwner?.summary??null,outputs:[...outputs.values()].map(capture=>capture.evidence())}),
    isQuiescent(){return (!executionHandle||executionHandle.isQuiescent()) && ![...sessions.values()].some(session=>!session.settled);},
    async quiesce() {
      revoke();
      // Retry the exact Linux stop before waiting on the tool queue. A failed
      // stop rejects that tool promptly but deliberately retains this handle.
      let queueError=null,stopError=null;
      if(executionHandle&&!executionHandle.isQuiescent())try{await executionHandle.stop(executionAbort.signal.reason);}catch(error){stopError=error;}
      if(!stopError)try{await queue;}catch(error){queueError=error;}
      const sessionErrors=(await Promise.allSettled([...sessions.values()].filter(session=>!stopError||session.settled).map(session=>session.completion))).filter(result=>result.status==='rejected').map(result=>result.reason);
      const quiescent=!executionHandle||executionHandle.isQuiescent();if(quiescent)executionHandle=null;
      const errors=[...new Set([queueError,stopError,programFailure,...sessionErrors].filter(Boolean))];
      if(preparingCommandState)try{await preparingCommandState;}catch(error){if(!errors.includes(error))errors.push(error);}
      for(const result of await Promise.allSettled([...outputReads]))if(result.status==='rejected'&&!errors.includes(result.reason))errors.push(result.reason);
      if(quiescent){
        for(const capture of outputs.values())try{capture.finish();}catch(error){errors.push(error);}
        const outputRetentionError=[...outputs.values()].map(capture=>capture.retentionError()).find(Boolean);
        if(outputRetentionError&&!errors.includes(outputRetentionError)){errors.push(outputRetentionError);await onOperation({tool:'run_task_program',phase:'output_retained',broker_id:brokerId,retained_at:spoolOwner?.path,code:outputRetentionError.code,diagnostic:safeDiagnostic(outputRetentionError)});}
        for(const owner of [tempOwner,...(retainProgramOutput||outputRetentionError?[]:[spoolOwner])])if(owner)try{await owner.close();}catch(error){errors.push(error);await onOperation({tool:'run_task_program',phase:'temp_retained',broker_id:brokerId,retained_at:error.retained_at??owner.path,code:error.code??'PI_COMMAND_TEMP_CLEANUP',diagnostic:safeDiagnostic(error)});}
        if(retainProgramOutput&&spoolOwner)try{await spoolOwner.assertOwned();}catch(error){errors.push(error);await onOperation({tool:'run_task_program',phase:'output_retained',broker_id:brokerId,retained_at:spoolOwner.path,code:error.code,diagnostic:safeDiagnostic(error)});}
      }
      const error=errors.length>1?new AggregateError(errors,'Program execution or owned-state cleanup failed'):errors[0]??null;
      return {quiescent,error};
    },
    call(name, args, callId) {
    const invoke = async () => {
      try { return await perform(name, args, callId); }
      catch (error) {
        if (['run_task_program','run_workspace_program'].includes(name) && ['ENVIRONMENT_BINDING_STALE','ENVIRONMENT_SETUP_REQUIRED','PI_EXECUTION_LAUNCH'].includes(error.code)) {
          await onOperation({call_id:callId,tool:name,program:String(args?.program??'').slice(0,100),phase:'rejected',code:error.code,diagnostic:safeDiagnostic(error)});
        }
        const stoppedOutputLimit = ['run_task_program','run_workspace_program','continue_workspace_command'].includes(name) && error?.code==='PI_EXECUTION_OUTPUT'
          && (!executionHandle || executionHandle.isQuiescent());
        const literalArguments = ['run_workspace_program','continue_workspace_command'].includes(name)
          && ['PI_EXECUTION_ARGUMENTS','PI_EXECUTION_SESSION','PI_EXECUTION_BUSY'].includes(error?.code);
        if (!recoverToolErrors || error?.committed || (!RECOVERABLE_TOOL_ERRORS.has(error?.code) && !stoppedOutputLimit && !literalArguments)) throw error;
        if(stoppedOutputLimit) error.message += '; command stopped. Captured output remains available through read_program_output and effects may be partial. Inspect effects and use a narrower query; do not blindly repeat the command.';
        const diagnostic = safeDiagnostic(error);
        const path = typeof args?.path === 'string' ? args.path.slice(0, 1000) : '';
        await onOperation({ call_id: callId, tool: name, ...(typeof args?.root === 'string' ? { root: args.root.slice(0, 1000) } : {}), path, phase: 'rejected', code: error.code, diagnostic });
        if(stoppedOutputLimit&&error.program_output)return {success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:{code:error.code,message:diagnostic},output_ref:error.program_output})}]};
        return errorResult(error.code, diagnostic);
      }
    };
    // Output evidence may still be read after a failed command. Preserve the
    // poisoned command queue and its error; this does not recover execution.
    const next = name==='read_program_output'?queue.then(invoke,invoke):queue.then(invoke);
    if(name==='read_program_output'){
      outputReads.add(next);void next.then(()=>outputReads.delete(next),()=>outputReads.delete(next));
    }
    // A failed operation poisons this broker. No subsequent tool may hide it.
    if(name!=='read_program_output')queue = next; return next;
  } };
}
