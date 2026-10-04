import test from 'node:test';
import assert from 'node:assert/strict';
import { observedSourceRequirements, projectObservedRequirements } from '../core/skill-import/source-requirements.mjs';

const resourcesFor = text => ({
  'source/SKILL.md':Buffer.from(`# Workflow\n\n${text}\n`),
  'source/references/semantic-output.md':Buffer.from('# Semantic field guide\n'),
});
const paths = resources => observedSourceRequirements(resources).filter(item=>item.requirement_kind==='artifact_path');

test('exact course bundle reference is knowledge, never an artifact to produce', () => {
  const paragraph="The author emits only the new lesson draft's semantic fields and its newly chosen relative `sources/` file paths. It does not copy hashes or paths from context or tool-result metadata into structured output. Read `references/semantic-output.md` for the exact field format. The Host computes byte identities and carries the resulting exact references to compilation. A source file is not a compile receipt.";
  const resources=resourcesFor(paragraph), requirements=observedSourceRequirements(resources);
  assert.deepEqual(paths(resources),[]);
  const reference=requirements.find(item=>item.requirement_kind==='knowledge');
  assert.equal(reference.requirement_id,'observed_reference_3_1');
  assert.deepEqual(reference.resource_refs,['source/references/semantic-output.md']);
  assert.deepEqual(reference.source_spans,[{resource:'source/SKILL.md',start_line:3,end_line:3}]);
  assert.equal(reference.trigger,'source_required_reference');
  const projected=projectObservedRequirements({nodes:[{id:'author',type:'agent'}],edges:[],source_requirements:requirements,requirement_mappings:[{requirement_id:reference.requirement_id,node_ids:['author'],binding_names:[],runtime_guards:[],resource_refs:reference.resource_refs,status:'agent_assisted',rationale:'Read the pinned shape guide.'}]},resources);
  assert.deepEqual(projected.nodes[0].required_artifacts,[]);
  assert.ok(projected.nodes[0].resource_refs.includes('source/references/semantic-output.md'));
});

test('filename tokens never supply artifact operations or activate a reference list', () => {
  for(const text of [
    'Read `references/semantic-output.md` for the field format.',
    'Consult `save.json` and `create.md`.',
    'Load `write.csv` and `update.txt`.',
    'Read `references/semantic-output.md`:\n- `result.json`',
  ]) assert.deepEqual(paths(resourcesFor(text)),[],text);
});

test('real write/save/update operations retain exact paths and source evidence', () => {
  for(const verb of ['Write','Save','Update','Create','Produce','Emit','Return','Output']) {
    const text=`${verb} \`sources/semantic-output.md\`.`, requirement=paths(resourcesFor(text))[0];
    assert.equal(requirement.details.artifact_path,'sources/semantic-output.md',text);
    assert.equal(requirement.trigger,'produce_declared_artifact');
    assert.deepEqual(requirement.source_spans,[{resource:'source/SKILL.md',start_line:3,end_line:3}]);
    assert.equal(requirement.requirement_id,'observed_artifact_path_3_1');
  }
  // Conditions in filenames are not conditional instructions either.
  assert.deepEqual(paths(resourcesFor('Write `when.json` and `optional.md`.')).map(item=>item.details.artifact_path),['when.json','optional.md']);
  assert.deepEqual(paths(resourcesFor('Save the required products:\n- `result.json`\n- `summary.md`')).map(item=>item.details.artifact_path),['result.json','summary.md']);
});

test('negated/conditional production and read clauses cannot borrow later verbs', () => {
  for(const text of [
    'Do not write `result.json`.',
    'Never update `sources/semantic-output.md`.',
    'If requested, save `result.json`.',
    'Read `references/semantic-output.md`. Do not save `result.json`.',
  ]) assert.deepEqual(paths(resourcesFor(text)),[],text);
  for(const text of [
    'Read `references/semantic-output.md`. Save `result.json`.',
    'Read `references/semantic-output.md`; write `result.json`.',
    'Do not update `old.json`; save `result.json`.',
  ]) assert.deepEqual(paths(resourcesFor(text)).map(item=>item.details.artifact_path),['result.json'],text);
});

test('a selected full result contract is an interface reference, never a schema deliverable', () => {
  // The retained native plan assigns these Host observation IDs to its Author.
  // Correct their facts in place rather than requiring a new semantic plan.
  const paragraph='Return exactly one result output selecting the Host-resolved full semantic_output SourceContract for [analysis result](references/results/analysis.schema.json) as result.contract_ref. Preserve its exact nested bounds and optional fields. Do not recreate schemas or split optional fields into required outputs. Return only newly authored or changed semantic fields; the Host retains unchanged fields. Required files is [] only when this exact product schema permits a state-only draft; otherwise write and return the newly chosen relative sources/ filenames required by that schema. Never return existing paths, identities, hashes, revisions, approval or receipts. New material-index selections are semantic choices; do not forbid the fields allowed by the exact selected schema.';
  const resources=resourcesFor(paragraph),requirements=observedSourceRequirements(resources);
  assert.deepEqual(paths(resources),[]);
  for(const id of ['observed_artifact_path_3_1','observed_artifact_schema_3']) {
    const requirement=requirements.find(item=>item.requirement_id===id);
    assert.equal(requirement.requirement_kind,'method_rule');
    assert.deepEqual(requirement.source_spans,[{resource:'source/SKILL.md',start_line:3,end_line:3}]);
    assert.equal(Object.hasOwn(requirement.details,'interface_terms'),false);
    assert.equal(Object.hasOwn(requirement.details,'artifact_path'),false);
  }
  assert.match(requirements.find(item=>item.requirement_id==='observed_artifact_path_3_1').details.rule_text,/references\/results\/analysis\.schema\.json/);
  assert.match(requirements.find(item=>item.requirement_id==='observed_artifact_schema_3').details.rule_text,/Do not recreate schemas/);
  const schema={type:'object',additionalProperties:false,required:['result'],properties:{result:{type:'object',additionalProperties:false,required:['files'],properties:{files:{type:'array',maxItems:0,items:{type:'string',maxLength:200}},draft:{type:'object',additionalProperties:false,properties:{title:{type:'string',minLength:1,maxLength:200}}}}}}};
  const projected=projectObservedRequirements({nodes:[{id:'author',type:'agent',input_bindings:{},outputs_schema:schema,required_artifacts:[{requirement_id:'observed_artifact_path_3_1',path:'schema.json'}]}],edges:[],source_requirements:requirements,requirement_mappings:requirements.map(item=>({requirement_id:item.requirement_id,node_ids:['author'],binding_names:[],runtime_guards:[],resource_refs:item.resource_refs,status:'agent_assisted',rationale:'Follow the exact selected result contract.'}))},resources);
  assert.deepEqual(projected.nodes[0].required_artifacts,[]);
  assert.deepEqual(projected.nodes[0].outputs_schema,schema);
  assert.deepEqual(projected.nodes[0].input_bindings,{});
  assert.ok(projected.nodes[0].requirement_ids.includes('observed_artifact_schema_3'));
});

test('schema references and schema-file writes retain separate ownership and complete filenames', () => {
  for(const text of [
    'Return a result using `references/result.schema.json`.',
    'Return a result conforming to `references/result.schema.json`.',
    'Select `references/result.schema.json` for the returned output format.',
    'Do not create a schema document `output.schema.json`.',
  ]) assert.deepEqual(paths(resourcesFor(text)),[],text);
  const text='Create a schema file `output.schema.json` using `references/result.schema.json`.';
  const resources=resourcesFor(text),requirements=observedSourceRequirements(resources);
  assert.deepEqual(paths(resources).map(item=>item.details.artifact_path),['output.schema.json']);
  assert.equal(requirements.find(item=>item.requirement_id==='observed_artifact_path_3_2').requirement_kind,'method_rule');
  assert.equal(requirements.find(item=>item.requirement_id==='observed_artifact_schema_3').requirement_kind,'artifact_schema');
  const pathRequirement=paths(resources)[0];
  const projected=projectObservedRequirements({nodes:[{id:'author',type:'agent',input_bindings:{}}],edges:[],source_requirements:requirements,requirement_mappings:requirements.map(item=>({requirement_id:item.requirement_id,node_ids:['author'],binding_names:[],runtime_guards:[],resource_refs:item.resource_refs,status:'agent_assisted',rationale:'Write the declared schema file; consult the existing one.'}))},resources);
  assert.deepEqual(projected.nodes[0].required_artifacts,[{requirement_id:pathRequirement.requirement_id,path:'output.schema.json'}]);
  for(const path of ['sources/product.v2.schema.json','C:/exports/product.v2.schema.json','/exports/product.v2.schema.json']) {
    assert.deepEqual(paths(resourcesFor(`Write \`${path}\`.`)).map(item=>item.details.artifact_path),[path]);
  }
  assert.deepEqual(paths(resourcesFor('Return `output.schema.json.backup`.')),[]);
});

test('negated schema clauses cannot invent properties for a positive interface definition', () => {
  const resources=resourcesFor('Return an object with exact keys `answer` and `files`. Do not recreate schemas or split optional fields into required outputs.');
  const requirement=observedSourceRequirements(resources).find(item=>item.requirement_kind==='artifact_schema');
  assert.deepEqual(requirement.details.interface_terms,['answer','files']);
  assert.doesNotMatch(requirement.required_result,/into required outputs/);
  assert.match(requirement.required_result,/exact keys/);
});
