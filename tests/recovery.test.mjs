import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.mjs';
import {newSession,contextFor} from '../server/core.mjs';
import {discoverSessions,hydrateSession} from '../server/recovery.mjs';
const ev=(id,epoch=0,t=4)=>({id,kind:'subtitle',epoch,videoTime:t,captureTime:1,text:'synthetic '+id});
function fixture(journal,{stopped=false}={}){
 const dir=mkdtempSync(path.join(tmpdir(),'biliclass-recovery-')),s=newSession({url:'https://www.bilibili.com/video/BV1Synthetic',title:'SYNTHETIC'});
 const folder=path.join(dir,'sessions',s.id);mkdirSync(folder,{recursive:true});
 writeFileSync(path.join(folder,'session.json'),JSON.stringify({id:s.id,source:s.source,createdAt:s.createdAt}));
 writeFileSync(path.join(folder,'events.jsonl'),journal);
 if(stopped)writeFileSync(path.join(folder,'stopped.json'),'{}');
 return {dir,id:s.id,file:path.join(folder,'events.jsonl'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
async function open(dir){const app=createApp({dataDir:dir,token:'b'.repeat(64)});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 return {app,req:async(p,b)=>fetch(base+p,{method:b?'POST':'GET',headers:{Authorization:'Bearer '+'b'.repeat(64),...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined}),close:()=>new Promise(r=>app.close(r))};
}
test('real HTTP restart restores evidence without resuming capture or blocking next explicit session',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'biliclass-restart-'));let api;
 try{
  api=await open(dir);const {id}=await (await api.req('/sessions',{url:'https://www.bilibili.com/video/BV1Synthetic'})).json();
  await api.req('/sessions/'+id+'/events',{events:[ev('old',0,9),ev('new',1,2)]});await api.close();api=null;
  api=await open(dir);const listing=await(await api.req('/sessions')).json();
  assert.equal(listing.sessions[0].closed,true);assert.equal(listing.sessions[0].events,null);
  const c=await(await api.req('/sessions/'+id+'/context')).json();
  assert.deepEqual(c.evidence.map(e=>e.id),['new']);assert.equal(c.recovery.status,'interrupted_by_restart');
  assert.equal((await api.req('/sessions/'+id+'/events',{events:[ev('unexpected',1,3)]})).status,400);
  assert.equal((await api.req('/sessions',{url:'https://www.bilibili.com/video/BV2Synthetic'})).status,201);
 }finally{if(api)await api.close();rmSync(dir,{recursive:true,force:true});}
});
test('stopped archives stay stopped; duplicate records replay once',async()=>{
 const f=fixture(JSON.stringify(ev('same'))+'\n'+JSON.stringify(ev('same'))+'\n',{stopped:true});
 try{const s=discoverSessions(f.dir).sessions.get(f.id);await Promise.all([hydrateSession(s,f.dir),hydrateSession(s,f.dir)]);assert.equal(s.recovery.status,'previously_stopped');assert.equal(s.ids.size,1);assert.equal(s.recovery.duplicateRecords,1);assert.equal(s.closed,true);}finally{f.cleanup();}
});
test('incomplete final record ignored with original bytes unchanged',async()=>{
 const f=fixture(JSON.stringify(ev('safe'))+'\n'+JSON.stringify(ev('notcommitted')));const before=readFileSync(f.file);
 try{const s=discoverSessions(f.dir).sessions.get(f.id);await hydrateSession(s,f.dir);assert.deepEqual(contextFor(s).evidence.map(e=>e.id),['safe']);assert(s.recovery.warnings.includes('incomplete_final_record_ignored'));assert.deepEqual(readFileSync(f.file),before);}finally{f.cleanup();}
});
test('invalid complete journal line exposes only valid prefix and warning',async()=>{
 const f=fixture(JSON.stringify(ev('safe'))+'\n{broken}\n'+JSON.stringify(ev('after-corruption'))+'\n');
 try{const s=discoverSessions(f.dir).sessions.get(f.id);await hydrateSession(s,f.dir);assert.equal(s.ids.size,1);assert(s.recovery.warnings.includes('invalid_complete_record_prefix_only'));}finally{f.cleanup();}
});
test('over-limit archive is not read or silently accepted',async()=>{
 const f=fixture(JSON.stringify(ev('safe'))+'\n');
 try{const s=discoverSessions(f.dir).sessions.get(f.id);await hydrateSession(s,f.dir,{maxBytes:2});assert.equal(s.ids.size,0);assert(s.recovery.warnings.includes('journal_unreadable_or_over_limit'));}finally{f.cleanup();}
});
test('invalid course metadata is isolated from other archives',()=>{
 const f=fixture('');
 try{const file=path.join(f.dir,'sessions',f.id,'session.json');const m=JSON.parse(readFileSync(file));m.source.url='https://evil.example/video/BV1x';writeFileSync(file,JSON.stringify(m));const found=discoverSessions(f.dir);assert.equal(found.sessions.size,0);assert.equal(found.warnings[0].reason,'archive_metadata_rejected');}finally{f.cleanup();}
});
