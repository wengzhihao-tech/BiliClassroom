import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as policy from '../extension/frame-policy.js';
import {validateEvent} from '../server/core.mjs';
import {createApp} from '../server/index.mjs';
const rect={x:100,y:50,width:1200,height:675,viewportWidth:1600,viewportHeight:900};
const turn=()=>new Promise(r=>setImmediate(r));
test('crop maps CSS viewport to reduced capture with inward pixel rounding',()=>{
 assert.deepEqual(policy.cropFor(rect,1280,720),{x:80,y:40,width:960,height:540,sourceWidth:1280,sourceHeight:720,outputWidth:960,outputHeight:540});
 const c=policy.cropFor({...rect,x:100.3,width:1199.6},1280,720);
 assert(c.x>=100.3*0.8);assert(c.x+c.width<=(100.3+1199.6)*0.8);
});
test('missing hidden invalid or mismatched geometry never falls back to full tab',()=>{
 for(const r of [null,{...rect,x:-1},{...rect,width:1600},{...rect,height:NaN},{...rect,viewportWidth:0}])assert.equal(policy.cropFor(r,1280,720),null);
 assert.equal(policy.cropFor(rect,1280,800),null);
 assert.equal(policy.cropFor(rect,0,720),null);
});
test('pixel difference suppresses tiny noise, keeps slide changes and bounded heartbeat',()=>{
 const black=policy.sampleLuma(new Uint8Array(32*18*4)),white=policy.sampleLuma(new Uint8Array(32*18*4).fill(255));
 assert.equal(policy.frameDecision(null,black,1000).reason,'first');
 const baseline={sample:black,at:1000};
 assert.equal(policy.frameDecision(baseline,new Uint8Array(576).fill(2),6000).keep,false);
 assert.equal(policy.frameDecision(baseline,white,6000).reason,'changed');
 assert.equal(policy.frameDecision(baseline,black,31000).reason,'heartbeat');
 assert.throws(()=>policy.sampleLuma(new Uint8Array(3)));
});
function harness(){
 let now=1000,listener,counter=0;const calls=[],draws=[],encodes=[],pixels=new Uint8Array(32*18*4);
 const context=vm.createContext({framePolicy:policy,Date:{now:()=>now},crypto:{randomUUID},btoa,Uint8Array,
  OffscreenCanvas:class{constructor(w,h){this.w=w;this.h=h;}getContext(){return{drawImage:(...args)=>draws.push(args.slice(1)),getImageData:()=>({data:pixels})};}
   convertToBlob(){counter++;return new Promise(resolve=>encodes.push(()=>resolve({arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})));}},
  chrome:{runtime:{onMessage:{addListener:f=>listener=f}},storage:{session:{set:async()=>{}}}},
  fetch:async(_url,opts)=>{calls.push(JSON.parse(opts.body));return{ok:true,status:200};},AbortSignal,setTimeout,clearTimeout,clearInterval});
 vm.runInContext(readFileSync(new URL('../extension/offscreen.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'')+
  "\nsession={id:'synthetic',token:'synthetic'};mapping={epoch:0,videoTime:10,wallTime:1000,rate:1,paused:false,videoRect:"+JSON.stringify(rect)+"};video={readyState:2,videoWidth:1280,videoHeight:720,pause(){}};",context);
 return {calls,draws,encodes,context,encoded:()=>counter,
  frame:()=>vm.runInContext('frame()',context),resolve:async()=>{encodes.shift()?.();await turn();await turn();},
  advance:t=>{now=t;vm.runInContext('mapping.wallTime='+t,context);},run:s=>vm.runInContext(s,context)};
}
test('offscreen crops before encoding, skips unchanged frame and sends heartbeat',async()=>{
 const h=harness();h.frame();assert.deepEqual(h.draws[0],[80,40,960,540,0,0,960,540]);await h.resolve();
 const e=h.calls[0].events[0];assert.equal(e.scope,'visible_video_region');assert.equal(e.crop.x,80);assert.equal(e.change.reason,'first');
 h.advance(6000);h.frame();await turn();assert.equal(h.encoded(),1);
 h.advance(31000);h.frame();await h.resolve();assert.equal(h.encoded(),2);assert.equal(h.calls[1].events[0].change.reason,'heartbeat');
});
test('offscreen invalid geometry emits one bounded gap and no encoded full-tab image',async()=>{
 const h=harness();h.run('mapping.videoRect=null');h.frame();await turn();h.frame();await turn();
 assert.equal(h.encoded(),0);assert.equal(h.draws.length,0);assert.equal(h.calls.length,1);assert.equal(h.calls[0].events[0].kind,'gap');
});
test('async crop rejects resize and pause, limits encoders to one',async()=>{
 for(const mutation of ['mapping.videoRect.x=120','mapping.paused=true','video.videoWidth=1200']){
  const h=harness();h.frame();h.frame();assert.equal(h.encoded(),1);h.run(mutation);await h.resolve();assert.equal(h.calls.length,0);
 }
});
test('content reports clipped visible video geometry and hides it when document hidden',async()=>{
 let listener,tick;const messages=[];const v={currentTime:10,paused:false,playbackRate:1,textTracks:[],addEventListener(){},getBoundingClientRect:()=>({left:-20,top:50,right:1300,bottom:900})};
 const document={visibilityState:'visible',querySelector:()=>v,querySelectorAll:()=>[]};
 vm.runInNewContext(readFileSync(new URL('../extension/content.js',import.meta.url),'utf8'),{document,innerWidth:1600,innerHeight:900,Date,URL,location:{href:'https://www.bilibili.com/video/BV1x'},crypto:{randomUUID},
 chrome:{runtime:{onMessage:{addListener:f=>listener=f},sendMessage:async m=>{messages.push(m);return{ok:true};}}},setInterval:f=>tick=f,setTimeout,clearTimeout});
 listener({type:'COLLECT_START'},{},()=>{});await turn();
 const r=messages.find(m=>m.type==='TIMELINE').data.videoRect;assert.equal(r.x,0);assert.equal(r.width,1300);assert.equal(r.height,850);
 document.visibilityState='hidden';tick();assert.equal(messages.filter(m=>m.type==='TIMELINE').at(-1).data.videoRect,null);
});
const raw=()=>({id:'crop-test',kind:'frame',epoch:0,videoTime:10,captureTime:1000,data:'data:image/jpeg;base64,AQID',scope:'visible_video_region',
 crop:{x:80,y:40,width:960,height:540,sourceWidth:1280,sourceHeight:720},width:960,height:540,change:{method:'luma32x18',score:1,reason:'first'}});
test('crop evidence rejects forged bounds and preserves legacy frame scope',()=>{
 const r=raw();assert.equal(validateEvent(r).scope,'visible_video_region');
 assert.throws(()=>validateEvent({...r,crop:{...r.crop,x:1000}}));
 assert.throws(()=>validateEvent({...r,change:{...r.change,score:NaN}}));
 assert.throws(()=>validateEvent({...r,scope:'arbitrary'}));
 const {scope,crop,width,height,change,...legacy}=r;assert.equal(validateEvent(legacy).scope,'visible_tab_frame');
});
test('real loopback HTTP journal retains crop provenance with synthetic image bytes',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bili-crop-')),app=createApp({dataDir:dir,token:'synthetic'});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 const post=(url,data)=>fetch(base+url,{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify(data)});
 try{
  const s=await(await post('/sessions',{url:'https://www.bilibili.com/video/BV1x',title:'synthetic crop'})).json();
  assert.equal((await post('/sessions/'+s.id+'/events',{events:[raw()]})).status,200);
  const stored=JSON.parse(readFileSync(path.join(dir,'sessions',s.id,'events.jsonl'),'utf8').trim());
  assert.deepEqual(stored.crop,raw().crop);assert.equal(stored.scope,'visible_video_region');
 }finally{await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}
});
