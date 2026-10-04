import {canonicalJSON,digest} from '../workflow-revisions.mjs';

/** Compact, exact compiler facts; no semantic verdict or publication waiver. */
export function authoringReviewFacts(proposal){
 const nodes=new Map(proposal.nodes.map(node=>[node.id,node]));
 const finiteChoices=proposal.nodes.filter(node=>node.type==='condition').map(node=>{
  const cases=node.cases??[],paths=cases.map(item=>item.when?.op==='eq'?item.when.args?.find(arg=>typeof arg.path==='string')?.path:null);
  const values=cases.map(item=>item.when?.args?.find(arg=>Object.hasOwn(arg,'value'))?.value);
  const path=paths[0],match=typeof path==='string'?/^\/nodes\/([^/]+)\/output(?:\/(.*))?$/.exec(path):null;
  let schema=match?nodes.get(match[1])?.outputs_schema:null;
  let required=Boolean(schema);
  for(const encoded of match?.[2]?.split('/')??[]){const name=encoded.replaceAll('~1','/').replaceAll('~0','~');required=required&&schema?.required?.includes(name)===true;schema=schema?.properties?.[name];}
  const finite=required&&cases.length>0&&paths.every(item=>item===path)&&values.every(item=>item!==undefined)&&Array.isArray(schema?.enum);
  return {node_id:node.id,selector:path??null,finite_domain:finite?structuredClone(schema.enum):null,
   explicit_values:structuredClone(values),default_label:node.default_label??null,
   default_possible_values:finite?schema.enum.filter(value=>!values.some(item=>canonicalJSON(item)===canonicalJSON(value))):null,
   producer_output_validated_before_condition:finite,
   interpretation:finite?'The producer output schema rejects values outside this finite domain before condition evaluation. Default covers only the remaining declared values.':'No finite-domain proof; review the default and missing-value behavior.'};
 });
 return {contract:'authoring-review-facts/v1',proposal_hash:digest(canonicalJSON(proposal)),finite_choices:finiteChoices,
  node_source_evidence:proposal.nodes.map(node=>({node_id:node.id,semantic_key:node.semantic_key??null,tool:node.tool??node.executor?.tool??null,
   source_spans:structuredClone(node.source_spans??(node.source_span?[node.source_span]:[])),resource_refs:structuredClone(node.resource_refs??[])})),
  interpretation:'Source spans are exactly those in the canonical proposal, not the whole resources list. Disjoint ranges are not an umbrella range. A supporting dependency quote can legitimately evidence the guarded Host effect. Judge whether each selected section supports its consumer; do not infer evidence for every line of a referenced resource.'};
}
