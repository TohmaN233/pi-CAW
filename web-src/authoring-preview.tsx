import { useEffect, useState } from 'react';
import { Canvas } from './canvas';
import { api, Details, Status, useLocale, type Json } from './shared';
import { loadAuthoringPreview } from './authoring-preview-actions.mjs';

export function AuthoringPreview({ pack, runId, providers, act, openRun }: { pack?: Json, runId?: string, providers: Json[],
  act: (work: () => Promise<any>) => void, openRun: (runId: string) => void }) {
  const t = useLocale();
  const [preview, setPreview] = useState<Json | null>(null), [candidates, setCandidates] = useState<Json[] | null>(null);
  const [selected, setSelected] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => { setPreview(null); setCandidates(null); setSelected(''); }, [pack?.revision_hash, runId]);
  const read = (selectedRun?: string) => act(async () => {
    setLoading(true); setPreview(null); setSelected('');
    try {
      const result = await loadAuthoringPreview(api, { pack, runId, selectedRun });
      if (result.candidates) setCandidates(result.candidates);
      setPreview(result.preview);
    } finally { setLoading(false); }
  });
  const node = preview?.workflow?.nodes.find((item: Json) => item.id === selected);
  return <section className="retained-review"><h3>{t('保留的生成结果预览', 'Retained generation preview')}</h3>
    <p>{t('读取已保存的生成图和独立审核证据。预览不会调用模型、推进 Run 或应用到源 Workflow。', 'Read the saved generated graph and independent review evidence. Previewing does not call a model, advance the Run, or apply changes to the source Workflow.')}</p>
    <button disabled={loading} onClick={() => read()}>{loading ? t('正在读取…', 'Reading…') : t('读取保留的生成结果', 'Read retained generation result')}</button>
    {candidates?.map(candidate => <div className="history-row" key={candidate.run_id}><code>{candidate.run_id}</code><Status value={candidate.status}/><span>{candidate.updated_at}</span><button disabled={loading} onClick={() => read(candidate.run_id)}>{t('预览此 Run', 'Preview this Run')}</button><button onClick={() => openRun(candidate.run_id)}>{t('打开 Run 详情', 'Open Run details')}</button></div>)}
    {candidates && !candidates.length && <p role="status">{t('此精确源版本没有可预览的保留生成 Run。', 'No retained authoring Run is available for this exact source revision.')}</p>}
    {candidates && candidates.length > 1 && !preview && <p role="status">{t('此版本有多个生成 Run，请明确选择一个预览。', 'This revision has multiple authoring Runs. Select one explicitly to preview.')}</p>}
    {preview && <><p><Status value={preview.status}/> · {preview.phase} · <code>{preview.run_id}</code></p>
      {preview.error && <div role="alert"><Details title={t('预览尚不可用', 'Preview unavailable')} value={preview.error}/></div>}
      {preview.workflow && <><div className="generation-preview" style={{ display: 'flex', height: 480 }}><Canvas workflow={preview.workflow} providers={providers} onChange={() => {}} onSelect={(kind, id) => setSelected(kind === 'node' ? id : '')} readOnly/></div>
      {node && <Details title={t('所选节点的固定定义', 'Selected node definition')} value={node}/>}<Details title={t('生成图的结构检查与启动限制', 'Generated graph validation and launch blockers')} value={preview.validation}/></>}
      <Details title={t('生成结果、精确身份与审核证据', 'Generated result, exact identity, and review evidence')} value={preview}/>
    </>}
  </section>;
}
