import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Geometric reading-order heuristic; never repairs symbols or invents missing text.
export function layoutOcrWords(words,width,height){
 if(!Array.isArray(words)||words.length>2000)throw Error('invalid OCR words');
 const sorted=words.map(w=>{
  if(!w||typeof w.text!=='string'||!w.text||w.text.length>500||
   !['x','y','width','height'].every(k=>Number.isFinite(w[k]))||w.x<0||w.y<0||w.width<=0||w.height<=0||w.x+w.width>width+1||w.y+w.height>height+1)throw Error('invalid OCR word bounds');
  return {text:w.text,x:w.x,y:w.y,width:w.width,height:w.height};
 }).sort((a,b)=>b.height-a.height||(a.y+a.height/2)-(b.y+b.height/2)||a.x-b.x);
 const rows=[];
 for(const w of sorted){
  const center=w.y+w.height/2;
  const row=rows.findLast(r=>Math.min(r.bottom,w.y+w.height)-Math.max(r.top,w.y)>=Math.min(r.height,w.height)*0.35||Math.abs(r.center-center)<=Math.max(3,Math.min(r.height,w.height)*0.6));
  if(row){row.words.push(w);row.center=(row.center*(row.words.length-1)+center)/row.words.length;row.height=Math.max(row.height,w.height);row.top=Math.min(row.top,w.y);row.bottom=Math.max(row.bottom,w.y+w.height);}
  else rows.push({center,top:w.y,bottom:w.y+w.height,height:w.height,words:[w]});
 }
 return rows.sort((a,b)=>a.center-b.center).map(r=>r.words.sort((a,b)=>a.x-b.x).map(w=>w.text).join(' ')).join('\n');
}
export function createWindowsOcrBackend({spawnWorker=spawn,tempRoot=path.join(root,'runtime/ocr-tmp'),timeoutMs=10000}={}){
 let busy=false;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('invalid OCR timeout');
 return async function recognize(frame,{signal,language='zh-Hans-CN'}={}){
  if(busy)throw Error('OCR busy');
  if(signal?.aborted)throw Error('OCR aborted');
  if(!frame||frame.kind!=='frame'||typeof frame.id!=='string'||!Number.isInteger(frame.epoch)||!Number.isFinite(frame.videoTime)||
   !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame.data)||frame.data.length>800000)throw Error('invalid OCR frame');
  if(!['zh-Hans-CN','en-US'].includes(language))throw Error('unsupported OCR language');
  busy=true;let dir;
  try{
   await mkdir(tempRoot,{recursive:true});dir=await mkdtemp(path.join(tempRoot,'frame-'));
   const file=path.join(dir,'image.jpg');await writeFile(file,Buffer.from(frame.data.split(',')[1],'base64'));
   if(signal?.aborted)throw Error('OCR aborted');
   const start=performance.now();
   const raw=await new Promise((resolve,reject)=>{
    const child=spawnWorker('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'server/windows-ocr.ps1'),'-ImagePath',file,'-Language',language],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',stopped=null,spawnError=null;const stop=reason=>{if(!stopped){stopped=reason;child.kill();}};
    const abort=()=>stop('OCR aborted');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop('OCR timeout'),timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data=>{output+=data;if(output.length>256000)stop('OCR output quota');});
    child.stderr.on('data',()=>{}); // Do not expose file paths or arbitrary engine errors.
    child.on('error',e=>{spawnError=e;});
    child.on('close',code=>{
     clearTimeout(timer);signal?.removeEventListener('abort',abort);
     if(stopped||spawnError||code!==0)return reject(Error(stopped||'OCR worker failed'));
     try{resolve(JSON.parse(output.replace(/^\uFEFF/,'').trim()));}catch{reject(Error('invalid OCR worker output'));}
    });
    if(signal?.aborted)abort();
   });
   if(signal?.aborted)throw Error('OCR aborted');
   if(typeof raw.text!=='string'||raw.text.length>12000||!Array.isArray(raw.words)||raw.words.length>2000||
    !Number.isInteger(raw.width)||!Number.isInteger(raw.height)||raw.width<1||raw.height<1||raw.width>960||raw.height>960)throw Error('invalid OCR result');
   const text=raw.words.length?layoutOcrWords(raw.words,raw.width,raw.height):raw.text;
   return {text,rawText:raw.text,readingOrder:'geometric_rows_unverified',sourceEventIds:[frame.id],epoch:frame.epoch,videoTime:frame.videoTime,engine:'Windows.Media.Ocr',language:raw.language,
    width:raw.width,height:raw.height,words:raw.words,recognitionMs:raw.recognitionMs,totalMs:Math.round(performance.now()-start),confidence:null,quality:'unverified',osVersion:raw.osVersion};
  }finally{try{if(dir)await rm(dir,{recursive:true,force:true});}finally{busy=false;}}
 };
}