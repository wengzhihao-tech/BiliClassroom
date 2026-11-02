import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
const turn=()=>new Promise(r=>setImmediate(r));
function processor(){
 let Type;const messages=[],context=vm.createContext({AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},registerProcessor:(_n,t)=>Type=t,Float32Array,sampleRate:8,currentFrame:0});
 vm.runInContext(readFileSync(new URL('../extension/pcm-worklet.js',import.meta.url),'utf8'),context);const p=new Type();
 return{p,messages,reset:(generation,enabled=true)=>p.port.onmessage({data:{type:'reset',generation,enabled}}),block(frame,value=0.5){context.currentFrame=frame;p.process([[new Float32Array(4).fill(value)]]);}};
}
test('collector stays disabled until configured and tags sample end clock and generation',()=>{
 const h=processor();h.block(0);h.block(4);assert.equal(h.messages.length,0);h.reset(1);h.block(8);h.block(12);
 assert.equal(h.messages.length,1);assert.equal(h.messages[0].generation,1);assert.equal(h.messages[0].audioEndTime,2);assert.equal(h.messages[0].samples.length,8);
});
test('pause reset clears partial samples and resumed block never contains earlier generation',()=>{
 const h=processor();h.reset(1);h.block(0,0.25);h.reset(2,false);h.block(4,0.5);h.reset(3);h.block(8,0.75);h.block(12,0.75);
 assert.equal(h.messages.length,1);assert.equal(h.messages[0].generation,3);assert([...h.messages[0].samples].every(x=>x===0.75));
});
function offscreen(rate=1){
 let listener,now=12000;const calls=[],resets=[];
 const context=vm.createContext({Date:{now:()=>now},crypto:{randomUUID},Float32Array,ArrayBuffer,DataView,Uint8Array,Number,Math,btoa,AbortSignal,setTimeout,clearTimeout,clearInterval,chrome:{runtime:{onMessage:{addListener:f=>listener=f}},storage:{session:{set:async()=>{}}}},fetch:async(_u,opt)=>{calls.push(JSON.parse(opt.body));return{ok:true,status:200};}});
 const src=readFileSync(new URL('../extension/offscreen.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
 context.resets=resets;vm.runInContext(src+"\nsession={id:'synthetic',token:'synthetic',audio:true};mapping={epoch:0,videoTime:110,wallTime:12000,rate:"+rate+",paused:false};ctx={currentTime:12,state:'running'};node={port:{postMessage:m=>resets.push(m)}};pcmGeneration=1;",context);
 return{calls,resets,context,pcm(extra={}){context.message={samples:new Float32Array(48000).fill(0.25),sampleRate:48000,generation:1,audioEndTime:11.8,...extra};vm.runInContext('pcm(message)',context);},timeline(extra={}){listener({target:'offscreen',type:'TIMELINE',data:{epoch:0,videoTime:110,wallTime:now,rate,paused:false,...extra}},null,()=>{});},now(t){now=t;}};
}
test('delayed PCM delivery uses source sample clock at both playback rates',async()=>{
 for(const rate of [1,2]){const h=offscreen(rate);h.pcm();await turn();const e=h.calls[0].events[0];assert(Math.abs(e.videoTime-(110-1.2*rate))<0.001);assert.equal(e.duration,1);assert.equal(Buffer.from(e.data,'base64').length,32000);}
});
test('rate pause resume seek and stale timeline each fence old PCM generations',async()=>{
 for(const change of [{rate:2},{paused:true},{epoch:1}]){
  const h=offscreen();h.timeline(change);assert.equal(h.resets.length,1);assert.equal(h.resets[0].generation,2);h.pcm();await turn();assert.equal(h.calls.length,0);
 }
 const h=offscreen();h.timeline({paused:true});assert.equal(h.resets[0].enabled,false);h.timeline({paused:false});assert.equal(h.resets[1].enabled,true);assert.equal(h.resets[1].generation,3);
 h.now(15001);h.timeline();assert.equal(h.resets[2].generation,4);
});
test('ordinary timeline ticks retain partial generation; malformed old or stale PCM is dropped',async()=>{
 const h=offscreen();h.timeline();assert.equal(h.resets.length,0);
 for(const extra of [{generation:0},{audioEndTime:9},{audioEndTime:13},{sampleRate:0},{samples:new Float32Array(0)},{audioEndTime:NaN}])h.pcm(extra);
 await turn();assert.equal(h.calls.length,0);h.pcm();await turn();assert.equal(h.calls.length,1);
});
