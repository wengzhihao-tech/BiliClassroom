import {ASR_INPUT_GATE,AudioWindows,TranscriptionQueue} from './asr-pipeline.mjs';
import {randomUUID} from 'node:crypto';
// Only a caller-supplied local backend is supported. No environment-triggered downloads/cloud calls.
export class AsrBridge{
  constructor(backend,appendDerived,{timeoutMs=10000}={}){
    this.current=null;this.timeline=null;this.metrics={accepted:0,suppressed:0,deliveryErrors:0,staleAudio:0};
    if(typeof backend==='function'){
      this.planner=new AudioWindows();
      this.queue=new TranscriptionQueue(backend,async raw=>{
        const s=this.current;
        if(!s||s.closed||s.id!==raw.sessionId||s.lastEpoch!==raw.epoch){this.metrics.suppressed++;return;}
        try{appendDerived(s,{...raw,id:randomUUID(),captureTime:Date.now()});this.metrics.accepted++;}
        catch{this.metrics.deliveryErrors++;throw Error('ASR result persistence failed');}
      },{timeoutMs});
    }
  }
  attach(s){
    if(!this.queue)return;
    if(this.current?.id!==s.id){this.reset();this.current=s;this.timeline=null;this.observedEpoch=null;}
  }
  reset(){this.planner?.reset();this.queue?.invalidate();}
  stop(s){if(this.current?.id===s.id){this.reset();this.current=null;this.timeline=null;}}
  close(){this.queue?.close();this.current=null;}
  consume(s,events){
    if(!this.queue||this.queue.faulted||s.closed)return;
    this.attach(s);
    for(const e of events){
      if(e.epoch<s.lastEpoch)continue;
      if(this.observedEpoch!==e.epoch){this.reset();this.observedEpoch=e.epoch;}
      if(e.kind==='gap'){if(e.media!=='frame')this.reset();continue;}
      if(e.kind==='playback'){
        const t=this.timeline;
        if(!t||e.epoch!==t.epoch||e.rate!==t.rate||e.paused!==t.paused)this.reset();
        this.timeline={epoch:e.epoch,rate:e.rate,paused:e.paused};continue;
      }
      if(e.kind!=='audio'||this.timeline?.paused)continue;
      // Playback observations in the same epoch are authoritative.
      if(this.timeline&&e.epoch===this.timeline.epoch&&e.playbackRate!==this.timeline.rate){this.metrics.staleAudio++;continue;}
      // A fresh epoch/rate observation invalidates old jobs before another 4-second window forms.
      if(this.timeline&&(e.epoch!==this.timeline.epoch||e.playbackRate!==this.timeline.rate)){
        this.reset();this.timeline={epoch:e.epoch,rate:e.playbackRate,paused:false};
      }
      const result=this.planner.push(s.id,e);
      if(result.reason==='stale_audio_time')this.metrics.staleAudio++;
      if(result.reason&&result.reason!=='duplicate'&&result.reason!=='stale_epoch'&&result.reason!=='stale_audio_time')this.queue.invalidate();
      for(const window of result.windows)this.queue.submit(window);
    }
  }
  status(sessionId){
    if(!this.queue)return{status:'disabled_no_backend'};
    return{status:this.queue.faulted?(this.queue.faultReason==='errors'?'blocked_backend_errors':'blocked_backend_timeout'):'configured_backend_unverified',failures:{consecutive:this.queue.consecutiveFailures,limit:3},active:!!this.queue.active,pending:!!this.queue.pending,currentSession:!sessionId||this.current?.id===sessionId,queue:{...this.queue.metrics},delivery:{...this.metrics},bufferedSamples:this.planner.samples,inputGate:{method:ASR_INPUT_GATE,skippedWindows:this.planner.metrics.silenceWindows}};
  }
}