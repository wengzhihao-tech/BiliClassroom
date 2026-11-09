import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function worker(){
  let listener,active,stored={pairToken:'a'.repeat(64)},calls=[];
  const chrome={runtime:{id:'test-extension',onMessage:{addListener:f=>listener=f},getContexts:async()=>[],sendMessage:async m=>{calls.push(m);return{ok:true};}},
    tabs:{get:async()=>({id:7,url:'https://www.bilibili.com/video/BV1x',title:'Synthetic'}),sendMessage:async(_tab,m)=>{calls.push(m);return {ok:true};},onRemoved:{addListener(){}}},
    storage:{session:{get:async k=>k==='active'?{active}:stored,set:async x=>{if('active'in x)active=x.active;Object.assign(stored,x);},remove:async()=>{active=undefined;}},local:{get:async()=>stored}},
    tabCapture:{getMediaStreamId:async()=> 'mock-stream'},offscreen:{createDocument:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
  const fetch=async(url,opt={})=>{calls.push({url,method:opt.method,body:opt.body?JSON.parse(opt.body):undefined});return{ok:true,status:200,json:async()=>url.endsWith('/sessions')?{id:'synthetic-session'}:{ok:true}};};
  vm.runInNewContext(readFileSync(new URL('../extension/worker.js',import.meta.url),'utf8'),{chrome,fetch,URL,AbortSignal,Error,setTimeout,clearTimeout});
  const msg=(m,sender={id:'test-extension'})=>new Promise(resolve=>{const result=listener(m,sender,resolve);if(result!==true)resolve(undefined);});
  return{msg,calls,get active(){return active;}};
}
test('user start selects requested tab and stop tears down capture',async()=>{
  const w=worker();assert.equal((await w.msg({type:'START',tabId:7,audio:true,frames:true})).ok,true);assert(w.active);assert(w.calls.some(x=>x.type==='CAPTURE_START'));
  assert.equal((await w.msg({type:'STOP'})).ok,true);assert.equal(w.active,undefined);assert(w.calls.some(x=>x.type==='CAPTURE_STOP'));
});
test('wrong content tab cannot ingest',async()=>{const w=worker();await w.msg({type:'START',tabId:7});const r=await w.msg({type:'EVENTS',events:[]},{id:'test-extension',tab:{id:8}});assert.match(r.error,/inactive tab/);});
test('SPA source change stops rather than mixing courses',async()=>{const w=worker();await w.msg({type:'START',tabId:7,audio:true});await w.msg({type:'SOURCE_CHANGED',sessionId:'synthetic-session'},{id:'test-extension',tab:{id:7}});assert.equal(w.active,undefined);});
test('second start rejected without creating a second session',async()=>{const w=worker();await w.msg({type:'START',tabId:7});assert((await w.msg({type:'START',tabId:7})).error);assert.equal(w.calls.filter(x=>x.url?.endsWith('/sessions')).length,1);});
test('offscreen cannot initiate start via content channel',async()=>{const w=worker();assert.equal(await w.msg({target:'offscreen',type:'CAPTURE_START'}),undefined);assert.equal(w.calls.length,0);});
test('worker sends explicit OCR language into session and keeps it in session storage',async()=>{
 const w=worker();await w.msg({type:'START',tabId:7,ocrLanguage:'en-US'});
 assert.equal(w.calls.find(x=>x.url?.endsWith('/sessions')).body.ocrLanguage,'en-US');assert.equal(w.active.ocrLanguage,'en-US');
});
test('invalid OCR language cannot launch capture or create server session',async()=>{
 const w=worker();assert((await w.msg({type:'START',tabId:7,ocrLanguage:'invalid'})).error);assert.equal(w.calls.length,0);assert.equal(w.active,undefined);
});

test('worker binds content start and accepts current session messages only',async()=>{
 const w=worker(),sender={id:'test-extension',tab:{id:7}};
 await w.msg({type:'START',tabId:7});
 const sessionId=w.active.id;
 assert.equal(w.calls.find(call=>call.type==='COLLECT_START')?.sessionId,sessionId);
 const events=await w.msg({type:'EVENTS',sessionId,events:[]},sender);
 assert.equal(events.ok,true);
 await w.msg({type:'TIMELINE',sessionId,data:{epoch:0}},sender);
 assert.equal(w.calls.find(call=>call.type==='TIMELINE')?.sessionId,sessionId);
});
test('old same-tab batches, clock messages, and source changes cannot affect current capture',async()=>{
 const w=worker(),sender={id:'test-extension',tab:{id:7}};
 await w.msg({type:'START',tabId:7});
 const baseline=w.calls.length;
 for(const type of ['EVENTS','TIMELINE','SOURCE_CHANGED']){
  const reply=await w.msg({type,sessionId:'old-session',events:[],data:{epoch:9}},sender);
  assert.equal(reply.ok,false);
 }
 const unbound=await w.msg({type:'EVENTS',events:[]},sender);
 assert.equal(unbound.ok,false);
 assert.equal(w.calls.length,baseline);
 assert.equal(w.active.id,'synthetic-session');
});
