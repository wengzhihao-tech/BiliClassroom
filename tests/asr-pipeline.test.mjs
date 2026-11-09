import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioWindows,TranscriptionQueue} from '../server/asr-pipeline.mjs';
import {newSession,prepareEvents,commitEvents,contextFor,validateEvent} from '../server/core.mjs';
const audio=(id,t,{epoch=0,rate=1,silent=false}={})=>{const data=Buffer.alloc(32000);if(!silent)for(let i=0;i<data.length;i+=2)data.writeInt16LE(i%160<80?4000:-4000,i);return{id,kind:'audio',epoch,videoTime:t,captureTime:1,sampleRate:16000,channels:1,duration:1,playbackRate:rate,data:data.toString('base64')};};
function feed(p,n=6,opts={}){const windows=[];for(let i=0;i<n;i++)windows.push(...p.push('s',audio('a'+i,i*(opts.rate||1),opts)).windows);return windows;}
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
test('4-second audio windows overlap by 2 seconds with exact evidence spans',()=>{
 const p=new AudioWindows(),w=feed(p);assert.equal(w.length,2);assert.deepEqual(w.map(x=>x.videoTime),[0,2]);assert.equal(w[0].audioS16.length,128000);assert.deepEqual(w[1].sourceEventIds,['a2','a3','a4','a5']);assert.equal(p.samples,32000);
});
test('2x playback maps four audio seconds to eight video seconds',()=>{
 const w=feed(new AudioWindows(),4,{rate:2})[0];assert.equal(w.videoTime,0);assert.equal(w.videoEnd,8);assert.equal(w.playbackRate,2);
});
test('silence energy gate emits no speech claims or transcription windows',()=>{
 const p=new AudioWindows();assert.equal(feed(p,6,{silent:true}).length,0);assert.equal(p.metrics.silenceWindows,2);
});
test('gap invalidates partial audio and emits a new segment identity',()=>{
 const p=new AudioWindows();feed(p,3);assert.equal(p.push('s',audio('gap',20)).reason,'audio_time_gap');
 let w;for(let i=1;i<=3;i++)w=p.push('s',audio('b'+i,20+i)).windows;
 assert.equal(w[0].videoTime,20);assert(w[0].segment>0);assert(!w[0].sourceEventIds.includes('a2'));
});
test('seek rejects old epoch and rate change cannot mix buffered chunks',()=>{
 const p=new AudioWindows();feed(p,3);assert.equal(p.push('s',audio('new',0,{epoch:1})).reason,'source_epoch_or_rate_change');
 assert.equal(p.push('s',audio('oldlate',3)).reason,'stale_epoch');
 assert.equal(p.push('s',audio('rate',2,{epoch:1,rate:2})).reason,'source_epoch_or_rate_change');assert.equal(p.samples,16000);
});
test('duplicate audio does not advance window or consume memory twice',()=>{
 const p=new AudioWindows(),e=audio('a',0);p.push('s',e);assert.equal(p.push('s',e).reason,'duplicate');assert.equal(p.samples,16000);
});
test('malformed audio format and unknown playback rate rejected',()=>{
 const p=new AudioWindows();assert.throws(()=>p.push('s',{...audio('a',0),sampleRate:48000}));assert.throws(()=>validateEvent({...audio('b',0),playbackRate:0}));
});
test('scheduler runs one backend and replaces backlog with newest pending window',async()=>{
 const w=feed(new AudioWindows())[0],held=defer(),calls=[],out=[];
 const q=new TranscriptionQueue(async x=>{calls.push(x.tag);if(x.tag===1)return held.promise;return 'synthetic';},x=>out.push(x));
 q.submit({...w,tag:1});q.submit({...w,tag:2});q.submit({...w,tag:3});assert.deepEqual(calls,[1]);held.resolve('synthetic');await q.idle();assert.deepEqual(calls,[1,3]);assert.equal(q.metrics.replaced,1);assert(out.every(e=>e.stability==='provisional'));
});
test('late backend response after seek is discarded even if backend ignores abort',async()=>{
 const w=feed(new AudioWindows())[0],held=defer(),out=[];let signal;
 const q=new TranscriptionQueue(async(x,o)=>{if(x.epoch===0){signal=o.signal;return held.promise;}return 'new';},e=>out.push(e));
 q.submit(w);q.submit({...w,epoch:1});assert(signal.aborted);held.resolve('obsolete');await q.idle();assert.deepEqual(out.map(e=>e.text),['new']);assert.equal(q.metrics.discarded,1);
});
test('same-epoch gap segment cancels outstanding old audio',async()=>{
 const w=feed(new AudioWindows())[0],held=defer(),out=[];
 const q=new TranscriptionQueue(x=>x.segment===0?held.promise:Promise.resolve('new segment'),e=>out.push(e));
 q.submit(w);q.submit({...w,segment:1});held.resolve('old segment');await q.idle();assert.deepEqual(out.map(e=>e.text),['new segment']);
});
test('closing scheduler prevents all late commits and further submissions',async()=>{
 const w=feed(new AudioWindows())[0],held=defer(),out=[];
 const q=new TranscriptionQueue(()=>held.promise,e=>out.push(e));q.submit(w);q.close();held.resolve('late');await q.idle();assert.equal(out.length,0);assert.throws(()=>q.submit(w));
});
test('provisional ASR is counted separately and excluded from teacher evidence',()=>{
 const s=newSession({url:'https://www.bilibili.com/video/BV1Synthetic'});
 commitEvents(s,prepareEvents(s,[audio('audio1',0)]),0);
 commitEvents(s,prepareEvents(s,[{id:'asr1',kind:'asr',epoch:0,videoTime:0,captureTime:1,text:'tentative',sourceEventIds:['audio1']}]),0);
 let c=contextFor(s);assert.equal(c.availability.asrProvisional,1);assert.equal(c.evidence.length,0);
 commitEvents(s,prepareEvents(s,[{id:'asr2',kind:'asr',epoch:0,videoTime:0,captureTime:1,text:'externally committed',sourceEventIds:['audio1'],stability:'stable'}]),0);
 c=contextFor(s);assert.equal(c.availability.asr,1);assert.deepEqual(c.evidence.map(e=>e.id),['asr2']);
});

test('three consecutive processing errors open sticky circuit and discard pending work',async()=>{
 const w=feed(new AudioWindows())[0];let calls=0;const q=new TranscriptionQueue(async()=>{calls++;throw Error('synthetic engine failure');},()=>{});
 for(let i=0;i<3;i++){q.submit(w);if(i===2)q.submit(w);await q.idle();}
 assert.equal(calls,3);assert.equal(q.faulted,true);assert.equal(q.faultReason,'errors');assert.equal(q.pending,null);assert.equal(q.metrics.errors,3);
 q.invalidate();assert.equal(q.consecutiveFailures,3);assert.throws(()=>q.submit(w));
});
test('valid empty recognition and successful delivery reset consecutive errors',async()=>{
 const w=feed(new AudioWindows())[0];let calls=0,out=[];const q=new TranscriptionQueue(async()=>{calls++;if([1,3,5].includes(calls))throw Error('synthetic');return calls===2?'   ':'text';},e=>out.push(e));
 for(let i=0;i<5;i++){q.submit(w);await q.idle();}
 assert.equal(q.faulted,false);assert.equal(q.consecutiveFailures,1);assert.equal(q.metrics.errors,3);assert.equal(q.metrics.empty,1);assert.equal(out.length,1);
});
test('explicit cancellation is excluded from consecutive engine error circuit',async()=>{
 const w=feed(new AudioWindows())[0];let reject;const q=new TranscriptionQueue(()=>new Promise((_r,j)=>reject=j),()=>{});
 q.submit(w);q.invalidate();reject(Error('cancelled process'));await q.idle();assert.equal(q.metrics.errors,0);assert.equal(q.consecutiveFailures,0);assert.equal(q.faulted,false);
});

test('DC-biased silence and one isolated full-scale click are filtered',()=>{
 for(const click of [false,true]){
  const p=new AudioWindows(),windows=[];
  for(let i=0;i<4;i++){
   const pcm=Buffer.alloc(32000);
   for(let j=0;j<pcm.length;j+=2)pcm.writeInt16LE(5000,j);
   if(click&&i===1)pcm.writeInt16LE(32767,240);
   windows.push(...p.push('s',{...audio('dc'+i,i),data:pcm.toString('base64')}).windows);
  }
  assert.equal(windows.length,0);
  assert.equal(p.metrics.silenceWindows,1);
 }
});
test('short sustained audio survives quiet remainder without modifying original PCM',()=>{
 const p=new AudioWindows(),windows=[],original=[];
 for(let i=0;i<4;i++){
  const pcm=Buffer.alloc(32000);
  if(i===2)for(let j=0;j<1920;j+=2)pcm.writeInt16LE(j%160<80?800:-800,j);
  original.push(pcm);
  windows.push(...p.push('s',{...audio('short'+i,i),data:pcm.toString('base64')}).windows);
 }
 assert.equal(windows.length,1);
 assert.deepEqual(windows[0].audioS16,Buffer.concat(original));
 assert.deepEqual(windows[0].sourceEventIds,['short0','short1','short2','short3']);
});
