import test from 'node:test';
import assert from 'node:assert/strict';
import {explain} from '../server/model.mjs';
const context={source:{title:'synthetic'},epoch:0,evidence:[{id:'e1',videoTime:4,text:'合成讲义'}]};
async function mockModel(content,fn){const before=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content}}]})});try{return await fn();}finally{globalThis.fetch=before;}}
test('fabricated model event id is rejected',async()=>{const r=await mockModel(JSON.stringify({answer:'解释',citations:[{id:'fake',videoTime:4}]}),()=>explain(context,'解释',{BILICLASS_MODEL:'test'}));assert.equal(r.status,'invalid_model_citations');assert.equal(r.answer,undefined);});
test('wrong citation timestamp is rejected',async()=>{const r=await mockModel(JSON.stringify({answer:'解释',citations:[{id:'e1',videoTime:400}]}),()=>explain(context,'解释',{BILICLASS_MODEL:'test'}));assert.equal(r.status,'invalid_model_citations');});
test('valid reference still does not prove semantic correctness',async()=>{const r=await mockModel(JSON.stringify({answer:'未经正确性验证的回答',citations:[{id:'e1',videoTime:4}],unknowns:[]}),()=>explain(context,'解释',{BILICLASS_MODEL:'test'}));assert.equal(r.status,'model_response_unverified');assert.equal(r.referenceCheck,'passed_semantics_not_verified');});
test('non-JSON model response is rejected',async()=>{const r=await mockModel('raw prose',()=>explain(context,'解释',{BILICLASS_MODEL:'test'}));assert.equal(r.status,'invalid_model_response');});
