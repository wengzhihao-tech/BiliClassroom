// Read-only presentation of provisional hypotheses; never promotes teacher evidence.
// Exact text + shared original PCM samples, not adjacent text alone, identifies repeats.
function overlap(a,b){
 const size=s=>s.reduce((n,p)=>n+p.endSample-p.startSample,0);
 let n=0;for(const p of a)for(const q of b)if(p.id===q.id)n+=Math.max(0,Math.min(p.endSample,q.endSample)-Math.max(p.startSample,q.startSample));
 return n/Math.max(1,size(a)+size(b)-n);
}
export function provisionalTranscript(events,wordRange){
 const inWordRange = word => !wordRange ||
  (word.videoEnd >= wordRange.from && word.videoEnd <= wordRange.to);
 let segment=0,rate=null;const records=[];
 for(const e of events){
  if(e.kind==='gap'&&e.media!=='frame')segment++;
  if(e.kind==='playback'){if(e.paused||(rate!==null&&rate!==e.rate))segment++;rate=e.rate;}
  if(e.kind==='asr'&&e.stability!=='stable'&&Array.isArray(e.words)&&e.words.some(inWordRange))records.push({e,segment});
 }
 const chosen=records.slice(-8),groups=[],index=new Map();let truncated=records.length>8,groupLimitReached=false,duplicates=0;
 // Prefer recent estimates for display, retaining every merged observation's provenance.
 for(const {e,segment} of chosen.toReversed()){
  const key=JSON.stringify([segment,e.epoch,e.engine,e.playbackRate]);
  for(let i=0;i<e.words.length;i++){
   const w=e.words[i];
   if(!inWordRange(w))continue;
   const candidates=new Set();
   for(const p of w.sourceSpans)for(const g of index.get(key+'|'+p.id)||[])candidates.add(g);
   const matches=[...candidates].filter(g=>!g.observations.some(o=>o.eventId===e.id)&&g.observations.some(o=>overlap(o.sourceSpans,w.sourceSpans)>=0.5));
   const same=matches.find(g=>g.word===w.word&&g.observations.every(o=>overlap(o.sourceSpans,w.sourceSpans)>=0.5));
   const observation={eventId:e.id,wordIndex:i,windowStart:e.windowStart,videoStart:w.videoStart,videoEnd:w.videoEnd,confidence:w.confidence,sourceSpans:w.sourceSpans.map(p=>({...p}))};
   let g=same;
   if(g){g.observations.push(observation);duplicates++;}
   else{
    if(groups.length>=512){truncated=true;groupLimitReached=true;continue;}
    g={id:e.id+':'+i,word:w.word,videoStart:w.videoStart,videoEnd:w.videoEnd,stability:'provisional',observations:[observation],conflicts:[]};
    groups.push(g);
   }
   for(const other of matches)if(other.word!==w.word){
    if(!g.conflicts.includes(other.id))g.conflicts.push(other.id);
    if(!other.conflicts.includes(g.id))other.conflicts.push(g.id);
   }
   for(const p of w.sourceSpans){const k=key+'|'+p.id;if(!index.has(k))index.set(k,new Set());index.get(k).add(g);}
  }
 }
 // Agreement is scoped to the visible hypotheses. A retry at the same
 // window start is one observation window, even with a different event ID.
 for (const group of groups) {
  const starts = new Set(group.observations.map(o => o.windowStart).filter(Number.isFinite));
  if (group.conflicts.length) group.windowAgreement = 'conflicting';
  else if (groupLimitReached || !starts.size) group.windowAgreement = 'unassessed';
  else group.windowAgreement = starts.size >= 2 ? 'agrees' : 'single_window';
 }
 groups.sort((a,b)=>a.videoStart-b.videoStart||a.videoEnd-b.videoEnd||a.id.localeCompare(b.id));
 return {stability:'provisional',wordTimeScoped:!!wordRange,method:'exact_text_all_observations_sample_iou_0.5',groups,duplicates,conflictGroups:groups.filter(g=>g.conflicts.length).length,truncated,
 limitations:['Window agreement describes only the recent hypotheses shown and does not verify or commit speech.','Different words sharing PCM remain visible as conflicts.','At most eight hypotheses and 512 word groups; raw events remain unchanged.']};
}
