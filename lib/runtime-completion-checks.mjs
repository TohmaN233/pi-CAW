import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireValue } from '../core/workflow-paths.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';
import { bindingContext } from '../core/workflow-execution-envelope.mjs';
import { hostToolContracts, requireHostToolExecutionScope, validateHostToolReceipt,requireHostToolInputCapacity } from '../core/execution/host-tool-runner.mjs';
import { hostCompletionInputs } from '../core/execution/main-host-check.mjs';
import { completionCheckScope,completionWorkspaceSnapshot,readCompletionCheckArtifact,requireCompletionProductFreshness,requireCompletionCheckReceipt } from '../core/execution/host-completion-check.mjs';
import { runtimeEnvironmentForState } from '../core/runtime-environment-state.mjs';
import { validateTextRepairScope } from '../core/execution/native-text-amendment.mjs';
import { projectFanoutInputs } from '../core/execution/fanout-input-projection.mjs';
import { mergeHostTools, resolveHostToolDispatch, executeExternalHostTool } from './external-host-tools.mjs';

function exactActive(state,args){
  requireValue(digest(args.control_token)===state.control_hash,'RUN_AUTHORITY','Host check needs its exact controller');
  const node=state.nodes[args.node_id],attempt=node?.attempts.find(item=>item.id===args.attempt_id);
  requireValue(node.active_attempt_id===args.attempt_id&&digest(args.lease_token)===attempt?.lease_hash&&['claimed','running'].includes(attempt.status)&&state.status==='running','STALE_LEASE','Automatic check needs its exact active execution lease');return attempt;
}

/** Persist intent before effects and receipt before completion. Uncertain intent
 * cannot be replayed: recovery must reconcile the original effect explicitly. */
export async function executeCompletionCheck(service,runId,args,{definition,envelope,output,turn,itemIndex=null,allItems,resources,signal}){
  const check=definition.completion_contract?.host_check;if(!check)return null;
  const record=await service.runtime.runs.read(runId),attempt=exactActive(record.state,args);
  const pinnedDefinition=record.pins.root.workflow.nodes.find(item=>item.id===args.node_id);
  const scope=await completionCheckScope(record,pinnedDefinition,attempt,itemIndex);
  requireValue(envelope.workspace===scope.workspace&&canonicalJSON(envelope.effective_allowed_paths)===canonicalJSON(scope.allowed_paths),
    'HOST_CHECK_SCOPE','Automatic check differs from its actual pinned execution envelope');
  const contract=hostToolContracts(record.pins.root.workflow).get(check.tool);
  requireHostToolExecutionScope(contract,{access:envelope.access,allowed_paths:envelope.effective_allowed_paths});
  let inputs=hostCompletionInputs(definition,bindingContext(record.state),envelope.inputs);
  if(itemIndex!==null)inputs=projectFanoutInputs(inputs,allItems,[allItems[itemIndex]]);
  const input={inputs,output};validateData(input,contract.input_schema);requireHostToolInputCapacity(contract,input);
  requireValue(Buffer.byteLength(canonicalJSON(output))<=256*1024,'COMPLETION_LIMIT','Inline semantic output exceeds its completion bound before automatic Host effects');
  const identity={node_id:args.node_id,attempt_id:args.attempt_id,item_index:itemIndex,workspace:envelope.workspace,allowed_paths:envelope.effective_allowed_paths,
    thread_id:turn.session_id,turn_id:turn.turn_id,contract_sha256:digest(canonicalJSON(contract)),input_sha256:digest(canonicalJSON(input)),output_sha256:digest(canonicalJSON(output))};
  requireValue(typeof identity.thread_id==='string'&&typeof identity.turn_id==='string','PI_TURN_EVIDENCE','Host check requires an actual Pi session and turn');
  const slotId=digest(canonicalJSON(identity));
  const inputRef=await service.runtime.runs.saveArtifact(runId,'check-input-'+slotId.slice(0,40),Buffer.from(canonicalJSON(input)));
  const saved=await service.runtime.transition(runId,'pi_completion_check_intent',(state,pins)=>{
    const attempt=exactActive(state,args);const slots=attempt.completion_checks??={};
    requireValue(digest(canonicalJSON(hostToolContracts(pins.root.workflow).get(check.tool)))===identity.contract_sha256,'HOST_CHECK_CONTRACT','Host check contract changed');
    if(slots[slotId])return {created:false,slot:structuredClone(slots[slotId])};
    requireValue(Object.values(slots).filter(slot=>slot.identity.item_index===itemIndex).every(slot=>slot.receipt),'HOST_CHECK_UNCERTAIN','An earlier automatic Host check for this item has an uncertain effect and must be reconciled');
    slots[slotId]={identity,input_ref:inputRef,phase:'intent',receipt:null};return {created:true,slot:structuredClone(slots[slotId])};
  });
  const reference={attempt_id:args.attempt_id,slot_id:slotId};
  function result(stored,receipt){
    requireValue(receipt.status==='succeeded','PI_HOST_CHECK_FAILED',receipt.diagnostics.message);
    validateData(stored.output,contract.output_schema);
    const accepted=stored.output[check.success_field]===true;
    if(!accepted&&check.text_amendment)validateTextRepairScope(output,stored.output[check.text_amendment.repair_scope_field],check.text_amendment);
    return {accepted,reference,correction:check.correction_field?stored.output[check.correction_field]:'Automatic Host completion verification rejected the proposed result.',
      repair_scope:check.text_amendment?stored.output[check.text_amendment.repair_scope_field]:null,effects:receipt.effects};
  }
  if(!saved.result.created){
    const receipt=saved.result.slot.receipt;requireValue(receipt,'HOST_CHECK_UNCERTAIN','Automatic Host check effects have no durable receipt');
    requireCompletionCheckReceipt(receipt,identity,runId,contract.id);
    requireValue(receipt.status==='succeeded','PI_HOST_CHECK_FAILED',receipt.diagnostics.message);
    const stored=await readCompletionCheckArtifact(service.runtime,runId,args.attempt_id,receipt.output_ref);
    requireValue(canonicalJSON(stored.identity)===canonicalJSON(identity)&&canonicalJSON(stored.input_ref)===canonicalJSON(saved.result.slot.input_ref)
      &&digest(canonicalJSON(stored.output))===receipt.output_sha256,'HOST_CHECK_OUTPUT_CORRUPT','Replayed Host check output differs from exact receipt');
    validateData(stored.output,contract.output_schema);
    if(stored.output[check.success_field]===true)await requireCompletionProductFreshness(scope.workspace,scope.product_paths,stored.workspace_snapshot);
    return result(stored,receipt);
  }
  const registry=mergeHostTools(service.builtinHostTools,service.getHostTools());
  const {external,descriptor}=resolveHostToolDispatch(service.builtinHostTools,registry,contract);
  // Completion programs are Host consumers. Their executable/argv resource
  // pins are independent of the documentation deliberately exposed to workers.
  const selectedResources=contract.identity.name==='workflow-resource-program'
    ? [...new Set([contract.argv[1],...contract.argv.filter(value=>value.startsWith('@RESOURCE:')&&value.endsWith('@')).map(value=>value.slice(10,-1))])].map(path=>{
      const pin=record.pins.root.resources.find(item=>item.path===path);
      requireValue(pin,'PI_RESOURCE_MISSING',`Host completion resource has no immutable Run pin: ${path}`);
      return {...pin,object_path:join(service.runtime.runs.directory(runId),'objects',pin.sha256)};
    }) : resources;
  const pinnedResources=await Promise.all(selectedResources.map(async item=>{
    const bytes=Buffer.isBuffer(item.bytes)||item.bytes instanceof Uint8Array?item.bytes:await readFile(item.object_path);
    requireValue(digest(bytes)===item.sha256,'PI_RESOURCE_DRIFT','Host completion executable resource differs from its exact Run pin');return {...item,bytes};
  }));
  const context={run_id:runId,node_id:args.node_id,attempt_id:args.attempt_id,workspace:envelope.workspace,
    ...(!external?{program_output_directory:join(service.runtime.runs.directory(runId),'execution-materials',args.attempt_id,'checks',slotId,'program-output'),onOperation:metadata=>service.recordTaskOperation(runId,args,metadata)}:{}),
    execution_slot:slotId,
    permissions:{access:envelope.access,allowed_paths:envelope.effective_allowed_paths},resources:pinnedResources,
    runtime_environment:runtimeEnvironmentForState(record.state,args.node_id),
    prepareRuntimeEnvironment:async()=> (await service.runtime.ensureRuntimeEnvironment(runId,{...args})).environment,
    task_root:record.state.constraints?.task_workspace??envelope.workspace,
    ...(record.state.constraints?.execution_binding?{execution_binding:record.state.constraints.execution_binding}:{})};
  const authorize=async()=>{
    requireValue(!signal?.aborted,'PI_TASK_ABORTED','Automatic completion check was revoked');
    requireValue(service.host.mainIdentity().session_id===record.state.main_actor,'PI_MAIN_SESSION_CHANGED','Completion checks retain the initiating Pi actor');
    const current=mergeHostTools(service.builtinHostTools,service.getHostTools());
    requireValue(canonicalJSON(resolveHostToolDispatch(service.builtinHostTools,current,contract).descriptor)===canonicalJSON(descriptor),'PI_EXTERNAL_HOST_PIN','Host completion implementation changed during execution');
    await service.runtime.execution(runId,args);
  };
  async function persistReceipt(receipt){
    validateHostToolReceipt(receipt);
    requireValue(receipt.run_id===runId&&receipt.node_id===args.node_id&&receipt.attempt_id===args.attempt_id
      &&receipt.tool===contract.id&&receipt.contract_sha256===identity.contract_sha256&&receipt.input_sha256===identity.input_sha256,
      'HOST_CHECK_INTENT','Completion receipt differs from its exact Run/node/attempt/tool/input intent');
    await service.runtime.transition(runId,'pi_completion_check_receipt',state=>{
      requireValue(digest(args.control_token)===state.control_hash,'RUN_AUTHORITY','Completion receipt needs its original controller');
      const attempt=state.nodes[args.node_id].attempts.find(item=>item.id===args.attempt_id),slot=attempt?.completion_checks?.[slotId];
      requireValue(slot&&digest(args.lease_token)===attempt.lease_hash&&canonicalJSON(slot.identity)===canonicalJSON(identity),'HOST_CHECK_INTENT','Completion receipt lost its exact intent');
      if(slot.receipt)requireValue(canonicalJSON(slot.receipt)===canonicalJSON(receipt),'HOST_CHECK_CONFLICT','Completion receipt replay differs');
      slot.receipt=structuredClone(receipt);slot.phase='received';
    });
  }
  let executed;
  try{
    executed=external?await executeExternalHostTool(registry,contract,input,context,{signal,authorize}):await service.toolRunner.execute(contract,input,context,{signal,receiptOnError:true,registry});
  }catch(error){
    if(!external&&error?.host_tool_receipt){
      try{await persistReceipt(error.host_tool_receipt);}
      catch(receiptError){throw new AggregateError([error,receiptError],'Host completion failure receipt could not be persisted');}
    }
    throw error;
  }
  let stored;
  if(executed.receipt.status==='succeeded'){
    validateData(executed.output,contract.output_schema);
    stored={identity,input_ref:inputRef,output:executed.output,
      ...(scope.product_paths.length&&executed.output[check.success_field]===true?{workspace_snapshot:await completionWorkspaceSnapshot(scope.workspace,scope.product_paths)}:{})};
    const payload_ref=await service.runtime.runs.saveArtifact(runId,'check-output-'+slotId.slice(0,40),Buffer.from(canonicalJSON(stored)));
    const wrapper={kind:'pi_host_completion_check',identity,payload_ref};
    const ref=await service.runtime.runs.saveExecutorResult(runId,args.attempt_id,wrapper);
    executed.receipt.output_ref={...ref,bytes:Buffer.byteLength(canonicalJSON(wrapper))};
  }
  await persistReceipt(executed.receipt);
  return result(stored,executed.receipt);
}
