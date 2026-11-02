import {existsSync,readdirSync,lstatSync,readFileSync,createReadStream} from 'node:fs';
import path from 'node:path';
import {newSession,prepareEvents,commitEvents} from './core.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function regular(file,max){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw new Error('invalid evidence file');return st;}
export function discoverSessions(dataDir){
  const sessions=new Map(),warnings=[],base=path.join(dataDir,'sessions');
  if(!existsSync(base))return {sessions,warnings};
  const baseStat=lstatSync(base);if(!baseStat.isDirectory()||baseStat.isSymbolicLink())return {sessions,warnings:[{reason:'archive_directory_rejected'}]};
  let count=0;
  for(const entry of readdirSync(base,{withFileTypes:true})){
    if(!uuid.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())continue;
    if(++count>10000){warnings.push({reason:'archive_discovery_limit'});break;}
    try{
      const dir=path.join(base,entry.name),metaFile=path.join(dir,'session.json');
      regular(metaFile,65536);const meta=JSON.parse(readFileSync(metaFile,'utf8'));
      if(meta.id!==entry.name||!Number.isFinite(Date.parse(meta.createdAt)))throw new Error('invalid metadata');
      const s=newSession({...meta.source,ocrLanguage:meta.ocrLanguage});s.id=meta.id;s.createdAt=meta.createdAt;s.closed=true;
      const stopped=existsSync(path.join(dir,'stopped.json'));
      if(stopped)regular(path.join(dir,'stopped.json'),65536);
      s.recovery={status:stopped?'previously_stopped':'interrupted_by_restart',hydrated:false,warnings:[],replayedEvents:0,duplicateRecords:0};
      sessions.set(s.id,s);
    }catch{warnings.push({sessionId:entry.name,reason:'archive_metadata_rejected'});}
  }
  return {sessions,warnings};
}
export async function hydrateSession(s,dataDir,{maxBytes=256*1024*1024}={}){
  if(!s.recovery||s.recovery.hydrated)return;
  if(s.hydrating)return s.hydrating;
  s.hydrating=(async()=>{
    const file=path.join(dataDir,'sessions',s.id,'events.jsonl'),r=s.recovery;
    try{
      if(!existsSync(file)){r.hydrated=true;return;}
      const stat=regular(file,maxBytes);s.bytes=stat.size;
      let pending='',records=0,broken=false;
      // Recover only newline-terminated records. Never rewrite or truncate original evidence.
      for await(const chunk of createReadStream(file,{encoding:'utf8'})){
        pending+=chunk;let end;
        while((end=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,end);pending=pending.slice(end+1);
          if(++records>100000||Buffer.byteLength(line)>1024*1024){r.warnings.push('journal_record_limit');broken=true;break;}
          try{
            const raw=JSON.parse(line),accepted=prepareEvents({...s,closed:false},[raw]);
            if(!accepted.length)r.duplicateRecords++;
            for(const e of accepted)if(typeof raw.receivedAt==='string')e.receivedAt=raw.receivedAt;
            commitEvents(s,accepted,0);r.replayedEvents+=accepted.length;
          }catch{r.warnings.push('invalid_complete_record_prefix_only');broken=true;break;}
        }
        if(broken)break;
        if(Buffer.byteLength(pending)>1024*1024){r.warnings.push('journal_line_limit');broken=true;break;}
      }
      if(!broken&&pending.length)r.warnings.push('incomplete_final_record_ignored');
    }catch{r.warnings.push('journal_unreadable_or_over_limit');}
    finally{r.hydrated=true;s.closed=true;}
  })();
  try{await s.hydrating;}finally{delete s.hydrating;}
}