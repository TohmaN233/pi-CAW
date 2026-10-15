import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { canonicalJSON, digest } from '../workflow-revisions.mjs';
import { requireValue, noSymlinks } from '../workflow-paths.mjs';
import { validateData } from '../workflow-data-schema.mjs';
import { hostToolContracts, validateHostToolReceipt } from './host-tool-runner.mjs';
import { executionEnvelope } from '../workflow-execution-envelope.mjs';
import { intersectBoundaries, pathBoundaries } from '../workflow-bindings.mjs';
import { assignedFanoutWritePaths } from './fanout-input-projection.mjs';
import { fanoutWorkspaces } from './fanout-workspace.mjs';

const MAX_SNAPSHOT_BYTES=256*1024*1024;
const inside=path=>path&&path!=='..'&&!path.startsWith('../')&&!isAbsolute(path);
const localPath=(workspace,target)=>relative(resolve(workspace),resolve(target)).replaceAll('\\','/');
const sameFile=(left,right)=>right.isFile()&&right.nlink===1&&left.dev===right.dev&&left.ino===right.ino
  &&left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs;

// Required artifacts are pinned node-relative products, never inferred from
// semantic output or observed effects. An isolated item owns only its subset.
export function completionProductPaths(definition,envelope,scope){
  const paths=[];
  for(const item of definition.required_artifacts??[]){
    const exact=pathBoundaries([item.path])[0],absolute=resolve(envelope.workspace,exact);
    requireValue(inside(localPath(envelope.workspace,absolute)),'HOST_CHECK_SCOPE','Declared product leaves the node workspace');
    const path=localPath(scope.workspace,absolute);
    if(!inside(path)){
      requireValue(Boolean(definition.fanout),'HOST_CHECK_SCOPE','Declared product leaves the check workspace');continue;
    }
    requireValue(intersectBoundaries(scope.allowed_paths,[path]).includes(path),'HOST_CHECK_SCOPE',`Declared product is outside the check grant: ${path}`);
    paths.push(path);
  }
  return [...new Set(paths)].sort();
}

export async function completionCheckScope({state,pins},definition,attempt,itemIndex=null){
  const envelope=executionEnvelope(definition,state,pins,attempt,null);
  let scope={workspace:envelope.workspace,allowed_paths:envelope.effective_allowed_paths};
  if(definition.fanout){
    const items=envelope.subagents.items;
    requireValue(Number.isSafeInteger(itemIndex)&&itemIndex>=0&&itemIndex<items.length,'HOST_CHECK_REQUIRED','Host check needs its exact pinned item index');
    const item=items[itemIndex],isolated=await fanoutWorkspaces(envelope,[item],definition.fanout);
    scope=isolated?{workspace:isolated[0].workspace,allowed_paths:isolated[0].allowed_paths}
      :{workspace:envelope.workspace,allowed_paths:assignedFanoutWritePaths({workspace:envelope.workspace,nodeAllowedPaths:envelope.effective_allowed_paths,assignedItems:[item],fanout:definition.fanout})};
  }else requireValue(itemIndex===null,'HOST_CHECK_REQUIRED','Single Host check cannot select an item');
  return {...scope,product_paths:completionProductPaths(definition,envelope,scope)};
}

// A successful semantic check freezes explicit products only. Bounded reads
// retain stable physical observations without walking granted directories.
export async function completionWorkspaceSnapshot(workspace, paths) {
  requireValue(Array.isArray(paths)&&paths.length<=64,'HOST_CHECK_SNAPSHOT_LIMIT','Completion snapshot exceeds 64 declared products');
  const entries=[];let bytes=0;
  for(const path of paths){
    const target=resolve(workspace,path),key=localPath(workspace,target);
    requireValue(inside(key)&&key===path,'HOST_CHECK_SCOPE','Completion product must be an exact workspace-relative file');
    await noSymlinks(target);const before=await lstat(target);
    requireValue(before.isFile()&&before.nlink===1,'HOST_CHECK_SCOPE','Completion products require regular single-link files');
    bytes+=before.size;requireValue(Number.isSafeInteger(before.size)&&bytes<=MAX_SNAPSHOT_BYTES,'HOST_CHECK_SNAPSHOT_LIMIT','Completion products exceed 256 MiB');
    const handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      requireValue(sameFile(before,await handle.stat()),'HOST_CHECK_SNAPSHOT_STALE',`Completion product changed before reading: ${path}`);
      const content=Buffer.alloc(before.size+1);let length=0;
      while(length<content.length){const read=await handle.read(content,length,Math.min(65536,content.length-length),length);if(!read.bytesRead)break;length+=read.bytesRead;}
      await noSymlinks(target);
      requireValue(length===before.size&&sameFile(before,await handle.stat())&&sameFile(before,await lstat(target)),
        'HOST_CHECK_SNAPSHOT_STALE',`Completion product changed while reading: ${path}`);
      entries.push({path,bytes:length,sha256:digest(content.subarray(0,length))});
    }finally{await handle.close();}
  }
  return {schema_version:1,coverage:'declared_products',workspace:resolve(workspace),entries};
}

export async function requireCompletionProductFreshness(workspace,paths,saved){
  if(!paths.length)return;
  requireValue(saved&&typeof saved==='object'&&!Array.isArray(saved),'HOST_CHECK_SNAPSHOT_REQUIRED','Declared products lack durable completion proof');
  if(typeof saved.schema_version!=='number'){
    // Legacy plain maps stay immutable. Only current exact declared paths are
    // evidence; unrelated entries do not regain whole-workspace authority.
    const key=path=>process.platform==='win32'?path.toLowerCase():path;
    const hashes=new Map(),savedPaths=Object.keys(saved);
    for(const path of paths){
      const matches=savedPaths.filter(candidate=>key(candidate)===key(path));
      requireValue(matches.length>0&&matches.every(candidate=>typeof saved[candidate]==='string'&&/^[a-f0-9]{64}$/.test(saved[candidate])&&saved[candidate]===saved[matches[0]]),
        'HOST_CHECK_SNAPSHOT_REQUIRED','Legacy completion snapshot lacks consistent valid declared product hashes');
      hashes.set(path,saved[matches[0]]);
    }
    const current=await completionWorkspaceSnapshot(workspace,paths);
    requireValue(current.entries.every(item=>item.sha256===hashes.get(item.path)),'HOST_CHECK_SNAPSHOT_STALE','Declared products changed after automatic completion verification');return;
  }
  requireValue(saved.schema_version===1&&saved.coverage==='declared_products'&&saved.workspace===resolve(workspace)&&Array.isArray(saved.entries)
    &&canonicalJSON(saved.entries.map(item=>item?.path))===canonicalJSON(paths)
    &&saved.entries.every(item=>item&&Object.keys(item).length===3&&Number.isSafeInteger(item.bytes)&&item.bytes>=0&&item.bytes<=MAX_SNAPSHOT_BYTES&&typeof item.sha256==='string'&&/^[a-f0-9]{64}$/.test(item.sha256)),
    'HOST_CHECK_SNAPSHOT_REQUIRED','Completion snapshot differs from its exact declared products');
  requireValue(canonicalJSON(await completionWorkspaceSnapshot(workspace,paths))===canonicalJSON(saved),
    'HOST_CHECK_SNAPSHOT_STALE','Declared products changed after automatic completion verification');
}

export function requireCompletionCheckReceipt(receipt,identity,runId,tool){
  validateHostToolReceipt(receipt);
  requireValue(receipt.run_id===runId&&receipt.node_id===identity.node_id&&receipt.attempt_id===identity.attempt_id&&receipt.tool===tool
    &&receipt.contract_sha256===identity.contract_sha256&&receipt.input_sha256===identity.input_sha256,
    'HOST_CHECK_INTENT','Completion receipt differs from its exact Run/node/attempt/tool/input intent');
}

export async function readCompletionCheckArtifact(runtime,runId,attemptId,reference){
  const wrapper=await runtime.runs.readExecutorResult(runId,attemptId,reference.sha256);
  requireValue(wrapper.kind==='pi_host_completion_check','HOST_CHECK_OUTPUT_CORRUPT','Unexpected completion check artifact');
  const bytes=await runtime.runs.readArtifact(runId,wrapper.payload_ref),stored=JSON.parse(bytes.toString('utf8'));
  requireValue(canonicalJSON(stored.identity)===canonicalJSON(wrapper.identity),'HOST_CHECK_OUTPUT_CORRUPT','Completion check payload identity differs');
  const input=JSON.parse((await runtime.runs.readArtifact(runId,stored.input_ref)).toString('utf8'));
  requireValue(digest(canonicalJSON(input))===stored.identity.input_sha256,'HOST_CHECK_OUTPUT_CORRUPT','Completion check input differs from its durable intent');
  requireValue(digest(canonicalJSON(input.output))===stored.identity.output_sha256,'HOST_CHECK_OUTPUT_CORRUPT','Completion check input differs from its exact semantic proposal');
  return stored;
}

export async function requireHostCompletionProof(runtime,runId,{state,pins},definition,attempt,output,reference,itemIndex=null) {
  const check=definition.completion_contract?.host_check;if(!check)return;
  requireValue(reference?.attempt_id&&typeof reference.slot_id==='string','HOST_CHECK_REQUIRED','Completion needs an exact durable automatic Host check');
  const owner=state.nodes[definition.id].attempts.find(item=>item.id===reference.attempt_id);
  const slot=owner?.completion_checks?.[reference.slot_id];
  requireValue(owner&&slot?.receipt?.status==='succeeded'&&slot.identity.output_sha256===digest(canonicalJSON(output))&&slot.identity.item_index===itemIndex,'HOST_CHECK_REQUIRED','Completion check does not bind its exact proposed item output');
  requireValue(owner.id===attempt.id||attempt.inherited_native_item_indices?.includes(itemIndex),'HOST_CHECK_REQUIRED','Completion check belongs to another execution attempt');
  const contract=hostToolContracts(pins.root.workflow).get(check.tool);
  requireValue(slot.identity.contract_sha256===digest(canonicalJSON(contract)),'HOST_CHECK_REQUIRED','Completion check contract differs from the pinned graph');
  requireValue(slot.identity.node_id===definition.id&&slot.identity.attempt_id===owner.id&&reference.slot_id===digest(canonicalJSON(slot.identity)),
    'HOST_CHECK_REQUIRED','Completion check slot differs from its exact node and attempt');
  const scope=await completionCheckScope({state,pins},definition,owner,itemIndex);
  requireValue(slot.identity.workspace===scope.workspace&&canonicalJSON(slot.identity.allowed_paths)===canonicalJSON(scope.allowed_paths),
    'HOST_CHECK_SCOPE','Completion check differs from its actual pinned execution envelope');
  requireCompletionCheckReceipt(slot.receipt,slot.identity,runId,contract.id);
  const stored=await readCompletionCheckArtifact(runtime,runId,owner.id,slot.receipt.output_ref);
  requireValue(canonicalJSON(stored.identity)===canonicalJSON(slot.identity)
    &&canonicalJSON(stored.input_ref)===canonicalJSON(slot.input_ref)
    &&digest(canonicalJSON(stored.output))===slot.receipt.output_sha256,'HOST_CHECK_OUTPUT_CORRUPT','Completion check durable output differs from its receipt');
  validateData(stored.output,contract.output_schema);
  requireValue(stored.output[check.success_field]===true,'HOST_CHECK_REJECTED','Automatic Host completion check rejected this result');
  await requireCompletionProductFreshness(scope.workspace,scope.product_paths,stored.workspace_snapshot);
  return slot;
}
