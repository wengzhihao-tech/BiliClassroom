import {provisionalTranscript} from './asr-overlap.mjs';
import {wordMetadata,validateWordSources} from './asr-words.mjs';
import {randomUUID} from 'node:crypto';

export class InputError extends Error {}
const kinds = new Set(['playback','subtitle','danmaku','frame','audio','gap','asr','ocr']);
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const finite = (v, min=0, max=864000) => Number.isFinite(v) && v >= min && v <= max;
export function sourceOf(raw) {
  if (!plain(raw)) throw new InputError('source required');
  let u; try { u = new URL(raw.url); } catch { throw new InputError('invalid course URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'www.bilibili.com' || !/^\/video\/BV[a-zA-Z0-9]+\/?$/.test(u.pathname)) throw new InputError('only Bilibili video pages supported');
  const page = Number(u.searchParams.get('p') || 1);
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new InputError('invalid part');
  return {url:`https://www.bilibili.com${u.pathname}?p=${page}`,bvid:u.pathname.split('/')[2],part:page,title:String(raw.title||'').slice(0,300)};
}
export function newSession(raw) {
  const source=sourceOf(raw),ocrLanguage=raw.ocrLanguage??'zh-Hans-CN';
  if(!['zh-Hans-CN','en-US'].includes(ocrLanguage))throw new InputError('unsupported OCR language');
  return {id:randomUUID(),source,ocrLanguage,createdAt:new Date().toISOString(),closed:false,events:[],ids:new Set(),bytes:0,lastEpoch:0};
}
export function validateEvent(raw) {
  if (!plain(raw) || !kinds.has(raw.kind)) throw new InputError('unknown event kind');
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.id)) throw new InputError('invalid event id');
  if (!Number.isSafeInteger(raw.epoch) || raw.epoch < 0 || raw.epoch > 100000) throw new InputError('invalid epoch');
  if (!finite(raw.videoTime) || !finite(raw.captureTime,0,1e16)) throw new InputError('invalid timestamps');
  const e = {id:raw.id,kind:raw.kind,epoch:raw.epoch,videoTime:raw.videoTime,captureTime:raw.captureTime};
  if (['subtitle','danmaku','asr','ocr','gap'].includes(e.kind)) {
    if(typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 12000) throw new InputError('invalid text');
    e.text=raw.text; e.source=e.kind==='subtitle'?'visible_player_caption':e.kind;
    if (['asr','ocr'].includes(e.kind)) e.sourceEventIds=Array.isArray(raw.sourceEventIds)?raw.sourceEventIds.filter(x=>typeof x==='string').slice(0,100):[];
  }
  if(e.kind==='ocr'){
    // Recognition is uncertain, including legacy OCR without an explicit quality field.
    e.quality='unverified';e.confidence=null;
    if(raw.rawText!==undefined){if(typeof raw.rawText!=='string'||raw.rawText.length>12000)throw new InputError('invalid raw OCR text');e.rawText=raw.rawText;}
    if(raw.engine!==undefined)e.engine=String(raw.engine).slice(0,80);
    if(raw.language!==undefined)e.language=String(raw.language).slice(0,40);
    if(raw.words!==undefined){
      if(!Array.isArray(raw.words)||raw.words.length>2000||!Number.isInteger(raw.width)||!Number.isInteger(raw.height)||!finite(raw.width,1,960)||!finite(raw.height,1,960))throw new InputError('invalid OCR dimensions');
      e.width=raw.width;e.height=raw.height;
      e.words=raw.words.map(w=>{
        if(!plain(w)||typeof w.text!=='string'||w.text.length>500||!['x','y','width','height'].every(k=>finite(w[k],0,961))||w.width<=0||w.height<=0||w.x+w.width>raw.width+1||w.y+w.height>raw.height+1)throw new InputError('invalid OCR word bounds');
        return {text:w.text,x:w.x,y:w.y,width:w.width,height:w.height};
      });
    }
    for(const k of ['recognitionMs','totalMs'])if(raw[k]!==undefined){if(!finite(raw[k],0,60000))throw new InputError('invalid OCR timing');e[k]=raw[k];}
  }
  if(e.kind==='gap'){
    if(raw.media!==undefined&&!['all','audio','frame'].includes(raw.media))throw new InputError('invalid gap media');
    e.media=raw.media||'all';
  }
  if(e.kind==='asr'){
    if(raw.stability!==undefined&&!['provisional','stable'].includes(raw.stability))throw new InputError('invalid ASR stability');
    e.stability=raw.stability||'provisional';
    if(raw.words!==undefined){try{Object.assign(e,wordMetadata(raw,e));}catch{throw new InputError('invalid ASR word metadata');}}
  }
  if (e.kind === 'playback') {
    if (!finite(raw.rate,0.1,16) || typeof raw.paused !== 'boolean') throw new InputError('invalid playback');
    Object.assign(e,{rate:raw.rate,paused:raw.paused,reason:String(raw.reason||'tick').slice(0,80)});
  }
  if (e.kind === 'frame') {
    if(typeof raw.data !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(raw.data) || raw.data.length>800000) throw new InputError('invalid JPEG frame');
    Object.assign(e,{data:raw.data,scope:'visible_tab_frame'});
    if(raw.scope==='visible_video_region'){
      const c=raw.crop;
      if(!plain(c)||!['x','y','width','height','sourceWidth','sourceHeight'].every(k=>Number.isInteger(c[k])&&finite(c[k],0,16384))||
        c.width<16||c.height<16||c.sourceWidth<32||c.sourceHeight<32||c.x+c.width>c.sourceWidth||c.y+c.height>c.sourceHeight||
        !Number.isInteger(raw.width)||!Number.isInteger(raw.height)||!finite(raw.width,1,960)||!finite(raw.height,1,960)||
        Math.abs((raw.width/raw.height)/(c.width/c.height)-1)>0.05)throw new InputError('invalid video crop');
      const change=raw.change;
      if(!plain(change)||change.method!=='luma32x18'||!['first','changed','heartbeat'].includes(change.reason)||!finite(change.score,0,1))throw new InputError('invalid frame change');
      e.scope=raw.scope;e.crop=Object.fromEntries(['x','y','width','height','sourceWidth','sourceHeight'].map(k=>[k,c[k]]));
      e.width=raw.width;e.height=raw.height;e.change={method:change.method,reason:change.reason,score:change.score};
    }else if(raw.scope!==undefined&&raw.scope!=='visible_tab_frame')throw new InputError('invalid frame scope');
  }
  if (e.kind === 'audio') {
    if(raw.sampleRate!==16000 || raw.channels!==1 || typeof raw.data!=='string' || !/^[A-Za-z0-9+/=]+$/.test(raw.data)) throw new InputError('invalid PCM audio');
    if(raw.data.length>Math.ceil(128000/3)*4)throw new InputError('PCM encoding too large');
    const decoded=Buffer.from(raw.data,'base64'),canonical=decoded.toString('base64');
    if(raw.data!==canonical&&raw.data!==canonical.replace(/=+$/,''))throw new InputError('invalid PCM base64');
    const n=decoded.length;
    if(n<2 || n>16000*2*4 || n%2 || !finite(raw.duration,0.001,4) || Math.abs(n/32000-raw.duration)>0.02) throw new InputError('audio length mismatch');
    const playbackRate=raw.playbackRate??1;
    if(!finite(playbackRate,0.1,16))throw new InputError('invalid audio playback rate');
    Object.assign(e,{data:raw.data,sampleRate:16000,channels:1,duration:raw.duration,playbackRate,encoding:'s16le'});
  }
  return e;
}
export function prepareEvents(session, raws) {
  if (session.closed) throw new InputError('session stopped');
  if (!Array.isArray(raws) || raws.length<1 || raws.length>30) throw new InputError('batch must contain 1..30 events');
  const accepted=[], seen=new Set(session.ids);
  for(const raw of raws) {
    const e=validateEvent(raw);
    if(seen.has(e.id)) continue;
    if(['asr','ocr'].includes(e.kind)) {
      const kind=e.kind==='asr'?'audio':'frame';
      if(!e.sourceEventIds.length || e.sourceEventIds.some(id=>!session.events.some(p=>p.id===id&&p.kind===kind&&p.epoch===e.epoch))) throw new InputError('derived event needs original evidence from same epoch');
    }
    if(e.kind==='asr'&&e.words){try{validateWordSources(e,session);}catch{throw new InputError('invalid ASR word source');}}
    accepted.push({...e,receivedAt:new Date().toISOString()}); seen.add(e.id);
  }
  return accepted;
}
export function commitEvents(s,events,bytes) {
  for(const e of events){s.ids.add(e.id);s.events.push(e);s.lastEpoch=Math.max(s.lastEpoch,e.epoch);}
  s.bytes+=bytes;
  // Memory is bounded separately from the durable event journal. IDs retained for deduplication.
  if(s.events.length>2400)s.events.splice(0,s.events.length-2400);
}
export function contextFor(s,{epoch=s.lastEpoch,at,window=90}={}) {
  if(!Number.isSafeInteger(epoch)||epoch<0 || !finite(window,1,300) || (at!==undefined&&!finite(at))) throw new InputError('invalid context window');
  const same=s.events.filter(e=>e.epoch===epoch);
  // Derived recognition may arrive late; it must not move the playback cursor backwards.
  const anchor=same.findLast(e=>e.kind==='playback') ??
    same.findLast(e=>e.kind!=='asr'&&e.kind!=='ocr') ?? same.at(-1);
  at ??= anchor?.videoTime ?? 0;
  const from=Math.max(0,at-window), to=at+0.25;
  const es=same.filter(e=>e.videoTime<=to && e.videoTime>=from);
  const count=k=>es.filter(e=>e.kind===k).length;
  const evidence=es.filter(e=>['subtitle','asr'].includes(e.kind)&&(e.kind!=='asr'||e.stability==='stable')).slice(-80).map(e=>({id:e.id,kind:e.kind,videoTime:e.videoTime,text:e.text,sourceEventIds:e.sourceEventIds||[],...(e.kind==='asr'?{stability:e.stability}:{})}));
  return {sessionId:s.id,source:s.source,ocrLanguage:s.ocrLanguage||'zh-Hans-CN',epoch,at,window,closed:s.closed,evidence,
    ocrEvidence:es.filter(e=>e.kind==='ocr').slice(-20).map(e=>({id:e.id,kind:e.kind,videoTime:e.videoTime,text:e.text,rawText:e.rawText,sourceEventIds:e.sourceEventIds||[],quality:'unverified',confidence:null,engine:e.engine,language:e.language})),
    provisionalTranscript:provisionalTranscript(same,{from,to}),
    provisionalEvidence:es.filter(e=>e.kind==='asr'&&e.stability!=='stable').slice(-20).map(e=>({id:e.id,kind:e.kind,videoTime:e.videoTime,text:e.text,sourceEventIds:e.sourceEventIds||[],stability:'provisional',...(e.words?{words:e.words,windowStart:e.windowStart,windowEnd:e.windowEnd,audioDuration:e.audioDuration,playbackRate:e.playbackRate,timing:e.timing,engine:e.engine}:{})})),
    availability:{subtitle:count('subtitle'),audioChunks:count('audio'),frames:count('frame'),asr:es.filter(e=>e.kind==='asr'&&e.stability==='stable').length,asrProvisional:es.filter(e=>e.kind==='asr'&&e.stability!=='stable').length,ocr:count('ocr'),danmaku:count('danmaku')},
    gaps:es.filter(e=>e.kind==='gap').map(e=>({videoTime:e.videoTime,text:e.text,media:e.media||'all'})),
    limitations:['采集到的音频和画面不等于已识别或已理解。','字幕为播放器显示文本，未人工校对。','弹幕不作为教师陈述。','OCR为未核验识别文字，独立列出；符号、行序和公式可能有误。','当前内存窗口最多保留2400个事件，完整证据见本地日志。']};
}
