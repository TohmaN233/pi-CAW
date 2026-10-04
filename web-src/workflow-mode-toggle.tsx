import { api, useLocale, type Json } from './shared';

export function WorkflowModeToggle({item,scope,busy,act,refresh}:{item:Json;scope:Json|null;busy:boolean;act:(work:()=>Promise<any>)=>void;refresh:()=>Promise<void>}) {
  const t=useLocale();
  if(item.system_managed||item.template_kind==='role')return null;
  const setShared=async(enabled:boolean)=>{await api('set_workflow_enabled',{workflow_id:item.id,expected_revision:item.revision_hash,enabled});await refresh();};
  return <div className="workflow-mode-toggle"><label className="check"><input type="checkbox" checked={scope?item.mode_enabled===true:item.enabled===true} disabled={busy}
    onChange={event=>{const enabled=event.target.checked;act(async()=>{
      if(!scope){await setShared(enabled);return;}
      await api('set_mode_workflow_enabled',{workflow_id:item.id,enabled,mode_pack_id:scope.mode_pack_id,
        ...(scope.revision===undefined?{}:{expected_revision:scope.revision}),...(scope.origin===undefined?{}:{expected_origin:scope.origin}),
        ...(scope.snapshot_id===undefined?{}:{expected_snapshot_id:scope.snapshot_id})});
      await refresh();
    });}}/>{scope?t('在当前对话中启用','Enable in this conversation'):t('启用 Workflow','Enable Workflow')}</label>
    {item.global_enabled===false&&<small className="muted">{t('共享定义已关闭。','The shared definition is disabled.')} <button disabled={busy} onClick={()=>act(()=>setShared(true))}>{t('启用共享定义','Enable shared definition')}</button></small>}
  </div>;
}
