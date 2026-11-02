import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createVoskBackend({python=path.join(root,'runtime/asr-venv/Scripts/python.exe'),model=path.join(root,'runtime/models/vosk-model-small-cn-0.22'),worker=path.join(root,'server/vosk-worker.py'),startupMs=15000,structured=false,spawnWorker}={}){
  if(!spawnWorker&&(!existsSync(python)||!existsSync(path.join(model,'am/final.mdl'))))throw new Error('local Vosk installation missing');
  let child=null,boot=null,pending=null,closed=false,busy=false,counter=0;
  const stats={engine:'vosk',version:'0.3.45',requests:0,completed:0,cancelled:0,failures:0,lastInferenceMs:null};
  function start(){
    if(closed)return Promise.reject(new Error('backend closed'));
    if(child)return boot.promise;
    let resolve,reject;boot={promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve:null,reject:null};boot.resolve=resolve;boot.reject=reject;
    const initial=boot;
    const owned=spawnWorker?spawnWorker():spawn(python,['-u',worker,model],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}});
    child=owned;owned.stderr.resume();owned.stdin.on('error',()=>{if(child===owned&&pending){pending.reject(new Error('engine input closed'));pending=null;}});
    const timer=setTimeout(()=>{owned.kill();initial.reject(new Error('engine startup timeout'));},startupMs);
    const lines=createInterface({input:owned.stdout});
    lines.on('line',line=>{
      if(line.length>200000){owned.kill();return;}
      let msg;try{msg=JSON.parse(line);}catch{return;}
      if(msg.type==='ready'){clearTimeout(timer);initial.resolve();return;}
      if(!pending||msg.id!==pending.id)return;
      const p=pending;pending=null;
      if(msg.type==='result'){stats.completed++;stats.lastInferenceMs=msg.elapsedMs??null;p.resolve(structured?{text:String(msg.text||''),words:msg.words||[],engine:'vosk',recognitionMs:msg.elapsedMs??0}:String(msg.text||''));}
      else{stats.failures++;p.reject(new Error('engine recognition failed'));}
    });
    owned.on('error',()=>{clearTimeout(timer);initial.reject(new Error('engine process unavailable'));if(pending){pending.reject(new Error('engine process unavailable'));pending=null;}if(child===owned){child=null;boot=null;}});
    owned.on('exit',()=>{
      clearTimeout(timer);lines.close();initial.reject(new Error('engine exited'));
      if(child===owned){child=null;boot=null;if(pending){pending.reject(new Error('engine exited'));pending=null;}}
    });
    // Prevent a startup cancellation producing an unhandled rejection before ready() is awaited.
    initial.promise.catch(()=>{});return initial.promise;
  }
  async function transcribe(window,{signal}={}){
    if(busy)throw new Error('backend already busy');busy=true;
    const abort=()=>{stats.cancelled++;child?.kill();};
    signal?.addEventListener('abort',abort,{once:true});
    try{
      if(signal?.aborted)throw new Error('cancelled');
      await start();if(signal?.aborted)throw new Error('cancelled');
      if(!Buffer.isBuffer(window.audioS16)||window.audioS16.length>960000)throw new Error('invalid audio');
      stats.requests++;
      const result=new Promise((resolve,reject)=>{const id=++counter;pending={id,resolve,reject};child.stdin.write(JSON.stringify({id,pcm:window.audioS16.toString('base64')})+'\n',err=>{if(err&&pending?.id===id){pending=null;reject(new Error('engine write failed'));}});});
      return await result;
    }finally{busy=false;signal?.removeEventListener('abort',abort);}
  }
  transcribe.ready=start;
  transcribe.close=()=>{closed=true;child?.kill();};
  transcribe.status=()=>({...stats,running:!!child,busy});
  return transcribe;
}