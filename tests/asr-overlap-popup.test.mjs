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
