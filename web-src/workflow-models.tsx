import { useEffect, useState } from 'react';
import { BindingPicker } from './pi-settings';
import { api, Details, useLocale, type Json } from './shared';

// Local slots retain the source graph's IDs, including IDs absent from settings.
export function workflowProviders(providers: Json[], descriptor?: Json | null): Json[] {
  if (!descriptor) return providers;
  const slots = descriptor.bindings.providers;
  const ids = new Set(Object.keys(slots));
  return [...providers.filter(provider => !ids.has(provider.id)), ...Object.entries(slots).map(([id, binding]) => {
    const configured = providers.find(provider => provider.id === id);
    if (!descriptor.local && configured) return configured;
    const selected = binding as Json | null;
    return { ...configured, id, name: configured?.name ?? id, kind: 'native_agent', enabled: true,
      binding: selected, config: { model: selected?.model_id, reasoning_effort: selected?.thinking } };
  })];
}

export function WorkflowModels({ pack, models, busy, act, saved, onDirty }: { pack: Json, models: Json[], busy: number,
  act: (work: () => Promise<any>) => void, saved: (pack: Json) => Promise<void>, onDirty: (dirty: boolean) => void }) {
  const t = useLocale();
  const descriptor = pack.model_bindings;
  const [providers, setProviders] = useState<Json>(() => structuredClone(descriptor.bindings.providers));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setProviders(structuredClone(descriptor.bindings.providers)); setDirty(false); }, [pack.revision_hash, descriptor]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]);
  const complete = Object.values(providers).every(binding => binding === null || binding.provider && binding.model_id && binding.thinking);
  return <section className="detail-page scroll"><h2>{t('本 Workflow 的模型', 'Models for this Workflow')}</h2>
    <p>{t('Main 沿用发起任务的 Pi 对话的实际模型和思考强度。下列子 Agent 槽位保留源 Provider ID；请明确选择本机 Pi 模型和思考强度。', 'Main inherits the initiating Pi conversation’s actual model and thinking. Child Agent slots retain their source Provider IDs; explicitly choose a local Pi model and thinking level.')}</p>
    <p>{t('保存会为当前精确版本创建本机配置，所有未选择的槽位保持未绑定。模型配置不随可安装包导出。', 'Saving creates local configuration for this exact revision. Unselected slots remain unbound. Model configuration is excluded from install packages.')}</p>
    {descriptor.stale && <p role="alert">{t('Workflow 版本已变化，请为此版本重新选择模型。旧版本的选择未沿用。', 'The Workflow revision changed. Choose models for this revision; previous selections were not reused.')}</p>}
    {!descriptor.local && <p role="status">{t('尚未保存本 Workflow 的本机配置；当前启动检查可能使用已注册的同 ID Provider。保存后只使用下面的明确选择。', 'This Workflow has no saved local configuration. Current launch checks may use registered Providers with matching IDs. After saving, only the explicit selections below apply.')}</p>}
    <div className="settings-grid">{Object.entries(providers).map(([id, binding]) => <fieldset className="settings-card" key={id} disabled={busy > 0}><legend>{id}</legend><BindingPicker models={models} binding={binding} change={next => { setProviders(current => ({ ...current, [id]: next })); setDirty(true); }}/></fieldset>)}</div>
    {!Object.keys(providers).length && <p>{t('此 Workflow 没有需要独立绑定模型的子 Agent。', 'This Workflow has no child Agent slots requiring an independent model binding.')}</p>}
    {!complete && <p role="alert">{t('请为已选择的模型明确选择思考强度，再保存。', 'Choose a thinking level for each selected model before saving.')}</p>}
    <div className="actions"><button className="primary" disabled={busy > 0 || !dirty || !complete} onClick={() => act(async () => {
      await api('save_workflow_bindings', { workflow_id: pack.workflow.id, workflow_revision: pack.revision_hash, expected_revision: descriptor.revision, providers });
      await saved(pack);
    })}>{t('保存本 Workflow 模型配置', 'Save Workflow model configuration')}{dirty ? ' *' : ''}</button>
    <button disabled={busy > 0} onClick={() => act(async () => saved(pack))}>{t('重新读取并放弃未保存选择', 'Reload and discard unsaved selections')}</button></div>
    <Details title={t('当前模型绑定与启动限制', 'Current model bindings and launch blockers')} value={descriptor}/>
  </section>;
}
