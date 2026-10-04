import { resolveBindings } from './workflow-bindings.mjs';
import { hostToolContracts } from './execution/host-tool-runner.mjs';

/** Only declared bindings and logical immutable references reach an executor. */
export function projectNodeContext(node, workflow, bindingContext) {
  // Runtime decision identity, required-reference receipts and final acceptance
  // are journal/controller data.  They may remain in durable node output for
  // auditing, but must never flow back into a later semantic executor merely
  // because that executor binds an upstream output object.
  const semanticContext = structuredClone(bindingContext);
  for (const definition of workflow.nodes ?? []) {
    const output = semanticContext.nodes?.[definition.id]?.output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
    if (definition.decision) { delete output.decision_id; delete output.references; }
    if (workflow.finalization?.node_id === definition.id) delete output.accepted;
  }
  const contract=node.type==='tool'&&node.executor?.kind==='tool'?hostToolContracts(workflow).get(node.executor.tool):null;
  const optionalHostInputs=new Set(Object.keys(contract?.input_schema?.properties??{}).filter(name=>!(contract.input_schema.required??[]).includes(name)));
  const inputs = resolveBindings(node.input_bindings ?? {}, semanticContext,{optionalHostInputs});
  const resources = structuredClone(node.resources ?? []);
  return {
    inputs,
    references: resources,
    projection: {
      mode: 'declared_bindings',
      bindings: Object.keys(node.input_bindings ?? {}).sort(),
      references: resources,
    },
  };
}
