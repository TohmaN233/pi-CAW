import test from 'node:test';
import assert from 'node:assert/strict';
import { callableInventory } from '../core/skill-import/callable-inventory.mjs';
import { callableSourceRequirements, observedSourceRequirements } from '../core/skill-import/source-requirements.mjs';
import { runtimeCallableInterface, callableBindingIssues } from '../core/skill-import/callable-runtime-interface.mjs';
import { sourceResourceMentions } from '../core/skill-import/source-resource-mentions.mjs';
import { analyzeSkillDependencies } from '../core/skill-import/dependency-reader.mjs';
import { reconcileImportObservations } from '../core/skill-import/import-reconciliation.mjs';
import { digest } from '../core/workflow-revisions.mjs';
import { redactKnownCredentials } from '../core/skill-import/skill-reader.mjs';

const bytes = text => Buffer.from(text);
test('callables bind exact argv, stdin and closure; templates and composite evidence stay private at runtime', () => {
  const resources = {
    'source/SKILL.md': bytes('# Process\n\nRun `node scripts/run.mjs --mode exact < input.txt`.\n\nIf export is requested, run `node scripts/export.mjs --format json`.\n'),
    'source/scripts/run.mjs': bytes("import './helper.mjs';\n"),
    'source/scripts/helper.mjs': bytes('export const result = 1;\n'),
    'source/scripts/export.mjs': bytes('export const format = "json";\n'),
  };
  const inventory = callableInventory(resources), calls = callableSourceRequirements(resources, inventory);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].details.interface.argv, ['scripts/run.mjs', '--mode', 'exact']);
  assert.equal(calls[0].details.interface.stdin.path, 'input.txt');
  assert.ok(calls[0].resource_refs.includes('source/scripts/helper.mjs'));
  assert.equal(calls[1].details.authority, 'conditional');
  const runtime = runtimeCallableInterface(calls[0].details.interface);
  assert.equal(runtime.entrypoint, 'source/scripts/run.mjs');
  assert.equal(runtime.argv[0], runtime.entrypoint);
  assert.equal(runtime.stdin.path, 'input.txt');
  assert.equal(calls[0].details.interface.argv[0], 'scripts/run.mjs');
  const missing = callableInventory({ 'source/SKILL.md': bytes('# Process\n\nRun `node scripts/absent.mjs`.\n') });
  assert.ok(missing.unresolved.some(item => item.code === 'MISSING_LOCAL_CALLABLE'));
});

test('composite operations require complete same-owner coverage or an exact registered implementation', () => {
  const resources = { 'source/SKILL.md': bytes('# Process\n\nRun `node scripts/a.mjs | node scripts/b.mjs`.\n'),
    'source/scripts/a.mjs': bytes(''), 'source/scripts/b.mjs': bytes('') };
  const requirements = callableSourceRequirements(resources);
  assert.equal(requirements.length, 2);
  const mappings = requirements.map((item, index) => ({ requirement_id: item.requirement_id, status: 'agent_assisted', node_ids: ['work' + index] }));
  assert.equal(callableBindingIssues(requirements, mappings, [{ id: 'work0', type: 'agent' }, { id: 'work1', type: 'agent' }]).size, 2);
  mappings.forEach(item => item.node_ids = ['work0']);
  assert.equal(callableBindingIssues(requirements, mappings, [{ id: 'work0', type: 'agent' }]).size, 0);
  const runtime = runtimeCallableInterface(requirements[0].details.interface);
  assert.equal(runtime.composite_transport.transport_status, 'same_activity');
  assert.equal(runtime.composite_transport.source_quote, undefined);
  assert.equal(runtime.composite_transport.source_span, undefined);
});

test('resource occurrences preserve later runtime use and do not derive authority from names', () => {
  const paths = ['source/references/history.md', 'source/references/example.md'];
  const source = 'Historical benchmark answers only:\n- `references/history.md`\n\nRead `references/example.md` as the runtime input.\n\nUse `references/history.md` as the template.\n';
  const mentions = sourceResourceMentions(source, paths);
  assert.deepEqual(mentions[0].mentions.map(item => item.disposition), ['non_runtime_reference', 'runtime']);
  assert.equal(mentions[0].retained, true);
  assert.equal(mentions[1].retained, true);
  const excluded = { 'source/SKILL.md': bytes('# Process\n\nDo not load `references/history.md` as an execution input.\n'), [paths[0]]: bytes('Archived answer.') };
  assert.ok(observedSourceRequirements(excluded).some(item => item.requirement_kind === 'knowledge'));
  assert.ok(!observedSourceRequirements(excluded, { source_resource_policy: true }).some(item => item.requirement_kind === 'knowledge'));
});

test('import reconciliation requires exact occurrence evidence and leaves true or declared blockers', () => {
  const resources = { 'source/SKILL.md': bytes('# Process\n\n```markdown\n[Result](outputs/result.md)\n```\n\n[Needed](references/missing.md)\n'),
    'source/scripts/program.mjs': bytes('const syntax = "[word](not-a-reference.md)";\n') };
  const inherited = [
    { code: 'UNRESOLVED_LOCAL_REFERENCE', path: 'source/SKILL.md', line: 4, target: 'outputs/result.md', origin: 'observed' },
    { code: 'UNRESOLVED_LOCAL_REFERENCE', path: 'source/scripts/program.mjs', line: 1, target: 'not-a-reference.md', origin: 'observed' },
    { code: 'UNRESOLVED_LOCAL_REFERENCE', path: 'source/SKILL.md', line: 7, target: 'references/missing.md', origin: 'declared' },
  ];
  const workflow = { nodes: [], import_status: { unresolved: inherited } };
  const reconciled = reconcileImportObservations({ workflow, proposal: { nodes: [] }, resources, pack: { provenance: {}, import_report: {} } });
  assert.deepEqual(reconciled.evidence.slice(0, 2).map(item => item.reason), ['artifact_template_reference', 'non_markdown_syntax']);
  assert.ok(reconciled.unresolved.some(item => item.origin === 'declared'));
  assert.ok(reconciled.unresolved.length > 0);
  for (const item of reconciled.evidence) {
    assert.match(item.occurrence_id, /^[a-f0-9]{64}$/);
    assert.equal(item.path, undefined); assert.equal(item.target, undefined);
  }
  assert.equal(reconciled.evidence[0].resource_sha256, digest(resources['source/SKILL.md']));
  const scan = analyzeSkillDependencies({ files: resources, metadata: {}, inventory: [], problems: [], root: null });
  assert.ok(!scan.unresolved.some(item => item.path === 'source/scripts/program.mjs'));
});

test('source-authorized user-selected destinations retain their default without an unconditional filename gate', () => {
  const resources={ 'source/WORKFLOW.md':bytes('# Process\n\nWrite `report.json` or another file explicitly named by the user.\n') };
  const legacy=observedSourceRequirements(resources).find(item=>item.requirement_kind==='artifact_path');
  const current=observedSourceRequirements(resources,{source_resource_policy:true}).find(item=>item.requirement_kind==='artifact_path');
  assert.equal(current.requirement_id,legacy.requirement_id);
  assert.equal(legacy.trigger,'produce_declared_artifact');assert.equal(current.trigger,'runtime_resolved_artifact');
  assert.match(current.required_result,/alternative file explicitly named by the user/);
});

test('a test filename or short credential literal is insufficient evidence for reconciliation', () => {
  const path='source/tests/auth.test.mjs',screened=redactKnownCredentials("test('auth',()=>{ const API_KEY='a'; actualAuthentication(API_KEY); });\n",'tests/auth.test.mjs');
  const resources={ 'source/SKILL.md':bytes('# Process\n\nRead the task.'),[path]:bytes(screened.text) };
  assert.equal(screened.findings.length,1);assert.equal(screened.findings[0].synthetic_evidence,undefined);
  const workflow={nodes:[],import_status:{unresolved:screened.findings.map(item=>({...item,path,origin:'observed'}))}};
  const result=reconcileImportObservations({workflow,proposal:{nodes:[]},resources,pack:{provenance:{},import_report:{}}});
  assert.ok(result.unresolved.some(item=>item.code==='CREDENTIAL_REDACTED'));
});
