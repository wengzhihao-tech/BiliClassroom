import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import * as framePolicy from '../extension/frame-policy.js';
const turn=()=>new Promise(r=>setImmediate(r));
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function content(send){
 let listener;const v={currentTime:10,paused:false,playbackRate:1,textTracks:[{activeCues:[{text:'synthetic caption'}]}],addEventListener(){}};
 const chrome={runtime:{onMessage:{addListener:f=>listener=f},sendMessage:send}};
 vm.runInNewContext(readFileSync(new URL('../extension/content.js',import.meta.url),'utf8'),{chrome,document:{querySelector:()=>v,querySelectorAll:()=>[]},location:{href:'https://www.bilibili.com/video/BV1x'},URL,Date,crypto:{randomUUID},setInterval(){},setTimeout,clearTimeout});
 return m=>new Promise(r=>listener(m,{},r));
}
test('content stop waits for pending ACK and drains remaining queued evidence',async()=>{
 const held=defer(),batches=[];const message=content(async m=>{if(m.type==='EVENTS'){batches.push(m.events);return held.promise;}return{ok:true};});
 await message({type:'COLLECT_START'});let stopped=false;const pending=message({type:'COLLECT_STOP'}).then(r=>{stopped=true;return r;});
 await turn();assert.equal(stopped,false);assert.equal(batches[0].length,2);held.resolve({accepted:2});const r=await pending;assert.equal(r.drained,true);assert.equal(r.remaining,0);
});
test('failed content delivery reports remainder rather than claiming a drain',async()=>{
 const batches=[];const message=content(async m=>{if(m.type==='EVENTS'){batches.push(m.events);return{error:'offline'};}return{ok:true};});
 await message({type:'COLLECT_START'});const r=await message({type:'COLLECT_STOP'});
 assert.equal(r.drained,false);assert.equal(r.remaining,2);assert(batches.length<=5);assert(batches.every(b=>b[0].id===batches[0][0].id));
});
function stoppingWorker({quota=false}={}){
 let listener;const contentAck=defer(),mediaAck=defer(),calls=[],stored={active:{id:'s',tabId:7,token:'synthetic',audio:true,frames:true}};
 const chrome={runtime:{id:'ext',onMessage:{addListener:f=>listener=f},sendMessage:m=>{calls.push(m.type);return mediaAck.promise;}},tabs:{sendMessage:(_id,m)=>{calls.push(m.type);return contentAck.promise;},onRemoved:{addListener(){}}},storage:{session:{get:async()=>stored,set:async x=>Object.assign(stored,x),remove:async()=>{delete stored.active;}},local:{get:async()=>({})}},action:{setBadgeText:async()=>{}}};
 const fetch=async(url)=>{calls.push(url);return{ok:!quota||!url.endsWith('/events'),status:quota&&url.endsWith('/events')?413:200,json:async()=>({ok:true})};};
 vm.runInNewContext(readFileSync(new URL('../extension/worker.js',import.meta.url),'utf8'),{chrome,fetch,URL,AbortSignal,Error,setTimeout,clearTimeout});
 return{calls,contentAck,mediaAck,stored,msg:(m,sender={id:'ext'})=>new Promise(r=>listener(m,sender,r))};
}
test('worker closes backend only after both producer stop acknowledgements',async()=>{
 const w=stoppingWorker(),p=w.msg({type:'STOP'});await turn();
 assert(w.calls.includes('COLLECT_STOP'));assert(w.calls.includes('CAPTURE_STOP'));assert(!w.calls.some(x=>x.endsWith('/stop')));
 w.contentAck.resolve({ok:true,drained:true,remaining:0});await turn();assert(!w.calls.some(x=>x.endsWith('/stop')));
 w.mediaAck.resolve({ok:true,drained:false,remaining:2,partialAudioDiscarded:true});
 const r=await p;assert.equal(r.lastStop.media.remaining,2);assert.equal(r.lastStop.backendClosed,true);assert.equal(w.stored.active,undefined);
});
test('quota error returns to producer without waiting on recursive stop',async()=>{
 const w=stoppingWorker({quota:true});const r=await Promise.race([w.msg({type:'EVENTS',sessionId:'s',events:[]},{id:'ext',tab:{id:7}}),new Promise(r=>setTimeout(()=>r({timeout:true}),250))]);
 assert.equal(r.timeout,undefined);assert.match(r.error,/413/);w.contentAck.resolve({drained:false,remaining:1});w.mediaAck.resolve({drained:false,remaining:1});await turn();
});
function frameHarness(){
 const blob=defer(),calls=[];let now=1000,listener;const context=vm.createContext({Date:{now:()=>now},crypto:{randomUUID},btoa,Uint8Array,framePolicy,OffscreenCanvas:class{getContext(){return{drawImage(){},getImageData(){return{data:new Uint8Array(32*18*4)};}};}convertToBlob(){return blob.promise;}},chrome:{runtime:{onMessage:{addListener:f=>listener=f}},storage:{session:{set:async()=>{}}}},fetch:async(_url,opts)=>{calls.push(JSON.parse(opts.body));return{ok:true,status:200};},AbortSignal,setTimeout,clearTimeout,clearInterval});
 vm.runInContext(readFileSync(new URL('../extension/offscreen.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'')+"\nsession={id:'synthetic',token:'synthetic'};mapping={epoch:0,videoTime:10,wallTime:1000,rate:1,paused:false,videoRect:{x:80,y:40,width:960,height:540,viewportWidth:1280,viewportHeight:720}};video={readyState:2,videoWidth:1280,videoHeight:720};frame();",context);
 return{calls,resolve:()=>blob.resolve({arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer}),advance:()=>{now=2000;vm.runInContext('mapping.videoTime=11;mapping.wallTime=2000;',context);},seek:()=>vm.runInContext('mapping.epoch=1;',context)};
}
test('frame keeps time of image draw, not asynchronous JPEG completion',async()=>{
 const h=frameHarness();h.advance();h.resolve();await turn();await turn();assert.equal(h.calls[0].events[0].videoTime,10);
});
test('asynchronous frame from pre-seek epoch is discarded',async()=>{
 const h=frameHarness();h.seek();h.resolve();await turn();await turn();assert.equal(h.calls.length,0);
});