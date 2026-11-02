(() => {
  let active=false,epoch=0,queue=[],busy=false,initial='',lastCaption='',lastVideo=null,allowDanmaku=false,dropped=0,lastDropNotice=0;
  const attached=new WeakSet(),seenDanmaku=new Map();
  const send=msg=>chrome.runtime.sendMessage(msg);
  function source(){const u=new URL(location.href);return u.origin+u.pathname+'?p='+(u.searchParams.get('p')||'1');}
  function video(){return document.querySelector('video');}
  function enqueue(kind,values={}){
    const v=video();if(!active||!v)return;
    if(queue.length>=60){dropped++;return;}
    queue.push({id:crypto.randomUUID(),kind,epoch,videoTime:v.currentTime||0,captureTime:Date.now(),...values});
  }
  let inFlight=null;
  function flush(){
    if(inFlight)return inFlight;
    if(!queue.length)return Promise.resolve();
    const target=queue,batch=target.slice(0,20);
    inFlight=(async()=>{
      try{const r=await send({type:'EVENTS',events:batch});if(r?.error)throw new Error(r.error);if(queue===target)target.splice(0,batch.length);}catch{}
    })().finally(()=>{inFlight=null;});
    return inFlight;
  }
  async function stopCollector(drain){
    active=false;const deadline=Date.now()+3000;
    if(drain){
      let attempts=0;
      while(queue.length&&attempts++<4&&Date.now()<deadline){
        let timer;await Promise.race([flush(),new Promise(r=>{timer=setTimeout(r,Math.max(0,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));
      }
    }
    const remaining=queue.length,report={ok:true,drained:remaining===0,remaining,dropped};
    queue=[];lastVideo=null;return report;
  }
  function attach(v){
    if(attached.has(v))return;attached.add(v);
    for(const name of ['seeking','ratechange','pause','play','waiting','ended'])v.addEventListener(name,()=>{
      if(!active)return;
      if(name==='seeking'){epoch++;lastCaption='';enqueue('gap',{text:'用户跳转；新时间轴分段，旧上下文不可合并。'});}
      enqueue('playback',{paused:v.paused,rate:v.playbackRate,reason:name});
      timeline(v);
    });
  }
  function videoRect(v){
    if(document.visibilityState!=='visible'||typeof v.getBoundingClientRect!=='function')return null;
    const vw=globalThis.innerWidth,vh=globalThis.innerHeight,vp=globalThis.visualViewport;
    if(vp&&(Math.abs(vp.scale-1)>0.001||Math.abs(vp.offsetLeft)>0.5||Math.abs(vp.offsetTop)>0.5))return null;
    const r=v.getBoundingClientRect();
    if(![r.left,r.top,r.right,r.bottom,vw,vh].every(Number.isFinite))return null;
    const x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(vw,r.right),bottom=Math.min(vh,r.bottom);
    if(right-x<32||bottom-y<32)return null;
    return {x,y,width:right-x,height:bottom-y,viewportWidth:vw,viewportHeight:vh};
  }
  function timeline(v){send({type:'TIMELINE',data:{epoch,videoTime:v.currentTime,paused:v.paused,rate:v.playbackRate,wallTime:Date.now(),videoRect:videoRect(v)}}).catch(()=>{});}
  function tick(){
    if(!active)return;
    if(source()!==initial){active=false;send({type:'SOURCE_CHANGED'}).catch(()=>{});return;}
    const v=video();
    if(!v)return;
    if(lastVideo&&v!==lastVideo){epoch++;lastCaption='';enqueue('gap',{text:'播放器实例变化；时间轴已隔离。'});}
    lastVideo=v;attach(v);timeline(v);
    enqueue('playback',{paused:v.paused,rate:v.playbackRate,reason:'tick'});
    const native=[...v.textTracks].flatMap(t=>[...(t.activeCues||[])].map(c=>c.text||''));
    const dom=[...document.querySelectorAll('.bpx-player-subtitle-panel-text,.bilibili-player-video-subtitle-item-text')].filter(el=>el.getClientRects().length).map(el=>el.textContent||'');
    const caption=(native.length?native:dom).join('\n').trim().slice(0,12000);
    if(caption&&caption!==lastCaption){lastCaption=caption;enqueue('subtitle',{text:caption});}
    if(!caption)lastCaption='';
    if(allowDanmaku){
      const now=Date.now();for(const [k,t]of seenDanmaku)if(now-t>15000)seenDanmaku.delete(k);
      for(const el of [...document.querySelectorAll('.bili-dm')].slice(0,30)){
        const text=(el.textContent||'').trim().slice(0,500);if(text&&!seenDanmaku.has(text)){seenDanmaku.set(text,now);enqueue('danmaku',{text});}
      }
    }
    if(dropped&&queue.length<30&&Date.now()-lastDropNotice>10000){const n=dropped;dropped=0;lastDropNotice=Date.now();enqueue('gap',{text:`本地服务拥塞，丢弃${n}条事件；存在采集缺口。`});}
    void flush();
  }
  chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{
    if(msg.type==='COLLECT_PROBE'){respond({ok:true});return;}
    if(msg.type==='COLLECT_START'){
      active=true;epoch=0;queue=[];dropped=0;lastDropNotice=0;initial=source();lastCaption='';lastVideo=null;seenDanmaku.clear();allowDanmaku=!!msg.danmaku;tick();respond({ok:true});
    }
    if(msg.type==='COLLECT_STOP'){stopCollector(msg.drain!==false).then(respond);return true;}
  });
  setInterval(tick,1000);
})();