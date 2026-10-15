import { open, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJSON, digest } from '../core/workflow-revisions.mjs';
import { ensureDirectory, noSymlinks, requireValue } from '../core/workflow-paths.mjs';
import { syncDirectory } from '../core/workflow-store.mjs';

export const NODE_INPUT_BUDGETS = Object.freeze({ item_bytes: 8192, inline_bytes: 12000, index_bytes: 16000 });
export function requireInputMaterialCapacity(resources) {
  const pins=resources.filter(item=>item.material_kind==='pi_node_input');
  requireValue(pins.length<=4096&&pins.every(item=>Number.isSafeInteger(item.bytes)&&item.bytes>=0&&item.bytes<=16*1024*1024)
    &&pins.reduce((sum,item)=>sum+item.bytes,0)<=64*1024*1024,'PI_INPUT_MATERIAL_LIMIT','Host input materials exceed their explicit 16 MiB/file, 64 MiB/task or 4096-pin capacity');
}
const byteLength = value => Buffer.byteLength(value, 'utf8');
const reference = item => ({ pi_caw_material: { path: item.path, sha256: item.sha256, bytes: item.bytes, encoding: item.encoding } });
export function materialInstruction(item) {
  return `Complete declared value is in pinned resource ${item.path} (${item.encoding}, ${item.bytes} bytes, sha256 ${item.sha256}). Read it with read_workflow_resource_chunk, following next_byte until complete. This reference does not grant workspace writes.`;
}

// Reusing an exact preparation is idempotent. Interrupted or changed evidence is
// never overwritten: its original complete bytes remain available for diagnosis.
async function immutableFile(path, bytes) {
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await noSymlinks(path);
    const stat = await lstat(path);
    requireValue(stat.isFile() && stat.nlink === 1 && stat.size === bytes.length && (await readFile(path)).equals(bytes),
      'PI_INPUT_MATERIAL_CONFLICT', 'Exact input material already exists with different bytes', { path });
    return;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

/** Preserve complete semantic values; spill whole fields, never substrings. */
export async function prepareNodeInputMaterials({ directory, identity, inputs, resources = [], budgets = NODE_INPUT_BUDGETS }) {
  requireValue(Object.values(budgets).every(value => Number.isSafeInteger(value) && value > 0), 'PI_INPUT_BUDGET', 'Input byte budgets must be positive integers');
  const semanticHash = digest(canonicalJSON(inputs));
  const preparation = digest(canonicalJSON({ identity, semantic_sha256: semanticHash,
    resources: resources.map(({ path, sha256 }) => ({ path, sha256 })), budgets }));
  const root = await ensureDirectory(join(directory, preparation));
  const {indices:_indices,...scopeIdentity}=identity;
  const prefix = `pi-caw-inputs/${digest(canonicalJSON(scopeIdentity))}`;
  requireValue(!resources.some(item => item.path === prefix || item.path.startsWith(prefix + '/')), 'PI_INPUT_RESOURCE_COLLISION', 'Source resource collides with exact input material namespace');
  const materials = [], fields = [],exposed=new Set();
  const save = async (name, bytes, encoding) => {
    requireValue(bytes.length<=16*1024*1024,'PI_INPUT_MATERIAL_LIMIT','Complete input material exceeds the explicit 16 MiB per-file capacity',{field:name,bytes:bytes.length});
    const sha256 = digest(bytes), file = `${sha256}.${encoding === 'utf8' ? 'txt' : 'json'}`;
    await immutableFile(join(root, file), bytes);
    const item = { path: `${prefix}/${file}`, sha256, bytes: bytes.length, object_path: join(root, file), encoding,material_kind:'pi_node_input' };
    if (!materials.some(value => value.path === item.path)) materials.push(item);
    return { ...item, field: name };
  };
  for (const name of Object.keys(inputs).sort()) {
    const value = inputs[name], text = typeof value === 'string' ? value : canonicalJSON(value);
    const utf8 = typeof value === 'string' && Buffer.from(text).toString('utf8') === text;
    const bytes = Buffer.from(utf8 ? text : canonicalJSON(value));
    fields.push(await save(name, bytes, utf8 ? 'utf8' : 'canonical-json'));
  }
  let catalog = canonicalJSON(resources.map(({ path, sha256, skill_name }) => ({ path, sha256, ...(skill_name ? { skill_name } : {}) })));
  if (byteLength(catalog) > budgets.item_bytes) {
    const item = await save('source-resource-catalog', Buffer.from(catalog), 'canonical-json');
    exposed.add(item.path);
    catalog = canonicalJSON(reference(item));
  }
  const catalogBytes=byteLength(catalog);
  const spilled = new Set(fields.filter(item => item.bytes > budgets.item_bytes).map(item => item.field));
  const ordered = [...fields].sort((a, b) => b.bytes - a.bytes || a.field.localeCompare(b.field, 'en'));
  const inlineBytes = () => catalogBytes+fields.filter(item => !spilled.has(item.field)).reduce((sum, item) => sum + byteLength(canonicalJSON(inputs[item.field])), 0);
  const projected = () => Object.fromEntries(fields.map(item => [item.field, spilled.has(item.field) ? reference(item) : inputs[item.field]]));
  for (const item of ordered) if (inlineBytes() > budgets.inline_bytes) spilled.add(item.field);
  for (const item of ordered) if (byteLength(canonicalJSON(projected()))+catalogBytes > budgets.index_bytes) spilled.add(item.field);
  let index = canonicalJSON(projected()), indexMaterial;
  if (byteLength(index)+catalogBytes > budgets.index_bytes) {
    indexMaterial = await save('declared-input-index', Buffer.from(index), 'canonical-json');
    exposed.add(indexMaterial.path);
    index = canonicalJSON(reference(indexMaterial));
    requireValue(byteLength(index)+catalogBytes <= budgets.index_bytes, 'PI_INPUT_INDEX_LIMIT', 'Input index reference exceeds its complete serialized byte budget');
  }
  const variables = Object.fromEntries(fields.map(item => [item.field, spilled.has(item.field) ? materialInstruction(item) : inputs[item.field]]));
  for(const item of fields)if(spilled.has(item.field))exposed.add(item.path);
  const manifest = { schema_version: 1, kind: 'pi_node_input_materials', identity, preparation_id: preparation,
    semantic_input_sha256: semanticHash, source_resources: resources.map(({ path, sha256 }) => ({ path, sha256 })),
    budgets, inline_bytes: inlineBytes(), index_bytes: byteLength(index)+catalogBytes,
    fields: fields.map(({ object_path, ...item }) => ({ ...item, inline: !spilled.has(item.field) })),
    ...(indexMaterial ? { index_material: reference(indexMaterial).pi_caw_material } : {}),
    derived_resources: materials.map(({ object_path, ...item }) => item) };
  const bytes = Buffer.from(canonicalJSON(manifest));
  const manifestPath = join(root, 'manifest.json'); await immutableFile(manifestPath, bytes);
  await syncDirectory(root);
  requireInputMaterialCapacity(materials.filter(item=>exposed.has(item.path)));
  return { variables, index, catalog, resources: [...resources, ...materials.filter(item=>exposed.has(item.path))],
    evidence: { manifest_path: manifestPath, manifest_sha256: digest(bytes), preparation_id: preparation,
      semantic_input_sha256: semanticHash, spilled_fields_sha256:digest(canonicalJSON([...spilled].sort())),spilled_count:spilled.size,
      prompt_input_bytes: byteLength(index), inline_bytes: inlineBytes() } };
}

export function assertPromptBytes(prompt, limit = 80000) {
  requireValue(Number.isSafeInteger(limit) && limit > 0, 'PI_PROMPT_LIMIT_CONFIG', 'Prompt byte limit must be a positive integer');
  const bytes = byteLength(prompt);
  requireValue(bytes <= limit, 'PI_PROMPT_LIMIT', 'Complete node prompt exceeds its UTF-8 byte budget', { prompt_bytes: bytes, max_prompt_bytes: limit });
  return prompt;
}
