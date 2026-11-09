import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {normalizeAsrResult} from '../server/asr-words.mjs';import {newSession,prepareEvents,commitEvents} from '../server/core.mjs';import {createApp} from '../server/index.mjs';
const window=(rate=1)=>({sampleRate:16000,audioDuration:4,playbackRate:rate,videoTime:50,spans:[0,1,2,3].map(i=>({id:'a'+i,startSample:0,endSample:16000}))});
const result=()=>({text:'synthetic word',engine:'vosk',recognitionMs:1,words:[{word:'synthetic',start:0.8,end:1.2,conf:0.75}]});
const audio=(i,rate=1)=>({id:'a'+i,kind:'audio',epoch:0,videoTime:50+i*rate,captureTime:1,data:Buffer.from(Int16Array.from({length:16000},(_,i)=>i%80<40?4000:-4000).buffer).toString('base64'),duration:1,sampleRate:16000,channels:1,playbackRate:rate});
const source={url:'https://www.bilibili.com/video/BV1synthetic'};
test('word crossing chunk boundary retains exact original audio sample references',()=>{
 const r=normalizeAsrResult(result(),window());assert.deepEqual(r.words[0].sourceSpans,[{id:'a0',startSample:12800,endSample:16000},{id:'a1',startSample:0,endSample:3200}]);
 assert.equal(r.words[0].videoStart,50.8);assert.equal(r.words[0].videoEnd,51.2);assert.equal(r.words[0].confidence,0.75);assert.deepEqual(normalizeAsrResult('legacy',{}),{text:'legacy'});
});
test('2x projection changes video times without changing audio sample ranges',()=>{
 const a=normalizeAsrResult(result(),window()),b=normalizeAsrResult(result(),window(2));
 assert.equal(b.words[0].videoStart,51.6);assert.equal(b.words[0].videoEnd,52.4);assert.equal(b.windowEnd,58);assert.deepEqual(a.words[0].sourceSpans,b.words[0].sourceSpans);
});
test('malformed engine words and forged source sample metadata are rejected',()=>{
 for(const word of [{word:'x',start:-1,end:1,conf:0.5},{word:'x',start:0,end:5,conf:0.5},{word:'x',start:0,end:1,conf:NaN}])assert.throws(()=>normalizeAsrResult({text:'bad',words:[word]},window()));
 assert.throws(()=>normalizeAsrResult(result(),{...window(),spans:[]}));
 const s=newSession(source);commitEvents(s,prepareEvents(s,[0,1,2,3].map(i=>audio(i))),0);
 const raw={...normalizeAsrResult(result(),window()),id:'asr',kind:'asr',epoch:0,videoTime:50,captureTime:2,sourceEventIds:['a0','a1','a2','a3']};
 assert.equal(prepareEvents(s,[raw])[0].words[0].confidence,0.75);
 const forged=structuredClone(raw);forged.words[0].sourceSpans[0].endSample=64000;assert.throws(()=>prepareEvents(s,[forged]));
});
async function fixture(fn,backend){
 const dir=mkdtempSync(path.join(os.tmpdir(),'bili-word-http-')),app=createApp({dataDir:dir,token:'synthetic',asrBackend:backend});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.address().port,req=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer synthetic',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert(r.ok);return r.json();};
 const {id}=await req('/sessions',source),p='/sessions/'+id;
 try{await fn({dir,id,p,req,feed:()=>req(p+'/events',{events:[{id:'clock',kind:'playback',epoch:0,videoTime:57,captureTime:1,rate:2,paused:false},...[0,1,2,3].map(i=>audio(i,2))]})});}finally{await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}
}
test('structured backend words survive real HTTP journal with provisional quality',async()=>{
 await fixture(async({dir,id,p,req,feed})=>{
  await feed();let c;for(let i=0;i<100;i++){c=await req(p+'/context');if(c.provisionalEvidence.length)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(c.evidence.length,0);assert.equal(c.provisionalEvidence[0].words[0].videoStart,51.6);assert.equal(c.provisionalEvidence[0].stability,'provisional');
  const log=readFileSync(path.join(dir,'sessions',id,'events.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)),e=log.find(e=>e.kind==='asr');assert.equal(e.words[0].sourceSpans[1].id,'a1');assert.equal(e.windowEnd,58);
 },async()=>result());
});
test('late structured word output after seek cannot enter a new epoch',async()=>{
 let resolve,signal;const held=new Promise(r=>resolve=r);
 await fixture(async({p,req,feed})=>{
  await feed();await req(p+'/events',{events:[{id:'seek',kind:'playback',epoch:1,videoTime:0,captureTime:2,rate:1,paused:false}]});assert.equal(signal.aborted,true);
  resolve(result());await new Promise(r=>setTimeout(r,10));const c=await req(p+'/context');assert.equal(c.provisionalEvidence.length,0);assert.equal(c.epoch,1);
 },async(_w,opts)=>{signal=opts.signal;return held;});
});
test('per-chunk timestamp jitter reproduces legacy rejection and source envelope fixes it at 1x and 2x',()=>{
 for(const rate of [1,2]){
  const s=newSession(source),audioEvents=[0,1,2,3].map(i=>({...audio(i,rate),videoTime:50+i*rate+[0,0.12,-0.08,0.15][i]}));
  commitEvents(s,prepareEvents(s,audioEvents),0);
  const r={text:'cross-boundary',words:[{word:'cross',start:0.8,end:1.2,conf:1},{word:'late',start:3.2,end:3.6,conf:1}]};
  const legacy={...normalizeAsrResult(r,window(rate)),id:'legacy',kind:'asr',epoch:0,videoTime:50,captureTime:2,sourceEventIds:audioEvents.map(a=>a.id)};
  assert.throws(()=>prepareEvents(s,[legacy]),/source/);
  const mapped=normalizeAsrResult(r,{...window(rate),spans:window(rate).spans.map((p,i)=>({...p,videoTime:audioEvents[i].videoTime,playbackRate:rate}))});
  const raw={...legacy,...mapped,id:'mapped'};const e=prepareEvents(s,[raw])[0];
  assert.equal(e.timing,'audio_sample_sources_envelope_not_browser_verified');
  assert(Math.abs(e.words[0].videoStart-(50+0.8*rate))<0.001);
  assert(Math.abs(e.words[0].videoEnd-(51*1+rate-1+0.12+0.2*rate))<0.001);
  assert(Math.abs(e.words[1].videoStart-(50+3.2*rate+0.15))<0.001);
  const forged=structuredClone(raw);forged.words[1].videoStart+=0.02;assert.throws(()=>prepareEvents(s,[forged]),/source/);
 }
});
test('sample timing supports trimmed window offsets and rejects mixed or invalid source timing',()=>{
 const w={...window(),videoTime:50.5,spans:[{id:'a0',startSample:8000,endSample:16000,videoTime:50,playbackRate:1},{id:'a1',startSample:0,endSample:16000,videoTime:51.1,playbackRate:1},{id:'a2',startSample:0,endSample:16000,videoTime:52,playbackRate:1},{id:'a3',startSample:0,endSample:16000,videoTime:53,playbackRate:1},{id:'a4',startSample:0,endSample:8000,videoTime:54,playbackRate:1}]};
 const r=normalizeAsrResult({text:'x',words:[{word:'x',start:0.4,end:0.6,conf:1}]},w);
 assert(Math.abs(r.words[0].videoStart-50.9)<0.001);assert(Math.abs(r.words[0].videoEnd-51.2)<0.001);
 const mixed=structuredClone(w);delete mixed.spans[1].videoTime;assert.throws(()=>normalizeAsrResult(result(),mixed));
 const mismatch=structuredClone(w);mismatch.spans[0].playbackRate=2;assert.throws(()=>normalizeAsrResult(result(),mismatch));
});
test('real HTTP planner propagates jittered source times to persisted provisional words',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bili-jitter-http-')),app=createApp({dataDir:dir,token:'synthetic',asrBackend:async()=>result()});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.address().port,req=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer synthetic',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert(r.ok);return r.json();};
 try{
  const {id}=await req('/sessions',source),p='/sessions/'+id;
  await req(p+'/events',{events:[0,1,2,3].map(i=>({...audio(i),videoTime:50+i+[0,0.12,-0.08,0.15][i]}))});
  let c;for(let i=0;i<100;i++){c=await req(p+'/context');if(c.provisionalEvidence.length)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(c.provisionalEvidence.length,1);assert.equal(c.evidence.length,0);assert(Math.abs(c.provisionalEvidence[0].words[0].videoEnd-51.32)<0.001);
  const log=readFileSync(path.join(dir,'sessions',id,'events.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(log.find(e=>e.kind==='asr').timing,'audio_sample_sources_envelope_not_browser_verified');
 }finally{await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}
});
