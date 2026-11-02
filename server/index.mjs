import http from 'node:http';
import {mkdirSync,existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {InputError,newSession,prepareEvents,commitEvents,contextFor} from './core.mjs';
import {explain} from './model.mjs';
import {OcrBridge} from './ocr-bridge.mjs';
import {createWindowsOcrBackend} from './windows-ocr.mjs';
import {AsrBridge} from './asr-bridge.mjs';
import {createVoskBackend} from './vosk-backend.mjs';
import {discoverSessions,hydrateSession} from './recovery.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createApp({dataDir=path.join(root,'runtime'),token,maxBytes=256*1024*1024,asrBackend=null,asrTimeoutMs=10000,ocrBackend=null,ocrTimeoutMs=10000}={}) {
  mkdirSync(dataDir,{recursive:true});
  const pairFile=path.join(dataDir,'pairing.json');
  token ??= existsSync(pairFile)?JSON.parse(readFileSync(pairFile)).token:randomBytes(32).toString('hex');
  if(!existsSync(pairFile))writeFileSync(pairFile,JSON.stringify({token}),{mode:0o600});
  const {sessions,warnings:recoveryWarnings}=discoverSessions(dataDir); let modelBusy=false;
  const appendDerived=(s,raw)=>{
    if(s.closed)throw new InputError('session stopped');
    const accepted=prepareEvents(s,[raw]),text=accepted.map(e=>JSON.stringify(e)+'\n').join(''),bytes=Buffer.byteLength(text);
    if(s.ids.size+accepted.length>100000||s.bytes+bytes>maxBytes)throw new InputError('derived quota exceeded');
    if(text)appendFileSync(path.join(dataDir,'sessions',s.id,'events.jsonl'),text);
    commitEvents(s,accepted,bytes);
  };
  const asr=new AsrBridge(asrBackend,appendDerived,{timeoutMs:asrTimeoutMs});
  const ocr=new OcrBridge(ocrBackend,appendDerived,{timeoutMs:ocrTimeoutMs});
  function auth(req){const got=Buffer.from(req.headers.authorization||'');const wanted=Buffer.from(`Bearer ${token}`);return got.length===wanted.length&&timingSafeEqual(got,wanted);}
  function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
  async function body(req){
    if(!(req.headers['content-type']||'').startsWith('application/json'))throw new InputError('JSON required');
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw new InputError('request too large');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InputError('invalid JSON');}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      // No CORS permission to Bilibili pages or arbitrary websites. Extension worker performs requests.
      const origin=req.headers.origin;
      if(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))return reply(res,403,{error:'origin rejected'});
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST');return reply(res,200,{ok:true});}
      if(req.url==='/health'&&req.method==='GET')return reply(res,200,{ok:true,version:'0.1.0',capture:'requires_explicit_user_start',modelConfigured:!!process.env.BILICLASS_MODEL,asr:asr.status().status,ocr:ocr.status().status});
      if(!auth(req))return reply(res,401,{error:'pairing required'});
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/sessions'&&req.method==='POST'){
        if([...sessions.values()].some(s=>!s.closed))return reply(res,409,{error:'stop current session first'});
        const s=newSession(await body(req));
        const dir=path.join(dataDir,'sessions',s.id);mkdirSync(dir,{recursive:true});
        writeFileSync(path.join(dir,'session.json'),JSON.stringify({id:s.id,source:s.source,ocrLanguage:s.ocrLanguage,createdAt:s.createdAt},null,2));sessions.set(s.id,s);
        return reply(res,201,{id:s.id});
      }
      if(url.pathname==='/sessions'&&req.method==='GET')return reply(res,200,{recoveryWarnings,sessions:[...sessions.values()].map(s=>({id:s.id,source:s.source,closed:s.closed,events:s.recovery&&!s.recovery.hydrated?null:s.ids.size,bytes:s.recovery&&!s.recovery.hydrated?null:s.bytes,recovery:s.recovery||null}))});
      const m=url.pathname.match(/^\/sessions\/([a-zA-Z0-9-]+)\/(events|context|stop|ask)$/);
      if(!m)return reply(res,404,{error:'unknown route'});
      const s=sessions.get(m[1]);if(!s)return reply(res,404,{error:'unknown session'});
      if(m[2]==='events'&&req.method==='POST'){
        const {events}=await body(req);const accepted=prepareEvents(s,events);
        const text=accepted.map(e=>JSON.stringify(e)+'\n').join('');const n=Buffer.byteLength(text);
        if(s.ids.size+accepted.length>100000||s.bytes+n>maxBytes)return reply(res,413,{error:'session quota reached; stop capture and export'});
        const dir=path.join(dataDir,'sessions',s.id);
        // Commit to durable journal before ACK; duplicate IDs make retries safe.
        if(text)appendFileSync(path.join(dir,'events.jsonl'),text);
        commitEvents(s,accepted,n);
        try{asr.consume(s,accepted);}catch{asr.metrics.deliveryErrors++;}
        try{ocr.consume(s,accepted);}catch{ocr.metrics.deliveryErrors++;}
        return reply(res,200,{accepted:accepted.length,duplicates:events.length-accepted.length});
      }
      if(m[2]==='stop'&&req.method==='POST'){asr.stop(s);ocr.stop(s);s.closed=true;writeFileSync(path.join(dataDir,'sessions',s.id,'stopped.json'),JSON.stringify({at:new Date().toISOString()}));return reply(res,200,{ok:true});}
      if(m[2]==='context'&&req.method==='GET'){
        const opts={};for(const k of ['epoch','at','window'])if(url.searchParams.has(k))opts[k]=Number(url.searchParams.get(k));
        await hydrateSession(s,dataDir,{maxBytes});
        return reply(res,200,{...contextFor(s,opts),recovery:s.recovery||null,asrRuntime:asr.status(s.id),ocrRuntime:ocr.status(s.id)});
      }
      if(m[2]==='ask'&&req.method==='POST'){
        if(modelBusy)return reply(res,429,{error:'one inference at a time'});
        const b=await body(req);await hydrateSession(s,dataDir,{maxBytes});modelBusy=true;
        try{return reply(res,200,await explain(contextFor(s,b.context||{}),b.question));}finally{modelBusy=false;}
      }
      return reply(res,405,{error:'method not allowed'});
    }catch(e){reply(res,e instanceof InputError?400:500,{error:e instanceof InputError?e.message:'local service failed; no credentials logged'});}
  });
  server.on('close',()=>{ocr.close();asr.close();asrBackend?.close?.();});
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const modelConfig=path.join(root,'runtime','local-model.json');
  if(!process.env.BILICLASS_MODEL&&existsSync(modelConfig)){
    const config=JSON.parse(readFileSync(modelConfig,'utf8'));
    if(config.enabled===true&&typeof config.model==='string')process.env.BILICLASS_MODEL=config.model;
  }
  const port=Number(process.env.BILICLASS_PORT||18743);
  let asrBackend=null;
  const asrConfig=path.join(root,'runtime/local-asr.json');
  if(existsSync(asrConfig)){
    const config=JSON.parse(readFileSync(asrConfig,'utf8'));
    if(config.enabled===true&&config.engine==='vosk'){asrBackend=createVoskBackend({structured:true});await asrBackend.ready();}
  }
  let ocrBackend=null;const ocrConfig=path.join(root,'runtime/local-ocr.json');
  if(existsSync(ocrConfig)){
    const config=JSON.parse(readFileSync(ocrConfig,'utf8'));
    if(config.enabled===true&&config.engine==='windows-native'&&process.platform==='win32')ocrBackend=createWindowsOcrBackend();
  }
  const app=createApp({asrBackend,ocrBackend});app.on('error',e=>{asrBackend?.close?.();console.error(`BiliClassroom could not start (${e.code||'error'})`);process.exitCode=1;});
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{asrBackend?.close?.();app.close(()=>process.exit(0));});
  app.listen(port,'127.0.0.1',()=>console.log(`BiliClassroom 0.1.0 listening on 127.0.0.1:${port}; token is in runtime/pairing.json (not printed)`));
}