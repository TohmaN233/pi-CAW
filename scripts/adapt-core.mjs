import { readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../core');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.name.endsWith('.mjs')) result.push(path);
  }
  return result;
}
await writeFile(join(root, 'config.mjs'), "export const ALLOWED_TEMPLATE_FIELDS = new Set(['task','context','constraints','verification','task_type_id','stage_id','provider_name']);\n");
await writeFile(join(root, 'native-provider-identity.mjs'), "// Pi model bindings have no built-in Provider registry or legacy aliases.\nexport function canonicalNativeProviderId(id) { return id; }\n");
await rename(join(root, 'execution/codex-skill-policy.mjs'), join(root, 'execution/skill-policy.mjs'));
for (const path of await files(root)) {
  let body = await readFile(path, 'utf8');
  body = body.replaceAll('codex-skill-policy.mjs', 'skill-policy.mjs');
  if (path.endsWith('workflow-package.mjs')) body = body.replaceAll('codex.workflow.package', 'pi-caw.workflow.package').replaceAll('codex-agents-workflow', 'pi-CAW');
  if (path.endsWith('workflow-runtime.mjs')) body = body.replace("['codex-app-server-host-main','codex-app-server']", "['pi-sdk-main']");
  if (path.endsWith('thread-protocol.mjs')) body = body.replaceAll("'codex_thread'", "'pi_session'");
  if (path.endsWith('workflow-resource-program.mjs')) body = body.replace("import { createCodexToolBroker } from './codex-tool-broker.mjs';", "import { createPiToolBroker } from '../../lib/host-tools.mjs';").replaceAll('createCodexToolBroker', 'createPiToolBroker');
  if (path.endsWith('routing-rules.mjs')) {
    const start = body.indexOf('export function defaultRoutingRules(');
    const end = body.indexOf('export function validateRoutingRules(', start);
    body = body.slice(0,start) + `export function defaultRoutingRules() {
  return {version:1,instructions:'Use only explicitly configured Pi Provider routes. An empty route blocks authoring; never guess a model.',selection_mode:'fixed',routes:Object.fromEntries(TASK_TYPES.map(type=>[type,{provider_id:'',role:type==='review'?'reviewer':'implementer'}]))};
}
` + body.slice(end);
    body = body.replace("{review_provider_id:'native-sol',max_rounds:4,...value}", "{max_rounds:4,...value}");
  }
  if (path.endsWith('authoring-workflows.mjs')) body = body.replace("routingRules?.generation?.review_provider_id ?? 'native-sol'", "routingRules?.generation?.review_provider_id ?? ''");
  if (path.endsWith('runtime-environment.mjs')) body = body.replace("join(home,'.codex','vendor')", "join(home,'.pi','agent','bin')");
  // Product-facing vocabulary changes; historical compiler certificates stay versioned.
  body = body.replaceAll('Codex task threads', 'Pi persistent sessions').replaceAll('Codex task thread', 'Pi persistent session')
    .replaceAll('Codex task identity', 'Pi session identity').replaceAll('exact Codex thread ID', 'exact Pi session ID')
    .replaceAll('native Codex Provider', 'native Pi Provider');
  await writeFile(path, body);
}
// Keep only the transitive dependency closure actually used by the portable core.
const used = new Set();
async function visit(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + '/') && !absolute.startsWith(root + '\\')) return;
  if (used.has(absolute)) return;
  used.add(absolute);
  const body = await readFile(absolute, 'utf8');
  for (const match of body.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) await visit(relative(root, resolve(dirname(absolute), match[2])));
}
for (const entry of ['workflow-runtime.mjs','workflow-store.mjs','workflow-package.mjs','templates.mjs']) await visit(entry);
for (const path of await files(root)) if (!used.has(path)) await unlink(path);
console.log(`Adapted portable closure: ${used.size} modules; Codex executable/connector dependencies removed.`);
