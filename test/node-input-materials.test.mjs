import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { prepareNodeInputMaterials, NODE_INPUT_BUDGETS } from '../lib/node-input-materials.mjs';
import { sdkTaskPrompt, currentMainTaskPrompt } from '../lib/task-prompt.mjs';
import { sharedPrefixInputProjection } from '../core/execution/shared-prefix-contract.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { fixture, workflow } from './fixtures.mjs';
import { createPiToolBroker } from '../lib/host-tools.mjs';

async function directory(t) {
  const root=await mkdtemp(join(tmpdir(),'pi-input-materials-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
test('multibyte fields and JSON escaping spill whole semantic values with exact durable hashes',async t=>{
  const root=await directory(t),inputs={task:'汉😀\\"\n'.repeat(2000),context:{data:'x'.repeat(9000)},verification:'small',lone:'\ud800'};
  const prepared=await prepareNodeInputMaterials({directory:root,identity:{attempt:'a'},inputs});
  const manifest=JSON.parse(await readFile(prepared.evidence.manifest_path,'utf8'));
  assert.equal(manifest.semantic_input_sha256,digest(canonicalJSON(inputs)));
  assert(manifest.inline_bytes<=12000);assert(manifest.index_bytes<=16000);
  assert.equal(manifest.fields.find(item=>item.field==='task').inline,false);
  for(const field of manifest.fields){
    const bytes=await readFile(join(dirname(prepared.evidence.manifest_path),field.path.split('/').at(-1)));
    assert.equal(digest(bytes),field.sha256);
    assert.deepEqual(field.encoding==='utf8'?bytes.toString('utf8'):JSON.parse(bytes.toString('utf8')),inputs[field.field]);
  }
  assert.equal(prepared.variables.verification,'small');assert(!prepared.variables.task.includes(inputs.task));
});
test('aggregate admission and serialized index remain bounded even with many escaped field names',async t=>{
  const inputs=Object.fromEntries(Array.from({length:80},(_,i)=>['field'+i+'"\\'.repeat(80),'a'.repeat(1000)]));
  const prepared=await prepareNodeInputMaterials({directory:await directory(t),identity:{node:'many'},inputs});
  const manifest=JSON.parse(await readFile(prepared.evidence.manifest_path,'utf8'));
  assert.equal(manifest.fields.length,80);assert(manifest.inline_bytes<=NODE_INPUT_BUDGETS.inline_bytes);
  assert(Buffer.byteLength(prepared.index)<=16000);assert(manifest.index_material);
  const index=prepared.resources.find(item=>item.path===manifest.index_material.path);
  assert.equal(Object.keys(JSON.parse(await readFile(index.object_path,'utf8'))).length,80);
});
test('exact material reuse succeeds and changed evidence fails without overwriting the original',async t=>{
  const args={directory:await directory(t),identity:{attempt:'exact'},inputs:{task:'hello'}};
  const one=await prepareNodeInputMaterials(args),two=await prepareNodeInputMaterials(args);
  assert.deepEqual(two.evidence,one.evidence);
  const manifest=JSON.parse(await readFile(one.evidence.manifest_path,'utf8'));
  const path=join(dirname(one.evidence.manifest_path),manifest.fields[0].path.split('/').at(-1));await writeFile(path,'changed');
  await assert.rejects(prepareNodeInputMaterials(args),{code:'PI_INPUT_MATERIAL_CONFLICT'});
  assert.equal(await readFile(path,'utf8'),'changed');
});
test('catalog and input values share aggregate and serialized budgets including escaping',async t=>{
  const resources=Array.from({length:30},(_,i)=>({path:'source/'+i+'.txt',sha256:'a'.repeat(64)})),inputs={task:'"\\'.repeat(1500),context:'汉'.repeat(1300),verification:'v'.repeat(4000)};
  const prepared=await prepareNodeInputMaterials({directory:await directory(t),identity:{node:'catalog'},inputs,resources});
  const manifest=JSON.parse(await readFile(prepared.evidence.manifest_path,'utf8'));
  assert(manifest.inline_bytes<=12000);assert(manifest.index_bytes<=16000);
  assert.equal(manifest.index_bytes,Buffer.byteLength(prepared.index)+Buffer.byteLength(prepared.catalog));
  assert(prepared.evidence.spilled_count>0);
});
test('large native input pin reconstructs beyond 1 MiB through exact resource chunks',async t=>{
  const root=await directory(t),task='汉😀\\"'.repeat(120000);
  const prepared=await prepareNodeInputMaterials({directory:join(root,'materials'),identity:{run:'large'},inputs:{task}});
  const resource=prepared.resources[0],bytes=await readFile(resource.object_path);assert(bytes.length>1024*1024);
  const broker=await createPiToolBroker({workspace:root,access:'read_only',allowedPaths:[],resources:[{...resource,bytes}],authorize:async()=>{},onOperation:async()=>{}});
  try{
    let cursor=0,text='';
    do{
      const reply=await broker.call('read_workflow_resource_chunk',{path:resource.path,start_byte:cursor,max_bytes:12000},'chunk-'+cursor);
      const value=JSON.parse(reply.contentItems[0].text);text+=value.text;cursor=value.end_byte;
      if(value.complete)break;
    }while(cursor<bytes.length);
    assert.equal(text,task);assert.equal(cursor,bytes.length);
  }finally{await broker.quiesce();}
});
test('incremental item preparation deduplicates complete common resource pins within one assignment',async t=>{
  const root=await directory(t),common=Object.fromEntries(Array.from({length:17},(_,i)=>['common'+i,'shared-value-'+i+'x'.repeat(10000)]));
  const pins=new Map();
  for(let index=0;index<32;index++){
    const prepared=await prepareNodeInputMaterials({directory:root,identity:{run:'r',assignment:0,indices:[index]},inputs:{...common,item:[index]}});
    for(const item of prepared.resources){if(pins.has(item.path))assert.equal(pins.get(item.path).sha256,item.sha256);pins.set(item.path,item);}
  }
  assert.equal(pins.size,17);
});
test('complete native and current Main prompts count schema and UTF-8 bytes before delivery',()=>{
  for(const compile of [sdkTaskPrompt,currentMainTaskPrompt]){
    const body='汉'.repeat(100),schema={description:'😀'.repeat(100)},submitted=compile('id',body,schema,5000);
    const bytes=Buffer.byteLength(submitted);assert(bytes>submitted.length);
    assert.equal(compile('id',body,schema,bytes),submitted);
    assert.throws(()=>compile('id',body,schema,bytes-1),{code:'PI_PROMPT_LIMIT'});
  }
});
test('shared prefix checks canonical equality after structured and JSON item projection',()=>{
  const items=[{id:'a'},{id:'b'}],envelope={inputs:{task:'same',nested:{items},context_json:JSON.stringify({items})},prompt_template:'{{task}}'};
  assert.deepEqual(sharedPrefixInputProjection(envelope,items,{common_inputs:['task']}),{task:'same'});
  for(const name of ['nested','context_json'])assert.throws(()=>sharedPrefixInputProjection(envelope,items,{common_inputs:[name,'task']}),{code:'HOST_MAIN_PREFIX_INPUT'});
  assert.throws(()=>sharedPrefixInputProjection(envelope,items,{common_inputs:[]}),{code:'HOST_MAIN_PREFIX_TEMPLATE'});
});
test('native service hands large inputs to exact scoped materials before any task dispatch',async t=>{
  const task='汉😀'.repeat(20000),seen=[];
  const f=await fixture(t,{resultFor:request=>{seen.push(request);return {text:'done'};}});
  const graph=workflow();await f.service.call('create_workflow',{workflow:graph});
  const run=await f.service.call('run',{workflow_id:graph.id,inputs:{task},workspace:f.workspace,access:'read_only'});
  await f.service.active.get(run.run_id)?.completion;
  const record=await f.service.runtime.runs.read(run.run_id);
  assert.equal(record.state.nodes.work.status,'succeeded');assert(seen.length>0);
  const request=seen.find(item=>item.node_id==='work'),resource=request.resources.find(item=>item.path.startsWith('pi-caw-inputs/'));
  assert.equal(await readFile(resource.object_path,'utf8'),task);
  assert(request.program_output_directory.startsWith(f.service.runtime.runs.directory(run.run_id)));
  const event=record.state.nodes.work.attempts[0].executor_events.find(item=>item.kind==='node_inputs_prepared');assert(event);
  assert.equal(event.metadata.semantic_input_sha256,digest(canonicalJSON({task})));
});
