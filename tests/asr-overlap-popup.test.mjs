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
