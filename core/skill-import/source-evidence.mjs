import {requireValue} from '../workflow-paths.mjs';

// Merge only intersecting intervals. Adjacent selected sections remain distinct
// semantic evidence; gaps must never become claimed source text.
export function disjointSourceSpans(spans) {
  requireValue(Array.isArray(spans),'EXPANSION_SOURCE_SPAN','Source evidence must be an array');
  const result=[];
  for(const raw of spans){
    requireValue(raw&&Object.keys(raw).every(key=>['resource','start_line','end_line'].includes(key))&&typeof raw.resource==='string'&&raw.resource.length>0&&Number.isInteger(raw.start_line)&&Number.isInteger(raw.end_line)
      &&raw.start_line>=1&&raw.end_line>=raw.start_line,'EXPANSION_SOURCE_SPAN','Source evidence needs valid inclusive line ranges');
    let merged=structuredClone(raw),position=result.length;
    for(let index=0;index<result.length;){
      const prior=result[index];
      if(prior.resource===merged.resource&&prior.start_line<=merged.end_line&&merged.start_line<=prior.end_line){
        position=Math.min(position,index);merged={resource:raw.resource,start_line:Math.min(prior.start_line,merged.start_line),end_line:Math.max(prior.end_line,merged.end_line)};
        result.splice(index,1);index=0;
      } else index++;
    }
    result.splice(Math.min(position,result.length),0,merged);
  }
  return result;
}
