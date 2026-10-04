import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';

test('Skill host inventory uses actual Pi discovery and explicit folder inventory stays separate', async t => {
  const f = await fixture(t), folder = join(f.workspace, 'selected-skills'), skill = join(folder, 'actual');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: actual\ndescription: Actual selected Skill\n---\n\nFull local instructions.');
  const discovered = [];
  f.host.getContext = () => ({ cwd: f.workspace });
  f.host.discoverSkills = async workspace => {
    discovered.push(workspace);
    return { skills: [{ path: join(skill, 'SKILL.md'), scope: 'project', enabled: true }], errors: [], discovered_by: 'active-pi-skill-command-catalog', model_invocations: 0 };
  };
  const host = await f.service.call('skill_inventory', { discovery: 'host', workspace: f.workspace });
  assert.equal(host.entries.length, 1); assert.deepEqual(discovered, [f.workspace]);
  const local = await f.service.call('skill_inventory', { discovery: 'folder', folder });
  assert.equal(local.entries.length, 1); assert.deepEqual(discovered, [f.workspace]);
  delete f.host.discoverSkills;
  await assert.rejects(f.service.call('skill_inventory', { discovery: 'host' }), { code: 'SKILL_DISCOVERY_UNAVAILABLE' });
});
