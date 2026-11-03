import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms)),defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const audio=(id,t,epoch=0)=>{const pcm=Buffer.alloc(32000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(4000,i);return{id,kind:'audio',epoch,videoTime:t,captureTime:1,sampleRate:16000,channels:1,duration:1,playbackRate:1,data:pcm.toString('base64')};};
async function fixture(fn,options={}){
 const dir=mkdtempSync(path.join(tmpdir(),'biliclass-asr-http-')),token='c'.repeat(64),app=createApp({dataDir:dir,token,...options});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 const req=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
 const {data:{id}}=await req('/sessions',{url:'https://www.bilibili.com/video/BV1Synthetic',title:'SYNTHETIC_NO_COURSE'});
 const ctx=async()=> (await req('/sessions/'+id+'/context')).data;
 const feed=(epoch=0,start=0,prefix='a')=>req('/sessions/'+id+'/events',{events:Array.from({length:4},(_,i)=>audio(prefix+i,start+i,epoch))});
 async function until(predicate){for(let i=0;i<100;i++){const c=await ctx();if(predicate(c))return c;await delay(5);}throw new Error('condition not reached');}
 try{await fn({dir,id,req,ctx,feed,until});}finally{await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}
}
test('default HTTP service never launches ASR and reports disabled',async()=>{
 await fixture(async({feed,ctx})=>{await feed();const c=await ctx();assert.equal(c.asrRuntime.status,'disabled_no_backend');assert.equal(c.availability.asrProvisional,0);});
});
test('actual HTTP audio ingestion journals provisional result with original audio IDs',async()=>{
 await fixture(async({feed,until,dir,id})=>{
  assert.equal((await feed()).status,200);const c=await until(c=>c.availability.asrProvisional===1);
  assert.equal(c.evidence.length,0);assert.equal(c.availability.asr,0);
  const log=readFileSync(path.join(dir,'sessions',id,'events.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const asr=log.find(e=>e.kind==='asr');assert.equal(asr.text,'synthetic backend response');assert.deepEqual(asr.sourceEventIds,['a0','a1','a2','a3']);assert.equal(asr.stability,'provisional');
 },{asrBackend:async()=> 'synthetic backend response'});
});
test('stop aborts outstanding backend and suppresses its late write',async()=>{
 const held=defer();let signal;
 await fixture(async({feed,req,id,ctx})=>{
  await feed();assert(signal);await req('/sessions/'+id+'/stop',{});assert(signal.aborted);held.resolve('late after stop');await delay(10);
  const c=await ctx();assert.equal(c.closed,true);assert.equal(c.availability.asrProvisional,0);
 },{asrBackend:async(_w,o)=>{signal=o.signal;return held.promise;}});
});
test('seek invalidates old task before four new seconds accumulate',async()=>{
 const held=defer(),seen=[];let signal;
 await fixture(async({feed,req,id,until})=>{
  await feed();
  await req('/sessions/'+id+'/events',{events:[{id:'seek',kind:'playback',epoch:1,videoTime:100,captureTime:2,rate:1,paused:false,reason:'seeking'}]});
  assert(signal.aborted);await feed(1,100,'new');held.resolve('obsolete');
  const c=await until(c=>c.availability.asrProvisional===1);assert.equal(c.epoch,1);assert.deepEqual(seen,[0,1]);assert.equal(c.asrRuntime.queue.discarded,1);
 },{asrBackend:async(w,o)=>{seen.push(w.epoch);if(w.epoch===0){signal=o.signal;return held.promise;}return 'new epoch';}});
});
test('pause cancels and prevents new audio windows while paused',async()=>{
 const held=defer();let calls=0,signal;
 await fixture(async({feed,req,id,ctx})=>{
  await feed();await req('/sessions/'+id+'/events',{events:[{id:'pause',kind:'playback',epoch:0,videoTime:4,captureTime:2,rate:1,paused:true,reason:'pause'}]});
  assert(signal.aborted);await feed(0,4,'paused');held.resolve('old');await delay(10);assert.equal(calls,1);assert.equal((await ctx()).availability.asrProvisional,0);
 },{asrBackend:async(_w,o)=>{calls++;signal=o.signal;return held.promise;}});
});
test('gap cancels outstanding inference immediately',async()=>{
 const held=defer();let signal;
 await fixture(async({feed,req,id,ctx})=>{
  await feed();await req('/sessions/'+id+'/events',{events:[{id:'gap',kind:'gap',epoch:0,videoTime:4,captureTime:2,text:'synthetic delivery gap'}]});
  assert(signal.aborted);held.resolve('obsolete');await delay(10);assert.equal((await ctx()).availability.asrProvisional,0);
 },{asrBackend:async(_w,o)=>{signal=o.signal;return held.promise;}});
});
test('retry duplicate source batch does not launch transcription twice',async()=>{
 let calls=0;
 await fixture(async({feed,until})=>{
  await feed();await until(c=>c.availability.asrProvisional===1);await feed();await delay(10);assert.equal(calls,1);
 },{asrBackend:async()=>{calls++;return 'one result';}});
});
test('uncooperative timed-out backend opens circuit without concurrent retries',async()=>{
 const held=defer();let calls=0;
 await fixture(async({feed,until,ctx})=>{
  await feed();const c=await until(c=>c.asrRuntime.status==='blocked_backend_timeout');
  assert.equal(c.asrRuntime.active,true);assert.equal(c.asrRuntime.queue.timeouts,1);
  await feed(0,4,'later');assert.equal(calls,1);held.resolve('late after timeout');await delay(10);
  const final=await ctx();assert.equal(final.availability.asrProvisional,0);assert.equal(final.asrRuntime.status,'blocked_backend_timeout');
 },{asrTimeoutMs:20,asrBackend:async()=>{calls++;return held.promise;}});
});
test('frame-only capture gap preserves outstanding audio recognition',async()=>{
 const held=defer();let signal;
 await fixture(async({feed,req,id,until})=>{
  await feed();await req('/sessions/'+id+'/events',{events:[{id:'visual-gap',kind:'gap',epoch:0,videoTime:4,captureTime:2,media:'frame',text:'synthetic missing frame'}]});
  assert.equal(signal.aborted,false);held.resolve('audio survives missing frame');
  await until(c=>c.availability.asrProvisional===1);const c=(await req('/sessions/'+id+'/context?at=4')).data;assert.equal(c.gaps[0].media,'frame');
 },{asrBackend:async(_w,o)=>{signal=o.signal;return held.promise;}});
});
test('new epoch frame-only gap still immediately cancels prior audio task',async()=>{
 const held=defer();let signal;
 await fixture(async({feed,req,id,ctx})=>{
  await feed();await req('/sessions/'+id+'/events',{events:[{id:'new-epoch-frame-gap',kind:'gap',epoch:1,videoTime:100,captureTime:2,media:'frame',text:'synthetic next epoch'}]});
  assert.equal(signal.aborted,true);held.resolve('obsolete audio');await delay(10);
  assert.equal((await ctx()).availability.asrProvisional,0);
 },{asrBackend:async(_w,o)=>{signal=o.signal;return held.promise;}});
});

test('late previous-rate audio cannot cancel current-rate task or rewind playback',async()=>{
 const held=defer();let calls=0,signal;
 await fixture(async({req,id,ctx,until})=>{
  await req('/sessions/'+id+'/events',{events:[{id:'clock2',kind:'playback',epoch:0,videoTime:100,captureTime:2,rate:2,paused:false}]});
  await req('/sessions/'+id+'/events',{events:[0,1,2,3].map(i=>audio('old'+i,i))});assert.equal(calls,0);
  await req('/sessions/'+id+'/events',{events:[0,1,2,3].map(i=>({...audio('fresh'+i,100+i*2),playbackRate:2}))});
  await req('/sessions/'+id+'/events',{events:[0,1,2,3].map(i=>audio('late'+i,i))});
  assert.equal(calls,1);assert.equal(signal.aborted,false);held.resolve('new rate survives');
  const c=await until(c=>c.provisionalEvidence.length===1);assert.equal(c.asrRuntime.delivery.staleAudio,8);assert.deepEqual(c.provisionalEvidence[0].sourceEventIds,['fresh0','fresh1','fresh2','fresh3']);assert.equal(c.evidence.length,0);
 },{asrBackend:async(_w,o)=>{calls++;signal=o.signal;return held.promise;}});
});

test('HTTP exposes sticky backend error circuit after three failures without new attempts',async()=>{
 let calls=0;
 await fixture(async({feed,req,id,until})=>{
  await feed();await until(c=>c.asrRuntime.queue.errors===1);
  for(let step=1;step<=2;step++){await req('/sessions/'+id+'/events',{events:[0,1].map(i=>audio('e'+step+'_'+i,2+step*2+i))});await until(c=>c.asrRuntime.queue.errors===step+1);}
  const c=await until(c=>c.asrRuntime.status==='blocked_backend_errors');assert.equal(c.asrRuntime.failures.consecutive,3);assert.equal(c.asrRuntime.pending,false);
  await feed(0,8,'later');await delay(10);assert.equal(calls,3);assert.equal(c.evidence.length,0);
 },{asrBackend:async()=>{calls++;throw Error('synthetic backend failure');}});
});
