const COLORS=['#363028','#C9A89A','#8FA89A','#8A9BAE','#C4B49A','#A898AE'];
const PEN_W=[2,6,16],ERASER_W=[28,60,110],FONT_SZ=[22,36,60];
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
    ctx.fillStyle=s.color;ctx.font=`${s.fs}px Georgia,serif`;
    s.text.split('\n').forEach((ln,i)=>ctx.fillText(ln,s.x,s.y+i*s.fs*1.35));
  }else if(s.type==='circle'){
    ctx.strokeStyle=s.color;ctx.lineWidth=s.w;ctx.lineCap='round';
    ctx.beginPath();ctx.arc(s.cx,s.cy,s.r,0,Math.PI*2);ctx.stroke();
  }else{
    // FIX Bug2: eraser in the base canvas is drawn as white fill (opaque white background),
    // NOT destination-out, because the base canvas has a white fillRect behind all strokes.
    ctx.strokeStyle=ctx.fillStyle=s.type==='eraser'?'#fff':s.color;
    ctx.lineWidth=s.w;ctx.lineCap='round';ctx.lineJoin='round';
    const p=s.pts;if(!p?.length){ctx.restore();return;}
    if(p.length===1){ctx.beginPath();ctx.arc(p[0].x,p[0].y,s.w/2,0,Math.PI*2);ctx.fill();}
    else{
      // FIX Bug2: draw the entire stroke as ONE continuous path (not segment-by-segment)
      // so there are no double-rendered overlap joints that cause visual width inconsistency.
      ctx.beginPath();
      ctx.moveTo(p[0].x,p[0].y);
      for(let i=1;i<p.length-1;i++){
        ctx.quadraticCurveTo(p[i].x,p[i].y,(p[i].x+p[i+1].x)/2,(p[i].y+p[i+1].y)/2);
      }
      ctx.lineTo(p[p.length-1].x,p[p.length-1].y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function redraw(){
  const W=canvas.width/dpr,H=canvas.height/dpr;
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  applyVP();drawGrid(W,H);for(const s of strokes)renderStroke(s);
}

// FIX Bug3 (闪烁): throttle redraws with requestAnimationFrame so the base canvas
// repaint is synced to the display refresh cycle. Without this, every pointermove
// message triggers an immediate synchronous fillRect+repaint on the OffscreenCanvas,
// which races against the live canvas incremental paint and causes visible flicker.
let rafPending=false;
function scheduleRedraw(){
  if(rafPending)return;
  rafPending=true;
  requestAnimationFrame(()=>{rafPending=false;redraw();});
}

self.onmessage=({data:d})=>{
  if(d.type==='init'){
    canvas=d.canvas;ctx=canvas.getContext('2d');dpr=d.dpr;vp=d.vp;strokes=d.strokes;
    // Initial draw can be immediate (no flicker risk at init time)
    redraw();
  }else if(d.type==='update'){
    if(d.vp)vp=d.vp;if(d.strokes)strokes=d.strokes;
    if(d.size){canvas.width=d.size.w;canvas.height=d.size.h;
      // Resize must redraw immediately — rAF after resize loses the new dimensions race
      redraw();return;
    }
    scheduleRedraw();
  }
};
