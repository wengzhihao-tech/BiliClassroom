import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
function collector(){
 let listener,timer,online=false;
 const batches=[],v={currentTime:0,paused:false,playbackRate:1,textTracks:[{activeCues:[]}],addEventListener(){}};
 const chrome={runtime:{onMessage:{addListener:f=>listener=f},sendMessage:async m=>{
  if(m.type==='EVENTS'){if(!online)return {error:'offline'};batches.push(m.events);return {ok:true};}return {ok:true};
 }}};
 vm.runInNewContext(readFileSync(new URL('../extension/content.js',import.meta.url),'utf8'),
 {chrome,document:{querySelector:()=>v,querySelectorAll:()=>[],visibilityState:'hidden'},location:{href:'https://www.bilibili.com/video/BV1x?p=1'},URL,Date,crypto:{randomUUID},setInterval:f=>timer=f,setTimeout,clearTimeout});
 return {batches,start:()=>listener({type:'COLLECT_START'},{},()=>{}),online:()=>online=true,
 caption:text=>v.textTracks[0].activeCues=text?[{text}]:[],tick:t=>{v.currentTime=t;timer();}};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('caption rejected by full queue is recaptured when capacity returns',async()=>{
 const c=collector();c.start();await turn();
 for(let i=1;i<=60;i++){c.tick(i);await turn();}
 c.caption('still visible after recovery');c.tick(61);await turn();
 c.online();c.tick(62);await turn();
 c.tick(63);await turn();
 for(let i=64;i<73;i++){c.tick(i);await turn();}
 const captions=c.batches.flat().filter(e=>e.kind==='subtitle');
 assert.equal(captions.length,1,'a dropped visible caption must be retried once');
 assert.equal(captions[0].text,'still visible after recovery');
 assert.equal(captions[0].videoTime,63,'recapture uses its actual observation time');
});
test('accepted captions deduplicate until caption disappears',async()=>{
 const c=collector();c.online();c.caption('same text');c.start();await turn();
 c.tick(1);await turn();c.tick(2);await turn();
 c.caption('');c.tick(3);await turn();
 c.caption('same text');c.tick(4);await turn();
 const captions=c.batches.flat().filter(e=>e.kind==='subtitle');
 assert.equal(captions.length,2);
 assert.deepEqual(captions.map(e=>e.videoTime),[0,4]);
});
