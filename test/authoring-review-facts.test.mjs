import test from 'node:test';
import assert from 'node:assert/strict';
import {authoringReviewFacts} from '../core/authoring/review-facts.mjs';
import {validateData} from '../core/workflow-data-schema.mjs';
const fixture=(schema={enum:['new','revise']})=>({nodes:[
 {id:'route',semantic_key:'router',type:'tool',outputs_schema:{type:'object',additionalProperties:false,required:['branch'],properties:{branch:schema}},source_spans:[{resource:'source/WORKFLOW.md',start_line:2,end_line:3},{resource:'source/WORKFLOW.md',start_line:10,end_line:11}],resource_refs:['source/WORKFLOW.md']},
 {id:'choice',type:'condition',cases:[{label:'new',when:{op:'eq',args:[{path:'/nodes/route/output/branch'},{value:'new'}]}}],default_label:'revise'},
]});
test('review facts bind the exact finite default domain and disjoint evidence without semantic approval',()=>{
 const proposal=fixture(),before=JSON.stringify(proposal),facts=authoringReviewFacts(proposal);
 assert.deepEqual(facts.finite_choices[0].default_possible_values,['revise']);
 assert.equal(facts.finite_choices[0].producer_output_validated_before_condition,true);
 assert.throws(()=>validateData({branch:'unexpected'},proposal.nodes[0].outputs_schema));
 assert.deepEqual(facts.node_source_evidence[0].source_spans,proposal.nodes[0].source_spans);
 assert.equal(Object.hasOwn(facts,'approved'),false);assert.equal(JSON.stringify(proposal),before);
});
test('review facts never claim a finite-domain default proof for unconstrained outputs or different selectors',()=>{
 const proposal=fixture({type:'string'});
 assert.equal(authoringReviewFacts(proposal).finite_choices[0].default_possible_values,null);
 const finite=fixture();finite.nodes[1].cases.push({label:'other',when:{op:'eq',args:[{path:'/inputs/other'},{value:'other'}]}});
 assert.equal(authoringReviewFacts(finite).finite_choices[0].producer_output_validated_before_condition,false);
 const optional=fixture();optional.nodes[0].outputs_schema.required=[];
 assert.equal(authoringReviewFacts(optional).finite_choices[0].producer_output_validated_before_condition,false);
});
