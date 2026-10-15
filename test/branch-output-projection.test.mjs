import test from 'node:test';
import assert from 'node:assert/strict';
import {bindingContext} from '../core/workflow-execution-envelope.mjs';
import {resolveBindings} from '../core/workflow-bindings.mjs';

test('coalesce receives the executed branch output after an earlier skipped branch',()=>{
 const accepted={accepted:true,semantic_result:'Three pages checked'};
 const state={inputs:{},nodes:{plain:{status:'skipped',output:null},video:{status:'skipped',output:null},page:{status:'succeeded',output:accepted}}};
 const output=resolveBindings({output:{coalesce:['/nodes/plain/output','/nodes/video/output','/nodes/page/output']}},bindingContext(state));
 assert.deepEqual(output.output,accepted);
 assert.equal(state.nodes.plain.output,null,'Projection must not rewrite durable history');
});
test('executed semantic null remains data while only skipped branches permit missing/default behavior',()=>{
 const context=bindingContext({inputs:{},nodes:{executed:{status:'succeeded',output:null},skipped:{status:'skipped',output:null},live:{status:'succeeded',output:{ok:true}}}});
 assert.equal(resolveBindings({output:{coalesce:['/nodes/executed/output','/nodes/live/output']}},context).output,null);
 assert.equal(resolveBindings({output:{path:'/nodes/skipped/output',default:'absent'}},context).output,'absent');
 assert.throws(()=>resolveBindings({output:'/nodes/skipped/output'},context),{code:'BINDING_MISSING'});
});
