import {randomUUID} from 'node:crypto';
// One owned backend invocation plus one newest pending frame across sessions.
export class OcrBridge{
 constructor(backend,appendDerived,{timeoutMs=10000}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('invalid OCR timeout');
  this.backend=typeof backend==='function'?backend:null;this.append=appendDerived;this.timeoutMs=timeoutMs;
  this.current=null;this.epoch=null;this.timeline=null;this.generation=0;this.active=null;this.pending=null;this.closed=false;this.fault=null;this.failures=0;
  this.metrics={submitted:0,replaced:0,cancelled:0,discarded:0,completed:0,empty:0,errors:0,timeouts:0,deliveryErrors:0,skippedScope:0};
 }
 invalidate(){this.generation++;this.pending=null;if(this.active&&!this.active.controller.signal.aborted){this.active.controller.abort();this.metrics.cancelled++;}}
 stop(s){if(this.current?.id===s.id){this.invalidate();this.current=null;this.timeline=null;this.epoch=null;}}
 close(){this.closed=true;this.invalidate();this.current=null;}
 consume(s,events){
  if(!this.backend||this.closed||this.fault||s.closed)return;
  if(this.current?.id!==s.id){this.invalidate();this.current=s;this.epoch=null;this.timeline=null;}
  for(const e of events){
   if(e.epoch<s.lastEpoch)continue;
   if(this.epoch!==e.epoch){this.invalidate();this.epoch=e.epoch;this.timeline=null;}
   if(e.kind==='gap'){if(e.media!=='audio')this.invalidate();continue;}
   if(e.kind==='playback'){
    const t=this.timeline;if(t&&(e.rate!==t.rate||e.paused!==t.paused))this.invalidate();
    if(e.paused)this.invalidate();this.timeline={rate:e.rate,paused:e.paused};continue;
   }
   if(e.kind!=='frame'||this.timeline?.paused)continue;
   if(e.scope!=='visible_video_region'){this.metrics.skippedScope++;continue;}
   if(this.pending)this.metrics.replaced++;
   this.pending={session:s,frame:e,generation:this.generation};this.metrics.submitted++;
  }
  this.kick();
 }
 kick(){
  if(this.active||!this.pending||this.closed||this.fault)return;
  const job=this.pending;this.pending=null;
  const controller=new AbortController(),active={controller};this.active=active;
  const timer=setTimeout(()=>{this.metrics.timeouts++;this.fault='backend_timeout';this.invalidate();},this.timeoutMs);timer.unref?.();
  active.promise=(async()=>{
   try{
    const r=await this.backend(job.frame,{signal:controller.signal,language:job.session.ocrLanguage||'zh-Hans-CN'});
    if(controller.signal.aborted||job.generation!==this.generation||job.session!==this.current||job.session.closed||job.session.lastEpoch!==job.frame.epoch||this.closed){this.metrics.discarded++;return;}
    if(!r||typeof r.text!=='string'||r.text.length>12000)throw Error('invalid OCR backend result');
    if(!r.text.trim()){this.metrics.empty++;this.failures=0;return;}
    try{
     this.append(job.session,{...r,id:randomUUID(),kind:'ocr',quality:'unverified',confidence:null,captureTime:Date.now(),epoch:job.frame.epoch,videoTime:job.frame.videoTime,sourceEventIds:[job.frame.id]});
     this.metrics.completed++;this.failures=0;
    }catch{this.metrics.deliveryErrors++;}
   }catch{
    if(!controller.signal.aborted){this.metrics.errors++;if(++this.failures>=3){this.fault='backend_failures';this.invalidate();}}
   }finally{clearTimeout(timer);if(this.active===active)this.active=null;this.kick();}
  })();
 }
 status(sessionId){
  return {status:!this.backend?'disabled_no_backend':this.fault?'blocked_'+this.fault:'configured_backend_unverified',
   active:!!this.active,pending:!!this.pending,currentSession:!sessionId||this.current?.id===sessionId,quality:'unverified',metrics:{...this.metrics}};
 }
}