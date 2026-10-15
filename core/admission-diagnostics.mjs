// Preserve bounded ownership evidence across RPC, aggregates and terminal
// compaction. Never serialize arbitrary error objects, arguments or owner tokens.
export function admissionFailureDetails(error) {
  const failures = [], seen = new Set();
  function add(value) {
    if (!value || typeof value !== 'object' || !/^(RUN_STORE_ADMISSION_|RUN_ADMISSION_QUEUE_)/.test(value.code ?? '')) return;
    const item = { code: String(value.code).slice(0, 128) };
    for (const key of ['phase', 'lock_path', 'ticket_path', 'created_at', 'owner_operation'])
      if (typeof value[key] === 'string' && value[key].length <= 4096) item[key] = value[key];
    for (const key of ['owner_pid', 'waited_ms'])
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) item[key] = value[key];
    const fingerprint = JSON.stringify(item);
    if (!failures.some(prior => JSON.stringify(prior) === fingerprint) && failures.length < 8) failures.push(item);
  }
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4 || failures.length >= 8) return;
    seen.add(value);
    if (Array.isArray(value.admission_failures) && value.admission_failures.length) for (const item of value.admission_failures.slice(0, 8)) add(item);
    else add(value);
    if (Array.isArray(value.errors)) for (const item of value.errors.slice(0, 8)) visit(item, depth + 1);
    visit(value.cause, depth + 1);
  }
  visit(error);
  return failures.length ? { admission_failures: failures } : {};
}
