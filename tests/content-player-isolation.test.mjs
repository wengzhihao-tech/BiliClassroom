import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

function collector(){
  let listener,tick;
  const sent=[],location={href:'https://www.bilibili.com/video/BV1x?p=1'};
  function player(time){
    const handlers=new Map();
    return {currentTime:time,paused:false,playbackRate:1,textTracks:[],
      addEventListener(name,fn){handlers.set(name,fn);},
      fire(name){handlers.get(name)?.();}};
  }
  let current=player(5);
  const document={querySelector:()=>current,querySelectorAll:()=>[],visibilityState:'hidden'};
  const chrome={runtime:{onMessage:{addListener:fn=>listener=fn},
    sendMessage:async msg=>{sent.push(msg);return {ok:true};}}};
  vm.runInNewContext(readFileSync(new URL('../extension/content.js',import.meta.url),'utf8'),
    {chrome,document,location,URL,Date,crypto:{randomUUID},setInterval:fn=>tick=fn,setTimeout,clearTimeout});
  return {sent,location,player,tick:()=>tick(),get current(){return current;},
    replace(v){current=v;},start(sessionId='synthetic-session'){listener({type:'COLLECT_START',sessionId},{},()=>{});}};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
test('replaced player events cannot change current epoch or offscreen timeline',async()=>{
  const c=collector();c.start();await settled();
  const old=c.current,next=c.player(50);c.replace(next);c.tick();await settled();
  const before=c.sent.length;
  for(const event of ['seeking','pause','play','ratechange','waiting','ended'])old.fire(event);
  await settled();
  assert.equal(c.sent.length,before,'detached player must produce no messages');
  next.currentTime=60;next.fire('seeking');c.tick();await settled();
  const timelines=c.sent.filter(m=>m.type==='TIMELINE');
  assert.equal(timelines.at(-1).data.epoch,2,'replacement and current seek each increment once');
  assert.equal(timelines.at(-1).data.videoTime,60);
  assert(c.sent.filter(m=>m.type==='EVENTS').flatMap(m=>m.events).some(e=>e.reason==='seeking'&&e.epoch===2));
});
test('source navigation blocks player events before the next polling tick',async()=>{
  const c=collector();c.start();await settled();
  c.location.href='https://www.bilibili.com/video/BV2y?p=2';
  const before=c.sent.length;
  c.current.fire('seeking');c.current.fire('pause');await settled();
  assert.equal(c.sent.length,before,'old course callbacks must not forward a new timeline');
  c.tick();await settled();
  assert.equal(c.sent.at(-1).type,'SOURCE_CHANGED');
});
test('current player pause and rate changes still reach the timeline',async()=>{
  const c=collector();c.start();await settled();
  c.current.paused=true;c.current.fire('pause');
  c.current.playbackRate=2;c.current.fire('ratechange');await settled();
  const timelines=c.sent.filter(m=>m.type==='TIMELINE');
  assert.equal(timelines.at(-1).data.paused,true);
  assert.equal(timelines.at(-1).data.rate,2);
  assert.equal(timelines.at(-1).data.epoch,0);
});

test('content attaches the original capture ID to each outgoing message',async()=>{
 const c=collector();c.start('first');await settled();
 c.location.href='https://www.bilibili.com/video/BV2y?p=2';c.tick();await settled();
 assert.deepEqual(c.sent.map(m=>m.type),['TIMELINE','EVENTS','SOURCE_CHANGED']);
 assert(c.sent.every(m=>m.sessionId==='first'));
 c.start('second');await settled();
 assert(c.sent.slice(3).every(m=>m.sessionId==='second'));
});
