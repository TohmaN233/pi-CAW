import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {agentTranscriptionClauses,authorsNewArtifactPaths} from '../core/agent-transcription-policy.mjs';
import {applySemanticRepair,collectSemanticBlueprintFindings,normalizeSemanticBlueprint} from '../core/authoring/blueprint-contract.mjs';
import {canonicalJSON,digest} from '../core/workflow-revisions.mjs';
import {validateWorkflowGraph} from '../core/workflow-validator.mjs';
import {agent,workflow} from './fixtures.mjs';
import {sourceContractMap} from '../core/skill-import/source-contracts.mjs';

const initial=JSON.parse(await readFile(new URL('./fixtures/artifact-plan.json',import.meta.url),'utf8'));
const patch=JSON.parse(await readFile(new URL('./fixtures/artifact-patch.json',import.meta.url),'utf8'));
const revision=JSON.parse(await readFile(new URL('./fixtures/artifact-revision-plan.json',import.meta.url),'utf8'));
const author=plan=>plan.activities.find(item=>item.key==='author_bundle');
const findings=plan=>collectSemanticBlueprintFindings(plan).filter(item=>item.semantic_keys.includes('author_bundle'));
const ready=({instructions=author(initial).instructions,access='bounded_write',inputs={task:'/inputs/task'}}={})=>{
  const write={...agent('write'),access,path_scope:['sources'],prompt_template:instructions,input_bindings:inputs,
    outputs_schema:{type:'object',required:['files'],additionalProperties:false,properties:{files:{type:'array',items:{type:'object',required:['path'],additionalProperties:false,properties:{path:{type:'string'}}}}}}};
  return validateWorkflowGraph(workflow([write]),{providers:[{id:'worker',enabled:true,kind:'native_agent',capabilities:{read:true,write:true},config:{agent_type:'default',role:'advisor'}}]});
};

test('the pinned synthetic initial blueprint may return newly authored relative artifact destinations',()=>{
  assert.equal(digest(canonicalJSON(initial)),'7ac8c350a67a8ea6abc3e322eb2843c9a9d9937e3e3299f93536b867d8e6ed25');
  const before=canonicalJSON(initial);
  assert.equal(authorsNewArtifactPaths(author(initial).instructions),true);
  assert.deepEqual(agentTranscriptionClauses(author(initial).instructions),[]);
  assert.deepEqual(findings(initial),[]);
  assert.equal(normalizeSemanticBlueprint(initial).activities.find(item=>item.key==='author_bundle').instructions,author(initial).instructions);
  assert.equal(canonicalJSON(initial),before);
  const validation=ready();assert.equal(validation.valid,true,JSON.stringify(validation));
});

test('the exact saved clarification patch also preserves new destination semantics',()=>{
  const repaired=applySemanticRepair(initial,patch,{targets:[{semantic_keys:['author_bundle'],affected_semantic_fields:['activities.author_bundle.instructions','activities.author_bundle.outputs.files']}]});
  assert.equal(authorsNewArtifactPaths(author(repaired).instructions),true);
  assert.deepEqual(agentTranscriptionClauses(author(repaired).instructions),[]);
  assert.deepEqual(findings(repaired),[]);
  assert.equal(ready({instructions:author(repaired).instructions}).valid,true);
});

test('the pinned synthetic revision defines an independently invented path and preserves document content',()=>{
  assert.equal(digest(canonicalJSON(revision)),'742fb74963201516534b588d54770b322a569db828a77b96c22af3d74d6346cd');
  const before=canonicalJSON(revision),activity=revision.activities.find(item=>item.key==='revise');
  assert.equal(authorsNewArtifactPaths(activity.instructions),true);
  assert.deepEqual(agentTranscriptionClauses(activity.instructions),[]);
  assert.deepEqual(collectSemanticBlueprintFindings(revision).filter(item=>item.semantic_keys.includes('revise')),[]);
  assert.equal(normalizeSemanticBlueprint(revision).activities.find(item=>item.key==='revise').instructions,activity.instructions);
  assert.equal(canonicalJSON(revision),before);
  const write={...agent('write'),access:'bounded_write',path_scope:['sources'],prompt_template:activity.instructions,
    input_bindings:{context:'/inputs/task',changeRequest:'/inputs/task'},outputs_schema:{type:'object',required:['path'],additionalProperties:false,properties:{path:{type:'string'}}}};
  const validate=node=>validateWorkflowGraph(workflow([node]),{providers:[{id:'worker',enabled:true,kind:'native_agent',capabilities:{read:true,write:true},config:{agent_type:'default',role:'advisor'}}]});
  const result=validate(write);assert.equal(result.valid,true,JSON.stringify(result));
  assert.ok(validate({...write,access:'read_only'}).errors.some(item=>item.code==='AUTHORED_ARTIFACT_WRITE_ACCESS'));
  assert.ok(validate({...write,input_bindings:{...write.input_bindings,path:'/inputs/task'}}).errors.some(item=>item.code==='AGENT_DETERMINISTIC_TRANSCRIPTION'));
});

test('the initial plan and saved patch retain their independent unmapped provenance finding',()=>{
  const repaired=applySemanticRepair(initial,patch,{targets:[{semantic_keys:['author_bundle']}]});
  const sectionInventory=initial.source_dispositions.map(item=>({section_id:item.section_id,authority:item.disposition==='reference'?'supporting':'required'}));
  for(const plan of [initial,repaired]){
    const result=collectSemanticBlueprintFindings(plan,{sectionInventory});
    assert.equal(result.length,1,JSON.stringify(result));
    assert.equal(result[0].code,'source_disposition_unmapped');
    assert.deepEqual(result[0].semantic_keys,['section_06_provenance']);
  }
});

test('new destination wording never permits copied input paths, identities or hashes',()=>{
  for(const clause of [
    'Return newly chosen relative file paths and copy input IDs.',
    'Return newly chosen relative file paths and the supplied paths.',
    'Return newly chosen relative file paths and hashes from the input.',
    'Return newly chosen destination strings under the required path field and carry forward original records.',
    'Return newly chosen supplied paths.',
    'The semantic output, path, is this independently invented destination filename and copy input IDs.',
    'The semantic output, path, is this independently invented destination filename and return the supplied paths.',
    'The semantic output, path, is this independently invented destination filename and include hashes from the input.',
    'The semantic output, path, is this independently invented destination filename from the input.',
  ]){
    assert.ok(agentTranscriptionClauses(clause).length,clause);
    const plan=structuredClone(initial);author(plan).instructions=clause;
    assert.ok(findings(plan).some(item=>item.code==='agent_deterministic_transcription'),clause);
    assert.ok(ready({instructions:clause}).errors.some(item=>item.code==='AGENT_DETERMINISTIC_TRANSCRIPTION'),clause);
  }
  const plan=structuredClone(initial);
  plan.records.find(item=>item.key==='NewFile').fields.push({name:'sha256',type:'string',required:true});
  assert.ok(findings(plan).some(item=>item.code==='agent_deterministic_transcription'&&item.message.includes('files.item.sha256')));
  const copiedPath=structuredClone(initial);author(copiedPath).inputs.push({name:'path',from:'input:path'});
  assert.ok(findings(copiedPath).some(item=>item.code==='agent_deterministic_transcription'&&item.message.includes('files.item.path')));
  assert.ok(ready({inputs:{path:'/inputs/task'}}).errors.some(item=>item.code==='AGENT_DETERMINISTIC_TRANSCRIPTION'));
});

test('read-only activities cannot claim newly authored file destinations',()=>{
  const plan=structuredClone(initial);author(plan).profile='worker_read';
  assert.ok(findings(plan).some(item=>item.code==='authored_artifact_write_access'));
  assert.ok(findings(plan).some(item=>item.code==='agent_deterministic_transcription'&&item.message.includes('files.item.path')));
  assert.ok(ready({access:'read_only'}).errors.some(item=>item.code==='AUTHORED_ARTIFACT_WRITE_ACCESS'));
});

test('synthetic Markdown and HTML outputs declare newly created destinations',async()=>{
  for(const name of ['markdown','html']){
    const plan=JSON.parse(await readFile(new URL(`./fixtures/artifact-${name}-plan.json`,import.meta.url),'utf8'));
    const activity=plan.activities.find(item=>!item.tool);
    assert.equal(authorsNewArtifactPaths(activity.instructions),true);
    assert.deepEqual(agentTranscriptionClauses(activity.instructions),[]);
    assert.deepEqual(collectSemanticBlueprintFindings(plan),[]);
    const copied=structuredClone(plan);
    copied.activities.find(item=>!item.tool).instructions+=' Copy the supplied input IDs.';
    assert.ok(collectSemanticBlueprintFindings(copied).some(item=>item.code==='agent_deterministic_transcription'));
    const readonly=structuredClone(plan);
    readonly.activities.find(item=>!item.tool).profile='worker_read';
    assert.ok(collectSemanticBlueprintFindings(readonly).some(item=>item.code==='authored_artifact_write_access'));
    const hashLeak=structuredClone(plan);
    const file=hashLeak.records.find(item=>item.fields.some(field=>field.name==='path'));
    file.fields.push({name:'sha256',type:'string',required:true});
    assert.ok(collectSemanticBlueprintFindings(hashLeak).some(item=>item.code==='agent_deterministic_transcription'&&item.message.includes('sha256')));
  }
});

test('dotted bindings and suffix prohibitions preserve explicit new destination ownership',()=>{
  for(const instructions of [
    'Return exactly one result. result.files describes only the new file just written, with its author-chosen relative path. Choose a new descriptive relative filename.',
    'result.files describes the one file just written using a newly chosen relative sources/ filename and tex format.',
    'result.files contains the newly chosen relative destination for the HTML just created, never an existing context path or supplied artifact identity.',
    'Return exactly one result with one newly chosen relative artifact path in files. Never reproduce existing paths or identifiers.',
    'The resolved contract requires exactly one newly authored file, with a newly chosen relative sources/ filename and only its admitted optional fields.',
  ]){
    assert.equal(authorsNewArtifactPaths(instructions),true,instructions);
    assert.deepEqual(agentTranscriptionClauses(instructions),[],instructions);
    assert.equal(ready({instructions}).valid,true,instructions);
    assert.ok(ready({instructions,access:'read_only'}).errors.some(item=>item.code==='AUTHORED_ARTIFACT_WRITE_ACCESS'));
    assert.ok(ready({instructions:instructions+' Copy the supplied input IDs.'}).errors.some(item=>item.code==='AGENT_DETERMINISTIC_TRANSCRIPTION'));
  }
  assert.equal(authorsNewArtifactPaths('Never return newly chosen relative paths.'),false);
  assert.equal(authorsNewArtifactPaths('Do not choose a new descriptive relative filename.'),false);
});

test('omitting unchanged fields is distinct from returning them and does not mask other copies',()=>{
  const instruction='For revisions return only newly changed semantic fields, in the context-defined order, omitting unchanged fields and source selections.';
  assert.deepEqual(agentTranscriptionClauses(instruction),[]);
  assert.ok(agentTranscriptionClauses('Return unchanged fields and source selections.').length);
  assert.ok(agentTranscriptionClauses('Return the supplied input IDs while omitting unchanged fields.').length);
  assert.ok(agentTranscriptionClauses('Return records verbatim, excluding unchanged fields.').length);
});

test('newly named source files establish destination ownership without granting copied metadata',()=>{
  const instructions='Write the two newly named source files only beneath sources/ and return exactly one result under the full contract with exactly two file entries, their newly chosen relative names and appropriate student/solution roles and formats.';
  assert.equal(authorsNewArtifactPaths(instructions),true);
  assert.deepEqual(agentTranscriptionClauses(instructions),[]);
  const plan=structuredClone(initial);author(plan).instructions=instructions;
  assert.deepEqual(findings(plan),[],'Nested file path fields remain author-owned');
  assert.equal(ready({instructions}).valid,true);
  const schema={type:'object',additionalProperties:false,required:['files'],properties:{files:{type:'array',minItems:2,maxItems:2,
    items:{type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string',minLength:1,maxLength:4096,pattern:'^sources/'}}}}}};
  const sourceContracts=sourceContractMap({'source/result.schema.json':Buffer.from(JSON.stringify(schema))});
  const selected=[...sourceContracts.values()].find(item=>item.json_pointer==='');
  const resolvedPlan=structuredClone(plan);
  author(resolvedPlan).outputs=[{name:'result',kind:'object',type_ref:'',values:[],contract_ref:selected.contract_id}];
  const resolvedFindings=collectSemanticBlueprintFindings(resolvedPlan,{sourceContracts});
  assert.ok(!resolvedFindings.some(item=>item.code==='agent_deterministic_transcription'),'Exact resolved full schema admits nested result.files.item.path');
  assert.deepEqual(selected.output_schema,schema,'Destination recognition preserves every pinned schema bound');
  assert.ok(ready({instructions,access:'read_only'}).errors.some(item=>item.code==='AUTHORED_ARTIFACT_WRITE_ACCESS'));
  for(const forbidden of ['Copy the supplied input IDs.','Return the existing source filenames.','Return the supplied paths.']){
    assert.ok(agentTranscriptionClauses(`${instructions} ${forbidden}`).length,forbidden);
    assert.ok(ready({instructions:`${instructions} ${forbidden}`}).errors.some(item=>item.code==='AGENT_DETERMINISTIC_TRANSCRIPTION'),forbidden);
  }
  assert.equal(authorsNewArtifactPaths('Read the named source files.'),false);
  assert.equal(authorsNewArtifactPaths('Preserve the supplied source filenames.'),false);
  assert.equal(authorsNewArtifactPaths('Do not create newly named source files.'),false);
});

test('a causal control-flow path is not a returned filesystem location',()=>{
  const instructions='Return succeeded=false so this path cannot complete successfully.';
  assert.deepEqual(agentTranscriptionClauses(instructions),[]);
  assert.deepEqual(agentTranscriptionClauses('Return succeeded=false so that this path cannot continue.'),[]);
  for(const forbidden of [
    'Return the supplied paths and succeeded=false so this path cannot complete successfully.',
    'Return succeeded=false and copy input IDs so this path cannot complete successfully.',
    'Return this path.',
    'Return the existing path so this path cannot complete successfully.',
  ])assert.ok(agentTranscriptionClauses(forbidden).length,forbidden);
  const plan=structuredClone(initial),activity=author(plan);
  activity.instructions=instructions;activity.profile='main_read';activity.outcome='none';activity.outputs=[{name:'succeeded',kind:'boolean',type_ref:'',values:[]}];
  const result=findings(plan);
  assert.ok(!result.some(item=>item.code==='agent_deterministic_transcription'));
  assert.ok(result.some(item=>item.code==='activity_none_with_outputs'),'An independent invalid outcome is still rejected');
});
