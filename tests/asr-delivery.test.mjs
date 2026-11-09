import test from 'node:test';
import assert from 'node:assert/strict';
import {AsrBridge} from '../server/asr-bridge.mjs';
function fixture(failAt){
 let calls=0,attempts=0,stored=0,time=0;
 const s={id:'synthetic',lastEpoch:0,closed:false};
 const b=new AsrBridge(async()=>{calls++;return 'synthetic text';},()=>{attempts++;if(failAt(attempts))throw Error('synthetic storage failure');stored++;});
 async function window(){const pcm=Buffer.alloc(32000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%160<80?4000:-4000,i);
  const n=time===0?4:2;
  for(let i=0;i<n;i++){const t=time++;b.consume(s,[{id:'a'+t,kind:'audio',epoch:0,videoTime:t,captureTime:1,sampleRate:16000,channels:1,duration:1,playbackRate:1,data:pcm.toString('base64')}]);}
  await b.queue.idle();
 }
 return {b,window,counts:()=>({calls,attempts,stored})};
}
test('persistent result storage failures stop ASR work after three attempts',async()=>{
 const f=fixture(()=>true);try{
  for(let i=0;i<3;i++)await f.window();
  assert.equal(f.b.status().status,'blocked_backend_errors');
  assert.equal(f.b.status().delivery.deliveryErrors,3);
  assert.equal(f.b.status().failures.consecutive,3);
  await f.window();assert.deepEqual(f.counts(),{calls:3,attempts:3,stored:0});
  f.b.reset();assert.equal(f.b.status().status,'blocked_backend_errors');
 }finally{f.b.close();}
});
test('successful persistence resets consecutive delivery failures but keeps totals',async()=>{
 const f=fixture(n=>n!==2);try{
  for(let i=0;i<3;i++)await f.window();
  assert.equal(f.b.status().failures.consecutive,1);
  assert.equal(f.b.status().queue.errors,2);
  assert.equal(f.b.status().delivery.deliveryErrors,2);
  assert.equal(f.b.status().delivery.accepted,1);
  assert.deepEqual(f.counts(),{calls:3,attempts:3,stored:1});
 }finally{f.b.close();}
});
