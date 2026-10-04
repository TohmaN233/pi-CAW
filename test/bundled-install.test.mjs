import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workflow } from './fixtures.mjs';
import { exportWorkflowPackage } from '../core/workflow-package.mjs';
import { digest } from '../core/workflow-revisions.mjs';

test('pinned local startup installation preserves exact Ready package and refuses existing user revisions atomically',async t=>{
  const f=await fixture(t),graph=workflow();graph.id='shipped-domain-workflow';
  const source=await f.service.store.create(graph),portable=exportWorkflowPackage(source,{}),bytes=Buffer.from(JSON.stringify(portable));
  await f.service.store.delete(graph.id,source.revision_hash);
  const package_path=join(f.root,'domain.workflow.json');await writeFile(package_path,bytes);
  const installed=await f.service.call('install_workflow_package',{package_path,expected_sha256:digest(bytes)});
  assert.equal(installed.revision_hash,source.revision_hash);assert.equal(installed.workflow.status,'ready');assert.equal(f.requests.length,0);
  const edit=structuredClone(installed.workflow);edit.description='Keep this local user customization';
  const customized=await f.service.store.save(graph.id,edit,{expected_revision:installed.revision_hash});
  await assert.rejects(f.service.call('install_workflow_package',{package_path,expected_sha256:digest(bytes)}),{code:'WORKFLOW_EXISTS'});
  const retained=await f.service.store.snapshot(graph.id);assert.equal(retained.revision_hash,customized.revision_hash);assert.equal(retained.workflow.description,edit.description);
  assert.equal(f.requests.length,0);assert.equal(f.mainRequests.length,0);
});
