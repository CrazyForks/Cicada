const COLORS=['#363028','#C9A89A','#8FA89A','#8A9BAE','#C4B49A','#A898AE'];
const PEN_W=[2,6,16],ERASER_W=[28,60,110],FONT_SZ=[22,36,60];
const RDP_EPS=[1.5,3,6];
let canvas,ctx,vp={x:0,y:0,scale:1},strokes=[],dpr=1;

const applyVP=()=>ctx.setTransform(vp.scale*dpr,0,0,vp.scale*dpr,vp.x*dpr,vp.y*dpr);

function drawGrid(W,H){
  let sp=32;while(sp*vp.scale<16)sp*=4;while(sp*vp.scale>64)sp/=2;
  const ox=-vp.x/vp.scale,oy=-vp.y/vp.scale,x1=(W-vp.x)/vp.scale,y1=(H-vp.y)/vp.scale;
  const sx=Math.floor(ox/sp)*sp,sy=Math.floor(oy/sp)*sp,r=1/vp.scale;
  ctx.fillStyle='rgba(0,0,0,.08)';ctx.beginPath();
  for(let gx=sx;gx<=x1+sp;gx+=sp)for(let gy=sy;gy<=y1+sp;gy+=sp)ctx.rect(gx-r,gy-r,r*2,r*2);
  ctx.fill();
}

function renderStroke(s){
  ctx.save();
  if(s.type==='text'){
    ctx.fillStyle=s.color;ctx.font=`${s.fs}px 'Lora',Georgia,serif`;
    s.text.split('\n').forEach((ln,i)=>ctx.fillText(ln,s.x,s.y+i*s.fs*1.35));
  }else if(s.type==='circle'){
    ctx.strokeStyle=s.color;ctx.lineWidth=s.w;ctx.lineCap='round';
    ctx.beginPath();ctx.arc(s.cx,s.cy,s.r,0,Math.PI*2);ctx.stroke();
  }else{
    ctx.strokeStyle=ctx.fillStyle=s.type==='eraser'?'#fff':s.color;
    ctx.lineWidth=s.w;ctx.lineCap='round';ctx.lineJoin='round';
    const p=s.pts;if(!p?.length){ctx.restore();return;}
    if(p.length===1){ctx.beginPath();ctx.arc(p[0].x,p[0].y,s.w/2,0,Math.PI*2);ctx.fill();}
    else{ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);for(let i=1;i<p.length-1;i++)ctx.quadraticCurveTo(p[i].x,p[i].y,(p[i].x+p[i+1].x)/2,(p[i].y+p[i+1].y)/2);ctx.lineTo(p[p.length-1].x,p[p.length-1].y);ctx.stroke();}
  }
  ctx.restore();
}

function redraw(){
  const W=canvas.width/dpr,H=canvas.height/dpr;
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  applyVP();drawGrid(W,H);for(const s of strokes)renderStroke(s);
}

function rdp(pts,eps){
  if(pts.length<=2)return pts;
  const a=pts[0],b=pts[pts.length-1],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
  let mx=0,mi=0;
  for(let i=1;i<pts.length-1;i++){
    const d=l2===0?Math.hypot(pts[i].x-a.x,pts[i].y-a.y):Math.abs(dy*pts[i].x-dx*pts[i].y+b.x*a.y-b.y*a.x)/Math.sqrt(l2);
    if(d>mx){mx=d;mi=i;}
  }
  return mx>eps?[...rdp(pts.slice(0,mi+1),eps).slice(0,-1),...rdp(pts.slice(mi),eps)]:[a,b];
}

self.onmessage=({data:d})=>{
  if(d.type==='init'){
    canvas=d.canvas;ctx=canvas.getContext('2d');dpr=d.dpr;vp=d.vp;strokes=d.strokes;redraw();
  }else if(d.type==='update'){
    if(d.vp)vp=d.vp;if(d.strokes)strokes=d.strokes;
    if(d.size){canvas.width=d.size.w;canvas.height=d.size.h;}
    redraw();
  }else if(d.type==='simplify'){
    // FIX: was checking d.type==='eraser' (always false here); now uses d.strokeType
    const eps=d.strokeType==='eraser'?10:(RDP_EPS[PEN_W.indexOf(d.w)]??2);
    self.postMessage({type:'simplified',id:d.id,pts:d.pts.length<=2?d.pts:rdp(d.pts,eps)});
  }
};
