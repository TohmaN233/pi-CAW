import { canonicalJSON, digest } from './workflow-revisions.mjs';
import { requireValue } from './workflow-paths.mjs';
import { isAbsolute, join, dirname, basename, delimiter } from 'node:path';
import { statSync, realpathSync, accessSync, constants } from 'node:fs';
import { normalizeExecutableRequirements, normalizeNodeRuntimeRequirements } from './runtime-requirements.mjs';

export const workspaceRuntimeDirectories = workspace => typeof workspace==='string'&&isAbsolute(workspace)
  ? ['.venv','venv','env'].flatMap(name=>['Scripts','bin'].map(bin=>join(workspace,name,bin))) : [];

export const runtimeEnvironmentForState = (state,nodeId) => (nodeId?state.nodes[nodeId]?.runtime_environment_binding?.environment:null)??state.runtime_environment ?? state.constraints?.runtime_environment ?? null;
export const runtimeRequirementsForState = state => state.constraints?.runtime_requirements ?? {
  executables: (runtimeEnvironmentForState(state)?.tools ?? []).map(tool => tool.name),
};

// Host evidence stays in the Run journal. Workers need only usable locations.
export function augmentedRuntimeEnvironment(env,environment,{workspace}={}){
  const windows=process.platform==='win32',key=value=>windows?value.toLowerCase():value;
  const tools=(environment?.tools??[]).filter(tool=>tool.status==='found'&&typeof tool.path==='string'&&isAbsolute(tool.path));
  const directories=[...new Set(tools.map(tool=>dirname(tool.path)))];
  const result={...env},pathKey=Object.keys(result).find(name=>name.toUpperCase()==='PATH'),inherited=pathKey?result[pathKey]:'';
  const canonical=path=>key(realpathSync.native(path));
  // Match libuv native Windows lookup: only a nonempty final extension is
  // literal-first, and a trailing dot already separates the appended extension.
  const candidateNames=name=>{
    if(!windows)return [name];
    const dot=name.lastIndexOf('.'),stem=name.endsWith('.')?name:`${name}.`;
    return [...(dot>=0&&dot<name.length-1?[name]:[]),`${stem}com`,`${stem}exe`];
  };
  const candidate=(directory,name)=>{
    const names=candidateNames(name);
    for(const filename of names){const path=join(directory,filename);let info;
      try{info=statSync(path);}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))continue;throw error;}
      if(!info.isFile())continue;
      if(!windows)accessSync(path,constants.X_OK);
      return {path,canonical:canonical(path)};
    }
    return null;
  };
  const edges=new Map(directories.map(directory=>[directory,new Set()]));
  const bindings=[];
  for(const tool of tools){
    const expected=canonical(tool.path),target=dirname(tool.path),filename=key(basename(tool.path)),name=key(tool.name);
    // Physical aliases keep their absolute binding; PATH cannot invent a logical alias.
    const matches=candidateNames(name);
    // An apparent logical stem (alpha. -> alpha..exe) is not a physical alias:
    // reject it when the actual native candidate resolves a different pin.
    const logicalStem=windows&&filename.replace(/\.(com|exe)$/,'')===name;
    if(!matches.includes(filename)&&!logicalStem)continue;
    bindings.push({tool,expected});
    const own=candidate(target,tool.name);
    requireValue(own?.canonical===expected,'ENVIRONMENT_BINDING_STALE','Bound executable is shadowed within its own directory',{dependency:tool.name,expected_path:tool.path,observed_path:own?.path??null});
    if(windows&&workspace){const local=candidate(workspace,tool.name);
      requireValue(!local||local.canonical===expected,'ENVIRONMENT_BINDING_STALE','Working directory shadows a bound executable',{dependency:tool.name,expected_path:tool.path,observed_path:local?.path??null});}
    for(const directory of directories){if(directory===target)continue;const found=candidate(directory,tool.name);if(found&&found.canonical!==expected)edges.get(target).add(directory);}
  }
  const ordered=[],remaining=new Set(directories);
  while(remaining.size){const next=directories.find(directory=>remaining.has(directory)&&![...remaining].some(other=>edges.get(other).has(directory)));
    requireValue(next,'ENVIRONMENT_BINDING_STALE','Executable directory precedence cannot satisfy all bound paths',{dependencies:bindings.map(({tool})=>tool.name),directories});
    ordered.push(next);remaining.delete(next);
  }
  for(const {tool,expected} of bindings){const found=ordered.map(directory=>candidate(directory,tool.name)).find(Boolean);
    requireValue(found?.canonical===expected,'ENVIRONMENT_BINDING_STALE','PATH resolution differs from the bound executable',{dependency:tool.name,expected_path:tool.path,observed_path:found?.path??null});}
  for(const name of Object.keys(result))if(name.toUpperCase()==='PATH')delete result[name];
  result.PATH=[...new Set([...ordered,...inherited.split(delimiter).filter(Boolean)])].join(delimiter);
  return result;
}

// Host evidence stays in the Run journal. Workers need only usable locations.

export function nodeRuntimeScope(state,pins,nodeId) {
  const node=pins.root.workflow.nodes.find(item=>item.id===nodeId);
  if(node?.runtime_requirements===undefined)return null;
  const scoped=normalizeNodeRuntimeRequirements(node.runtime_requirements);
  const requirements={executables:normalizeExecutableRequirements([...(runtimeRequirementsForState(state).executables??[]),...scoped.executables])};
  return {node_id:nodeId,requirements,source_requirement_ids:scoped.source_requirement_ids,
    scope_sha256:digest(canonicalJSON({workflow_revision:pins.root.revision_hash,node_id:nodeId,requirements,source_requirement_ids:scoped.source_requirement_ids}))};
}
export const runtimeEnvironmentPathsHash = environment => digest(canonicalJSON((environment?.tools??[]).map(({name,path,requirement_key})=>({name,path,...(requirement_key===undefined?{}:{requirement_key})}))));
export function runtimeEnvironmentForWorker(state,node,pins) {
  const scope=node&&pins?nodeRuntimeScope(state,pins,node.id):null;
  const binding=scope?state.nodes[node.id].runtime_environment_binding:null;
  if(scope)requireValue(binding?.scope_sha256===scope.scope_sha256&&binding.environment.status==='ready','ENVIRONMENT_BINDING_STALE','Scoped node dependencies have no exact verified binding',{node_id:node.id});
  const environment = scope?binding.environment:runtimeEnvironmentForState(state);
  return environment ? { status: environment.status, tools: environment.tools.map(({name,status,path}) => ({name,status,path})),...(scope?{scope_sha256:scope.scope_sha256}:{}) } : null;
}

export async function ensureRunRuntimeEnvironment(runtime, runId, { control_token, expected_sequence, extraDirectories = [],node_id,attempt_id,lease_token }) {
  const record = await runtime.runs.read(runId);
  await runtime.authorizeController(runId, {control_token});
  requireValue(expected_sequence === undefined || expected_sequence === record.sequence, 'RUN_SEQUENCE_CONFLICT', 'Run changed before dependency verification');
  const scope=node_id?nodeRuntimeScope(record.state,record.pins,node_id):null;
  const requirements = scope?.requirements??runtimeRequirementsForState(record.state);
  const binding=scope?record.state.nodes[node_id].runtime_environment_binding:null;
  const pinned = scope?(binding?.scope_sha256===scope.scope_sha256?binding.environment:null):runtimeEnvironmentForState(record.state);
  const admission=state=>{
    if(!scope)return;
    const node=state.nodes[node_id];
    requireValue(['ready','claimed','running'].includes(node?.status),'NODE_NOT_READY','Scoped dependency activation requires a selected executable node',{node_id});
    if(attempt_id!==undefined){
      const attempt=node.attempts.find(item=>item.id===attempt_id);
      requireValue(node.active_attempt_id===attempt_id&&attempt&&digest(lease_token)===attempt.lease_hash,'LEASE_INVALID','Scoped dependency verification requires its exact active lease');
      requireValue(attempt.runtime_environment_scope?.scope_sha256===scope.scope_sha256&&attempt.runtime_environment_scope.paths_sha256===runtimeEnvironmentPathsHash(pinned),'ENVIRONMENT_BINDING_STALE','Scoped execution paths differ from the admitted attempt');
    }
  };
  admission(record.state);
  if (!requirements.executables.length) return { environment: pinned, sequence: record.sequence };
  await runtime.assertAncestors(record.pins);
  requireValue(record.state.status === 'running', 'RUN_NOT_RUNNING', 'Runtime dependencies can only be rebound for a running Run');
  let stale;
  try {
    await runtime.environmentVerifier(requirements, pinned);
    if (!record.state.environment_attention) return { environment: pinned, sequence: record.sequence,...(scope?{scope_sha256:scope.scope_sha256}:{}) };
  } catch (error) {
    if (error.code !== 'ENVIRONMENT_BINDING_STALE') throw error;
    stale = { code: error.code, dependency: error.dependency ?? error.details?.dependency ?? null,
      reason: error.reason ?? error.details?.reason ?? error.message, cause_code: error.cause_code ?? error.details?.cause_code ?? null };
  }
  const environment = await runtime.environmentResolver(requirements, {extraDirectories,knownDirectories:workspaceRuntimeDirectories(record.state.permissions.workspace)});
  if(scope&&attempt_id!==undefined&&environment.status==='ready')requireValue(runtimeEnvironmentPathsHash(environment)===runtimeEnvironmentPathsHash(pinned),'ENVIRONMENT_BINDING_STALE','Scoped re-registration cannot change executable paths of an admitted attempt');
  const attention = environment.status !== 'ready';
  // Keep the initial constraints and immutable pins intact. Each re-registration
  // is an explicit journal transition, not a rewrite of previous evidence.
  const result = await runtime.transition(runId, attention ? 'runtime_environment_attention' : 'runtime_environment_rebound', (state,pins) => {
    requireValue(state.control_hash===record.state.control_hash&&state.pins_hash===record.state.pins_hash,'RUN_AUTHORITY','Run binding changed during dependency verification');
    admission(state);
    if(scope)requireValue(canonicalJSON(nodeRuntimeScope(state,pins,node_id))===canonicalJSON(scope),'ENVIRONMENT_BINDING_STALE','Scoped requirements changed during verification');
    requireValue(state.status === 'running', 'RUN_NOT_RUNNING', 'Run stopped during dependency verification');
    if (attention) {
      state.environment_attention = { ...environment, ...(scope?scope:{}), ...(stale ? {cause:stale} : {}) };
    } else {
      if(scope){
        state.nodes[node_id].runtime_environment_binding={...scope,environment,generation:(binding?.generation??0)+1,verified_at:new Date().toISOString()};
      }else{
      state.runtime_environment = environment;
      state.environment_generation = (state.environment_generation ?? 0) + 1;
      state.environment_rebinding = { generation: state.environment_generation, previous_sha256: digest(canonicalJSON(pinned)),
        current_sha256: digest(canonicalJSON(environment)), verified_at: new Date().toISOString(), ...(stale ? {cause:stale} : {}) };
      }
      state.environment_attention = null;
    }
    state.updated_at = new Date().toISOString();
  }, expected_sequence===undefined?{}:{expected_sequence: record.sequence});
  requireValue(!attention, 'ENVIRONMENT_SETUP_REQUIRED', '运行依赖需要重新注册；已搜索本机，安装前需要用户同意。', {environment});
  return { environment, sequence: result.sequence,...(scope?{scope_sha256:scope.scope_sha256}:{}) };
}
