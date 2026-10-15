import { assertPromptBytes } from './node-input-materials.mjs';

export function sdkTaskPrompt(dispatchId, prompt, schema, limit) {
  return assertPromptBytes(`PI_CAW_DISPATCH ${dispatchId}\n${prompt}\n\nRequired semantic result schema:\n${JSON.stringify(schema)}\nSubmit the result once using caw_submit_result, then finish this turn. If that call stages the body, correct it with stage_id and patch only. Do not output the body again.`, limit);
}

export function currentMainTaskPrompt(dispatchId, prompt, schema, limit, workspace) {
  return assertPromptBytes(`PI_CAW_MAIN ${dispatchId}\nExecute the Main node in this current Pi chat. Retrieve its packet with caw {"action":"main_task","args":{}}. ${currentMainResultProtocol()}\nRun workspace: ${JSON.stringify(workspace)}. Resolve task files and native tool/program paths against this authorized workspace; the chat cwd may differ. The packet's access and allowed_paths still govern every write.\n${prompt}\nRequired semantic result schema:\n${JSON.stringify(schema)}`, limit);
}

export function currentMainResultProtocol(stageId) {
  const full='Submit semantic values with caw {"action":"main_result","args":{"summary":"Brief nonempty summary","result":<semantic JSON matching outputs_schema>}}. The argument names are summary and result; output is not a result argument. Finish the turn after a successful submission.';
  return stageId
    ? `The Host retained the submitted body under stage_id ${JSON.stringify(stageId)}. Correct it using caw {"action":"main_result","args":{"summary":"Brief nonempty summary","stage_id":${JSON.stringify(stageId)},"patch":[{"op":"set","path":"/field","value":<small correction>}]}}. patch must be an array of real corrections to the retained body. Do not resend that body. Finish the turn after promotion.`
    : full+' Use summary, stage_id and a patch array only after the Host actually returns PI_RESULT_STAGED with its real stage_id. Without that Host response, submit the correct complete result; never invent a stage_id.';
}

export function currentMainCorrectionPrompt(dispatchId,{code,reason,stageId},limit) {
  return assertPromptBytes(`PI_CAW_MAIN ${dispatchId}\nProtocol correction for the same task in this current Pi chat. Preserve completed files and continue only the result submission. Reuse the previously supplied semantic schema and inputs.\n${code}: ${reason}\n${currentMainResultProtocol(stageId)}`,limit);
}
