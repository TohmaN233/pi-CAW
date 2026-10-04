import {useEffect,useState} from 'react';
import {api,useLocale,type Json} from './shared';
export function RunCleanup({busy,act,refresh}:{busy:number;act:(action:()=>Promise<void>)=>void;refresh:()=>Promise<void>}) {
 const t=useLocale();const [hours,setHours]=useState<number|undefined>(),[result,setResult]=useState<Json|null>(null),[maintenanceError,setMaintenanceError]=useState<Json|null>(null);
 useEffect(()=>{act(async()=>{const value=await api('run_retention');setHours(value.completed_hours);setMaintenanceError(value.maintenance_error);});},[]);
 return <section className="panel"><h2>{t('运行记录清理','Run history cleanup')}</h2>
 <p>{t('失败或取消且已关闭执行进程的记录自动清理。中断、暂停、待确认与效果未确认的记录保留以便恢复。正式成果与聊天保留。','Quiescent failed/cancelled process data is cleaned automatically. Interrupted, paused, pending and uncertain runs remain recoverable. Deliverables and chats are kept.')}</p>
 {maintenanceError&&<p role="alert">{t('自动清理未完成','Automatic cleanup failed')}: {maintenanceError.code} · {maintenanceError.message}</p>}
 <label>{t('完成记录保留小时数','Hours to retain completed runs')} <input type="number" min={0} max={720} value={hours??''} disabled={busy>0} onChange={event=>setHours(Number(event.target.value))}/></label>{' '}
 <button disabled={busy>0||hours===undefined} onClick={()=>act(async()=>{await api('run_retention',{completed_hours:hours});})}>{t('保存','Save')}</button>{' '}
 <button disabled={busy>0} onClick={()=>act(async()=>{setResult(await api('cleanup_run_history',{completed_now:true}));await refresh();})}>{t('一键清理已结束记录','Clean finished runs now')}</button>
 {result&&<p role="status">{t('已清理','Cleaned')} {result.deleted.length} · {(result.bytes/1024/1024).toFixed(2)} MB · {t('保留可恢复/待确认记录','Protected recoverable/pending records')} {result.protected.length}</p>}
 </section>;
}
