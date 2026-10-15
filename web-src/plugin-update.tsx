import { useEffect, useState } from 'react';
import { api, useLocale } from './shared';

declare const __PI_CAW_VERSION__: string;

type UpdateStatus =
  | { status: 'checking' }
  | { status: 'update_available'; currentVersion: string; latestVersion: string }
  | { status: 'local_ahead'; currentVersion: string; latestVersion: string }
  | { status: 'up_to_date'; currentVersion: string; latestVersion: string }
  | { status: 'error'; message: string };

export function PluginUpdate() {
  const t = useLocale();
  const [status, setStatus] = useState<UpdateStatus>({ status: 'checking' });

  async function check() {
    setStatus({ status: 'checking' });
    try {
      const result = await api('plugin_update', { current_version: __PI_CAW_VERSION__ });
      setStatus(result as UpdateStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ status: 'error', message });
    }
  }

  useEffect(() => { void check(); }, []);

  const message = status.status === 'checking'
    ? t('正在检查更新…', 'Checking for updates…')
    : status.status === 'update_available'
      ? t(`发现新版本 v${status.latestVersion}`, `Update available: v${status.latestVersion}`)
      : status.status === 'local_ahead'
        ? t(`本地版本较新 · 最新 v${status.latestVersion}`, `Local version is newer · latest v${status.latestVersion}`)
        : status.status === 'up_to_date'
          ? t('已是最新版本', 'Up to date')
          : t(`无法检查更新：${status.message}`, `Unable to check for updates: ${status.message}`);

  return <div className={`plugin-update plugin-update-${status.status}`} aria-live="polite" title={message}>
    <span className="plugin-update-version">{t('版本', 'Version')} v{__PI_CAW_VERSION__}</span>
    {status.status === 'update_available'
      ? <a className="plugin-update-status" href="https://github.com/TohmaN233/pi-CAW#installation-and-first-use" target="_blank" rel="noopener noreferrer">{message}</a>
      : <span className="plugin-update-status" role={status.status === 'error' ? 'alert' : 'status'}>{message}</span>}
    {status.status === 'error' && <button className="plugin-update-retry" onClick={() => void check()}>{t('重试', 'Retry')}</button>}
    <a href="https://github.com/TohmaN233/pi-CAW" target="_blank" rel="noopener noreferrer"
      aria-label={t('在 GitHub 上为 Pi-CAW 点星', 'Star Pi-CAW on GitHub')}>☆ Star</a>
  </div>;
}
