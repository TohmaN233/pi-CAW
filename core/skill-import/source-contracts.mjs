import { posix } from 'node:path';
import { canonicalJSON, digest, LIMITS } from '../workflow-revisions.mjs';
import { validateDataSchema } from '../workflow-data-schema.mjs';
import { requireValue } from '../workflow-paths.mjs';

const executableNames = new Set(['python','python3','node','ffmpeg','ffprobe','git','java','rscript','codegraph']);
export const RESOLVED_SEMANTIC_OUTPUT_RULE='For a selected source-pinned interface with status resolved and semantic_output true, preserve its exact output schema and source-declared mode applicability. Generic conditional methods apply only when their condition is satisfied for the selected kind/mode and that exact contract permits the result. A declared minItems of 1 excludes an empty array; a mode explicitly marked false does not activate methods requiring that mode. Do not invent an alternate branch or demand weaker bounds merely because shared prose describes another conditional mode. This rule does not waive source-required behavior: an explicit source requirement contradicting its exact interface is a source/Host contract inconsistency to report, not permission to change the pinned schema or ask a planner to rewrite machine fields.';
export const SOURCE_EVIDENCE_RULE='Activity source sections and requirement assignments are semantic selections; the Host projects their exact disjoint source ranges, without filling gaps. A selected section can contain relevant constraints and incidental clauses; selection is not a claim that every clause executes in that activity. Wrong semantic source selection or a wrong method consumer belongs to source_disposition or the applicable semantic coverage check, not a request for the planner to edit Host coordinates. A resolved selected SourceContract range proves that consumer\'s interface, including the full exact schema when selected, and is not method-consumption or transition-order evidence. Resource references grant access; they do not assert that every line of that file supports the activity. Handoff evidence describes the adjacent source-defined phases, rather than inheriting interface documents from either endpoint.';
const safe = value => value.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64).toLowerCase() || 'resource';
const lineNumber = (text,index) => text.slice(0,index).split('\n').length;
const sourceSpan = (resource,text,start,end) => ({resource,start_line:lineNumber(text,start),end_line:lineNumber(text,end)});

function balancedCalls(text,name){
  const calls=[];let cursor=0;
  while(cursor<text.length){
    const found=text.indexOf(name,cursor);if(found<0)break;
    let open=found+name.length;while(/\s/.test(text[open] ?? ''))open++;
    if(text[open]!=='('){cursor=open+1;continue;}
    let depth=0,quote='',escaped=false,index=open;
    for(;index<text.length;index++){
      const char=text[index];
      if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote='';continue;}
      if(char==='"'||char==="'"){quote=char;continue;}
      if(char==='(')depth++;else if(char===')'&&--depth===0){calls.push({start:found,end:index+1,body:text.slice(open+1,index)});index++;break;}
    }
    cursor=Math.max(index,open+1);
  }
  return calls;
}

const pythonStrings = value => [...value.matchAll(/(?:^|[,{[(\s])(?:[rubf]{0,2})?(["'])(.*?)\1/gis)].map(match=>match[2]);
const literal = value => {
  const trimmed=value.trim();
  if(/^[-+]?\d+(?:\.\d+)?$/.test(trimmed))return Number(trimmed);
  if(trimmed==='True')return true;if(trimmed==='False')return false;if(trimmed==='None')return null;
  const string=trimmed.match(/^(?:[rubf]{0,2})?(["'])(.*?)\1$/is);return string?string[2]:undefined;
};
const keyword = (body,name) => body.match(new RegExp(`\\b${name}\\s*=\\s*([^,\\n)]+)`,'i'))?.[1];

function argparseContract(resource,bytes){
  const text=bytes.toString('utf8'),calls=balancedCalls(text,'add_argument');
  if(!calls.length)return null;
  const positionals=[],options=[],spans=[];
  for(const call of calls){
    const names=pythonStrings(call.body).filter(item=>item.length>0);if(!names.length)continue;
    const flags=names.filter(item=>item.startsWith('-')),required=/\brequired\s*=\s*True\b/.test(call.body),nargs=literal(keyword(call.body,'nargs') ?? ''),action=literal(keyword(call.body,'action') ?? ''),type=keyword(call.body,'type')?.trim() ?? '';
    const choicesText=call.body.match(/\bchoices\s*=\s*[\[{(]([^\]})]*)[\]})]/s)?.[1] ?? '';
    const choices=pythonStrings(choicesText);
    const entry={name:flags.length?(flags.find(item=>item.startsWith('--')) ?? flags[0]).replace(/^-+/, '').replaceAll('-','_'):names[0],...(required?{required:true}:{}),...(nargs!==undefined?{nargs}:{}),...(action?{action}:{}),...(type?{value_type:type}:{}),...(choices.length?{choices}:{}),source_span:sourceSpan(resource,text,call.start,call.end)};
    if(flags.length)options.push({...entry,flags});else positionals.push({...entry,required:true});
    spans.push(entry.source_span);
  }
  if(!positionals.length&&!options.length)return null;
  const hash=digest(bytes),contract_id=`interface_${safe(resource)}_${hash.slice(0,12)}`;
  return {contract_id,kind:'python_cli',authority:'interface',status:'resolved',resource,resource_sha256:hash,source_spans:spans,interface:{interpreter:'python',entrypoint:resource,positionals,options}};
}

function pythonArtifactContract(resource,bytes){
  const text=bytes.toString('utf8'),properties={},required=new Set(),spans=[];
  for(const match of text.matchAll(/\brequired\s*=\s*[\[(]([^\])]+)[\])]/gs)){
    for(const key of pythonStrings(match[1]))required.add(key);
    spans.push(sourceSpan(resource,text,match.index,match.index+match[0].length));
  }
  for(const match of text.matchAll(/(?:\b(?:self\.)?(?:spec|data|payload|scenario)\s*\[\s*["']([^"']+)["']\s*\]|\b(?:self\.)?(?:spec|data|payload|scenario)\.get\(\s*["']([^"']+)["']\s*\))\s*!=\s*([^:\n]+)/g)){
    const key=match[1]??match[2],value=literal(match[3]);if(value===undefined)continue;
    properties[key]={const:value};spans.push(sourceSpan(resource,text,match.index,match.index+match[0].length));
  }
  for(const match of text.matchAll(/(?:\b(?:self\.)?(?:spec|data|payload|scenario)\s*\[\s*["']([^"']+)["']\s*\]|\b(?:self\.)?(?:spec|data|payload|scenario)\.get\(\s*["']([^"']+)["']\s*\))\s+not\s+in\s+([\[{(][^\]})]+[\]})])/g)){
    const key=match[1]??match[2],values=pythonStrings(match[3]);if(!values.length)continue;
    properties[key]={type:'string',enum:values};spans.push(sourceSpan(resource,text,match.index,match.index+match[0].length));
  }
  const variables=new Map();
  for(const match of text.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:_require_list\(\s*)?(?:self\.)?(?:spec|data|payload|scenario)\.get\(\s*["']([^"']+)["']/g))variables.set(match[1],match[2]);
  for(const match of text.matchAll(/not\s+isinstance\(\s*([A-Za-z_]\w*)\s*,\s*(list|dict|str|int|float|bool)\s*\)([^\n]*)/g)){
    const key=variables.get(match[1]);if(!key)continue;
    const map={list:'array',dict:'object',str:'string',int:'integer',float:'number',bool:'boolean'},schema={type:map[match[2]]};
    if(match[2]==='list'&&new RegExp(`\\bor\\s+not\\s+${match[1]}\\b`).test(match[3]))schema.minItems=1;
    properties[key]={...(properties[key]??{}),...schema};spans.push(sourceSpan(resource,text,match.index,match.index+match[0].length));
  }
  for(const [variable,key] of variables){
    const direct=new RegExp(`for\\s+([A-Za-z_]\\w*)\\s+in\\s+${variable}\\s*:[\\s\\S]{0,500}?_require_mapping\\(\\s*\\1\\b`,'m').exec(text);
    const enumerated=new RegExp(`for\\s+[A-Za-z_]\\w*\\s*,\\s*([A-Za-z_]\\w*)\\s+in\\s+enumerate\\(\\s*${variable}\\s*\\)\\s*:[\\s\\S]{0,500}?_require_mapping\\(\\s*\\1\\b`,'m').exec(text);
    const loop=direct??enumerated;
    if(loop){properties[key]={...(properties[key]??{}),type:'array',items:{type:'object',additionalProperties:true}};spans.push(sourceSpan(resource,text,loop.index,loop.index+loop[0].length));}
  }
  for(const match of text.matchAll(/not\s+str\(\s*(?:self\.)?(?:spec|data|payload|scenario)\.get\(\s*["']([^"']+)["'][^)]*\)[^\n]*\.strip\(\)/g)){properties[match[1]]={type:'string',minLength:1};spans.push(sourceSpan(resource,text,match.index,match.index+match[0].length));}
  for(const [variable,key] of variables)if(new RegExp(`\\bif\\s+not\\s+${variable}\\s*:`).test(text)){properties[key]={...(properties[key]??{}),type:'array',minItems:1};}
  for(const key of required)properties[key]??={};
  for(const key of Object.keys(properties))if(!required.has(key)&&!Object.hasOwn(properties[key],'const')&&!Object.hasOwn(properties[key],'enum'))delete properties[key];
  if(!Object.keys(properties).length)return null;
  const hash=digest(bytes),contract_id=`artifact_${safe(resource)}_${hash.slice(0,12)}`;
  // A file-wide lexical scan cannot prove which function consumes the object,
  // or that it describes a producer's output. Keep the constraints as review
  // evidence, never as an exact Host-enforced artifact schema.
  return {contract_id,kind:'json_artifact',authority:'source_observation',status:'candidate',observed_direction:'read',resource,resource_sha256:hash,source_spans:dedupeSpans(spans),artifact_schema:{type:'object',properties,required:[...required],additionalProperties:true}};
}

function dedupeSpans(spans){return [...new Map(spans.map(item=>[canonicalJSON(item),item])).values()].sort((a,b)=>a.resource.localeCompare(b.resource)||a.start_line-b.start_line||a.end_line-b.end_line);}

function explicitJsonSchemaContract(resource,bytes){
  try {
    requireValue(bytes.length<=LIMITS.resource,'SOURCE_CONTRACT_SCHEMA_SIZE','Explicit JSON Schema exceeds the pinned resource budget');
    const text=bytes.toString('utf8');
    requireValue(Buffer.from(text,'utf8').equals(bytes),'SOURCE_CONTRACT_SCHEMA_ENCODING','Explicit JSON Schema must be UTF-8');
    const schema=JSON.parse(text);
    validateDataSchema(schema);
    const hash=digest(bytes);
    const base={kind:'json_artifact',authority:'interface',status:'resolved',source_format:'json_schema',semantic_output:true,resource,resource_sha256:hash,source_spans:[{resource,start_line:1,end_line:text.split('\n').length}]};
    const contractId=`schema_${safe(resource).slice(0,48)}_${hash.slice(0,12)}`;
    const entry=(contract_id,json_pointer,output)=>({...base,contract_id,json_pointer,schema_sha256:digest(canonicalJSON(output)),artifact_schema:structuredClone(output),output_schema:structuredClone(output)});
    return [entry(contractId,'',schema),...Object.entries(schema.properties??{}).map(([name,property])=>({...entry(`${contractId}_${safe(name).slice(0,24)}_${digest(name).slice(0,8)}`,`/properties/${name.replaceAll('~','~0').replaceAll('/','~1')}`,property),property_name:name}))];
  } catch(error) {
    throw Object.assign(new Error(`Invalid explicit JSON Schema source contract ${resource}: ${error.message}`),{code:'SOURCE_CONTRACT_SCHEMA',details:{resource,cause_code:error.code??'JSON_PARSE'},cause:error});
  }
}

/** Statically indexes exact source interfaces. It never imports or executes source code. */
export function sourceContractIndex(resources){
  const contracts=[];
  for(const resource of Object.keys(resources).sort()){
    if(/\.schema\.json$/i.test(resource)){
      contracts.push(...explicitJsonSchemaContract(resource,Buffer.from(resources[resource])));
      continue;
    }
    if(!/\.py$/i.test(resource))continue;
    const bytes=Buffer.from(resources[resource]);
    for(const contract of [argparseContract(resource,bytes),pythonArtifactContract(resource,bytes)])if(contract)contracts.push(contract);
  }
  return {contract:'workflow-source-contract-index/v1',resolved_semantic_output_rule:RESOLVED_SEMANTIC_OUTPUT_RULE,source_evidence_rule:SOURCE_EVIDENCE_RULE,contracts:contracts.sort((a,b)=>a.contract_id.localeCompare(b.contract_id))};
}

export function sourceContractMap(resources){return new Map(sourceContractIndex(resources).contracts.map(item=>[item.contract_id,item]));}

function shellTokens(line){
  const tokens=[];let value='',quote='',quoted=false,escaped=false;
  const push=()=>{if(value){tokens.push({value,quoted});value='';quoted=false;}};
  for(const char of line){
    if(quote){if(escaped){value+=char;escaped=false;}else if(char==='\\'&&quote==='"')escaped=true;else if(char===quote){quote='';quoted=true;}else value+=char;continue;}
    if(char==='"'||char==="'"){quote=char;quoted=true;continue;}
    if(/\s/.test(char)){push();continue;}
    if(['|',';'].includes(char)){push();tokens.push({value:char,quoted:false});continue;}
    value+=char;
  }
  push();return tokens;
}

const normalizedExecutable = value => /^rscript$/i.test(value)?'Rscript':value.toLowerCase();

// "node" is also a graph/data noun. Only software spelling, installation /
// availability prose, or an actual JavaScript command supplies runtime evidence.
const nodeRuntimeProse = text => /\bnode(?:\.js|js)\b/i.test(text)
  || /\b(?:install(?:ing|ed)?|require(?:s|d)?|dependency|need(?:s)?)\s+(?:(?:the|a|an)\s+)?node\b(?!\s+(?:for|in|of|per|that|which|with|to\s+(?:join|connect|represent|model)))\b/i.test(text)
  || /\bnode\b\s+(?:runtime|interpreter|executable|binary|installation|installed|available|on\s+(?:the\s+)?PATH|(?:must|needs?\s+to)\s+be\s+(?:installed|available))/i.test(text)
  || /\b(?:run|use|with)\s+node\s+(?:--[A-Za-z]|[^\s;]+\.[mc]?js\b)/i.test(text);
const nodeCommandArguments = tokens => tokens.length===1
  || tokens.slice(1).some(token=>(!token.quoted&&/^-{1,2}[A-Za-z]/.test(token.value))||/\.[mc]?js(?:$|\b)/i.test(token.value));

/** Returns actual command-position dependencies and explicit dependency prose; quoted arguments never create dependencies. */
export function dependencyExecutables(line){
  const inline=[...line.matchAll(/`([^`]+)`/g)].map(match=>match[1]);
  if(inline.length){const outer=line.replace(/`[^`]+`/g,' ');return [...new Set([...inline.flatMap(dependencyExecutables),...dependencyExecutables(outer)])];}
  const cleaned=line.replace(/^\s*(?:(?:\d+[.)]|[-*+])\s*)?`?\s*/,'').replace(/`\s*$/,'');
  const tokens=shellTokens(cleaned),found=new Set(),first=tokens.find(item=>!item.quoted)?.value?.replace(/^&$/,'');
  const basename=value=>posix.basename(String(value).replaceAll('\\','/')).replace(/\.(?:exe|cmd|bat)$/i,'').toLowerCase();
  let commandStart=true;
  for(let index=0;index<tokens.length;index++){
    const token=tokens[index];
    if(['|',';','&&','||'].includes(token.value)){commandStart=true;continue;}
    if(!commandStart||token.quoted)continue;
    let name=basename(token.value);if(['sudo','env','command','call','&'].includes(name)){commandStart=true;continue;}
    if(executableNames.has(name)&&(name!=='node'||nodeCommandArguments(tokens.slice(index))))found.add(normalizedExecutable(name));
    commandStart=false;
  }
  if(!found.size || !executableNames.has(basename(first))){
    const unquoted=cleaned.replace(/(["']).*?\1/g,' ');
    for(const clause of unquoted.split(/[;；]\s*|(?<=[.!?。！？])\s+/)){
      if(!/\b(?:require(?:s|d)?|dependency|install|need(?:s)?|use|with|run|available)\b|\bon\s+(?:the\s+)?PATH\b/i.test(clause))continue;
      for(const match of clause.matchAll(/\b(?:python3?|node(?:\.js|js)?|ffmpeg|ffprobe|git|java|Rscript|codegraph)\b/gi)){
        const name=/^node/i.test(match[0])?'node':normalizedExecutable(match[0]);
        if(name!=='node'||nodeRuntimeProse(clause))found.add(name);
      }
    }
  }
  return [...found];
}
