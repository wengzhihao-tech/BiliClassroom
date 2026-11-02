import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceOf,newSession,prepareEvents,commitEvents,contextFor} from '../server/core.mjs';
import {explain} from '../server/model.mjs';
const src={url:'https://www.bilibili.com/video/BV1AbCd?p=2&spm_id_from=private',title:'Synthetic PID lesson'};
const event=(id,kind='subtitle',epoch=0,t=10)=>({id,kind,epoch,videoTime:t,captureTime:1770000000000,text:'误差等于目标值减去测量值'});
test('canonical URL drops tracking and credentials',()=>assert.equal(sourceOf(src).url,'https://www.bilibili.com/video/BV1AbCd?p=2'));
for(const url of ['https://evil.example/video/BV1x','https://www.bilibili.com.evil.test/video/BV1x','http://www.bilibili.com/video/BV1x','https://www.bilibili.com/video/BV1x?p=0'])test('reject source '+url,()=>assert.throws(()=>sourceOf({url})));
test('duplicate event retry is idempotent',()=>{const s=newSession(src);const es=prepareEvents(s,[event('a'),event('a')]);assert.equal(es.length,1);commitEvents(s,es,20);assert.equal(prepareEvents(s,[event('a')]).length,0);});
test('seek epoch and future evidence excluded',()=>{const s=newSession(src);commitEvents(s,prepareEvents(s,[event('old','subtitle',0,10),event('new','subtitle',1,3),event('future','subtitle',1,60)]),0);assert.deepEqual(contextFor(s,{epoch:1,at:4}).evidence.map(e=>e.id),['new']);});
test('danmaku is counted but excluded from teacher evidence',()=>{const s=newSession(src);commitEvents(s,prepareEvents(s,[event('chat','danmaku')]),0);const c=contextFor(s);assert.equal(c.availability.danmaku,1);assert.equal(c.evidence.length,0);});
test('batch rejection is atomic',()=>{const s=newSession(src);assert.throws(()=>prepareEvents(s,[event('a'),{...event('b'),videoTime:NaN}]));assert.equal(s.events.length,0);});
test('stopped session cannot ingest',()=>{const s=newSession(src);s.closed=true;assert.throws(()=>prepareEvents(s,[event('a')]));});
test('audio validates sample rate and duration',()=>{const s=newSession(src);const a={...event('pcm','audio'),data:Buffer.alloc(32000).toString('base64'),sampleRate:16000,channels:1,duration:1};assert.equal(prepareEvents(s,[a])[0].duration,1);assert.throws(()=>prepareEvents(s,[{...a,duration:3}]));assert.throws(()=>prepareEvents(s,[{...a,sampleRate:48000}]));});
test('derived text needs original evidence',()=>assert.throws(()=>prepareEvents(newSession(src),[{...event('asr','asr'),sourceEventIds:['missing']}])));
test('context window bounded and invalid time rejected',()=>{const s=newSession(src);assert.throws(()=>contextFor(s,{window:301}));assert.throws(()=>contextFor(s,{at:-1}));});
test('model is not claimed if disabled',async()=>assert.equal((await explain(contextFor(newSession(src)),'解释',{})).status,'not_configured'));
test('no hallucinated text inference from capture counts',async()=>assert.equal((await explain(contextFor(newSession(src)),'解释',{BILICLASS_MODEL:'local'})).status,'insufficient_evidence'));
test('late recognition cannot rewind default playback context',()=>{
 const s=newSession(src);commitEvents(s,[{...event('clock','playback',0,100),rate:1,paused:false},event('now','subtitle',0,100),{...event('late','asr',0,0),stability:'provisional'}],0);
 const c=contextFor(s);assert.equal(c.at,100);assert.deepEqual(c.evidence.map(e=>e.id),['now']);assert.equal(c.provisionalEvidence.length,0);
 assert.equal(contextFor(s,{at:0}).provisionalEvidence.length,1);
});
test('without playback primary capture anchors context before delayed derived text',()=>{
 const s=newSession(src);commitEvents(s,[event('now','subtitle',0,20),{...event('old','ocr',0,2),sourceEventIds:['frame']}],0);
 assert.equal(contextFor(s).at,20);
 const only=newSession(src);commitEvents(only,[{...event('derived','ocr',0,2),sourceEventIds:['frame']}],0);assert.equal(contextFor(only).at,2);
});
test('latest playback arrival wins over max video time and earlier epochs',()=>{
 const s=newSession(src);commitEvents(s,[{...event('earlier','playback',0,500),rate:1,paused:false},{...event('clock','playback',1,10),rate:1,paused:true},event('future','subtitle',1,12),{...event('late','asr',1,0),stability:'provisional'}],0);
 const c=contextFor(s);assert.equal(c.epoch,1);assert.equal(c.at,10);assert.equal(c.evidence.length,0);
});
