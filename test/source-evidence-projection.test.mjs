import test from 'node:test';
import assert from 'node:assert/strict';
import {disjointSourceSpans} from '../core/skill-import/source-evidence.mjs';
import {sourceSectionInventory} from '../core/skill-import/source-dispositions.mjs';
import {sourceContractIndex,SOURCE_EVIDENCE_RULE} from '../core/skill-import/source-contracts.mjs';
import {observedSourceRequirements,projectObservedRequirements} from '../core/skill-import/source-requirements.mjs';
import {lowerSemanticBlueprint} from '../core/authoring/workflow-forge.mjs';
import {SEMANTIC_BLUEPRINT_CONTRACT} from '../core/authoring/blueprint-contract.mjs';
import {decodeGeneratedProposalDetailed,EXPANSION_PROPOSAL_SCHEMA} from '../core/skill-import/expansion-run.mjs';
import {validateData} from '../core/workflow-data-schema.mjs';
import {canonicalJSON,digest} from '../core/workflow-revisions.mjs';

const span=(start_line,end_line,resource='source/SKILL.md')=>({resource,start_line,end_line});
const closed=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text={type:'string',minLength:1,maxLength:100};
const tool=(id,input_schema,output_schema)=>({id,identity:{name:id,version:'1',sha256:digest(id)},argv:[id],input_schema,output_schema,
  env_allow:[],permissions:{network:false,read_paths:['.'],write_paths:[]},output_cap_bytes:10000,deadline_ms:5000,idempotency:{mode:'safe'}});

test('source evidence removes overlapping/nested duplicates without bridging gaps or merging adjacent semantic sections',()=>{
  const selected=[span(4,8),span(6,6),span(10,12),span(13,14),span(1,20,'source/result.schema.json')],before=canonicalJSON(selected);
  assert.deepEqual(disjointSourceSpans(selected),[span(4,8),span(10,12),span(13,14),span(1,20,'source/result.schema.json')]);
  assert.deepEqual(disjointSourceSpans([span(1,3),span(7,9),span(3,7)]),[span(1,9)]);
  assert.deepEqual(disjointSourceSpans(disjointSourceSpans(selected)),disjointSourceSpans(selected));
  assert.equal(canonicalJSON(selected),before);
  assert.throws(()=>disjointSourceSpans([span(0,3)]),{code:'EXPANSION_SOURCE_SPAN'});
  assert.throws(()=>disjointSourceSpans([span(4,8),{...span(6,6),unexpected:true}]),{code:'EXPANSION_SOURCE_SPAN'},'Merging cannot erase an invalid field');
});

test('Forge separates exact interface and method-consumer evidence from handoff phase evidence without rewriting semantic selections',()=>{
  const resources={'source/SKILL.md':Buffer.from(['# Product','','Global scoped product constraints.','','## Context','','Load context.','','## Author','','Read and apply [guide](guide.md), then author the answer using result.schema.json.','','## Persist','','Persist the answer and validate the saved result.','','## Provenance','','Apply the method attribution when authoring.',''].join('\n')),
    'source/guide.md':Buffer.from('# Teaching method\n\nExplain with a substantive example.\n'),'source/result.schema.json':Buffer.from(JSON.stringify(closed({answer:text}),null,2))};
  const sections=sourceSectionInventory(resources),section=title=>sections.find(item=>item.title===title).section_id;
  const index=sourceContractIndex(resources),schema=index.contracts.find(item=>item.json_pointer==='');
  const contracts=[tool('context',closed({}),closed({context:text})),tool('persist',closed({answer:text}),closed({succeeded:{type:'boolean'}}))];
  const shape=(name,kind='text')=>({name,kind,type_ref:'',values:[]});
  const all=sections.map(item=>item.section_id),authorSections=[section('Overview'),section('Context'),section('Author'),section('Persist'),section('Provenance')];
  const plan={contract:SEMANTIC_BLUEPRINT_CONTRACT,purpose:'Explain and save an answer.',runtime_dependencies:[],records:[],lists:[],enums:[],
    activities:[{key:'context',tool:'context',profile:'main_read',instructions:'Load the selected context.',source_sections:[section('Overview'),section('Context'),section('Persist')],inputs:[],outputs:[shape('context')]},
      {key:'author',tool:'',profile:'worker_read',instructions:'Explain the selected context and return a newly authored answer.',source_sections:authorSections,inputs:[{name:'context',from:'context.context'}],outputs:[{...shape('result','object'),contract_ref:schema.contract_id}]},
      {key:'persist',tool:'persist',profile:'main_read',instructions:'Persist the answer using the Host.',source_sections:[section('Author'),section('Persist')],inputs:[{name:'answer',from:'author.result.answer'}],outputs:[shape('succeeded','boolean')]},
    ],source_dispositions:all.map(section_id=>({section_id,disposition:'workflow',activity_keys:['author'],note:'The author preserves the selected source constraints.'})),
    requirement_assignments:observedSourceRequirements(resources).map(item=>({requirement_id:item.requirement_id,activity_keys:['author']})),
    approvals:[],sequences:[{key:'process',members:['context','author','persist'],failure_meaning:'all_required'}],parallels:[],choices:[]};
  const before=canonicalJSON(plan),graph=lowerSemanticBlueprint({revision_hash:digest('fixture'),workflow:{id:'source-evidence',requirements:{},host_tools:contracts}},resources,plan);
  const projected=projectObservedRequirements(graph,resources),author=projected.nodes.find(node=>node.semantic_key==='author'),persist=projected.nodes.find(node=>node.semantic_key==='persist'),context=projected.nodes.find(node=>node.semantic_key==='context');
  assert.ok(author.source_spans.some(item=>item.resource===schema.resource),'Exact selected full interface remains evidence for its Author');
  assert.ok(author.resource_refs.includes('source/guide.md'),'The semantic method consumer retains its reference');
  assert.ok(!persist.resource_refs.includes('source/guide.md'),'Citing a shared section cannot grant its teaching references to a deterministic tool');
  assert.ok(!persist.resource_refs.includes(schema.resource),'No schema resource grant without explicit contract selection');
  assert.ok(context.source_spans.some(item=>canonicalJSON(item)===canonicalJSON(sections.find(item=>item.title==='Persist').source_span)),
    'An explicitly broad semantic selection stays visible; the Host cannot silently repair it');
  for(const edge of projected.edges)assert.ok(edge.source_spans.every(item=>item.resource==='source/SKILL.md'),'Edges never inherit endpoint interface documents');
  for(const node of projected.nodes)for(let a=0;a<node.source_spans.length;a++)for(let b=a+1;b<node.source_spans.length;b++){
    const left=node.source_spans[a],right=node.source_spans[b];assert.ok(left.resource!==right.resource||left.end_line<right.start_line||right.end_line<left.start_line,'No nested/repeated source intervals');
  }
  assert.equal(index.source_evidence_rule,SOURCE_EVIDENCE_RULE);assert.match(index.source_evidence_rule,/semantic selections/);
  assert.equal(canonicalJSON(plan),before);validateData(projected,EXPANSION_PROPOSAL_SCHEMA);
});

test('legacy compact decoding preserves sparse selected sections instead of inventing their min/max umbrella',()=>{
  const resources={'source/SKILL.md':Buffer.from('# Product\n\nOverview.\n\n## First\n\nFirst action.\n\n## Unselected\n\nUnrelated action.\n\n## Last\n\nLast action.\n')},sections=sourceSectionInventory(resources);
  const selected=[sections[1],sections[3]],proposal={semantic_rules:[],observed_requirement_mappings:[],
    source_dispositions:sections.map(section=>({section_id:section.section_id,disposition:'reference',node_ids:[]})),
    nodes:[{id:'author',type:'agent',section_ids:selected.map(item=>item.section_id),prompt_template:'Perform the selected actions.',outputs_schema:closed({answer:text})}],edges:[]};
  const decoded=decodeGeneratedProposalDetailed({proposal},digest('legacy'),{sourceInventory:sections});
  assert.deepEqual(decoded.proposal.nodes[0].source_spans,selected.map(item=>item.source_span));
  assert.equal(decoded.proposal.nodes[0].source_span.end_line,selected[0].source_span.end_line);
  assert.ok(!decoded.proposal.nodes[0].source_spans.some(item=>item.start_line<=sections[2].source_span.start_line&&item.end_line>=sections[2].source_span.end_line));
});
