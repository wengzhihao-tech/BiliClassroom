import test from 'node:test';import assert from 'node:assert/strict';
import {AudioWindows} from '../server/asr-pipeline.mjs';import {AsrBridge} from '../server/asr-bridge.mjs';
const audio=(id,t,epoch=0)=>({id,kind:'audio',epoch,videoTime:t,captureTime:1,sampleRate:16000,channels:1,duration:1,playbackRate:1,data:Buffer.alloc(32000,8).toString('base64')});
test('late audio does not rewind a same-epoch window; seek epoch still resets',()=>{
 const p=new AudioWindows();for(let i=0;i<4;i++)p.push('s',audio('a'+i,i));
 const before=p.samples,segment=p.segment;
 assert.equal(p.push('s',audio('late',1)).reason,'stale_audio_time');assert.equal(p.samples,before);assert.equal(p.segment,segment);
 const w=p.push('s',audio('a4',4));assert.equal(w.reason,null);
 assert.equal(p.push('s',audio('seek',0,1)).reason,'source_epoch_or_rate_change');
});
test('late audio cannot abort an in-flight ASR job',async()=>{
 let resolve,signal;const received=[];const s={id:'s',closed:false,lastEpoch:0};
 const b=new AsrBridge(async (_w,o)=>{signal=o.signal;return await new Promise(r=>resolve=r);},(_s,e)=>received.push(e));
 b.consume(s,[0,1,2,3].map(i=>audio('a'+i,i)));assert(signal);
 b.consume(s,[audio('late',1)]);assert.equal(signal.aborted,false);assert.equal(b.status('s').delivery.staleAudio,1);
 resolve('synthetic');await b.queue.idle();assert.equal(received.length,1);assert.deepEqual(received[0].sourceEventIds,['a0','a1','a2','a3']);b.close();
});