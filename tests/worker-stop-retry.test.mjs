import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.mjs';
function worker(store,{fail=true,fetchImpl}={}){
 let listener;const calls=[];
 const chrome={runtime:{id:'ext',onMessage:{addListener:f=>listener=f},sendMessage:async m=>{calls.push(m);return {drained:true,remaining:0};}},
 tabs:{sendMessage:async(_id,m)=>{calls.push(m);return {drained:true,remaining:0};},get:async()=>({id:7,url:'https://www.bilibili.com/video/BV1x'}),onRemoved:{addListener(){}}},
 storage:{session:{get:async key=>({[key]:store[key]}),set:async value=>Object.assign(store,value),remove:async key=>{delete store[key];}},local:{get:async()=>({pairToken:'a'.repeat(64)})}},
 action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
 const fetch=async (url,options)=>{calls.push({url});return fetchImpl?fetchImpl(url,options):{ok:!fail,status:fail?500:200,json:async()=>({ok:true})};};
 vm.runInNewContext(readFileSync(new URL('../extension/worker.js',import.meta.url),'utf8'),{chrome,fetch,URL,AbortSignal,Error,setTimeout,clearTimeout});
 return {calls,msg:m=>new Promise(resolve=>listener(m,{id:'ext'},resolve))};
}
const active=()=>({id:'synthetic-session',tabId:7,token:'a'.repeat(64),audio:true,frames:true});
test('failed backend stop survives worker recreation and retries without restarting producers',async()=>{
 const store={active:active()},first=worker(store);
 const r=await first.msg({type:'STOP'});assert.equal(r.lastStop.backendClosed,false);
 assert.equal(store.active,undefined);assert.equal(store.pendingStop?.id,'synthetic-session');
 const resumed=worker(store,{fail:false}),status=await resumed.msg({type:'STATUS'});
 assert.equal(status.active,false);assert.equal(status.pendingStop,true);assert(!JSON.stringify(status).includes('a'.repeat(64)));
 const stopped=await resumed.msg({type:'STOP'});assert.equal(stopped.lastStop.backendClosed,true);
 assert.equal(store.pendingStop,undefined);assert.equal(resumed.calls.filter(c=>c.url?.endsWith('/synthetic-session/stop')).length,1);
 assert(!resumed.calls.some(c=>c.type==='CAPTURE_STOP'||c.type==='COLLECT_STOP'));
 assert.equal(stopped.lastStop.content.drained,true);
});
test('pending backend stop blocks another explicit start before creating a session',async()=>{
 const store={active:active()},first=worker(store);await first.msg({type:'STOP'});
 const resumed=worker(store,{fail:false}),r=await resumed.msg({type:'START',tabId:7});
 assert(r.error);assert.equal(resumed.calls.length,0);
});
test('successful stop does not retain a pending backend closure',async()=>{
 const store={active:active()},w=worker(store,{fail:false});const r=await w.msg({type:'STOP'});
 assert.equal(r.lastStop.backendClosed,true);assert.equal(store.pendingStop,undefined);assert.equal(store.active,undefined);
});

test('explicit stop clears a missing backend session confirmed by real loopback HTTP',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bili-stop-missing-'));
 const app=createApp({dataDir:dir,token:'a'.repeat(64)});
 try{
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+app.address().port,store={pendingStop:active()};
  const w=worker(store,{fetchImpl:(url,options)=>fetch(base+new URL(url).pathname,options)});
  const stopped=await w.msg({type:'STOP'});
  assert.equal(stopped.lastStop.backendClosed,false);
  assert.equal(stopped.lastStop.backendStatus,'missing');
  assert.equal(store.pendingStop,undefined);
  const status=await worker(store).msg({type:'STATUS'});
  assert.equal(status.pendingStop,false);
  assert.equal(status.lastStop.backendStatus,'missing');
  assert(!JSON.stringify(status).includes('a'.repeat(64)));
 }finally{
  if(app.listening)await new Promise(resolve=>app.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});
test('only exact missing-session response can release a pending stop',async()=>{
 for(const [status,detail] of [[401,'unknown session'],[500,'unknown session'],[404,'unknown route'],[404,null]]){
  const store={pendingStop:active()};
  const w=worker(store,{fetchImpl:async()=>({ok:false,status,json:async()=>{
   if(detail===null)throw Error('non-JSON');
   return {error:detail};
  }})});
  const stopped=await w.msg({type:'STOP'});
  assert.equal(stopped.lastStop.backendClosed,false);
  assert.notEqual(stopped.lastStop.backendStatus,'missing');
  assert.equal(store.pendingStop.id,'synthetic-session');
 }
});
test('automatic capture end leaves missing session for explicit acknowledgement',async()=>{
 const store={active:active()};
 const w=worker(store,{fetchImpl:async()=>({ok:false,status:404,json:async()=>({error:'unknown session'})})});
 await w.msg({type:'CAPTURE_ENDED'});
 assert.equal(store.pendingStop.id,'synthetic-session');
 assert.equal(store.active,undefined);
 assert.equal((await w.msg({type:'STOP'})).lastStop.backendStatus,'missing');
 assert.equal(store.pendingStop,undefined);
});
