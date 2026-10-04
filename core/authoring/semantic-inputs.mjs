// Declarative input grammar only: no execution, evaluation or inferred aliases.
export const SEMANTIC_INPUT_MAX_LENGTH=8500;
export const SEMANTIC_INPUT_GUIDE='An input from is input:name, activity.output.property, or coalesce(activity.output,other.output,...), optionally followed by a shared .property projection. Coalesce requires 2..32 unique declared activity-output alternatives, each at most 260 characters, whose producers are mutually exclusive upstream routes. It selects the original available value; it never asks an Agent to copy or combine values.';

const activityReference=(value,{expression=false}={})=>{
  if(typeof value!=='string'||value.length>260||value.startsWith('input:'))return null;
  const separator=value.indexOf('.');
  if(separator<1||separator===value.length-1||!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.slice(0,separator))
    ||expression&&/[(),\s]/.test(value))return null;
  return {activity:value.slice(0,separator),output:value.slice(separator+1)};
};
export function semanticInputReferences(from){
  if(typeof from!=='string'||!from.length||from.length>SEMANTIC_INPUT_MAX_LENGTH)return null;
  if(from.startsWith('input:'))return from.length<=260&&from.length>6?[{input:from.slice(6)}]:null;
  if(!from.startsWith('coalesce(')){const reference=activityReference(from);return reference?[reference]:null;}
  const expression=/^coalesce\(([^()]*)\)(?:\.([^(),\s]+))?$/.exec(from);
  if(!expression)return null;
  const alternatives=expression[1].split(',').map(value=>value.trim());
  if(alternatives.length<2||alternatives.length>32||new Set(alternatives).size!==alternatives.length)return null;
  const references=alternatives.map(value=>activityReference(expression[2]?`${value}.${expression[2]}`:value,{expression:true}));
  if(references.some(value=>!value)||new Set(references.map(value=>value.activity)).size!==references.length)return null;
  return references;
}
