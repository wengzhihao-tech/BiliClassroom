import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWindowsOcrBackend,layoutOcrWords} from '../server/windows-ocr.mjs';
const frame={id:'frame-1',kind:'frame',epoch:2,videoTime:12,data:'data:image/jpeg;base64,AQID'};
function worker(){
 const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.killed=false;
 c.kill=()=>{c.killed=true;setImmediate(()=>c.emit('close',1));return true;};return c;
}
async function fixture(fn){const dir=await mkdtemp(path.join(tmpdir(),'bili-native-ocr-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('OCR adapter retains frame provenance and removes temporary image after success',async()=>fixture(async tempRoot=>{
 const c=worker(),recognize=createWindowsOcrBackend({tempRoot,spawnWorker:()=>{setImmediate(()=>{c.stdout.end(JSON.stringify({text:'synthetic',words:[],width:960,height:540,language:'en-US',recognitionMs:2}));c.emit('close',0);});return c;}});
 const r=await recognize(frame);assert.deepEqual(r.sourceEventIds,['frame-1']);assert.equal(r.epoch,2);assert.equal(r.videoTime,12);assert.equal(r.confidence,null);assert.deepEqual(await readdir(tempRoot),[]);
}));
test('OCR single worker rejects backlog; abort kills owned child before cleanup',async()=>fixture(async tempRoot=>{
 let c,ready;const started=new Promise(r=>ready=r),recognize=createWindowsOcrBackend({tempRoot,spawnWorker:()=>{c=worker();ready();return c;}}),controller=new AbortController();
 const pending=recognize(frame,{signal:controller.signal});await started;await assert.rejects(recognize(frame),/busy/);
 controller.abort();await assert.rejects(pending,/aborted/);assert.equal(c.killed,true);assert.deepEqual(await readdir(tempRoot),[]);
}));
test('OCR timeout kills worker and rejects fabricated or malformed output',async()=>fixture(async tempRoot=>{
 let c;const recognize=createWindowsOcrBackend({tempRoot,timeoutMs:10,spawnWorker:()=>c=worker()});
 await assert.rejects(recognize(frame),/timeout/);assert.equal(c.killed,true);assert.deepEqual(await readdir(tempRoot),[]);
 const bad=createWindowsOcrBackend({tempRoot,spawnWorker:()=>{const w=worker();setImmediate(()=>{w.stdout.end('not JSON');w.emit('close',0);});return w;}});
 await assert.rejects(bad(frame),/invalid OCR worker output/);assert.deepEqual(await readdir(tempRoot),[]);
}));
test('OCR validates frame and language without launching a process',async()=>{
 let calls=0;const recognize=createWindowsOcrBackend({spawnWorker:()=>{calls++;throw Error('must not spawn');}});
 await assert.rejects(recognize({...frame,data:'file:///private'}),/invalid/);
 await assert.rejects(recognize(frame,{language:'arbitrary'}),/language/);
 const c=new AbortController();c.abort();await assert.rejects(recognize(frame,{signal:c.signal}),/aborted/);assert.equal(calls,0);
});
test('OCR geometry restores interleaved rows while leaving lost symbols unrepaired',()=>{
 const word=(text,x,y,width=30,height=20)=>({text,x,y,width,height});
 const words=[word('error',10,10),word('u',10,100),word('20',120,10),word('motor',10,200),word('speed',70,200)];
 assert.equal(layoutOcrWords(words,960,540),'error 20\nu\nmotor speed');
 assert(!layoutOcrWords(words,960,540).includes('motor_speed'));
 assert.throws(()=>layoutOcrWords([word('outside',950,10)],960,540),/bounds/);
});
test('OCR child UTF8 split buffers preserve Chinese text',async()=>fixture(async tempRoot=>{
 const recognize=createWindowsOcrBackend({tempRoot,spawnWorker:()=>{
  const c=worker();setImmediate(()=>{
   const bytes=Buffer.from(JSON.stringify({text:'中文',words:[],width:960,height:540}));
   const at=bytes.indexOf(Buffer.from('中文'))+1;c.stdout.write(bytes.subarray(0,at));c.stdout.end(bytes.subarray(at));c.emit('close',0);
  });return c;
 }});
 assert.equal((await recognize(frame)).text,'中文');
}));

test('small operators attach to full-height code row before punctuation can seed separate rows',()=>{
 const words=[{text:'u',x:37,y:235,width:14,height:17},{text:'=',x:65,y:238,width:16,height:9},{text:'Kp',x:96,y:229,width:34,height:30},
 {text:'*',x:141,y:229,width:12,height:12},{text:'error;',x:164,y:235,width:74,height:21}];
 assert.equal(layoutOcrWords(words,960,540),'u = Kp * error;');
});
