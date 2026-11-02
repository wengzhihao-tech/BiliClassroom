import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.mjs';
const token='a'.repeat(64);
test('HTTP auth, persistence, deduplication, origin, stop',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'biliclass-test-'));const server=createApp({dataDir:dir,token});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const req=(route,body,extra={})=>fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await fetch(base+'/sessions')).status,401);
    assert.equal((await req('/sessions',undefined,{Origin:'https://www.bilibili.com'})).status,403);
    const r=await req('/sessions',{url:'https://www.bilibili.com/video/BV1test',title:'synthetic'});assert.equal(r.status,201);const {id}=await r.json();
    assert.equal((await req('/sessions',{url:'https://www.bilibili.com/video/BV1test'})).status,409);
    const events=[{id:'caption1',kind:'subtitle',epoch:0,videoTime:2,captureTime:Date.now(),text:'合成测试：比例控制'}];
    assert.equal((await (await req(`/sessions/${id}/events`,{events})).json()).accepted,1);
    assert.equal((await (await req(`/sessions/${id}/events`,{events})).json()).duplicates,1);
    assert.equal((await (await req(`/sessions/${id}/context`)).json()).evidence[0].text,events[0].text);
    const journal=readFileSync(path.join(dir,'sessions',id,'events.jsonl'),'utf8').trim().split('\n');assert.equal(journal.length,1);
    assert.equal((await req(`/sessions/${id}/stop`,{})).status,200);
    assert.equal((await req(`/sessions/${id}/events`,{events})).status,400);
    assert(!readFileSync(path.join(dir,'sessions',id,'events.jsonl'),'utf8').includes(token));
  }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
test('session quota rejects without committing',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'biliclass-quota-'));const server=createApp({dataDir:dir,token,maxBytes:5});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;const post=(p,b)=>fetch(base+p,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(b)});
  try{const{id}=await(await post('/sessions',{url:'https://www.bilibili.com/video/BV1x'})).json();assert.equal((await post(`/sessions/${id}/events`,{events:[{id:'x',kind:'subtitle',epoch:0,videoTime:0,captureTime:1,text:'x'}]})).status,413);assert.deepEqual(readdirSync(path.join(dir,'sessions',id)),['session.json']);}
  finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
test('HTTP context keeps latest playback position after delayed ASR journal append',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'biliclass-cursor-')),server=createApp({dataDir:dir,token});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const req=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.equal(r.ok,true);return r.json();};
 try{
  const {id}=await req('/sessions',{url:'https://www.bilibili.com/video/BV1synthetic'});
  const p='/sessions/'+id;
  await req(p+'/events',{events:[{id:'audio',kind:'audio',epoch:0,videoTime:0,captureTime:1,sampleRate:16000,channels:1,duration:1,data:Buffer.alloc(32000).toString('base64')},
   {id:'clock',kind:'playback',epoch:0,videoTime:5,captureTime:2,paused:false,rate:1},
   {id:'visual-gap',kind:'gap',epoch:0,videoTime:5,captureTime:2,media:'frame',text:'synthetic frame missing'}]});
  await req(p+'/events',{events:[{id:'late-asr',kind:'asr',epoch:0,videoTime:0,captureTime:3,text:'synthetic late text',stability:'provisional',sourceEventIds:['audio']}]});
  const c=await req(p+'/context');assert.equal(c.at,5);assert.equal(c.gaps[0].media,'frame');assert.equal(c.provisionalEvidence[0].id,'late-asr');assert.equal(c.evidence.length,0);
  assert.equal((await req(p+'/context?at=0')).gaps.length,0);
 }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
