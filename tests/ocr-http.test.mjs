import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms)),defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const frame=(id='f',epoch=0,t=10)=>({id,kind:'frame',epoch,videoTime:t,captureTime:1,data:'data:image/jpeg;base64,AQID',scope:'visible_video_region',
 crop:{x:0,y:0,width:960,height:540,sourceWidth:960,sourceHeight:540},width:960,height:540,change:{method:'luma32x18',score:1,reason:'first'}});
const clock=(id,epoch=0,paused=false,rate=1)=>({id,kind:'playback',epoch,videoTime:10,captureTime:1,rate,paused});
async function fixture(fn,options={}){
 const dir=mkdtempSync(path.join(tmpdir(),'bili-ocr-http-')),app=createApp({dataDir:dir,token:'synthetic',...options});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.address().port;
 const req=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer synthetic',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
 const s=(await req('/sessions',{url:'https://www.bilibili.com/video/BV1synthetic',title:'SYNTHETIC_NO_COURSE'})).data;
 const p='/sessions/'+s.id,feed=events=>req(p+'/events',{events}),context=async()=> (await req(p+'/context?at=11')).data;
 const until=async predicate=>{for(let i=0;i<150;i++){const c=await context();if(predicate(c))return c;await delay(5);}throw Error('OCR condition timeout');};
 try{await fn({dir,id:s.id,p,req,feed,context,until});}finally{await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}
}
test('HTTP OCR defaults disabled and skips legacy whole-tab frames when configured',async()=>{
 await fixture(async({feed,context})=>{await feed([frame()]);assert.equal((await context()).ocrRuntime.status,'disabled_no_backend');});
 let calls=0;await fixture(async({feed,context})=>{const {scope,crop,width,height,change,...legacy}=frame();await feed([legacy]);assert.equal(calls,0);assert.equal((await context()).ocrRuntime.metrics.skippedScope,1);},{ocrBackend:async()=>{calls++;return{text:'not called'};}});
});
test('HTTP OCR journals original frame provenance and keeps uncertain text outside teacher evidence',async()=>{
 await fixture(async({dir,id,feed,until})=>{
  await feed([clock('clock'),frame()]);const c=await until(c=>c.ocrEvidence.length===1);
  assert.equal(c.evidence.length,0);assert.equal(c.ocrEvidence[0].quality,'unverified');assert.equal(c.ocrEvidence[0].confidence,null);assert.deepEqual(c.ocrEvidence[0].sourceEventIds,['f']);assert.equal(c.ocrEvidence[0].videoTime,10);
  const log=readFileSync(path.join(dir,'sessions',id,'events.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)),ocr=log.find(e=>e.kind==='ocr');
  assert.equal(ocr.rawText,'synthetic raw');assert.equal(ocr.epoch,0);assert.equal(ocr.text,'synthetic OCR');
 },{ocrBackend:async()=>({text:'synthetic OCR',rawText:'synthetic raw',epoch:99,sourceEventIds:['forged'],quality:'verified',confidence:1})});
});
test('HTTP OCR holds one invocation and only newest pending frame',async()=>{
 const held=defer(),seen=[];
 await fixture(async({feed,until})=>{
  await feed([frame('a')]);await until(c=>c.ocrRuntime.active);await feed([frame('b')]);await feed([frame('c')]);
  assert.deepEqual(seen,['a']);held.resolve({text:'first'});const c=await until(c=>c.ocrEvidence.length===2);
  assert.deepEqual(seen,['a','c']);assert.equal(c.ocrRuntime.metrics.replaced,1);
 },{ocrBackend:async f=>{seen.push(f.id);return f.id==='a'?held.promise:{text:'newest'};}});
});
test('HTTP OCR pause rate seek visual-gap stop and new-session suppress late results',async()=>{
 for(const action of ['pause','rate','seek','gap','stop','new-session']){
  const held=defer();let signal;
  await fixture(async({feed,req,p,until,context})=>{
   await feed([clock('clock'),frame()]);await until(c=>c.ocrRuntime.active);assert(signal);
   if(action==='pause')await feed([clock('pause',0,true)]);
   if(action==='rate')await feed([clock('rate',0,false,2)]);
   if(action==='seek')await feed([clock('seek',1)]);
   if(action==='gap')await feed([{id:'gap',kind:'gap',epoch:0,videoTime:10,captureTime:1,media:'frame',text:'synthetic missing visual'}]);
   if(action==='stop'||action==='new-session')await req(p+'/stop',{});
   if(action==='new-session'){const s=(await req('/sessions',{url:'https://www.bilibili.com/video/BV2synthetic'})).data;await req('/sessions/'+s.id+'/events',{events:[clock('new-clock')]});}
   assert.equal(signal.aborted,true,action);held.resolve({text:'obsolete'});await delay(10);assert.equal((await context()).ocrEvidence.length,0,action);
  },{ocrBackend:async(_f,o)=>{signal=o.signal;return held.promise;}});
 }
});
test('HTTP duplicate rejected-batch and quota failures never schedule extra OCR',async()=>{
 let calls=0;
 await fixture(async({feed,until})=>{
  await feed([frame()]);await until(c=>c.ocrEvidence.length===1);await feed([frame()]);assert.equal(calls,1);
  assert.equal((await feed([frame('bad-batch'),{id:'bad',kind:'unknown'}])).status,400);assert.equal(calls,1);
 },{ocrBackend:async()=>{calls++;return{text:'once'};}});
 calls=0;await fixture(async({feed})=>{assert.equal((await feed([frame()])).status,413);assert.equal(calls,0);},{maxBytes:1,ocrBackend:async()=>{calls++;return{text:'never'};}});
});
test('HTTP OCR timeout opens sticky circuit without concurrent retry of uncooperative backend',async()=>{
 const held=defer();let calls=0;
 await fixture(async({feed,until,context})=>{
  await feed([frame()]);await until(c=>c.ocrRuntime.status==='blocked_backend_timeout');await feed([frame('later')]);assert.equal(calls,1);
  held.resolve({text:'late'});await delay(10);const c=await context();assert.equal(c.ocrEvidence.length,0);assert.equal(c.ocrRuntime.status,'blocked_backend_timeout');
 },{ocrTimeoutMs:20,ocrBackend:async()=>{calls++;return held.promise;}});
});
test('legacy OCR cannot silently become verified teacher evidence and invalid word metadata is atomic',async()=>{
 await fixture(async({feed,context})=>{
  await feed([frame()]);assert.equal((await feed([{id:'legacy',kind:'ocr',epoch:0,videoTime:10,captureTime:2,text:'legacy',sourceEventIds:['f'],quality:'verified'}])).status,200);
  const c=await context();assert.equal(c.ocrEvidence[0].quality,'unverified');assert.equal(c.evidence.length,0);
  assert.equal((await feed([{id:'invalid-ocr',kind:'ocr',epoch:0,videoTime:10,captureTime:2,text:'bad',sourceEventIds:['f'],width:960,height:540,words:[{text:'out',x:950,y:1,width:40,height:20}]}])).status,400);
 });
});
test('empty recognition is visible in metrics without inventing text',async()=>{
 await fixture(async({feed,until})=>{await feed([frame()]);const c=await until(c=>c.ocrRuntime.metrics.empty===1);assert.equal(c.ocrEvidence.length,0);assert.equal(c.availability.ocr,0);},{ocrBackend:async()=>({text:''})});
});
