const base='http://127.0.0.1:18743';
let changing=false;
const load=async()=> (await chrome.storage.session.get('active')).active;
async function api(route,method='GET',body,token){
  const r=await fetch(base+route,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  if(!r.ok){const e=new Error(`本地服务 HTTP ${r.status}`);e.status=r.status;throw e;}return r.json();
}
let stopping=null;
function bounded(p,ms=4000){
  let timer;return Promise.race([p,new Promise(resolve=>{timer=setTimeout(()=>resolve({drained:false,reason:'timeout'}),ms);})]).finally(()=>clearTimeout(timer));
}
async function stop(options={}){
  if(stopping)return stopping;
  stopping=stopOnce(options);
  try{return await stopping;}finally{stopping=null;}
}
async function stopOnce({drain=true}={}){
  const active=await load(),pending=(await chrome.storage.session.get('pendingStop')).pendingStop,s=active||pending;let lastStop=null;
  if(s){
    const previous=(await chrome.storage.session.get('lastStop')).lastStop;
    const [content,media]=active?await Promise.all([
      bounded(chrome.tabs.sendMessage(s.tabId,{type:'COLLECT_STOP',drain})).catch(()=>({drained:false,reason:'tab_unavailable'})),
      s.audio||s.frames?bounded(chrome.runtime.sendMessage({target:'offscreen',type:'CAPTURE_STOP',drain})).catch(()=>({drained:false,reason:'offscreen_unavailable'})):Promise.resolve({drained:true,remaining:0})
    ]):[previous?.content??{drained:false,reason:'previous_report_missing'},previous?.media??{drained:false,reason:'previous_report_missing'}];
    let backendClosed=false;try{await api(`/sessions/${s.id}/stop`,'POST',{},s.token);backendClosed=true;}catch{}
    lastStop={sessionId:s.id,content,media,backendClosed};
    await chrome.storage.session.set({lastStop});
    if(backendClosed)await chrome.storage.session.remove('pendingStop');
    else await chrome.storage.session.set({pendingStop:s});
  }
  await chrome.storage.session.remove('active');
  await chrome.action.setBadgeText({text:''});
  return lastStop;
}
async function start(msg){
  if(await load())throw new Error('请先停止当前课程');
  if((await chrome.storage.session.get('pendingStop')).pendingStop)throw new Error('上次课程停止尚未确认，请点击停止重试');
  const ocrLanguage=msg.ocrLanguage??'zh-Hans-CN';
  if(!['zh-Hans-CN','en-US'].includes(ocrLanguage))throw new Error('不支持此OCR语言');
  const tab=await chrome.tabs.get(msg.tabId);
  const u=new URL(tab.url);
  if(u.origin!=='https://www.bilibili.com'||!/^\/video\/BV[a-zA-Z0-9]+\/?$/.test(u.pathname))throw new Error('请在B站普通视频课程页面启动');
  const {pairToken}=await chrome.storage.local.get('pairToken');
  if(!/^[a-f0-9]{64}$/.test(pairToken||''))throw new Error('请先填入本机配对码');
  // Content script must be present (refresh pages opened before extension installation).
  await chrome.tabs.sendMessage(tab.id,{type:'COLLECT_PROBE'});
  const {id}=await api('/sessions','POST',{url:tab.url,title:tab.title,ocrLanguage},pairToken);
  const s={id,tabId:tab.id,token:pairToken,ocrLanguage,audio:!!msg.audio,frames:!!msg.frames,danmaku:!!msg.danmaku};
  await chrome.storage.session.set({active:s});
  try{
    if(s.audio||s.frames){
      const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
      if(!contexts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'用户点击后采集选定课程标签页音频与画面'});
      const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
      const r=await chrome.runtime.sendMessage({target:'offscreen',type:'CAPTURE_START',streamId,session:s});
      if(!r?.ok)throw new Error(r?.error||'采集初始化失败');
    }
    await chrome.tabs.sendMessage(tab.id,{type:'COLLECT_START',danmaku:s.danmaku});
    await chrome.action.setBadgeText({text:'REC'});await chrome.action.setBadgeBackgroundColor({color:'#b44231'});
    return {ok:true,sessionId:id};
  }catch(e){await stop();throw e;}
}
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  if(msg.target==='offscreen')return;
  if(sender.id!==chrome.runtime.id)return;
  (async()=>{
    const s=await load();
    if(sender.tab){
      if(!s||sender.tab.id!==s.tabId)throw new Error('inactive tab');
      if(msg.type==='SOURCE_CHANGED'){await stop();return {ok:true};}
      if(msg.type==='TIMELINE'){
        await chrome.runtime.sendMessage({target:'offscreen',type:'TIMELINE',data:msg.data}).catch(()=>{});return {ok:true};
      }
      if(msg.type==='EVENTS'){
        try{return await api(`/sessions/${s.id}/events`,'POST',{events:msg.events},s.token);}
        catch(e){if(e.status===413){await chrome.storage.session.set({lastError:'课程采集达到本地配额，已自动停止。'});void stop({drain:false});}throw e;}
      }
      throw new Error('unsupported content message');
    }
    if(msg.type==='START'||msg.type==='STOP'){
      if(changing)throw new Error('操作进行中');changing=true;
      try{if(msg.type==='STOP'){const lastStop=await stop();return {ok:true,lastStop};}return await start(msg);}finally{changing=false;}
    }
    if(msg.type==='STATUS')return s?{active:true,sessionId:s.id,context:await api(`/sessions/${s.id}/context`,'GET',undefined,s.token)}:{active:false,pendingStop:!!(await chrome.storage.session.get('pendingStop')).pendingStop,lastError:(await chrome.storage.session.get('lastError')).lastError||null,lastStop:(await chrome.storage.session.get('lastStop')).lastStop||null};
    if(msg.type==='ASK'){if(!s)throw new Error('课程未启动');return api(`/sessions/${s.id}/ask`,'POST',{question:msg.question},s.token);}
    if(msg.type==='CAPTURE_ENDED'){await stop({drain:false});return {ok:true};}
    throw new Error('unknown action');
  })().then(respond).catch(e=>respond({ok:false,error:e.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(async id=>{const s=await load();if(s?.tabId===id)await stop();});