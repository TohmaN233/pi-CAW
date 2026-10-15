import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,workflow,agent,settle} from './fixtures.mjs';
import {workflowResourceProgramIdentity} from '../core/execution/workflow-resource-program.mjs';

test('Host completion selects executable and argv pins without exposing them or unrelated resources to worker',async t=>{
 const f=await fixture(t),node={...agent('work'),access:'bounded_write',path_scope:['.'],resources:[],
  completion_contract:{on_missing:'block',outcome:'artifact',host_check:{tool:'check_program',success_field:'complete',correction_field:'diagnostic'}}};
 const graph=workflow([node]);graph.requirements.executables=[{name:'node',version:'>=22'}];
 graph.host_tools=[{id:'check_program',identity:workflowResourceProgramIdentity(),argv:['node','check.mjs','.scratch','@INPUT@','@RESOURCE:expected.txt@'],env_allow:[],
  input_schema:{type:'object',properties:{inputs:{},output:{}},required:['inputs','output'],additionalProperties:false},
  output_schema:{type:'object',properties:{complete:{type:'boolean'},diagnostic:{type:'string'}},required:['complete','diagnostic'],additionalProperties:false},
  permissions:{network:false,read_paths:['.'],write_paths:['.']},deadline_ms:10000,output_cap_bytes:131072,idempotency:{mode:'safe'}}];
 await f.service.call('create_workflow',{workflow:graph,resources:{'check.mjs':"import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const expected=fs.readFileSync(process.argv[3],'utf8');console.log(JSON.stringify({complete:input.output.text===expected,diagnostic:'Exact pinned check ran'}));",'expected.txt':'done','unrelated.bin':Buffer.from([255,254,253])}});
 const run=await f.service.call('run',{workflow_id:graph.id,workspace:f.workspace,access:'bounded_write',allowed_paths:['.'],inputs:{task:'Check a result'}});
 await settle(f.service,run.run_id);
 const record=await f.service.runtime.runs.read(run.run_id);
 assert.equal(record.state.nodes.work.status,'succeeded',JSON.stringify(record.state.nodes.work.error));
 assert.deepEqual(f.requests[0].resources,[]);
 const checks=Object.values(record.state.nodes.work.attempts[0].completion_checks);assert.equal(checks.length,1);assert.equal(checks[0].receipt.status,'succeeded');
});
