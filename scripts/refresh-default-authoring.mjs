import { readFile, writeFile } from 'node:fs/promises';
import { AUTHORING_WORKFLOWS, createStoredAuthoringWorkflow, validateStoredAuthoringWorkflow } from '../core/authoring/authoring-workflows.mjs';
import { coreProvider } from '../lib/models.mjs';

const path = new URL('../defaults/workflows/defaults.json', import.meta.url);
const packs = JSON.parse(await readFile(path, 'utf8'));
const providers = JSON.parse(await readFile(new URL('../defaults/providers.json', import.meta.url), 'utf8')).map(coreProvider);
for (const definition of AUTHORING_WORKFLOWS) {
  const pack = packs.find(item => item.workflow.id === definition.id), old = pack.workflow;
  const planner = providers.find(item => item.id === old.authoring.planner_provider_id);
  const reviewer = providers.find(item => item.id === old.authoring.review_provider_id);
  pack.workflow = { ...createStoredAuthoringWorkflow(definition, { planner, reviewer, maxRounds: old.authoring.max_rounds }),
    template_kind: 'workflow', ...(old.layout ? { layout: old.layout } : {}) };
  validateStoredAuthoringWorkflow(pack.workflow, providers);
}
await writeFile(path, JSON.stringify(packs, null, 2) + '\n');
console.log('Bundled authoring graphs match the registered Pi compiler identities.');
