import test from 'node:test';
import assert from 'node:assert/strict';
import {routeReviewFindings} from '../core/skill-import/review-checklist.mjs';
import {CONVERSION_CONTRACT} from '../core/skill-import/conversion-contract.mjs';
import {SEMANTIC_BLUEPRINT_GUIDE} from '../core/authoring/blueprint-contract.mjs';

test('unsupported workspace and directory freshness gates route to Host repair without consuming semantic repair',()=>{
  const host=[
    '[validation_strength] Host imposes a whole-workspace freshness gate without source authority.',
    '[validation_strength] The Host enforces an entire workspace immutability requirement.',
    '[validation_strength] Host adds a directory unchanged gate.',
    '[validation_strength] Host projects a workspace freshness requirement.',
  ];
  const semantic=[
    '[validation_strength] The reviewer should inspect the declared products; do not add a Host workspace freshness gate.',
    '[validation_strength] The source requires validating all selected diagrams.',
    '[validation_strength] Documentation mentions a Host directory gate as an unrelated example.',
  ];
  const result=routeReviewFindings([...host,...semantic]);
  assert.deepEqual(result.host_findings,host);assert.deepEqual(result.semantic_findings,semantic);
  const guidance=JSON.stringify(CONVERSION_CONTRACT);
  assert.match(guidance,/selected products/);assert.match(guidance,/without an explicit source or user requirement/);
  assert.match(SEMANTIC_BLUEPRINT_GUIDE.host_check_authority,/Host scope defects block generation/);
});
