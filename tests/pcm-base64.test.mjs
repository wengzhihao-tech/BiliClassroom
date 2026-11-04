import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {validateEvent} from '../server/core.mjs';import {createApp} from '../server/index.mjs';
const event=(id,data)=>({id,kind:'audio',epoch:0,videoTime:0,captureTime:1,sampleRate:16000,channels:1,duration:0.001,playbackRate:1,data});
test('PCM accepts canonical padded or unpadded data and rejects malformed base64 before decode',()=>{
 for(const x of ['AQI=','AQI'])assert.equal(validateEvent(event('ok',x)).data,x);
 for(const x of ['AQI=AAAA','AQI====','AQJ=','A','A'.repeat(200000)])assert.throws(()=>validateEvent(event('bad',x)));
});
test('malformed PCM makes HTTP batch atomic with no accepted events',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bili-pcm-'));const app=createApp({dataDir:dir,token:'synthetic'});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 async function req(p,b){const r=await fetch(base+p,{method:b?'POST':'GET',headers:{Authorization:'Bearer synthetic',...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});return{status:r.status,data:await r.json()};}
 try{const id=(await req('/sessions',{url:'https://www.bilibili.com/video/BV1Synthetic'})).data.id;
 const invalid=await req('/sessions/'+id+'/events',{events:[event('valid','AQI='),event('bad','AQI=AAAA')]});assert.equal(invalid.status,400);
 const c=await req('/sessions/'+id+'/context');assert.equal(c.data.availability.audioChunks,0);
 const good=await req('/sessions/'+id+'/events',{events:[event('valid','AQI=')]});assert.equal(good.data.accepted,1);
 await req('/sessions/'+id+'/stop',{});}finally{await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}
});
