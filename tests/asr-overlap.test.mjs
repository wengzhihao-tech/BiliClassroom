import test from 'node:test';import assert from 'node:assert/strict';
import {provisionalTranscript} from '../server/asr-overlap.mjs';
import {contextFor} from '../server/core.mjs';
const word=(text='控制',start=0,end=8000,id='a')=>({word:text,videoStart:2+start/16000,videoEnd:2+end/16000,confidence:1,sourceSpans:[{id,startSample:start,endSample:end}]});
const event=(id,words=[word()],extra={})=>({id,kind:'asr',epoch:0,videoTime:0,windowStart:0,engine:'vosk',playbackRate:1,stability:'provisional',words,text:words.map(w=>w.word).join(' '),...extra});
test('shared PCM repeated word merges but retains both original hypotheses',()=>{
 const es=[event('old'),event('new',[word('控制',100,7900)],{windowStart:2,videoTime:2})],before=JSON.stringify(es),r=provisionalTranscript(es);
 assert.equal(r.groups.length,1);assert.equal(r.duplicates,1);assert.equal(r.groups[0].observations.length,2);assert.equal(JSON.stringify(es),before);assert.equal(r.stability,'provisional');
});
test('genuine repetitions at different audio samples and unrelated audio IDs survive',()=>{
 const r=provisionalTranscript([event('a',[word(),word('控制',9000,15000)]),event('b',[word('控制',0,8000,'b')])]);assert.equal(r.groups.length,3);assert.equal(r.duplicates,0);
});
test('conflicting words sharing original audio remain alternatives with bidirectional links',()=>{
 const r=provisionalTranscript([event('a'),event('b',[word('空置')])]);assert.equal(r.groups.length,2);assert.equal(r.conflictGroups,2);for(const g of r.groups)assert.equal(g.conflicts.length,1);
});
test('epoch rate engine audio gap and pause fence repeat aggregation',()=>{
 for(const extra of [{epoch:1},{playbackRate:2},{engine:'other'}])assert.equal(provisionalTranscript([event('a'),event('b',undefined,extra)]).groups.length,2);
 for(const fence of [{kind:'gap',media:'audio'},{kind:'gap',media:'all'},{kind:'playback',paused:true,rate:1}])assert.equal(provisionalTranscript([event('a'),fence,event('b')]).groups.length,2);
 assert.equal(provisionalTranscript([event('a'),{kind:'gap',media:'frame'},event('b')]).groups.length,1);
});
test('weak sample overlap never deletes nearby identical words; multi-chunk overlap merges',()=>{
 assert.equal(provisionalTranscript([event('a'),event('b',[word('控制',7000,15000)])]).groups.length,2);
 const a=word();a.sourceSpans=[{id:'a',startSample:14000,endSample:16000},{id:'b',startSample:0,endSample:6000}];
 const b=structuredClone(a);b.sourceSpans[1].endSample=5900;
 assert.equal(provisionalTranscript([event('a',[a]),event('b',[b])]).groups.length,1);
});
test('bounded view exposes truncation; no words legacy and stable events are not fabricated',()=>{
 assert.equal(provisionalTranscript(Array.from({length:9},(_,i)=>event('e'+i))).truncated,true);
 const r=provisionalTranscript([event('legacy',undefined,{words:undefined}),event('stable',undefined,{stability:'stable'})]);assert.equal(r.groups.length,0);
 const many=Array.from({length:3},(_,j)=>event('m'+j,Array.from({length:256},(_,i)=>word('w'+j+'_'+i,0,8000,'s'+j+'_'+i))));
 const capped=provisionalTranscript(many);assert.equal(capped.groups.length,512);assert.equal(capped.truncated,true);
});
test('context adds dedup view without changing raw provisional or teacher evidence',()=>{
 const s={id:'s',source:{},lastEpoch:0,closed:true,events:[event('a'),event('b',undefined,{windowStart:2,videoTime:2})]};
 const c=contextFor(s,{at:4});assert.equal(c.provisionalEvidence.length,2);assert.equal(c.provisionalTranscript.groups.length,1);assert.equal(c.evidence.length,0);
});

test('overlap chains do not collapse separate repeated words and preserve observations',()=>{
 const es=[event('old',[word('控制',0,9000)]),event('middle',[word('控制',3000,12000)]),event('new',[word('控制',6000,15000)])];
 const before=JSON.stringify(es),r=provisionalTranscript(es);
 assert.equal(r.groups.length,2);assert.equal(r.duplicates,1);
 assert.equal(r.groups.reduce((n,g)=>n+g.observations.length,0),3);
 assert.equal(JSON.stringify(es),before);assert(r.groups.every(g=>g.stability==='provisional'));
});
