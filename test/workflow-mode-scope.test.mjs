import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workflow, settle } from './fixtures.mjs';
import { openWorkbench } from '../lib/workbench-server.mjs';
import { validateWorkflowScope, projectWorkflowCatalog } from '../lib/workflow-scope.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';

async function scoped(t) {
  const f=await fixture(t);
  for(const id of ['course-example','study-example']){const graph=workflow();graph.id=id;graph.name=id;await f.service.call('create_workflow',{workflow:graph});}
  let policy={mode_pack_id:'course-builder',workflow_ids:['course-example'],enabled_workflow_ids:['course-example'],revision:0,origin:'course-origin',snapshot_id:'course-snapshot'};
  f.host.workflowScope=()=>policy;
  return {...f,get scope(){return policy;},scopeTo:value=>{policy=value;}};
}

test('Host scope validation fails on foreign enablement and catalog projection preserves all shared definitions',()=>{
  const scope=validateWorkflowScope({mode_pack_id:'course',workflow_ids:['course-example'],enabled_workflow_ids:[],revision:1});
  const rows=[{id:'course-example',template_kind:'workflow',enabled:true},{id:'study-example',template_kind:'workflow',enabled:true},{id:'shared-role',template_kind:'role',enabled:true},{id:'authoring',template_kind:'workflow',system_managed:true,enabled:true}];
  const before=canonicalJSON(rows),result=projectWorkflowCatalog(rows,scope);assert.equal(result.length,4);assert.equal(canonicalJSON(rows),before);
  assert.equal(result[0].mode_included,undefined);assert.equal(result[0].global_enabled,true);assert.equal(result[0].enabled,false);assert.equal(result[1].mode_enabled,false);
  assert.deepEqual(result.slice(2),rows.slice(2));assert.deepEqual(projectWorkflowCatalog(rows,null),rows);
  assert.throws(()=>validateWorkflowScope({...scope,enabled_workflow_ids:['foreign']}),{code:'PI_MODE_WORKFLOW_SCOPE'});
  assert.throws(()=>validateWorkflowScope({...scope,workflow_ids:['course-example','course-example']}),{code:'PI_MODE_WORKFLOW_SCOPE'});
});

test('mode switch changes product route and effective catalog availability while cross-mode management stays available',async t=>{
  const f=await scoped(t),before=await f.service.store.snapshot('study-example');
  let rows=await f.service.call('list');assert.ok(rows.some(row=>row.id==='study-example'&&row.mode_enabled===false&&row.enabled===false&&row.global_enabled===true));
  assert.equal((await f.service.call('route',{task:'study-example'})).decision,'none');assert.equal((await f.service.call('route',{task:'course-example'})).selected.id,'course-example');
  assert.equal((await f.service.call('read',{workflow_id:'study-example'})).revision_hash,before.revision_hash);
  const edit=structuredClone(before.workflow);edit.description='Teacher may review and edit this other-mode definition';
  await f.service.call('save',{workflow_id:edit.id,expected_revision:before.revision_hash,workflow:edit});
  f.scopeTo({mode_pack_id:'study-research',workflow_ids:['study-example'],enabled_workflow_ids:['study-example']});
  rows=await f.service.call('list');assert.ok(rows.some(row=>row.id==='course-example'&&row.mode_enabled===false));
  assert.equal((await f.service.call('route',{task:'course-example'})).decision,'none');
  assert.equal((await f.service.store.snapshot('course-example')).workflow.enabled,true);
});

test('model and Workbench product runs share mode admission before Run intent, and async mode changes are rechecked',async t=>{
  const f=await scoped(t),args={workflow_id:'study-example',workspace:f.workspace,access:'read_only',inputs:{task:'bounded explanation'}};
  await assert.rejects(f.service.call('run',args),{code:'PI_MODE_WORKFLOW_DISABLED'});await assert.rejects(f.service.call('start',args,{human:true}),{code:'PI_MODE_WORKFLOW_DISABLED'});
  f.scopeTo({...f.scope,enabled_workflow_ids:[]});await assert.rejects(f.service.call('run',{...args,workflow_id:'course-example'}),{code:'PI_MODE_WORKFLOW_DISABLED'});
  f.scopeTo({...f.scope,enabled_workflow_ids:['course-example']});f.host.authorizeExecution=async request=>{f.scopeTo({...f.scope,enabled_workflow_ids:[]});return {authorized:true,session_id:request.session_id,operation:request.operation};};
  await assert.rejects(f.service.call('run',{...args,workflow_id:'course-example'}),{code:'PI_MODE_WORKFLOW_DISABLED'});
  assert.equal((await f.service.call('runs')).length,0);assert.equal(f.requests.length,0);assert.equal(f.mainRequests.length,0);
});

test('already pinned Run inspection and cancellation survive a later mode scope switch',async t=>{
  const f=await scoped(t),run=await f.service.call('run',{workflow_id:'course-example',workspace:f.workspace,access:'read_only',inputs:{task:'original course task'}});
  await settle(f.service,run.run_id);const original=await f.service.runtime.runs.read(run.run_id);
  f.scopeTo({mode_pack_id:'study-research',workflow_ids:['study-example'],enabled_workflow_ids:['study-example']});
  const viewed=await f.service.call('get',{run_id:run.run_id});assert.equal(viewed.workflow_id,'course-example');
  assert.equal((await f.service.runtime.runs.read(run.run_id)).pins.root.revision_hash,original.pins.root.revision_hash);
  const cancelled=await f.service.call('cancel',{run_id:run.run_id},{human:true});assert.deepEqual(cancelled,[run.run_id]);assert.equal((await f.service.runtime.runs.read(run.run_id)).state.status,'cancelled');
});

test('human Workbench mode preference callbacks keep the server alive and never change global graphs or Role bindings',async t=>{
  const f=await scoped(t),server=await openWorkbench(f.service);t.after(()=>server.close());
  const url=new URL(server.url),token=url.hash.slice(1);url.hash='';const endpoint=new URL('/api',url);
  const post=(operation,args={})=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({operation,args})});
  const before=await f.service.store.snapshot('course-example'),settings=digest(canonicalJSON(await f.service.call('settings')));let callbacks=0;
  f.host.setWorkflowEnabled=async request=>{callbacks++;assert.equal(request.session_id,f.mainSession);assert.equal(request.expected_revision,f.scope.revision);
    await new Promise(resolve=>setImmediate(resolve));f.scopeTo({...f.scope,enabled_workflow_ids:request.enabled?['course-example']:[],revision:f.scope.revision+1});};
  const args={workflow_id:'course-example',enabled:false,mode_pack_id:f.scope.mode_pack_id,expected_revision:0,expected_origin:f.scope.origin,expected_snapshot_id:f.scope.snapshot_id};
  await assert.rejects(f.service.call('set_mode_workflow_enabled',args),{code:'HUMAN_CONFIGURATION_REQUIRED'});
  const response=await post('set_mode_workflow_enabled',args);assert.equal(response.status,200);assert.equal((await response.json()).result.revision,1);
  assert.equal((await post('workflow_scope')).status,200);assert.equal(callbacks,1);
  assert.equal((await f.service.store.snapshot('course-example')).revision_hash,before.revision_hash);assert.equal(digest(canonicalJSON(await f.service.call('settings'))),settings);
  const stale=await post('set_mode_workflow_enabled',{...args,enabled:true});assert.equal(stale.status,400);assert.equal((await stale.json()).code,'PI_MODE_WORKFLOW_CONFLICT');assert.equal(callbacks,1);
});

test('absent scope retains standalone behavior while explicit empty mode scope denies all new product runs',async t=>{
  const f=await scoped(t);delete f.host.workflowScope;
  assert.equal((await f.service.call('workflow_scope')),null);assert.equal((await f.service.call('route',{task:'course-example'})).selected.id,'course-example');
  f.host.workflowScope=()=>({mode_pack_id:'legacy-learning',workflow_ids:[],enabled_workflow_ids:[]});
  assert.equal((await f.service.call('route',{task:'course-example'})).available_ready,0);
  await assert.rejects(f.service.call('run',{workflow_id:'course-example',workspace:f.workspace,access:'read_only',inputs:{task:'scope absent bypass'}}),{code:'PI_MODE_WORKFLOW_DISABLED'});
  assert.equal((await f.service.call('read',{workflow_id:'course-example'})).workflow.id,'course-example');
});

test('Host may compose a newly registered generic Workflow using actual catalog metadata without caller injection or global mutation',async t=>{
  const f=await scoped(t);let observed=[];
  f.host.workflowScope=(sessionId,catalog)=>{
    assert.equal(sessionId,f.mainSession);observed=catalog;
    return {...f.scope,workflow_ids:catalog.filter(row=>row.kind==='workflow'&&!row.system_managed).map(row=>row.id)};
  };
  await f.service.call('workflow_scope');assert.equal(observed.some(row=>row.id==='generic-video'),false);
  const graph=workflow();graph.id='generic-video';graph.name='Video workflow';await f.service.call('create_workflow',{workflow:graph});
  const original=await f.service.store.snapshot(graph.id),scope=await f.service.call('workflow_scope');
  assert.ok(scope.workflow_ids.includes(graph.id));assert.equal(scope.enabled_workflow_ids.includes(graph.id),false);
  assert.ok(observed.some(row=>row.id===graph.id&&row.kind==='workflow'&&row.status==='ready'&&row.revision_hash===original.revision_hash));
  await assert.rejects(f.service.call('run',{workflow_id:graph.id,workspace:f.workspace,access:'read_only',inputs:{task:'video'}}),{code:'PI_MODE_WORKFLOW_DISABLED'});
  f.host.setWorkflowEnabled=async request=>{
    assert.ok(request.catalog.some(row=>row.id===graph.id));assert.equal(request.catalog.some(row=>row.id==='caller-forged'),false);
    f.scopeTo({...f.scope,enabled_workflow_ids:[...f.scope.enabled_workflow_ids,request.workflow_id],revision:1});
  };
  await f.service.call('set_mode_workflow_enabled',{workflow_id:graph.id,enabled:true,mode_pack_id:scope.mode_pack_id,
    expected_revision:0,expected_origin:scope.origin,expected_snapshot_id:scope.snapshot_id,catalog:[{id:'caller-forged'}]},{human:true});
  assert.equal((await f.service.call('route',{task:'Video workflow'})).selected.id,graph.id);
  assert.equal((await f.service.store.snapshot(graph.id)).revision_hash,original.revision_hash);
});

test('a session switch during async catalog acquisition cannot apply a preference to the new chat',async t=>{
  const f=await scoped(t),readCatalog=f.service.workflowCatalog.bind(f.service);let callbacks=0;
  f.service.workflowCatalog=async()=>{const rows=await readCatalog();const identity=f.host.mainIdentity();f.host.mainIdentity=()=>({...identity,session_id:'foreign-session'});return rows;};
  f.host.setWorkflowEnabled=async()=>{callbacks++;};
  await assert.rejects(f.service.call('set_mode_workflow_enabled',{workflow_id:'course-example',enabled:false,mode_pack_id:f.scope.mode_pack_id,
    expected_revision:0,expected_origin:f.scope.origin,expected_snapshot_id:f.scope.snapshot_id},{human:true}),{code:'PI_MAIN_SESSION_CHANGED'});
  assert.equal(callbacks,0);assert.equal(f.scope.revision,0);
});

test('another mode default never prevents a human from enabling an installed Workflow',async t=>{
  const f=await scoped(t),before=await f.service.store.snapshot('study-example');
  const scope=await f.service.call('workflow_scope');
  assert.ok(scope.workflow_ids.includes('study-example'),'actual library extends old mode default list');
  f.host.setWorkflowEnabled=async request=>{
    f.scopeTo({...f.scope,workflow_ids:scope.workflow_ids,enabled_workflow_ids:[...f.scope.enabled_workflow_ids,request.workflow_id],revision:1});
  };
  const args={workflow_id:'study-example',enabled:true,mode_pack_id:scope.mode_pack_id,expected_revision:0,expected_origin:scope.origin,expected_snapshot_id:scope.snapshot_id};
  await assert.rejects(f.service.call('set_mode_workflow_enabled',{...args,workflow_id:'not-installed'},{human:true}),{code:'PI_MODE_WORKFLOW_SCOPE'});
  await f.service.call('set_mode_workflow_enabled',args,{human:true});
  assert.equal((await f.service.call('route',{task:'study-example'})).selected.id,'study-example');
  assert.equal((await f.service.store.snapshot('study-example')).revision_hash,before.revision_hash);
});

test('standalone human switches preserve Ready/Draft status, resources and existing Run pins with revision CAS',async t=>{
  const f=await scoped(t);delete f.host.workflowScope;
  const before=await f.service.store.snapshot('course-example');
  const run=await f.service.call('run',{workflow_id:'course-example',workspace:f.workspace,access:'read_only',inputs:{task:'original'}});
  await settle(f.service,run.run_id);
  const args={workflow_id:'course-example',enabled:false,expected_revision:before.revision_hash};
  await assert.rejects(f.service.call('set_workflow_enabled',args),{code:'HUMAN_CONFIGURATION_REQUIRED'});
  const off=await f.service.call('set_workflow_enabled',args,{human:true});
  assert.equal(off.workflow.status,'ready');assert.equal(off.workflow.enabled,false);
  assert.deepEqual(off.resources,before.resources);assert.deepEqual(off.workflow.nodes,before.workflow.nodes);
  assert.equal((await f.service.call('route',{task:'course-example'})).decision,'none');
  assert.equal((await f.service.runtime.runs.read(run.run_id)).pins.root.revision_hash,before.revision_hash);
  await assert.rejects(f.service.call('set_workflow_enabled',{...args,enabled:true},{human:true}),{code:'REVISION_CONFLICT'});
  const on=await f.service.call('set_workflow_enabled',{...args,enabled:true,expected_revision:off.revision_hash},{human:true});
  assert.equal(on.workflow.status,'ready');assert.equal((await f.service.call('route',{task:'course-example'})).selected.id,'course-example');
  const draft={...on.workflow,status:'draft'};
  const saved=await f.service.call('save',{workflow_id:draft.id,workflow:draft,expected_revision:on.revision_hash},{human:true});
  const draftOff=await f.service.call('set_workflow_enabled',{...args,expected_revision:saved.revision_hash},{human:true});
  assert.equal(draftOff.workflow.status,'draft','switching never publishes a Draft');
});
