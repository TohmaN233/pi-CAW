// The secret belongs to this loopback browser tab and never enters persistent storage.
const fragment = window.location.hash.slice(1);
export const token = fragment.includes('=') ? new URLSearchParams(fragment).get('token') ?? '' : fragment;
if (fragment) window.history.replaceState(null, '', window.location.pathname + window.location.search);
export function getInitialAppRoute() {
  const query = new URLSearchParams(window.location.search);
  return { workflowId: query.get('workflow_id'), runId: query.get('run_id') };
}
export async function requestPi(operation: string, args: Record<string, unknown> = {}) {
  if (!token) throw new Error('This Pi Workbench tab has no credentials. Reopen it with /caw.');
  const response = await fetch('/api', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation, args }), signal: AbortSignal.timeout(120000),
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { code: body.code, detail: { ...body, ...(body.details ?? {}) } });
  if (!Object.prototype.hasOwnProperty.call(body, 'result')) throw new Error('Pi Workbench returned an invalid API response.');
  return body.result;
}
