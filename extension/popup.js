import {recognitionSummary} from './evidence-view.js';
const $=id=>document.getElementById(id),show=x=>{$('status').textContent=typeof x==='string'?x:JSON.stringify(x,null,2);};
async function call(msg){const r=await chrome.runtime.sendMessage(msg);show(r);if(msg.type==='STATUS'||msg.type==='STOP')$('evidence').textContent=recognitionSummary(r);return r;}
const saved=await chrome.storage.local.get(['pairToken','ocrLanguage']);$('token').value=saved.pairToken||'';
$('ocrLanguage').value=['zh-Hans-CN','en-US'].includes(saved.ocrLanguage)?saved.ocrLanguage:'zh-Hans-CN';
$('ocrLanguage').onchange=async()=>{const value=$('ocrLanguage').value;if(['zh-Hans-CN','en-US'].includes(value))await chrome.storage.local.set({ocrLanguage:value});};
$('save').onclick=async()=>{const v=$('token').value.trim();if(!/^[a-f0-9]{64}$/.test(v))return show('配对码应为64位十六进制文本。');await chrome.storage.local.set({pairToken:v});show('配对码已保存在此浏览器扩展内。');};
for(const action of ['start','stop','refresh','ask'])$(action).onclick=async()=>{
  try{
    if(action==='start'){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});await call({type:'START',tabId:tab.id,audio:$('audio').checked,frames:$('frames').checked,danmaku:$('danmaku').checked,ocrLanguage:$('ocrLanguage').value});await call({type:'STATUS'});}
    if(action==='stop')await call({type:'STOP'});
    if(action==='refresh')await call({type:'STATUS'});
    if(action==='ask')await call({type:'ASK',question:$('question').value});
  }catch(e){show(e.message);}
};
await call({type:'STATUS'}).catch(e=>show(e.message));