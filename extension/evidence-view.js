const clip=(s,n=1000)=>String(s??'').slice(0,n);
const time=t=>Number.isFinite(t)?t.toFixed(1)+'秒':'时间未知';
const refs=ids=>Array.isArray(ids)?ids.slice(0,3).map(x=>clip(x,100)).join(', '):'未知';
const overlapSummary=view=>{
 if(!['exact_text_original_sample_iou_0.5','exact_text_all_observations_sample_iou_0.5'].includes(view?.method)||!Array.isArray(view.groups))return null;
 const groups=view.groups.slice(0,512).filter(g=>g&&typeof g.word==='string'&&Array.isArray(g.observations)&&g.observations.length);
 if(!groups.length)return null;
 const byId=new Map(groups.map(g=>[g.id,g])),shown=groups.slice(-24);
 const lines=['\n语音暂定（重叠已合并，仍未核验）','以下显示最近'+shown.length+'组；重复识别不是稳定提交。'];
 if(view.truncated)lines.push('聚合范围已截断，完整原始识别记录见详细状态与本地日志。');
 if(groups.length>shown.length)lines.push('较早的'+(groups.length-shown.length)+'组未在此展开。');
 for(const g of shown){
  const conflicts=Array.isArray(g.conflicts)?g.conflicts.slice(0,3):[];
  const alternatives=conflicts.map(id=>clip(byId.get(id)?.word||id,100));
  lines.push(time(g.videoStart)+'–'+time(g.videoEnd)+' · '+clip(g.word,100)+(alternatives.length?' · 存在冲突：'+alternatives.join(' / '):''));
  for(const o of g.observations.slice(0,2)){
   const spans=Array.isArray(o.sourceSpans)?o.sourceSpans.slice(0,3):[];
   const audio=spans.map(p=>clip(p.id,100)+'['+p.startSample+','+p.endSample+')').join(', ');
   lines.push('识别引用：'+clip(o.eventId,100)+'#'+o.wordIndex+'；音频样本：'+(audio||'未知'));
  }
  if(g.observations.length>2)lines.push('另有'+(g.observations.length-2)+'次识别引用，见详细状态。');
 }
 return lines;
};
export function recognitionSummary(status){
 if(!status?.active||!status.context)return '尚未采集。只有点击“开始当前课程”才会采集音画。';
 const c=status.context,lang=c.ocrLanguage==='en-US'?'英文/代码':'中文/混合';
 const state=c.ocrRuntime?.status,ocrState=state==='disabled_no_backend'?'未连接':state?.startsWith('blocked_')?'已暂停识别（引擎超时或失败）':state==='configured_backend_unverified'?'已连接，输出待核验':'状态未知';
 const lines=['画面文字：'+ocrState+'；本课程语言：'+lang,'语言选择仅在下次开始课程时生效。','语音暂定与OCR未核验文字不属于教师事实，也不会进入默认问答。'];
 for(const e of (c.evidence||[]).slice(-2))lines.push('\n字幕/稳定文字 · '+time(e.videoTime)+' · '+clip(e.id,100)+'\n'+clip(e.text));
 const overlap=overlapSummary(c.provisionalTranscript);
 if(overlap)lines.push(...overlap);
 else for(const e of (c.provisionalEvidence||[]).slice(-3))lines.push('\n语音暂定 · '+time(e.videoTime)+' · '+clip(e.id,100)+'\n'+clip(e.text)+'\n音频来源：'+refs(e.sourceEventIds));
 for(const e of (c.ocrEvidence||[]).slice(-3))lines.push('\nOCR未核验 · '+time(e.videoTime)+' · '+clip(e.id,100)+'\n'+clip(e.text)+'\n画面来源：'+refs(e.sourceEventIds));
 if(!(c.ocrEvidence||[]).length)lines.push('\n当前时间窗暂无画面文字。');
 return lines.join('\n');
}