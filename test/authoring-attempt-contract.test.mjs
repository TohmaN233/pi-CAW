import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CURRENT_AUTHORING_SEMANTIC_BLUEPRINT_SCHEMA, SEMANTIC_BLUEPRINT_CONTRACT, SEMANTIC_REPAIR_CONTRACT, normalizeSemanticBlueprint, validateSemanticBlueprintContract } from '../core/authoring/blueprint-contract.mjs';
import { authoringAttemptOutputSchema } from '../core/skill-import/expansion-run.mjs';
import { validateGenerationProposal } from '../core/skill-import/proposal-validation.mjs';
import { generationRetryClass } from '../core/skill-import/generation-retry-policy.mjs';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { validateData } from '../core/workflow-data-schema.mjs';

const record=()=>({pins:{root:{provenance:{authoring_contract:'pi-caw-authoring-workflow/v29'},workflow:{nodes:[{id:'expand',outputs_schema:{}},{id:'final',outputs_schema:{type:'object',required:['checks'],properties:{checks:{type:'array'}}}}]}}},state:{}});
const plan=()=>({contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Answer the supplied task.',source_dispositions:[],requirement_assignments:[],runtime_dependencies:[],records:[],lists:[],enums:[],activities:[{key:'answer',instructions:'Answer the supplied task.',profile:'worker_read',source_sections:['source'],inputs:[{name:'task',from:'input:task'}],outputs:[{name:'answer',kind:'text',values:[],type_ref:''}],tool:''}],approvals:[],sequences:[],parallels:[],choices:[]});

test('Pi initial and recovered planner dispatches use the exact current semantic schema',()=>{
  const persisted=record(),schema=authoringAttemptOutputSchema(persisted,'expand');
  assert.deepEqual(schema.properties.proposal,CURRENT_AUTHORING_SEMANTIC_BLUEPRINT_SCHEMA);
  assert.deepEqual(persisted.pins.root.workflow.nodes[0].outputs_schema,{});
  validateData({proposal:plan()},schema);
  const compact=plan();delete compact.records;
  validateData({proposal:compact},schema);
  const invalid=plan();invalid.records=null;
  assert.throws(()=>validateData({proposal:invalid},schema),{code:'DATA_INVALID'});
  assert.deepEqual(authoringAttemptOutputSchema(persisted,'final'),persisted.pins.root.workflow.nodes[1].outputs_schema);
});

test('Pi repair dispatch selects the exact targeted patch schema and rejects regenerated plans',()=>{
  const persisted=record();persisted.state.generation_repair={previous_proposal:plan(),feedback:{findings:[{semantic_keys:['answer'],affected_semantic_fields:['activities.instructions']}]}};
  const schema=authoringAttemptOutputSchema(persisted,'expand');
  assert.equal(schema.properties.proposal.properties.contract.const,SEMANTIC_REPAIR_CONTRACT);
  assert.equal(schema.properties.proposal.properties.upsert.properties.activities.maxItems,6);
  assert.throws(()=>validateData({proposal:plan()},schema),{code:'DATA_INVALID'});
  validateData({proposal:{contract:SEMANTIC_REPAIR_CONTRACT,purpose:'',upsert:{activities:[plan().activities[0]]},remove:{}}},schema);
  persisted.state.generation_repair.previous_proposal=null;
  assert.throws(()=>authoringAttemptOutputSchema(persisted,'expand'),{code:'AUTHORING_REPAIR_STATE'});
});

test('the synthetic free-form planner artifact is diagnosed before normalization and compilation without changing meaning',async()=>{
  // Intentionally malformed fictional output; no private Run data is used.
  const output=JSON.parse(await readFile(new URL('./fixtures/invalid-planner-output.json',import.meta.url),'utf8'));
  const before=canonicalJSON(output),hash=digest(canonicalJSON(output.proposal));
  assert.equal(digest(before),'62843cb8069036c349f94fea41894eaa76189d028cab8067ec182d711d07b056');
  const inspect=error=>{
    assert.equal(error.code,'GENERATION_PROPOSAL_CONTRACT');
    assert.equal(error.artifact_sha256,hash);
    assert.equal(error.automatic_retry,false);
    assert.equal(generationRetryClass(error),'mechanical');
    const paths=new Set(error.findings.map(item=>item.path));
    for(const path of ['$/inputs','$/types','$/controls','$/continuation','$/uncertainties','$/activities/0/profile','$/activities/1/outputs/0/optional'])assert.ok(paths.has(path),path);
    assert.ok(output.proposal.types.find(item=>item.name==='source_reference').fields.some(field=>field.name==='sha256'));
    assert.ok(output.proposal.activities.find(item=>item.key==='author_bundle').outputs.some(item=>item.name==='files'));
    return true;
  };
  assert.throws(()=>validateSemanticBlueprintContract(output.proposal,{requireDependencyAssessment:true}),inspect);
  assert.throws(()=>normalizeSemanticBlueprint(output.proposal),inspect);
  assert.throws(()=>validateGenerationProposal(output,{pack:{workflow:{}},resources:{},provenance:{authoring_contract:'pi-caw-authoring-workflow/v29'},context:{}}),inspect);
  assert.equal(canonicalJSON(output),before);
  assert.throws(()=>validateData(output,authoringAttemptOutputSchema(record(),'expand')),{code:'DATA_INVALID'});
});


test('omitted empty semantic fields normalize explicitly without altering raw evidence or coercing supplied meaning',()=>{
  const original=plan(),compact=structuredClone(original);
  for(const key of ['records','lists','enums','approvals','sequences','parallels','choices'])delete compact[key];
  delete compact.activities[0].tool;delete compact.activities[0].outputs[0].values;delete compact.activities[0].outputs[0].type_ref;
  const raw=canonicalJSON(compact),repairs=[];
  const canonical=validateSemanticBlueprintContract(compact,{requireDependencyAssessment:true,repairs});
  assert.deepEqual(canonical,original);assert.equal(canonicalJSON(compact),raw);
  assert.equal(repairs.length,10);assert.ok(repairs.every(item=>item.kind==='host_empty_semantic_field'));
  assert.deepEqual(normalizeSemanticBlueprint(compact),normalizeSemanticBlueprint(original));
  const noHandoff=structuredClone(compact);delete noHandoff.activities[0].inputs;delete noHandoff.activities[0].outputs;
  assert.deepEqual(validateSemanticBlueprintContract(noHandoff).activities[0].inputs,[]);
  for(const mutate of [b=>b.records=null,b=>b.activities[0].tool=false,b=>b.types=[{key:'important'}]]){
    const bad=structuredClone(compact);mutate(bad);assert.throws(()=>validateSemanticBlueprintContract(bad),{code:'GENERATION_PROPOSAL_CONTRACT'});
  }
  const missingType=structuredClone(compact);missingType.activities[0].outputs[0].kind='object';missingType.activities[0].outputs[0].type_ref='undeclared_type';
  assert.throws(()=>normalizeSemanticBlueprint(missingType),{code:'AUTHORING_SEMANTIC'});
});
