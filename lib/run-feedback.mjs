const labels={running:'运行中',succeeded:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断，保留以便恢复',paused:'已暂停',blocked:'等待处理',awaiting_acceptance:'等待确认'};
export function nodeFeedback(record, id, node) {
  const definition=record.pins.root.workflow.nodes.find(item=>item.id===id);
  const attempt=node.attempts?.find(item=>item.id===node.active_attempt_id)??node.attempts?.at(-1);
  const receipt=attempt?.dispatch?.receipt;
  const provider=record.pins.providers?.find(item=>item.id===definition?.executor?.provider_id);
  const event=attempt?.executor_events?.at(-1);
  const binding=receipt?.observed_model??provider?.config;
  return {id,name:definition?.name??id,type:definition?.type??'unknown',status:node.status,
    executor:receipt?.executor??definition?.executor?.kind??'control',tool:definition?.executor?.tool??null,
    main_mode:receipt?.main_mode??null,model:binding?{provider:binding.provider??null,model_id:binding.model_id??null,thinking:binding.thinking??null}:null,
    model_source:receipt?.observed_model?'observed':binding?'pinned':null,
    attempt_id:attempt?.id??null,attempts:node.attempts?.length??0,
    session_count:receipt?.sessions?.length??(receipt?.thread_id&&receipt.executor!=='pi-current-chat-main'?1:0),
    activity:event?{kind:event.kind,tool:event.metadata?.tool??null,phase:event.metadata?.phase??null,status:event.metadata?.status??null}:null,
    event_count:attempt?.executor_event_count??0,started_at:attempt?.started_at??null,finished_at:attempt?.finished_at??null,
    error:node.error??null};
}
export function runFeedback(record) {
  const {state:s,pins}=record, entries=Object.entries(s.nodes);
  const active=entries.filter(([,n])=>['running','claimed'].includes(n.status)).map(([id])=>pins.root.workflow.nodes.find(n=>n.id===id)?.name??id);
  const files=new Set();
  const scan=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(scan);return;}
    if(typeof v.path==='string' && typeof v.sha256==='string' && /^(?:[A-Za-z]:[\\/]|\/)/.test(v.path))files.add(v.path);
    for(const [k,c]of Object.entries(v))if(['files','artifacts','source','output','publishedOutput'].includes(k))scan(c);};
  for(const [,n]of entries)if(n.output?.succeeded===true)scan(n.output);
  scan(s.output);scan(s.outputs);
  const product=entries.map(([,n])=>n.output).find(o=>o?.taskId===s.inputs.taskId && o?.succeeded===true && ['lesson','semester','assignment','deck'].includes(o.kind));
  return {schema_version:1,run_id:s.run_id,main_actor:s.main_actor,workflow_name:pins.root.workflow.name,
    status:s.status,label:labels[s.status]??s.status,active_nodes:active,
    completed:entries.filter(([,n])=>n.status==='succeeded').length,total:entries.filter(([,n])=>n.status!=='skipped').length,
    files:[...files].sort(),nodes:entries.map(([id,node])=>nodeFeedback(record,id,node)),...(s.error?{error:s.error}:{}),
    ...(s.inputs.taskId?{task_id:s.inputs.taskId}:{}),
    course:(pins.root.workflow.host_tools??[]).some(t=>t.id.startsWith('course_')),section:product?.kind==='lesson'?'lessons':product?.kind==='semester'?'semester-plan':product?.kind==='assignment'?'assignments':'outputs'};
}
export function feedbackText(event) {
  const escape=s=>String(s).replace(/[\[\]<>`]/g,'');
  const lines=[`**${escape(event.workflow_name)} · ${escape(event.label)}**`,
    event.active_nodes.length?`当前：${event.active_nodes.map(escape).join('、')}`:`已完成 ${event.completed}/${event.total} 个节点。`];
  if(event.error)lines.push(`错误：${escape(event.error.message??JSON.stringify(event.error))}`);
  if(event.status==='succeeded' && event.course)lines.push('成果已保存，等待教师审阅。');
  if(event.course && event.status==='succeeded')lines.push(`[打开课程成果与审阅](/course-builder?sessionId=${encodeURIComponent(event.main_actor)}#${event.section})`);
  for(const path of event.files)lines.push(`[${escape(path.split(/[\\/]/).at(-1))}](<${path.replace(/\\/g,'/').replace(/>/g,'%3E')}>)`);
  return lines.join('\n\n');
}
