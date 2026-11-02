import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVoskBackend} from '../server/vosk-backend.mjs';
function fixture({structured=false}={}){
 const dir=mkdtempSync(path.join(tmpdir(),'bili-vosk-adapter-')),file=path.join(dir,'worker.mjs');let launches=0;
 writeFileSync(file,`import{createInterface}from'node:readline';process.stdout.write(JSON.stringify({type:'ready'})+'\\n');for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line),n=Buffer.from(q.pcm,'base64').length;if(n===6){process.stdout.write(JSON.stringify({type:'error',id:q.id})+'\\n');continue;}setTimeout(()=>process.stdout.write(JSON.stringify({type:'result',id:q.id,text:'TEST_BACKEND_NOT_REAL_ASR',words:[{word:'synthetic',start:0,end:0.5,conf:0.75}],elapsedMs:1})+'\\n'),n===2?500:1);}`);
 const backend=createVoskBackend({structured,spawnWorker:()=>{launches++;return spawn(process.execPath,[file],{windowsHide:true,stdio:['pipe','pipe','pipe']});}});
 return{backend,get launches(){return launches;},cleanup:async()=>{backend.close();await new Promise(r=>setTimeout(r,30));rmSync(dir,{recursive:true,force:true});}};
}
test('local adapter reuses a ready subprocess and frames request IDs',async()=>{
 const f=fixture();try{await f.backend.ready();assert.equal(await f.backend({audioS16:Buffer.alloc(4)}),'TEST_BACKEND_NOT_REAL_ASR');assert.equal(await f.backend({audioS16:Buffer.alloc(4)}),'TEST_BACKEND_NOT_REAL_ASR');assert.equal(f.launches,1);assert.equal(f.backend.status().completed,2);}finally{await f.cleanup();}
});
test('abort terminates owned subprocess before another request launches',async()=>{
 const f=fixture();try{await f.backend.ready();const controller=new AbortController(),pending=f.backend({audioS16:Buffer.alloc(2)},{signal:controller.signal});setTimeout(()=>controller.abort(),30);await assert.rejects(pending);assert.equal(f.backend.status().running,false);await f.backend({audioS16:Buffer.alloc(4)});assert.equal(f.launches,2);}finally{await f.cleanup();}
});
test('worker protocol failure is rejected without fabricated transcript',async()=>{
 const f=fixture();try{await assert.rejects(f.backend({audioS16:Buffer.alloc(6)}));assert.equal(f.backend.status().failures,1);}finally{await f.cleanup();}
});
test('structured Vosk mode preserves engine words while legacy mode remains string',async()=>{
 const f=fixture({structured:true});try{const r=await f.backend({audioS16:Buffer.alloc(4)});assert.equal(r.engine,'vosk');assert.equal(r.words[0].end,0.5);assert.equal(r.words[0].conf,0.75);}finally{await f.cleanup();}
});
