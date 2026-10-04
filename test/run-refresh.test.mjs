import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunRefresh, currentMainPending, finalDecisionArgs, loadPiRunPanelSnapshot, loadRunPanelSnapshot, loadRunSnapshot, retainedRecheckedReview } from '../web-src/run-refresh.mjs';
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; }
function snapshot(sequence) { return { state: { sequence }, next: {sequence}, events: [sequence], live: {sequence} }; }
test('later refresh publishes one complete snapshot and discards a late older generation', async () => {
  const control = createRunRefresh(), first = deferred(), second = deferred(), published = [];
  const a = control.refresh(() => first.promise, value => published.push(value));
  const b = control.refresh(() => second.promise, value => published.push(value));
  assert.equal(published.length, 0);
  second.resolve(snapshot(11)); assert.equal(await b, true);
  first.resolve(snapshot(10)); assert.equal(await a, false);
  assert.deepEqual(published, [snapshot(11)]);
  assert.equal(await control.refresh(async () => snapshot(9), value => published.push(value)), false);
  assert.deepEqual(published, [snapshot(11)]);
});
test('selection invalidation rejects in-flight snapshots and current errors remain visible', async () => {
  const control = createRunRefresh(), old = deferred(), published = [];
  const a = control.refresh(() => old.promise, value => published.push(value));
  control.invalidate(); old.resolve(snapshot(20)); assert.equal(await a, false);
  assert.deepEqual(published, []);
  await assert.rejects(control.refresh(async () => { throw new Error('current failure'); }, () => {}), /current failure/);
});

test('an old Run action completing after disposal cannot start or publish another refresh', async () => {
  const control = createRunRefresh(); control.dispose();
  let loaded = false;
  assert.equal(await control.refresh(async () => { loaded = true; return snapshot(99); }, () => assert.fail('published disposed Run')), false);
  assert.equal(loaded, false);
});


test('event polling advances only the published cursor and resets on authority change', async () => {
  const refresh = createRunRefresh(); const calls = []; let published; let head = 2;
  const api = async (_op, args) => {
    calls.push(args.after_sequence);
    return { state: { sequence: head }, next: { sequence: head }, events: [1,2,3].filter(n => n <= head && n > args.after_sequence).map(sequence => ({ sequence })) };
  };
  const poll = authority => refresh.refresh(previous => loadRunSnapshot(api, 'run', authority, previous), value => { published = value; });
  await poll('first'); head = 3; await poll('first');
  assert.deepEqual(calls, [0,2]);
  assert.deepEqual(published.events.map(e => e.sequence), [1,2,3]);
  await poll('rotated'); assert.deepEqual(calls, [0,2,0]);
  const gate = deferred();
  const stale = refresh.refresh(async previous => { await gate.promise; return loadRunSnapshot(api, 'run', 'rotated', previous); }, () => assert.fail('stale published'));
  await poll('rotated'); gate.resolve(); await stale;
  await poll('rotated'); assert.equal(calls.at(-1), 3);
});

test('a Run without a pending Main action still publishes its first snapshot', async () => {
  const refresh = createRunRefresh(); let published;
  const calls=[];
  const api=async (operation,args) => {
    calls.push(operation);
    if(operation==='run_snapshot')return {state:{sequence:1,status:'running'},next:{approvals:[]},events:[{sequence:1}]};
    if(operation==='current_main_pending'){assert.deepEqual(args,{run_id:'run-1'});return null;}
    assert.fail(`Unexpected operation: ${operation}`);
  };
  assert.equal(await refresh.refresh(previous=>loadRunPanelSnapshot(api,'run-1',undefined,previous),value=>{published=value;}),true);
  assert.equal(published.state.status,'running');
  assert.equal(published.bridgeProposal,null);
  assert.deepEqual(calls,['run_snapshot','current_main_pending']);
});

test('Main pending views keep valid acceptance and control gates visible', async () => {
  const final={kind:'final_acceptance',run_id:'run-1',node_id:'final',proposal:{accepted:true}};
  const control={kind:'control_wait',outcome:{status:'blocked',stop_reason:'approval',approvals:[{id:'approval-1'}]}};
  const active={kind:'host_main',run_id:'run-1',status:'running'};
  const detached={run_id:'run-1',pid:1234,phase:'running',at:'2026-09-26T00:00:00.000Z'};
  for(const value of [final,control,active,detached]){
    const expected=value===detached?{...detached,kind:'host_main',status:'running'}:value;
    assert.deepEqual(currentMainPending(value,'run-1'),expected);
    const api=async operation=>operation==='run_snapshot'
      ?{state:{sequence:1},next:{},events:[]}:value;
    const refresh=createRunRefresh();let published;
    assert.equal(await refresh.refresh(previous=>loadRunPanelSnapshot(api,'run-1',undefined,previous,
      async()=>({status:'running'})),snapshot=>{published=snapshot;}),true);
    assert.deepEqual(published.bridgeProposal,expected);
    assert.deepEqual(published.live,{status:'running'});
  }
  assert.equal(currentMainPending(null,'run-1'),null);
});

test('malformed or unknown Main pending responses fail visibly before snapshot publication', async () => {
  for(const value of [undefined,[],{}, {kind:'unknown',run_id:'run-1'},
    {kind:'final_acceptance',run_id:'run-1',node_id:'final'},
    {kind:'control_wait',outcome:null},
    {kind:'host_main',run_id:'another-run',status:'running'},
    {run_id:'run-1',phase:'running',pid:1234}])
    assert.throws(()=>currentMainPending(value,'run-1'),error=>error.detail?.code==='CURRENT_MAIN_PENDING_INVALID');
  const refresh=createRunRefresh();let published=false;
  const api=async operation=>operation==='run_snapshot'
    ?{state:{sequence:1},next:{},events:[]}:{kind:'unknown',run_id:'run-1'};
  await assert.rejects(refresh.refresh(previous=>loadRunPanelSnapshot(api,'run-1',undefined,previous),()=>{published=true;}),
    error=>error.detail?.code==='CURRENT_MAIN_PENDING_INVALID');
  assert.equal(published,false);
});

test('Pi Run polling retains event deltas without exposing controller tokens', async () => {
  const calls = [], pack = { workflow: { finalization: { node_id: 'final' } } };
  let sequence = 1;
  const api = async (operation, args) => {
    calls.push({ operation, args });
    if (operation === 'run_definition') return pack;
    if (operation === 'run_snapshot') return { state: { run_id: 'pi-run', sequence, nodes: { final: { attempts: [] } } },
      next: { approvals: [] }, events: [{ sequence }] };
    assert.fail(`Unexpected operation: ${operation}`);
  };
  const first = await loadPiRunPanelSnapshot(api, 'pi-run', null);
  sequence = 2;
  const next = await loadPiRunPanelSnapshot(api, 'pi-run', first);
  assert.deepEqual(next.events, [{ sequence: 1 }, { sequence: 2 }]);
  assert.deepEqual(calls.filter(call => call.operation === 'run_snapshot').map(call => call.args),
    [{ run_id: 'pi-run', after_sequence: 0 }, { run_id: 'pi-run', after_sequence: 1 }]);
  assert.equal(next.proposal, null);
});

test('Pi final and authoring proposal views must match the observed journal attempt', async () => {
  const hash = 'a'.repeat(64), other = 'b'.repeat(64);
  const pack = { workflow: { finalization: { node_id: 'final' } }, provenance: { kind: 'authoring_workflow_run' } };
  const api = (finalHash, authoringHash) => async operation => {
    if (operation === 'run_definition') return pack;
    if (operation === 'run_snapshot') return { state: { run_id: 'pi-run', sequence: 2,
      nodes: { final: { attempts: [{ result_proposal: { sha256: hash } }] } } }, events: [], next: {} };
    if (operation === 'final_proposal') return { proposal_sha256: finalHash, completion: { summary: 'Reviewed' } };
    if (operation === 'advance_authoring') return { phase: 'review_required', proposal_sha256: authoringHash };
    assert.fail(`Unexpected operation: ${operation}`);
  };
  const snapshot = await loadPiRunPanelSnapshot(api(hash, hash), 'pi-run', null);
  assert.equal(snapshot.authoring.proposal_sha256, snapshot.proposal.proposal_sha256);
  await assert.rejects(loadPiRunPanelSnapshot(api(other, hash), 'pi-run', null), /final proposal changed/);
  await assert.rejects(loadPiRunPanelSnapshot(api(hash, other), 'pi-run', null), /authoring proposal changed/);
});

test('final decisions carry the exact displayed hash, explicit acceptance or bounded rejection reason', () => {
  const proposal = { proposal_sha256: 'a'.repeat(64) };
  assert.deepEqual(finalDecisionArgs(proposal, { accepted: true, expected_revision: 'source-version' }),
    { proposal_sha256: proposal.proposal_sha256, accepted: true, expected_revision: 'source-version' });
  assert.deepEqual(finalDecisionArgs(proposal, { reason: '  Verification failed  ' }),
    { proposal_sha256: proposal.proposal_sha256, reason: 'Verification failed' });
  assert.throws(() => finalDecisionArgs(proposal, { reason: ' ' }), /rejection reason/);
  assert.throws(() => finalDecisionArgs(proposal, { reason: 'x'.repeat(2001) }), /rejection reason/);
  assert.throws(() => finalDecisionArgs({ proposal_sha256: 'unknown' }, { accepted: true }), /exact final proposal/);
});

test('retained reviewer acceptance is available only for the exact closed artifact after a Host checklist rejection', () => {
  const hash='a'.repeat(64), pack={provenance:{kind:'authoring_workflow_run',source_revision:'source-revision'}};
  const proposal={proposal_sha256:hash};
  const attempt={id:'saved-review',status:'failed',error:{code:'GENERATION_REVIEW_REJECTED'},
    result_proposal:{sha256:hash},dispatch:{receipt:{task_id:'exact-session'}},
    executor_events:[{kind:'session_state',metadata:{status:'closed'}}]};
  const state={generation_repair:{feedback:{code:'GENERATION_CHECKLIST_INVALID'}},nodes:{final:{status:'ready',attempts:[attempt]}}};
  assert.equal(retainedRecheckedReview(state,pack,proposal),attempt);
  assert.equal(retainedRecheckedReview(state,pack,{proposal_sha256:'b'.repeat(64)}),null);
  assert.equal(retainedRecheckedReview(state,{provenance:{}},proposal),null);
  for(const changed of [{status:'running'},{dispatch:{}},{executor_events:[]},{dispatch:{receipt:{},cancellation_pending:true}}]) {
    const altered=structuredClone(state);Object.assign(altered.nodes.final.attempts[0],changed);
    assert.equal(retainedRecheckedReview(altered,pack,proposal),null);
  }
  assert.deepEqual(finalDecisionArgs(proposal,{accepted:true,expected_revision:pack.provenance.source_revision}),
    {proposal_sha256:hash,accepted:true,expected_revision:'source-revision'});
});

test('Pi polling keeps durable owner errors visible and refuses a missing observed final artifact', async () => {
  const worker={status:'attention',error:{code:'PI_MCP_LOGIN_REQUIRED',message:'Sign in with /mcp in the parent Pi conversation.'}};
  const api=async operation=>{
    if(operation==='run_definition')return {workflow:{finalization:{node_id:'final'}}};
    if(operation==='run_snapshot')return {state:{run_id:'pi-run',sequence:1,nodes:{final:{attempts:[]}}},events:[],next:{},host_worker:worker};
    assert.fail(operation);
  };
  assert.deepEqual((await loadPiRunPanelSnapshot(api,'pi-run',null)).host_worker,worker);
  await assert.rejects(loadPiRunPanelSnapshot(async operation=>{
    if(operation==='run_snapshot')return {state:{run_id:'pi-run',sequence:1,nodes:{final:{attempts:[{result_proposal:{sha256:'a'.repeat(64)}}]}}},events:[],next:{}};
    if(operation==='final_proposal')return null;
    return api(operation);
  },'pi-run',null),/final proposal changed/);
});
