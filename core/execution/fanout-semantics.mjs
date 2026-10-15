import { validateData } from '../workflow-data-schema.mjs';
import { requireValue } from '../workflow-paths.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Conditional outcome rules stay pure: submission preflight must never execute
// a Host check or admit results into the Run.
export function fanoutResultSchema(definition) {
  const schema=definition.outputs_schema.properties[definition.fanout.result_output].items;
  return {type:'object',properties:{items:{type:'array',items:definition.fanout.result_mode==='per_item'
    ?{type:'object',properties:{outcome:{type:'string',enum:['completed','blocked',...(definition.fanout.shared_change_field?['delegated']:[])]},result:schema,block_reason:{type:'string',minLength:1,maxLength:4096}},required:['outcome'],additionalProperties:false}:schema}},required:['items'],additionalProperties:false};
}

export function inspectFanoutItem(definition,item,itemIndex) {
  const invalid=reason=>({issue:{item_index:itemIndex,category:'invalid',reason}});
  if(!object(item))return invalid(`Host-selected item ${itemIndex} needs one object result`);
  const keys=Object.keys(item),sharedChangeField=definition.fanout.shared_change_field;
  const validReason=typeof item.block_reason==='string'&&Boolean(item.block_reason.trim())&&item.block_reason.length<=4096;
  const delegated=item.outcome==='delegated'||item.outcome==='blocked'&&Object.hasOwn(item,'result')&&sharedChangeField;
  if(delegated){
    if(keys.some(key=>!['outcome','result','block_reason'].includes(key))||!Object.hasOwn(item,'result')||
      item.outcome==='blocked'&&!validReason||Object.hasOwn(item,'block_reason')&&!validReason)
      return invalid(`Item ${itemIndex} has an invalid delegated shared-change result`);
  }else if(item.outcome==='blocked'&&keys.length===2&&keys.every(key=>['outcome','block_reason'].includes(key))&&validReason)
    return {issue:{item_index:itemIndex,category:'blocked',reason:item.block_reason}};
  else if(item.outcome!=='completed'||keys.length!==2||!keys.every(key=>['outcome','result'].includes(key)))
    return invalid(`Item ${itemIndex} needs completed result or specific blocked reason`);
  try{validateData(item.result,definition.outputs_schema.properties[definition.fanout.result_output].items,`$/items/${itemIndex}/result`);}
  catch(error){if(error.code!=='DATA_INVALID')throw error;return invalid(error.message);}
  if(delegated){
    const shared=item.result?.[sharedChangeField];
    const present=typeof shared==='string'?Boolean(shared.trim()):Array.isArray(shared)?shared.length>0:
      object(shared)?Object.keys(shared).length>0:shared!==undefined&&shared!==null&&shared!==false;
    if(!sharedChangeField||!present)return invalid(`Item ${itemIndex} delegated without a nonempty ${sharedChangeField??'shared change'} result`);
  }
  return {result:item.result,delegated:Boolean(delegated),...(delegated&&item.block_reason?{delegation_reason:item.block_reason}:{})};
}

export function validateFanoutResult(definition,result,indices) {
  validateData(result,fanoutResultSchema(definition));
  const count=definition.fanout.result_mode==='per_item'?indices.length:1;
  requireValue(result.items.length===count,'DATA_INVALID',`Fan-out result needs exactly ${count} ordered items; received ${result.items.length}`);
  if(definition.fanout.result_mode==='per_item')for(const [local,item]of result.items.entries()){
    const {issue}=inspectFanoutItem(definition,item,indices[local]);
    requireValue(issue?.category!=='invalid','DATA_INVALID',issue?.reason);
  }
}
