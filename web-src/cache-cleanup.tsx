import {useState} from 'react';
import {api,Details,useLocale,type Json} from './shared';
export function CacheCleanup({act,busy}:{act:(fn:()=>Promise<unknown>)=>unknown,busy:number}) {
 const t=useLocale();const [preview,setPreview]=useState<Json|null>(null),[result,setResult]=useState<Json|null>(null);
 return <details><summary>{t('旧版本缓存清理','Old version cache cleanup')}</summary><p>{t('先审阅当前清理计划，再删除计划中未被引用的历史版本。当前版本、Run 日志与固定资源引用会保留。计划变化时必须重新预览。','Review the current cleanup plan before deleting unreferenced history revisions. Current revisions, Run journals, and pinned resource references are retained. Preview again if the plan changes.')}</p>
 <button disabled={busy>0} onClick={()=>act(async()=>{setPreview(await api('cache_cleanup_preview'));setResult(null);})}>{t('查看可清理空间','Preview reclaimable space')}</button>{' '}
 <button className="danger" disabled={busy>0||!preview?.plan_hash||!preview.files.length} onClick={()=>act(async()=>{const value=await api('cleanup_caches',{expected_plan_hash:preview!.plan_hash});setResult(value);setPreview(null);})}>{t('按已审阅计划清理','Clean the reviewed plan')}</button>
 {preview&&<><p>{t('可清理','Reclaimable')}: {preview.files.length} {t('个对象','objects')} · {(preview.bytes/1024/1024).toFixed(2)} MB</p><Details title={t('清理计划、对象及保留记录','Cleanup plan, objects, and retained records')} value={preview}/></>}
 {result&&<><p>{t('已清理','Cleaned')}: {result.deleted.length} {t('个对象','objects')} · {(result.bytes/1024/1024).toFixed(2)} MB</p><Details title={t('实际清理记录','Actual cleanup record')} value={result}/></>}
 </details>;
}
