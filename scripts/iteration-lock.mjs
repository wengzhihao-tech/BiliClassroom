import {openSync,writeFileSync,closeSync,readFileSync,existsSync,unlinkSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=process.env.BILICLASS_LOCK_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../automation');
mkdirSync(root,{recursive:true});const file=path.join(root,'iteration.lock.json');const[action,runId]=process.argv.slice(2);
function current(){return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;}
if(action==='status'){console.log(JSON.stringify({lock:current()}));}
else if(!/^[a-zA-Z0-9_-]{8,100}$/.test(runId||'')){console.error('unique runId required');process.exitCode=1;}
else if(action==='acquire'){
  try{
    const fd=openSync(file,'wx');try{writeFileSync(fd,JSON.stringify({runId,acquiredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+75*60000).toISOString(),note:'expiry requires review; never auto-steal a lock'}));}finally{closeSync(fd);}
    console.log(JSON.stringify({acquired:true,runId}));
  }catch(e){if(e.code!=='EEXIST')throw e;console.log(JSON.stringify({acquired:false,reason:'existing_lock_requires_review'}));process.exitCode=2;}
}else if(action==='release'){
  const lock=current();if(lock?.runId!==runId){console.log(JSON.stringify({released:false,reason:'owner_mismatch_or_missing'}));process.exitCode=2;}
  else{unlinkSync(file);console.log(JSON.stringify({released:true,runId}));}
}else{console.error('use acquire|release|status');process.exitCode=1;}
