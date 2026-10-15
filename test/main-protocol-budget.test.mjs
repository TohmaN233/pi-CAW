import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,workflow,agent,settle} from './fixtures.mjs';

for(const exhaust of [false,true])test(`current Main protocol correction ${exhaust?'exhausts':'consumes'} the pinned budget and retains exact rejection evidence`,async t=>{
  let corrections=0;
  const f=await fixture(t,{resultFor:async request=>{
    if(request.node_id!=='work')return {text:'final'};
    assert.equal(typeof request.onSemanticCorrection,'function');
    do{
      corrections++;
      await request.onSemanticCorrection({turn_id:randomUUID(),code:'PI_RESULT_BODY',reason:'Use summary and result; no body is staged.'});
    }while(exhaust);
    return {text:'corrected'};
  }});
  const node=agent('work',{kind:'main',mode:'orchestration'});node.retry.max_attempts=2;
  await f.service.call('create_workflow',{workflow:workflow([node])});
  const run=await f.service.call('run',{workflow_id:'example',workspace:f.workspace,access:'read_only',inputs:{task:'Correct a native submission'}});
  const snapshot=await settle(f.service,run.run_id),state=snapshot.state.nodes.work,attempt=state.attempts.at(-1);
  assert.equal(state.status,exhaust?'failed':'succeeded',JSON.stringify(state.error));assert.equal(attempt.completion_turns,2,JSON.stringify(state.error));
  const rejections=attempt.executor_events.filter(e=>e.kind==='semantic_blocked');assert.equal(rejections.length,exhaust?2:1);
  for(const entry of rejections){assert.equal(entry.metadata.thread_id,f.mainSession);assert.match(entry.metadata.reason,/PI_RESULT_BODY:.*no body is staged/);}
  const evidence=attempt.executor_events.filter(e=>e.kind==='tool_operation'&&e.metadata.tool==='main_semantic_result');assert.equal(evidence.length,rejections.length);
  for(const entry of evidence){assert.equal(entry.metadata.code,'PI_RESULT_BODY');assert.match(entry.metadata.evidence_sha256,/^[a-f0-9]{64}$/);assert(entry.metadata.artifact);}
  if(exhaust){assert.equal(state.error.code,'PI_MAIN_REPAIR_EXHAUSTED');assert.match(state.error.message,/Use summary and result/);assert.equal(snapshot.state.nodes.final.status,'pending');}
  else assert.equal(state.output.text,'corrected');
});
