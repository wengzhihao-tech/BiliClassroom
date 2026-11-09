import test from 'node:test';import assert from 'node:assert/strict';
import {recognitionSummary} from '../extension/evidence-view.js';
import {provisionalTranscript} from '../server/asr-overlap.mjs';
test('popup consumes current aggregate and remains compatible with previous method',()=>{
 const w={word:'控制',videoStart:1,videoEnd:2,confidence:1,sourceSpans:[{id:'audio1',startSample:0,endSample:8000}]};
 const e=id=>({id,kind:'asr',epoch:0,engine:'vosk',playbackRate:1,stability:'provisional',windowStart:0,words:[w]});
 const view=provisionalTranscript([e('a'),e('b')]);
 assert.equal(view.method,'exact_text_all_observations_sample_iou_0.5');
 for(const method of [view.method,'exact_text_original_sample_iou_0.5']){
  const text=recognitionSummary({active:true,context:{provisionalTranscript:{...view,method},provisionalEvidence:[{id:'fallback',text:'FALLBACK',sourceEventIds:[]}]}});
  assert(text.includes('重叠已合并'));assert(text.includes('audio1[0,8000)'));assert(!text.includes('FALLBACK'));
 }
});

test('popup labels distinct-window agreement and keeps audio and event references',()=>{
 const word={word:'控制',videoStart:2,videoEnd:2.5,confidence:1,sourceSpans:[{id:'audio1',startSample:0,endSample:8000}]};
 const events=[0,2].map(windowStart=>({id:'asr-'+windowStart,kind:'asr',epoch:0,engine:'vosk',playbackRate:1,stability:'provisional',windowStart,words:[word]}));
 const view=provisionalTranscript(events);
 const text=recognitionSummary({active:true,context:{provisionalTranscript:view}});
 assert(text.includes('多窗口一致'));
 assert(text.includes('语音暂定'));
 assert(text.includes('asr-2#0'));
 assert(text.includes('audio1[0,8000)'));
 const legacy=structuredClone(view);
 delete legacy.groups[0].windowAgreement;
 assert(!recognitionSummary({active:true,context:{provisionalTranscript:legacy}}).includes('多窗口一致'));
});

test('word-scoped empty aggregate never falls back to out-of-range structured text',()=>{
 const status={active:true,context:{
  provisionalTranscript:{method:'exact_text_all_observations_sample_iou_0.5',groups:[],wordTimeScoped:true},
  provisionalEvidence:[{id:'structured',text:'FUTURE',words:[{}]},{id:'legacy',text:'LEGACY'}]
 }};
 const summary=recognitionSummary(status);
 assert(!summary.includes('FUTURE'));
 assert(summary.includes('LEGACY'));
});

test('speech summary distinguishes missing audio, processing, and service-wide skips',()=>{
 const status={active:true,context:{availability:{audioChunks:0},asrRuntime:{
  status:'configured_backend_unverified',currentSession:true,active:true,pending:true,
  inputGate:{skippedWindows:3},queue:{replaced:2}
 }}};
 const text=recognitionSummary(status);
 for(const expected of ['当前时间窗未收到音频片段','正在识别，有一个窗口等待处理','服务启动以来','能量筛选跳过 3','排队被替换 2'])assert(text.includes(expected));
});
test('speech summary differentiates faults and tolerates older context payloads',()=>{
 for(const [status,label] of [['disabled_no_backend','未连接本地识别后端'],['blocked_backend_timeout','识别任务超时'],['blocked_backend_errors','识别后端连续失败'],[undefined,'状态未知']]){
  const text=recognitionSummary({active:true,context:{asrRuntime:{status,active:true,pending:true}}});
  assert(text.includes(label));
  assert(!text.includes('正在识别'));
 }
 const historical=recognitionSummary({active:true,context:{asrRuntime:{
  status:'configured_backend_unverified',currentSession:false,active:true,pending:true,inputGate:{skippedWindows:4},queue:{replaced:3}
 }}});
 assert(historical.includes('输出待核验'));
 assert(!historical.includes('正在识别'));
 assert(!historical.includes('服务启动以来'));
});
