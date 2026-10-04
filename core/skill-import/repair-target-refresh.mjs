import {canonicalJSON,digest} from '../workflow-revisions.mjs';
import {semanticGenerationRepair} from './generation-retry-policy.mjs';
import {validateRepairTargets} from './generation-repair.mjs';
import {requireValue} from '../workflow-paths.mjs';

// A retained delta remains bound to its exact old base and raw artifact. Host
// upgrades may improve stable-key localization of the same deterministic error;
// replay uses that current localization and records both identities. This never
// grants an unrelated new diagnosis or rewrites the original Run's findings.
export function refreshRetainedRepairTargets(base,feedback,{validate,currentSourceRequirements=[]}){
  const targets=feedback?.findings??[];
  const previousHash=digest(canonicalJSON(targets));
  try{validate(base);return {targets,receipt:{outcome:'base_now_valid',previous_findings_sha256:previousHash}};}
  catch(error){
    if(!semanticGenerationRepair(error)||error.code!==feedback?.code)throw error;
    const fresh=error.findings;
    const matches=(a,b)=>a.code===b.code&&(a.semantic_keys??[]).some(key=>(b.semantic_keys??[]).includes(key));
    requireValue(Array.isArray(fresh)&&fresh.length&&targets.length&&fresh.every(a=>targets.some(b=>matches(a,b)))&&targets.every(a=>fresh.some(b=>matches(a,b))),
      'GENERATION_RECHECK_REPAIR_TARGET','Current compiler diagnosis differs from the retained patch targets; replay an earlier full plan before requesting another patch');
    const checked=validateRepairTargets(base,{...feedback,findings:fresh},{currentSourceRequirements});
    requireValue(checked.valid,'GENERATION_RECHECK_REPAIR_TARGET',checked.diagnostic);
    return {targets:fresh,receipt:{outcome:'matching_deterministic_findings',previous_findings_sha256:previousHash,current_findings_sha256:digest(canonicalJSON(fresh))}};
  }
}
