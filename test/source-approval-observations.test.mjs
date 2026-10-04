import test from 'node:test';
import assert from 'node:assert/strict';
import { observedSourceRequirements, projectObservedRequirements } from '../core/skill-import/source-requirements.mjs';
import { compileRequirementCoverage } from '../core/skill-import/semantic-expander.mjs';
import { decodeGeneratedProposalDetailed, EXPANSION_PROPOSAL_SCHEMA } from '../core/skill-import/expansion-run.mjs';
import { validateData, validateDataSchema } from '../core/workflow-data-schema.mjs';
import { sourceSectionInventory } from '../core/skill-import/source-dispositions.mjs';

// Fictional mixed paragraph exercises existing approval, negation and pending
// review without including a user's original workflow instructions.
const documentParagraph = 'This workflow generates a new documentation bundle. Its input is a Host-created `taskId` and the user\'s `task`. Existing user approval is required before validation. The Host binds the project, selected references, output directory and observed revisions before execution. The author must return both a complete `documentDraft` and the requested `files`; the draft is required. A model must never choose another project, invent identities or approve a user draft. Missing project prerequisites stop before a model call. The new documentation draft remains pending user approval; that pending review permits standalone experimental Markdown/HTML generation and validation.';
const resourcesFor = text => ({'source/SKILL.md':Buffer.from(`# Workflow\n\n${text}\n`)});
const observations = text => observedSourceRequirements(resourcesFor(text));

test('fictional document paragraph retains approval-state evidence without inventing a human gate', () => {
  const resources = {'source/SKILL.md':Buffer.from(`---\nname: fictional-document-artifacts\ndescription: Generate a bounded document.\n---\n\n# One document, bounded artifacts\n\n${documentParagraph}\n`)};
  const requirements = observedSourceRequirements(resources), observation = requirements.find(item=>item.requirement_id==='observed_approval_8');
  assert.equal(observation.requirement_kind,'method_rule');
  assert.equal(observation.details.rule_text,documentParagraph);
  assert.deepEqual(observation.source_spans,[{resource:'source/SKILL.md',start_line:8,end_line:8}]);
  assert.deepEqual(observation.details.approval_clauses.map(clause=>clause.relation),['existing_prerequisite','non_approval','pending_review','pending_review']);
  assert.equal(requirements.some(item=>item.requirement_kind==='approval'),false);
  assert.equal(requirements.filter(item=>item.requirement_kind==='method_rule').length,2);
  assert.ok(requirements.some(item=>item.requirement_id==='observed_method_rule_8'));
  const projected=projectObservedRequirements({nodes:[],edges:[],source_requirements:[{...observation,requirement_kind:'approval',details:{}}],requirement_mappings:[]},resources);
  assert.deepEqual(projected.source_requirements.find(item=>item.requirement_id==='observed_approval_8'),observation);
  assert.deepEqual(projected.requirement_mappings,[]); // Host never fabricates coverage.
});

test('legacy paired method assignments retain their exact IDs when the separate approval ID is corrected', () => {
  for(const [line,text] of [[8,documentParagraph],[14,'The writer must not claim compilation or teacher approval.']]) {
    const resources={'source/SKILL.md':Buffer.from(`# Workflow\n${'\n'.repeat(line-2)}${text}\n`)};
    const approvalId=`observed_approval_${line}`, methodId=`observed_method_rule_${line}`;
    const requirements=observedSourceRequirements(resources);
    assert.equal(requirements.find(item=>item.requirement_id===approvalId).requirement_kind,'method_rule');
    assert.equal(requirements.find(item=>item.requirement_id===methodId).requirement_kind,'method_rule');
    assert.equal(new Set(requirements.map(item=>item.requirement_id)).size,requirements.length);
    const mappings=[approvalId,methodId].map(requirement_id=>({requirement_id,node_ids:['write'],binding_names:[],runtime_guards:[],resource_refs:['source/SKILL.md'],status:'agent_assisted',rationale:'Retained exact source assignment.'}));
    const projected=projectObservedRequirements({nodes:[{id:'write',type:'agent',operation_mode:'write',input_bindings:{},resource_refs:['source/SKILL.md']}],edges:[],source_requirements:requirements.map(item=>item.requirement_id===approvalId?{...item,requirement_kind:'approval',details:{}}:item),requirement_mappings:mappings},resources);
    assert.deepEqual(projected.requirement_mappings,mappings);
    assert.ok(projected.nodes[0].requirement_ids.includes(approvalId));
    assert.ok(projected.nodes[0].requirement_ids.includes(methodId));
    assert.equal(projected.source_requirements.find(item=>item.requirement_id===approvalId).requirement_kind,'method_rule');
  }
});

test('existing approval, pending review and non-approval rules remain actionable source evidence', () => {
  for(const text of [
    'Use the already approved lesson plan before compiling the revision.',
    'Existing teacher approval is required before compiling the revision.',
    'Only after checking existing teacher approval may the revision be compiled.',
    'Only the previously approved version is an input; a fresh approval is not required.',
    'The draft must remain pending teacher approval; experimental compilation is permitted.',
    'Keep the draft pending teacher review.',
    'After this workflow ends, the teacher must approve the draft outside the workflow.',
    'The model must never approve a teacher draft.',
    'A model must never choose another project, invent identities or approve a teacher draft.',
    'This step never approves a lesson or accepts a deck.',
    'The writer must not claim compilation or teacher approval.',
    'Never assume or fabricate user approval.',
    'Do not ask the user for approval before creating the pending draft.',
    'No new semester approval is needed for a bounded correction.',
    'Approval is not required before experimental compilation.',
    'Drafting does not require teacher approval.',
    '无需教师批准即可生成待审核的实验稿。',
    '模型不得批准教师教案。',
    '使用已经批准的学期计划。',
  ]) {
    const requirements=observations(text);
    assert.equal(requirements.some(item=>item.requirement_kind==='approval'),false,text);
    const evidence=requirements.find(item=>item.details?.approval_clauses?.length);
    assert.ok(evidence,text); assert.equal(evidence.requirement_kind,'method_rule',text);
    assert.equal(evidence.details.rule_text,text); assert.deepEqual(evidence.source_spans,[{resource:'source/SKILL.md',start_line:3,end_line:3}]);
  }
});

test('real pre-operation approvals remain protected, including negative operation guards and mixed clauses', () => {
  for(const text of [
    'The teacher must approve the lesson before generating the Beamer deck.',
    'The lesson must be approved before generating the Beamer deck.',
    'Obtain explicit user approval before publishing.',
    'Ask the user for approval to install Python.',
    'Approval is required before deploying the changes.',
    'Do not publish without user approval.',
    'Never generate the Beamer deck until the teacher approves the lesson.',
    'Never publish the already approved draft until the teacher approves the new revision.',
    'Do not approve the publication until the user confirms it.',
    'Only after the teacher approves the lesson may the deck be generated.',
    'Keep the draft pending approval until the teacher approves it; only then publish.',
    'A model must never approve the draft; the teacher must approve it before publication.',
    'The lesson is already approved. Obtain approval for publishing its new revision.',
    '教师必须批准教案之后才能生成课件。',
    '未经教师批准不得发布。',
  ]) {
    const requirement=observations(text).find(item=>item.requirement_kind==='approval');
    assert.ok(requirement,text); assert.equal(requirement.details.rule_text,text);
    assert.ok(requirement.details.approval_clauses.some(clause=>clause.relation==='operation_gate'),text);
  }
});

test('approval vocabulary cannot borrow must/before from another sentence', () => {
  const requirements=observations('The writer must return the artifact. Approval is a later teacher decision. Save the draft before delivery.');
  assert.equal(requirements.some(item=>item.requirement_kind==='approval'),false);
});

test('Host validation of approval state does not invent a new human decision and cannot hide an explicit acquisition',()=>{
  const statement='Call registered fixture_task_context with directly bound Root taskId. Host validates the current project/document target, frozen selected sources, attachment scope, prerequisites, baseline revisions and user approval where required. Its context and top-level bindingSha256 stay authoritative.';
  const requirements=observations(statement),state=requirements.find(x=>x.details?.approval_clauses?.length);
  assert.equal(requirements.some(x=>x.requirement_kind==='approval'),false);
  assert.equal(state.requirement_kind,'method_rule');
  assert.deepEqual(state.details.approval_clauses.map(x=>x.relation),['existing_prerequisite']);
  assert.match(state.details.approval_clauses[0].source_quote,/Host validates/);
  for(const text of [
    'Host verifies teacher approval before compiling.',
    'Only after Host checks teacher approval may the saved source be compiled.',
  ])assert.equal(observations(text).some(x=>x.requirement_kind==='approval'),false,text);
  for(const text of [
    'Host validates teacher approval, and the teacher must approve the revision before publication.',
    'Host verifies prior approval. Obtain user approval before publishing the new artifact.',
    'Host verifies selected source hashes; the teacher must approve the lesson before generating slides.',
    'The teacher must approve the lesson before the Host validates it.',
  ])assert.ok(observations(text).some(x=>x.requirement_kind==='approval'),text);
});

test('coverage accepts state constraints without a gate and still rejects unprotected actual approval', () => {
  const coverage = (text,{gate=false}={}) => {
    const resources=resourcesFor(text), requirements=observedSourceRequirements(resources);
    const ids=requirements.map(item=>item.requirement_id), author={id:'author',type:'agent',operation_mode:'write',input_bindings:{},resource_refs:['source/SKILL.md'],requirement_ids:ids};
    const nodes=gate?[{id:'approval',type:'human_gate',requirement_ids:ids,resource_refs:['source/SKILL.md']},author]:[author];
    const edges=gate?[{source:'start',target:'approval'},{source:'approval',target:'author'}]:[{source:'start',target:'author'}];
    const proposal={nodes,edges,source_requirements:requirements,requirement_mappings:requirements.map(item=>({requirement_id:item.requirement_id,node_ids:nodes.map(node=>node.id),binding_names:[],runtime_guards:[],resource_refs:['source/SKILL.md'],status:'agent_assisted',rationale:'Fixture activities preserve the exact source constraint.'}))};
    return compileRequirementCoverage(proposal,resources,nodes,edges);
  };
  assert.doesNotThrow(()=>coverage(documentParagraph));
  const protectedText='The teacher must approve the lesson before generating the Beamer deck.';
  assert.throws(()=>coverage(protectedText),error=>error.code==='EXPANSION_REQUIREMENT_COVERAGE'&&error.message.includes('Approval needs both a human gate'));
  assert.doesNotThrow(()=>coverage(protectedText,{gate:true}));
});

test('typed approval clause evidence survives Host projection, ordinary decode, persisted replay and coverage', () => {
  validateDataSchema(EXPANSION_PROPOSAL_SCHEMA);
  for(const text of [documentParagraph,'The teacher must approve the lesson before generating the Beamer deck.']) {
    const resources=resourcesFor(text), requirements=observedSourceRequirements(resources), ids=requirements.map(item=>item.requirement_id);
    const source_span={resource:'source/SKILL.md',start_line:3,end_line:3}, hasGate=requirements.some(item=>item.requirement_kind==='approval');
    const author={id:'author',type:'agent',operation_mode:'write',input_bindings:{},resource_refs:['source/SKILL.md'],requirement_ids:ids,confidence:1,source_span};
    const nodes=hasGate?[{id:'approval',type:'human_gate',input_bindings:{},requirement_ids:ids,resource_refs:['source/SKILL.md'],confidence:1,source_span},author]:[author];
    const edges=(hasGate?[['start','approval'],['approval','author']]:[['start','author']]).map(([source,target],index)=>({id:`edge-${index}`,source,target,confidence:1,source_span}));
    const proposal={source_revision:'a'.repeat(64),nodes,edges,source_requirements:requirements,requirement_mappings:requirements.map(item=>({requirement_id:item.requirement_id,node_ids:nodes.map(node=>node.id),binding_names:[],runtime_guards:[],resource_refs:['source/SKILL.md'],status:'agent_assisted',rationale:'Fixture preserves the source rule and its authority.'})),source_dispositions:sourceSectionInventory(resources).map(section=>({section_id:section.section_id,disposition:'workflow',node_ids:nodes.map(node=>node.id),requirement_ids:ids,rationale:'Execute the exact source constraints.'}))};
    const projected=projectObservedRequirements(proposal,resources);
    const ordinary=decodeGeneratedProposalDetailed({proposal:projected},proposal.source_revision,{requireSourceDispositions:true}).proposal;
    const replay=decodeGeneratedProposalDetailed(JSON.parse(JSON.stringify({proposal:ordinary})),proposal.source_revision,{requireSourceDispositions:true}).proposal;
    const legacy=decodeGeneratedProposalDetailed({proposal_json:JSON.stringify(ordinary)},proposal.source_revision,{requireSourceDispositions:true}).proposal;
    assert.deepEqual(replay.source_requirements,requirements);
    assert.deepEqual(ordinary.source_requirements,replay.source_requirements);
    assert.deepEqual(legacy.source_requirements,replay.source_requirements);
    assert.doesNotThrow(()=>compileRequirementCoverage(replay,resources,replay.nodes,replay.edges));
    assert.ok(replay.source_requirements.some(item=>item.details.approval_clauses?.length));
    for(const mutate of [
      clause=>{clause.relation='silently_approved';},
      clause=>{delete clause.source_quote;},
      clause=>{clause.teacherApproved=true;},
    ]) {
      const malformed=structuredClone(replay); mutate(malformed.source_requirements.find(item=>item.details.approval_clauses).details.approval_clauses[0]);
      assert.throws(()=>decodeGeneratedProposalDetailed({proposal:malformed},proposal.source_revision),{code:'GENERATION_PROPOSAL_CONTRACT'});
    }
    assert.doesNotThrow(()=>validateData(replay,EXPANSION_PROPOSAL_SCHEMA));
  }
});
