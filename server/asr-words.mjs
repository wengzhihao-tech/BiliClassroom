// Engine confidence is not fact correctness; all pipeline output remains provisional.
const finite=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
export function normalizeAsrResult(result,w){
 if(typeof result==='string')return {text:result};
 if(!result||typeof result.text!=='string')throw Error('invalid ASR result');
 if(result.words===undefined)return {text:result.text};
 if(!Array.isArray(result.words)||result.words.length>256||w.sampleRate!==16000||!finite(w.audioDuration,0.001,30)||!finite(w.playbackRate,0.1,16)||!finite(w.videoTime,0,864000)||!Array.isArray(w.spans)||w.spans.length>100)throw Error('invalid ASR word window');
 let offset=0;const spans=w.spans.map(p=>{
  if(typeof p.id!=='string'||!Number.isInteger(p.startSample)||!Number.isInteger(p.endSample)||p.startSample<0||p.endSample<=p.startSample)throw Error('invalid ASR spans');
  const s={...p,offset};offset+=p.endSample-p.startSample;return s;
 });
 const samples=Math.round(w.audioDuration*16000);if(offset!==samples)throw Error('ASR source length mismatch');
 const sourceTiming=spans.some(s=>s.videoTime!==undefined||s.playbackRate!==undefined);
 if(sourceTiming&&!spans.every(s=>finite(s.videoTime,0,864000)&&s.playbackRate===w.playbackRate))throw Error('invalid audio source timing');
 let previous=-1;
 const words=result.words.map(p=>{
  if(!p||typeof p.word!=='string'||!p.word||p.word.length>100||!finite(p.start,0,w.audioDuration)||!finite(p.end,0,w.audioDuration+0.05)||p.end<=p.start||p.start<previous||!finite(p.conf,0,1))throw Error('invalid ASR word');
  previous=p.start;const start=p.start,end=Math.min(w.audioDuration,p.end),from=Math.floor(start*16000),to=Math.min(samples,Math.ceil(end*16000));
  const intervals=[];
  const sourceSpans=spans.flatMap(s=>{const left=Math.max(from,s.offset),right=Math.min(to,s.offset+s.endSample-s.startSample);if(sourceTiming&&right>left)intervals.push({start:s.videoTime+(s.startSample+left-s.offset)/16000*s.playbackRate,end:s.videoTime+(s.startSample+right-s.offset)/16000*s.playbackRate});return right>left?[{id:s.id,startSample:s.startSample+left-s.offset,endSample:s.startSample+right-s.offset}]:[];});
  if(!sourceSpans.length)throw Error('ASR word has no source');
  return {word:p.word,start,end,confidence:p.conf,videoStart:sourceTiming?Math.min(...intervals.map(x=>x.start)):w.videoTime+start*w.playbackRate,videoEnd:sourceTiming?Math.max(...intervals.map(x=>x.end)):w.videoTime+end*w.playbackRate,sourceSpans};
 });
 return {text:result.text,words,audioDuration:w.audioDuration,playbackRate:w.playbackRate,windowStart:w.videoTime,windowEnd:w.videoTime+w.audioDuration*w.playbackRate,
 timing:sourceTiming?'audio_sample_sources_envelope_not_browser_verified':'engine_words_rate_projection_not_browser_verified',engine:String(result.engine||'unknown').slice(0,80),...(finite(result.recognitionMs,0,60000)?{recognitionMs:result.recognitionMs}:{})};
}
export function wordMetadata(raw,e){
 const sourceTiming=raw.timing==='audio_sample_sources_envelope_not_browser_verified';
 if(!Array.isArray(raw.words)||raw.words.length>256||!finite(raw.audioDuration,0.001,30)||!finite(raw.playbackRate,0.1,16)||raw.windowStart!==e.videoTime||
  !finite(raw.windowEnd,0,864000)||Math.abs(raw.windowEnd-e.videoTime-raw.audioDuration*raw.playbackRate)>0.001)throw Error('invalid ASR window');
 let previous=-1;
 const words=raw.words.map(w=>{
  if(!w||typeof w.word!=='string'||!w.word||w.word.length>100||!finite(w.start,0,raw.audioDuration)||!finite(w.end,0,raw.audioDuration)||w.end<=w.start||w.start<previous||!finite(w.confidence,0,1)||
   !finite(w.videoStart,0,864000)||!finite(w.videoEnd,0,864000)||w.videoEnd<=w.videoStart||(!sourceTiming&&(Math.abs(w.videoStart-e.videoTime-w.start*raw.playbackRate)>0.001||Math.abs(w.videoEnd-e.videoTime-w.end*raw.playbackRate)>0.001))||
   !Array.isArray(w.sourceSpans)||!w.sourceSpans.length||w.sourceSpans.length>100)throw Error('invalid ASR word');
  previous=w.start;
  const sourceSpans=w.sourceSpans.map(p=>{
   if(!p||typeof p.id!=='string'||!e.sourceEventIds.includes(p.id)||!Number.isInteger(p.startSample)||!Number.isInteger(p.endSample)||p.startSample<0||p.endSample<=p.startSample||p.endSample>64000)throw Error('invalid ASR source span');
   return {id:p.id,startSample:p.startSample,endSample:p.endSample};
  });
  return {word:w.word,start:w.start,end:w.end,confidence:w.confidence,videoStart:w.videoStart,videoEnd:w.videoEnd,sourceSpans};
 });
 if(raw.recognitionMs!==undefined&&!finite(raw.recognitionMs,0,60000))throw Error('invalid ASR timing');
 return {words,audioDuration:raw.audioDuration,playbackRate:raw.playbackRate,windowStart:raw.windowStart,windowEnd:raw.windowEnd,timing:sourceTiming?'audio_sample_sources_envelope_not_browser_verified':'engine_words_rate_projection_not_browser_verified',engine:String(raw.engine||'unknown').slice(0,80),...(raw.recognitionMs!==undefined?{recognitionMs:raw.recognitionMs}:{})};
}
export function validateWordSources(e,session){
 for(const w of e.words||[]){
  const intervals=[];
  for(const p of w.sourceSpans){
   const a=session.events.find(x=>x.id===p.id&&x.kind==='audio'&&x.epoch===e.epoch);
   if(!a||p.endSample>Buffer.from(a.data,'base64').length/2)throw Error('ASR source sample out of range');
   const start=a.videoTime+p.startSample/16000*a.playbackRate,end=a.videoTime+p.endSample/16000*a.playbackRate;
   intervals.push({start,end});
   if(e.timing==='audio_sample_sources_envelope_not_browser_verified'){
    if(a.playbackRate!==e.playbackRate)throw Error('ASR source rate mismatch');
   }else if(start<w.videoStart-0.051||end>w.videoEnd+0.051)throw Error('ASR source video time mismatch');
  }
  if(e.timing==='audio_sample_sources_envelope_not_browser_verified'&&
   (Math.abs(w.videoStart-Math.min(...intervals.map(x=>x.start)))>0.001||Math.abs(w.videoEnd-Math.max(...intervals.map(x=>x.end)))>0.001))throw Error('ASR sample envelope mismatch');
 }
}
