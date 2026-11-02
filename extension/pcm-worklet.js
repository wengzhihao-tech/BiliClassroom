class PCMCollector extends AudioWorkletProcessor {
  constructor(){
    super();this.parts=[];this.size=0;this.generation=0;this.enabled=false;
    this.port.onmessage=event=>{
      this.parts=[];this.size=0;this.enabled=false;
      const m=event.data;
      if(m?.type==='reset'&&Number.isSafeInteger(m.generation)&&m.generation>0){this.generation=m.generation;this.enabled=m.enabled===true;}
    };
  }
  process(inputs){
    if(!this.enabled)return true;
    const channels=inputs[0];if(!channels?.length)return true;
    const mono=new Float32Array(channels[0].length);
    for(const ch of channels)for(let i=0;i<mono.length;i++)mono[i]+=ch[i]/channels.length;
    this.parts.push(mono);this.size+=mono.length;
    if(this.size>=sampleRate){
      const data=new Float32Array(this.size);let off=0;for(const p of this.parts){data.set(p,off);off+=p.length;}
      this.port.postMessage({samples:data,sampleRate,generation:this.generation,audioEndTime:(currentFrame+mono.length)/sampleRate},[data.buffer]);this.parts=[];this.size=0;
    }
    return true;
  }
}
registerProcessor('pcm-collector',PCMCollector);
