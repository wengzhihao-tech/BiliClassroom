import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {newSession} from '../server/core.mjs';import {createApp} from '../server/index.mjs';import {recognitionSummary} from '../extension/evidence-view.js';
const source={url:'https://www.bilibili.com/video/BV1synthetic'};
test('OCR language whitelist preserves backward-compatible Chinese default',()=>{
 assert.equal(newSession(source).ocrLanguage,'zh-Hans-CN');assert.equal(newSession({...source,ocrLanguage:'en-US'}).ocrLanguage,'en-US');
 for(const ocrLanguage of ['invalid','en-US; command',{},1])assert.throws(()=>newSession({...source,ocrLanguage}));
});
test('HTTP session language reaches OCR backend and survives closed archive recovery',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'bili-language-'));let app,seen;
 const start=async ocrBackend=>{app=createApp({dataDir:dir,token:'synthetic',ocrBackend});await new Promise(r=>app.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+app.address().port;};
 let base=await start(async(_f,opts)=>{seen=opts.language;return{text:'synthetic',language:opts.language};});
 const req=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer synthetic',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
 try{
  assert.equal((await req('/sessions',{...source,ocrLanguage:'invalid'})).status,400);
  const {id}=(await req('/sessions',{...source,ocrLanguage:'en-US'})).data;
  await req('/sessions/'+id+'/events',{events:[{id:'frame',kind:'frame',epoch:0,videoTime:10,captureTime:1,scope:'visible_video_region',data:'data:image/jpeg;base64,AQID',
   crop:{x:0,y:0,width:960,height:540,sourceWidth:960,sourceHeight:540},width:960,height:540,change:{method:'luma32x18',reason:'first',score:1}}]});
  let c;for(let i=0;i<100;i++){c=(await req('/sessions/'+id+'/context')).data;if(c.ocrEvidence.length)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(seen,'en-US');assert.equal(c.ocrEvidence[0].language,'en-US');assert.equal(c.ocrLanguage,'en-US');assert.equal(c.evidence.length,0);
  assert.equal(JSON.parse(readFileSync(path.join(dir,'sessions',id,'session.json'))).ocrLanguage,'en-US');
  await req('/sessions/'+id+'/stop',{});await new Promise(r=>app.close(r));base=await start(null);
  const recovered=(await req('/sessions/'+id+'/context')).data;assert.equal(recovered.ocrLanguage,'en-US');assert.equal(recovered.closed,true);assert.equal(recovered.ocrEvidence[0].quality,'unverified');
 }finally{await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});}
});
test('recognition summary keeps uncertainty video time and original media IDs visible',()=>{
 const text=recognitionSummary({active:true,context:{ocrLanguage:'en-US',ocrRuntime:{status:'configured_backend_unverified'},evidence:[],ocrEvidence:[{id:'ocr1',videoTime:12.5,text:'<img src=x onerror=evil()>',sourceEventIds:['frame1']}],provisionalEvidence:[{id:'asr1',videoTime:11,text:'draft',sourceEventIds:['audio1']}]}});
 for(const expected of ['英文/代码','OCR未核验','语音暂定','12.5秒','frame1','audio1','<img src=x'])assert(text.includes(expected));
 assert(recognitionSummary({active:false}).includes('尚未采集'));
});
test('popup opens without capture, stores language choice and renders evidence as literal text',async()=>{
 const elements=new Map(),messages=[],settings={pairToken:'a'.repeat(64),ocrLanguage:'zh-Hans-CN'};
 const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{value:'',checked:true,textContent:''});return elements.get(id);}};
 const status={active:true,context:{ocrLanguage:'en-US',ocrRuntime:{status:'configured_backend_unverified'},ocrEvidence:[{id:'ocr1',videoTime:3,text:'<script>evil()</script>',sourceEventIds:['frame1']}]}};
 const chrome={storage:{local:{get:async()=>settings,set:async x=>Object.assign(settings,x)}},tabs:{query:async()=>[{id:7}]},runtime:{sendMessage:async m=>{messages.push(m);return m.type==='STATUS'?status:{ok:true};}}};
 const code=readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
 await vm.runInNewContext('(async()=>{'+code+'})()',{document,chrome,recognitionSummary});
 assert.deepEqual(messages.map(m=>m.type),['STATUS']);assert(elements.get('evidence').textContent.includes('<script>evil()</script>'));
 elements.get('ocrLanguage').value='en-US';await elements.get('ocrLanguage').onchange();assert.equal(settings.ocrLanguage,'en-US');assert.equal(messages.length,1);
 await elements.get('start').onclick();assert.equal(messages.find(m=>m.type==='START').ocrLanguage,'en-US');
});
test('aggregated provisional view replaces duplicate raw text and exposes conflicting alternatives and PCM refs',()=>{
 const observation=(id)=>({eventId:id,wordIndex:1,sourceSpans:[{id:'audio1',startSample:100,endSample:8000}]});
 const context={provisionalEvidence:[{id:'raw',videoTime:0,text:'RAW DUPLICATE',sourceEventIds:['audio1']}],
 provisionalTranscript:{method:'exact_text_original_sample_iou_0.5',groups:[
 {id:'g1',word:'控制',videoStart:1,videoEnd:2,observations:[observation('asr1'),observation('asr2')],conflicts:['g2']},
 {id:'g2',word:'空置',videoStart:1,videoEnd:2,observations:[observation('asr3')],conflicts:['g1']}
 ]}};
 const text=recognitionSummary({active:true,context});
 assert(!text.includes('RAW DUPLICATE'));
 for(const expected of ['重叠已合并','仍未核验','不是稳定提交','存在冲突：空置','存在冲突：控制','asr1#1','asr2#1','audio1[100,8000)','1.0秒–2.0秒'])assert(text.includes(expected));
 assert.equal(context.provisionalEvidence[0].text,'RAW DUPLICATE');
});
test('unknown or empty aggregate format falls back to original provisional events',()=>{
 for(const provisionalTranscript of [undefined,{method:'future',groups:[]},{method:'exact_text_original_sample_iou_0.5',groups:[]}]){
  const text=recognitionSummary({active:true,context:{provisionalTranscript,provisionalEvidence:[{id:'legacy',videoTime:3,text:'original draft',sourceEventIds:['a1']}]}});
  assert(text.includes('original draft'));assert(text.includes('a1'));
 }
});
test('aggregate rendering is bounded and reveals both server and display truncation',()=>{
 const groups=Array.from({length:30},(_,i)=>({id:'g'+i,word:'WORD_'+i+'_END',videoStart:i,videoEnd:i+1,observations:Array.from({length:4},(_,j)=>({eventId:'e'+j,wordIndex:i,sourceSpans:[{id:'audio',startSample:0,endSample:100}]})),conflicts:[]}));
 const text=recognitionSummary({active:true,context:{provisionalTranscript:{method:'exact_text_original_sample_iou_0.5',groups,truncated:true}}});
 assert(text.includes('最近24组'));assert(text.includes('较早的6组'));assert(text.includes('范围已截断'));assert(text.includes('另有2次识别引用'));
 assert(!text.includes('WORD_0_END'));assert(text.includes('WORD_29_END'));assert(text.length<16000);
});
