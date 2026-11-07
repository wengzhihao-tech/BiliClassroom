import * as framePolicy from './frame-policy.js';
let stream,ctx,node,video,timer,session,mapping,queue=[],pumping=false,blockedUntil=0,dropped=0,lastFrame='',stoppingCapture=false;
let pcmGeneration=0;
function resetPcm(){pcmGeneration++;node?.port.postMessage({type:'reset',generation:pcmGeneration,enabled:!!session&&!!mapping&&!mapping.paused&&Date.now()-mapping.wallTime<=2500});}
const endpoint='http://127.0.0.1:18743';
function make(kind,extra={}){
  if(stoppingCapture||!session||!mapping||Date.now()-mapping.wallTime>2500||mapping.paused)return null;
  const t=mapping.videoTime+(Date.now()-mapping.wallTime)/1000*mapping.rate;
  return {id:crypto.randomUUID(),kind,epoch:mapping.epoch,videoTime:t,captureTime:Date.now(),...extra};
}
function add(e){if(!e||stoppingCapture)return false;if(queue.length>=8){dropped++;return false;}queue.push(e);void pump();return true;}
function flushDrops(){if(!dropped||queue.length>=8||stoppingCapture)return;const n=dropped,e=make('gap',{text:`音画发送拥塞，丢弃${n}条；存在缺口。`});if(!e)return;dropped=0;if(!add(e))dropped+=n;}
let pumpPromise=null;
function pump(){
  if(pumpPromise)return pumpPromise;
  if(!session||!queue.length)return Promise.resolve();
  pumpPromise=pumpOnce().finally(()=>{pumpPromise=null;});return pumpPromise;
}
async function pumpOnce(){
  const current=session,target=queue,batch=target.slice(0,2);
  try{
    const r=await fetch(`${endpoint}/sessions/${current.id}/events`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${current.token}`},body:JSON.stringify({events:batch}),signal:AbortSignal.timeout(4000)});
    if(r.status===413){await chrome.storage.session.set({lastError:'音画采集达到本地配额，已自动停止。'});void chrome.runtime.sendMessage({type:'CAPTURE_ENDED'}).catch(()=>{});return;}
    if(!r.ok)throw new Error('ingest rejected');
    if(session===current&&queue===target){target.splice(0,batch.length);flushDrops();}
  }catch{}
}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
function pcm({samples,sampleRate,generation,audioEndTime}){
  if(stoppingCapture||!session||!mapping||mapping.paused||generation!==pcmGeneration||!ctx||ctx.state!=='running'||Date.now()<blockedUntil)return;
  if(!(samples instanceof Float32Array)||!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000||samples.length<sampleRate*0.001||samples.length>sampleRate*1.25||!Number.isFinite(audioEndTime))return;
  const audioLag=ctx.currentTime-audioEndTime;
  if(!Number.isFinite(audioLag)||audioLag < -0.05||audioLag>2.5)return;
  const length=Math.floor(samples.length*16000/sampleRate),buf=new ArrayBuffer(length*2),dv=new DataView(buf);
  for(let i=0;i<length;i++){
    const from=Math.floor(i*sampleRate/16000),to=Math.min(samples.length,Math.floor((i+1)*sampleRate/16000));let value=0;
    for(let j=from;j<to;j++)value+=samples[j];value/=Math.max(1,to-from);value=Math.max(-1,Math.min(1,value));dv.setInt16(i*2,Math.round(value*(value<0?32768:32767)),true);
  }
  const e=make('audio',{data:base64(new Uint8Array(buf)),sampleRate:16000,channels:1,duration:length/16000,playbackRate:mapping?.rate||1});
  if(e){e.videoTime=Math.max(0,e.videoTime-(length/16000+Math.max(0,audioLag))*(mapping?.rate||1));add(e);}
}
let frameBusy=false,frameBaseline=null,frameKey='',lastFrameGap='',lastFrameGapAt=0;
function frame(){
  const event=make('frame'),owner=session;
  if(frameBusy||!video||video.readyState<2||!event)return;
  const rect=mapping.videoRect?{...mapping.videoRect}:null,crop=framePolicy.cropFor(rect,video.videoWidth,video.videoHeight);
  if(!crop){
    if(lastFrameGap!=='geometry'||Date.now()-lastFrameGapAt>=30000){
      lastFrameGap='geometry';lastFrameGapAt=Date.now();
      add(make('gap',{media:'frame',text:'视频区域不可用或截图尺寸与视口不匹配；已跳过画面，未回退整标签页。'}));
    }
    frameBaseline=null;frameKey='';return;
  }
  lastFrameGap='';
  const key=framePolicy.geometryKey(rect)+':'+crop.sourceWidth+':'+crop.sourceHeight;
  if(key!==frameKey){frameBaseline=null;frameKey=key;}
  const w=crop.outputWidth,h=crop.outputHeight;
  frameBusy=true;
  (async()=>{
    const canvas=new OffscreenCanvas(w,h),c=canvas.getContext('2d');
    c.drawImage(video,crop.x,crop.y,crop.width,crop.height,0,0,w,h);
    const thumb=new OffscreenCanvas(32,18),tc=thumb.getContext('2d',{willReadFrequently:true});
    tc.drawImage(canvas,0,0,32,18);
    const sample=framePolicy.sampleLuma(tc.getImageData(0,0,32,18).data);
    const decision=framePolicy.frameDecision(frameBaseline,sample,event.captureTime);
    if(!decision.keep)return;
    const blob=await canvas.convertToBlob({type:'image/jpeg',quality:0.55});
    const data=base64(new Uint8Array(await blob.arrayBuffer()));
    if(stoppingCapture||session!==owner||mapping?.epoch!==event.epoch||mapping.paused||
      Date.now()-mapping.wallTime>2500||framePolicy.geometryKey(mapping.videoRect)!==framePolicy.geometryKey(rect)||
      video?.videoWidth!==crop.sourceWidth||video?.videoHeight!==crop.sourceHeight)return;
    const {outputWidth,outputHeight,...sourceCrop}=crop;
    if(add({...event,data:'data:image/jpeg;base64,'+data,scope:'visible_video_region',
      crop:sourceCrop,width:w,height:h,change:{method:'luma32x18',reason:decision.reason,score:decision.score}})){
      frameBaseline={sample,at:event.captureTime};
    }
  })().catch(()=>{
    if(session===owner&&mapping?.epoch===event.epoch)add(make('gap',{media:'frame',text:'视频区域编码失败；本次画面缺失。'}));
  }).finally(()=>{frameBusy=false;});
}
async function stop({drain=false}={}){
  stoppingCapture=true;pcmGeneration++;clearInterval(timer);timer=undefined;
  const old=stream;stream=null;
  if(old)old.getTracks().forEach(t=>{t.onended=null;t.stop();});
  node?.disconnect();node=null;if(ctx)await ctx.close().catch(()=>{});ctx=null;
  if(video){video.pause();video.srcObject=null;video=null;}
  const droppedAtStop=dropped,partialAudioDiscarded=!!session?.audio,deadline=Date.now()+3000;
  if(drain){let attempts=0;while(queue.length&&attempts++<5&&Date.now()<deadline){
    let timer;await Promise.race([pump(),new Promise(r=>{timer=setTimeout(r,Math.max(0,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));
  }}
  const report={drained:queue.length===0,remaining:queue.length,dropped:droppedAtStop,partialAudioDiscarded};
  session=null;mapping=null;queue=[];lastFrame='';frameBaseline=null;frameKey='';lastFrameGap='';return report;
}
async function start(msg){
  await stop();stoppingCapture=false;session=msg.session;dropped=0;blockedUntil=Date.now();
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      audio:session.audio?{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:msg.streamId}}:false,
      video:session.frames?{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:msg.streamId,maxWidth:1280,maxHeight:720,maxFrameRate:2}}:false
    });
    for(const track of stream.getTracks())track.onended=()=>{if(session)chrome.runtime.sendMessage({type:'CAPTURE_ENDED'}).catch(()=>{});};
    if(session.audio){
      ctx=new AudioContext();await ctx.audioWorklet.addModule('pcm-worklet.js');
      const source=ctx.createMediaStreamSource(stream);source.connect(ctx.destination); // preserve audible course playback
      node=new AudioWorkletNode(ctx,'pcm-collector');source.connect(node);const mute=ctx.createGain();mute.gain.value=0;node.connect(mute).connect(ctx.destination);
      node.port.onmessage=e=>pcm(e.data);resetPcm();await ctx.resume();
    }
    if(session.frames){video=document.createElement('video');video.muted=true;video.srcObject=stream;await video.play();}
    let ticks=0;timer=setInterval(()=>{void pump();if(session?.frames&&++ticks%5===0)frame();},1000);
  }catch(e){await stop();throw e;}
}
chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{
  if(msg.target!=='offscreen')return;
  if(msg.type==='TIMELINE'){
    const previous=mapping,next=msg.data;
    const boundary=!previous||previous.epoch!==next.epoch||previous.rate!==next.rate||previous.paused!==next.paused||Date.now()-previous.wallTime>2500;
    if(previous&&previous.epoch!==next.epoch){queue=[];frameBaseline=null;frameKey='';}
    mapping=next;if(boundary){blockedUntil=Date.now();resetPcm();}flushDrops();
    respond({ok:true});return;
  }
  const p=msg.type==='CAPTURE_START'?start(msg):stop({drain:msg.drain!==false});p.then(report=>respond({ok:true,...report})).catch(e=>respond({ok:false,error:e.message}));return true;
});