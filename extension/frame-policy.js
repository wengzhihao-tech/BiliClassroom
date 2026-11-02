// Pure crop and change policy. Geometry is CSS viewport coordinates; pixels are tab capture.
export function cropFor(rect, sourceWidth, sourceHeight) {
  if(!rect || !Number.isInteger(sourceWidth)||!Number.isInteger(sourceHeight)||sourceWidth<32||sourceHeight<32||sourceWidth>16384||sourceHeight>16384)return null;
  const {x,y,width,height,viewportWidth:vw,viewportHeight:vh}=rect;
  if(![x,y,width,height,vw,vh].every(Number.isFinite)||x<0||y<0||width<32||height<32||vw<64||vh<64||vw>16384||vh>16384||x+width>vw+0.01||y+height>vh+0.01)return null;
  // A resized/letterboxed stream cannot safely use the previous viewport mapping.
  if(Math.abs((sourceWidth/sourceHeight)/(vw/vh)-1)>0.02)return null;
  const left=Math.ceil(x*sourceWidth/vw),top=Math.ceil(y*sourceHeight/vh);
  const right=Math.floor((x+width)*sourceWidth/vw),bottom=Math.floor((y+height)*sourceHeight/vh);
  if(right-left<16||bottom-top<16)return null;
  const scale=Math.min(1,960/(right-left),960/(bottom-top));
  return {x:left,y:top,width:right-left,height:bottom-top,sourceWidth,sourceHeight,
    outputWidth:Math.max(1,Math.floor((right-left)*scale)),outputHeight:Math.max(1,Math.floor((bottom-top)*scale))};
}
export const geometryKey = r => r ? [r.x,r.y,r.width,r.height,r.viewportWidth,r.viewportHeight].join(':') : '';
export function sampleLuma(rgba) {
  if(!rgba || rgba.length!==32*18*4)throw new Error('invalid frame sample');
  const out=new Uint8Array(32*18);
  for(let i=0;i<out.length;i++)out[i]=Math.round((77*rgba[4*i]+150*rgba[4*i+1]+29*rgba[4*i+2])/256);
  return out;
}
export function frameDecision(previous,current,now) {
  if(!previous)return {keep:true,reason:'first',score:1};
  const score=current.reduce((n,v,i)=>n+Math.abs(v-previous.sample[i]),0)/(current.length*255);
  return {keep:score>=0.02||now-previous.at>=30000,reason:score>=0.02?'changed':'heartbeat',score};
}
