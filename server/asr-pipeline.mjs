import {normalizeAsrResult} from './asr-words.mjs';
import {validateEvent} from './core.mjs';
// Model-independent scheduling primitives. Energy gating is NOT a trained VAD.
export class AudioWindows {
  constructor(){this.reset();this.metrics={resets:0,silenceWindows:0,duplicates:0,stale:0};}
  reset(){this.segment=(this.segment??-1)+1;this.parts=[];this.samples=0;this.key=null;this.last=null;this.seen=new Set();}
  push(sessionId,raw){
    if(typeof sessionId!=='string'||!sessionId)throw new Error('session required');
    const e=validateEvent(raw);if(e.kind!=='audio')throw new Error('audio required');
    if(this.last?.sessionId===sessionId&&e.epoch<this.last.epoch){this.metrics.stale++;return{windows:[],reason:'stale_epoch'};}
    const key=JSON.stringify([sessionId,e.epoch,e.playbackRate]),previous=this.last;
    if(this.key===key&&this.seen.has(e.id)){this.metrics.duplicates++;return{windows:[],reason:'duplicate'};}
    const end=previous?previous.videoTime+previous.duration*previous.playbackRate:null;
    const discontinuity=this.key!==null&&(this.key!==key||Math.abs(e.videoTime-end)>0.25);
    let reason=null;
    if(discontinuity){reason=this.key!==key?'source_epoch_or_rate_change':'audio_time_gap';this.reset();this.metrics.resets++;}
    this.key=key;this.last={...e,sessionId};this.seen.add(e.id);
    if(this.seen.size>256)this.seen.delete(this.seen.values().next().value);
    this.parts.push({event:e,pcm:Buffer.from(e.data,'base64'),offset:0});this.samples+=Buffer.from(e.data,'base64').length/2;
    const windows=[];
    while(this.samples>=64000){
      let remaining=64000,sum=0;const pcm=[],spans=[];
      for(const p of this.parts){
        const take=Math.min(remaining,p.pcm.length/2-p.offset),bytes=p.pcm.subarray(p.offset*2,(p.offset+take)*2);
        pcm.push(bytes);spans.push({id:p.event.id,startSample:p.offset,endSample:p.offset+take,videoTime:p.event.videoTime,playbackRate:p.event.playbackRate});
        for(let i=0;i<bytes.length;i+=2){const x=bytes.readInt16LE(i)/32768;sum+=x*x;}
        remaining-=take;if(!remaining)break;
      }
      const first=this.parts[0],start=first.event.videoTime+first.offset/16000*e.playbackRate,rms=Math.sqrt(sum/64000);
      if(rms>=0.01)windows.push({sessionId,segment:this.segment,epoch:e.epoch,playbackRate:e.playbackRate,videoTime:start,videoEnd:start+4*e.playbackRate,audioDuration:4,sampleRate:16000,sourceEventIds:[...new Set(spans.map(s=>s.id))],spans,audioS16:Buffer.concat(pcm),energyGate:'rms_only_not_vad',timing:'rate_projection_not_browser_verified'});
      else this.metrics.silenceWindows++;
      let trim=32000;
      while(trim){const p=this.parts[0],n=Math.min(trim,p.pcm.length/2-p.offset);p.offset+=n;trim-=n;this.samples-=n;if(p.offset===p.pcm.length/2)this.parts.shift();}
    }
    return{windows,reason};
  }
}
export class TranscriptionQueue {
  constructor(backend,onResult,{timeoutMs=10000}={}){if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('invalid timeout');this.timeoutMs=timeoutMs;this.faulted=false;this.faultReason=null;this.consecutiveFailures=0;if(typeof backend!=='function'||typeof onResult!=='function')throw new Error('explicit local backend and sink required');this.backend=backend;this.onResult=onResult;this.generation=0;this.pending=null;this.active=null;this.key=null;this.closed=false;this.metrics={replaced:0,cancelled:0,discarded:0,errors:0,timeouts:0,empty:0};}
  fail(){this.metrics.errors++;this.consecutiveFailures++;if(this.consecutiveFailures>=3){this.faulted=true;this.faultReason='errors';this.pending=null;}}
  invalidate(){this.generation++;this.pending=null;if(this.active){this.active.controller.abort();this.metrics.cancelled++;}this.key=null;}
  close(){this.closed=true;this.invalidate();}
  submit(window){
    if(this.closed||this.faulted)throw new Error('queue closed or backend timeout circuit open');
    const key=JSON.stringify([window.sessionId,window.epoch,window.playbackRate,window.segment]);
    if(this.key!==null&&this.key!==key)this.invalidate();
    this.key=key;if(this.pending)this.metrics.replaced++;
    this.pending={window,generation:this.generation};this.kick();
  }
  kick(){
    if(this.active||!this.pending||this.closed||this.faulted)return;
    const job=this.pending;this.pending=null;const controller=new AbortController();this.active={controller};
    const timer=setTimeout(()=>{this.faulted=true;this.faultReason='timeout';this.metrics.timeouts++;this.invalidate();},this.timeoutMs);timer.unref?.();
    this.active.promise=(async()=>{
      try{
        const result=await this.backend(job.window,{signal:controller.signal});
        if(this.closed||controller.signal.aborted||job.generation!==this.generation){this.metrics.discarded++;return;}
        const normalized=normalizeAsrResult(result,job.window),text=normalized.text;
        if(typeof text!=='string'||text.length>12000)throw Error('invalid ASR text');
        if(!text.trim()){this.consecutiveFailures=0;this.metrics.empty++;return;}
        await this.onResult({...normalized,kind:'asr',stability:'provisional',text,epoch:job.window.epoch,videoTime:job.window.videoTime,sourceEventIds:job.window.sourceEventIds,sessionId:job.window.sessionId});this.consecutiveFailures=0;
      }catch{if(!controller.signal.aborted)this.fail();}
    })().finally(()=>{clearTimeout(timer);this.active=null;this.kick();});
  }
  async idle(){while(this.active){await this.active.promise;}}
}