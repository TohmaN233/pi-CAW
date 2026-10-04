import { useState } from 'react';
import { api, Details, useLocale, type Json } from './shared';
export function LocalClients() {
 const t=useLocale(); const [value,setValue]=useState<Json|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <section><h2>{t('当前 Pi 模型目录','Current Pi model catalog')}</h2><p>{t('目录来自当前 Pi 对话可用且已认证的模型。刷新不会选择模型或修改既有绑定。','The catalog comes from models available and authenticated in the current Pi conversation. Refreshing does not select a model or alter existing bindings.')}</p><button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{setValue(await api('models'));}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}}>{busy?t('正在读取…','Reading…'):t('刷新目录','Refresh catalog')}</button>{error&&<p role="alert">{error}</p>}{value&&<><ul>{value.models.map((model:Json)=><li key={`${model.provider}/${model.model_id}`}>{model.name} · {model.provider}/{model.model_id} · {model.thinking_levels.join(', ')}</li>)}</ul><Details title={t('目录来源和模型契约','Catalog source and model contracts')} value={value}/></>}</section>;
}
