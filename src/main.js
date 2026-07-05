const $ = id => document.getElementById(id);
const base = $('base'), live = $('live'), cur = $('cur'), ti = $('ti');
const lctx = live.getContext('2d'), cctx = cur.getContext('2d');
const ZH = $('zoom-hud'), TT = $('toast'), BU = $('btn-undo'), BR = $('btn-redo');

const COLORS = ['#363028','#C9A89A','#8FA89A','#8A9BAE','#C4B49A','#A898AE'];
const PEN_W = [2,6,16], ERASER_W = [28,60,110], FONT_SZ = [22,36,60], RDP_EPS = [1.5,3,6];
const MIN_SCALE = 0.05, MAX_SCALE = 20, MIN_D2 = 4;
const dpr = Math.min(window.devicePixelRatio||1, 2);

let vp = {x:0,y:0,scale:1};
let tool='pen', ci=0, wi=0;
let strokes=[], undoStack=[[]], histIdx=0;
let isDrawing=false, drawPts=[];
let spaceDown=false, mousePanning=false, midPanning=false;
let panStart=null, vpAtPanStart=null, rafId=null;
let curSX=-999, curSY=-999;
let recording=true;
let replayLog=[], recordStart=null;

// ── OffscreenCanvas + ESM Worker (Feature 4) ──
let worker, workerReady=false;
const pendingSimplify = new Map();
let simpId = 0;

function initWorker() {
  if (!('OffscreenCanvas' in window) || !base.transferControlToOffscreen) return false;
  try {
    const offscreen = base.transferControlToOffscreen();
    worker = new Worker(new URL('./render.worker.js', import.meta.url), {type:'module'});
    worker.onmessage = ({data}) => {
      if (data.type === 'simplified') {
        pendingSimplify.get(data.id)?.(data.pts);
        pendingSimplify.delete(data.id);
      }
    };
    worker.postMessage({type:'init', canvas:offscreen, dpr, vp:{...vp}, strokes:[]}, [offscreen]);
    workerReady = true;
    return true;
  } catch(e) { console.warn('Worker init failed', e); return false; }
}

function workerRedraw(newStrokes, newVp, size) {
  if (!workerReady) return;
  const msg = {type:'update', strokes:newStrokes??strokes, vp:newVp??{...vp}};
  if (size) msg.size = size;
  worker.postMessage(msg);
}

function workerSimplify(pts, type, w) {
  if (!workerReady) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = simpId++;
    pendingSimplify.set(id, resolve);
    worker.postMessage({type:'simplify', id, pts, type, w});
  });
}

// Fallback main-thread ctx
let bctx = null;
const getFallbackCtx = () => bctx || (bctx = base.getContext('2d'));

function resize() {
  const W=innerWidth, H=innerHeight;
  const pw=Math.round(W*dpr), ph=Math.round(H*dpr);
  for (const c of [live,cur]) {
    c.width=pw; c.height=ph; c.style.width=W+'px'; c.style.height=H+'px';
  }
  if (!workerReady) {
    base.width=pw; base.height=ph; base.style.width=W+'px'; base.style.height=H+'px';
  }
  scheduleRedraw(); drawCursorAt(curSX,curSY);
}
window.addEventListener('resize', () => {
  if (workerReady) workerRedraw(null, null, {w:Math.round(innerWidth*dpr), h:Math.round(innerHeight*dpr)});
  resize();
});

const s2w = (sx,sy) => ({x:(sx-vp.x)/vp.scale, y:(sy-vp.y)/vp.scale});
const applyVP = ctx => ctx.setTransform(vp.scale*dpr,0,0,vp.scale*dpr,vp.x*dpr,vp.y*dpr);

function setZoom(ns, cx, cy) {
  const rf=ns/vp.scale;
  vp.x=cx-(cx-vp.x)*rf; vp.y=cy-(cy-vp.y)*rf; vp.scale=ns;
  ZH.textContent=Math.round(ns*100)+'%';
}
function zoomAt(f,cx,cy){ setZoom(Math.max(MIN_SCALE,Math.min(MAX_SCALE,vp.scale*f)),cx,cy); }

function drawGrid(ctx, W, H) {
  let sp=32;
  while(sp*vp.scale<16) sp*=4;
  while(sp*vp.scale>64) sp/=2;
  const ox=-vp.x/vp.scale, oy=-vp.y/vp.scale;
  const x1=(W-vp.x)/vp.scale, y1=(H-vp.y)/vp.scale;
  const sx=Math.floor(ox/sp)*sp, sy=Math.floor(oy/sp)*sp;
  const r=1/vp.scale;
  ctx.fillStyle='rgba(0,0,0,.08)'; ctx.beginPath();
  for(let gx=sx;gx<=x1+sp;gx+=sp)
    for(let gy=sy;gy<=y1+sp;gy+=sp)
      ctx.rect(gx-r,gy-r,r*2,r*2);
  ctx.fill();
}

function renderStroke(ctx, s) {
  ctx.save();
  if (s.type==='text') {
    ctx.fillStyle=s.color;
    ctx.font=`${s.fs}px 'Lora',Georgia,serif`;
    s.text.split('\n').forEach((ln,i)=>ctx.fillText(ln,s.x,s.y+i*s.fs*1.35));
  } else if (s.type==='circle') {
    ctx.strokeStyle=s.color; ctx.lineWidth=s.w; ctx.lineCap='round';
    ctx.beginPath(); ctx.arc(s.cx,s.cy,s.r,0,Math.PI*2); ctx.stroke();
  } else {
    ctx.strokeStyle=ctx.fillStyle=s.type==='eraser'?'#fff':s.color;
    ctx.lineWidth=s.w; ctx.lineCap='round'; ctx.lineJoin='round';
    const p=s.pts;
    if(!p?.length){ctx.restore();return;}
    if(p.length===1){ctx.beginPath();ctx.arc(p[0].x,p[0].y,s.w/2,0,Math.PI*2);ctx.fill();}
    else{
      ctx.beginPath(); ctx.moveTo(p[0].x,p[0].y);
      for(let i=1;i<p.length-1;i++)
        ctx.quadraticCurveTo(p[i].x,p[i].y,(p[i].x+p[i+1].x)/2,(p[i].y+p[i+1].y)/2);
      ctx.lineTo(p[p.length-1].x,p[p.length-1].y); ctx.stroke();
    }
  }
  ctx.restore();
}

function scheduleRedraw() {
  if(workerReady){workerRedraw();return;}
  if(rafId) return;
  rafId=requestAnimationFrame(()=>{rafId=null;redrawBase();});
}

function redrawBase() {
  if(workerReady){workerRedraw();return;}
  const ctx=getFallbackCtx();
  const W=base.width/dpr, H=base.height/dpr;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,base.width,base.height);
  applyVP(ctx); drawGrid(ctx,W,H);
  for(const s of strokes) renderStroke(ctx,s);
}

function drawCursorAt(sx,sy) {
  cctx.setTransform(1,0,0,1,0,0); cctx.clearRect(0,0,cur.width,cur.height);
  if(sx<0||sy<0) return;
  if(tool==='pen'){
    cctx.fillStyle=COLORS[ci];
    cctx.beginPath(); cctx.arc(sx*dpr,sy*dpr,5*dpr,0,Math.PI*2); cctx.fill();
  } else if(tool==='eraser'){
    const r=Math.max(8,ERASER_W[wi]*vp.scale/2);
    cctx.strokeStyle='rgba(80,80,80,.7)'; cctx.lineWidth=1.5*dpr;
    cctx.setLineDash([4*dpr,3*dpr]);
    cctx.beginPath(); cctx.arc(sx*dpr,sy*dpr,r*dpr,0,Math.PI*2); cctx.stroke();
  }
}
const setCursorStyle = t => { live.style.cursor=t==='text'?'text':'none'; };

function rdp(pts,eps){
  if(pts.length<=2) return pts;
  const a=pts[0],b=pts[pts.length-1];
  const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;
  let mx=0,mi=0;
  for(let i=1;i<pts.length-1;i++){
    const d=len2===0?Math.hypot(pts[i].x-a.x,pts[i].y-a.y)
      :Math.abs(dy*pts[i].x-dx*pts[i].y+b.x*a.y-b.y*a.x)/Math.sqrt(len2);
    if(d>mx){mx=d;mi=i;}
  }
  return mx>eps?[...rdp(pts.slice(0,mi+1),eps).slice(0,-1),...rdp(pts.slice(mi),eps)]:[a,b];
}
function simplifySync(s){
  if(s.type==='text'||!s.pts||s.pts.length<=2) return s;
  return {...s,pts:rdp(s.pts,s.type==='eraser'?10:(RDP_EPS[PEN_W.indexOf(s.w)]??2))};
}

function detectCircle(pts){
  const n=pts.length;
  if(n<12) return null;
  let cx=0,cy=0;
  for(const p of pts){cx+=p.x;cy+=p.y;}
  cx/=n;cy/=n;
  let sumD=0,sumD2=0,arcLen=0;
  const d=new Array(n);
  for(let i=0;i<n;i++){
    d[i]=Math.hypot(pts[i].x-cx,pts[i].y-cy);sumD+=d[i];
    if(i)arcLen+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y);
  }
  const r=sumD/n;
  if(r<10)return null;
  for(let i=0;i<n;i++)sumD2+=(d[i]-r)**2;
  if(Math.sqrt(sumD2/n)/r>0.26||arcLen<Math.PI*r*1.5)return null;
  if(Math.hypot(pts[0].x-pts[n-1].x,pts[0].y-pts[n-1].y)>r*0.55)return null;
  return{cx,cy,r};
}

function animateCircleSnap(s,onDone){
  const dur=340,start=performance.now();
  function frame(now){
    const t=Math.min((now-start)/dur,1);
    const sp=t<0.65?(t/0.65)*1.06:1.06-((t-0.65)/0.35)*0.06;
    lctx.setTransform(1,0,0,1,0,0);lctx.clearRect(0,0,live.width,live.height);
    lctx.save();applyVP(lctx);
    lctx.translate(s.cx,s.cy);lctx.scale(0.82+0.18*sp,0.82+0.18*sp);lctx.translate(-s.cx,-s.cy);
    lctx.globalAlpha=Math.min(t*4,1);lctx.strokeStyle=s.color;lctx.lineWidth=s.w;lctx.lineCap='round';
    lctx.beginPath();lctx.arc(s.cx,s.cy,s.r,0,Math.PI*2);lctx.stroke();
    lctx.restore();
    t<1?requestAnimationFrame(frame):onDone();
  }
  requestAnimationFrame(frame);
}

function pushHistory(){
  undoStack=undoStack.slice(0,histIdx+1);
  undoStack.push(JSON.parse(JSON.stringify(strokes)));
  histIdx++;_updBtns();saveDraft();
}
function _updBtns(){
  BU.disabled=histIdx===0;BR.disabled=histIdx===undoStack.length-1;
}

const clearLive=()=>{lctx.setTransform(1,0,0,1,0,0);lctx.clearRect(0,0,live.width,live.height);};

function appendLiveSeg(ctx,pts,color,width){
  const n=pts.length;
  if(n<2)return;
  ctx.strokeStyle=ctx.fillStyle=color;
  ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();
  if(n===2){ctx.moveTo(pts[0].x,pts[0].y);ctx.lineTo(pts[1].x,pts[1].y);}
  else{
    const i=n-2,p0=pts[i-1]??pts[i];
    ctx.moveTo((p0.x+pts[i].x)/2,(p0.y+pts[i].y)/2);
    ctx.quadraticCurveTo(pts[i].x,pts[i].y,(pts[i].x+pts[i+1].x)/2,(pts[i].y+pts[i+1].y)/2);
  }
  ctx.stroke();
}

async function commitStroke(){
  if(!drawPts.length)return;
  const isE=tool==='eraser',ew=isE?ERASER_W[wi]:PEN_W[wi];
  if(!isE){
    const c=detectCircle(drawPts);
    if(c){
      drawPts=[];clearLive();
      const s={type:'circle',cx:c.cx,cy:c.cy,r:c.r,color:COLORS[ci],w:ew};
      if(recording&&recordStart!=null) replayLog.push({t:performance.now()-recordStart,s:JSON.parse(JSON.stringify(s))});
      animateCircleSnap(s,()=>{strokes=[...strokes,s];pushHistory();if(workerReady)workerRedraw();else renderStroke(getFallbackCtx(),s);clearLive();});
      return;
    }
  }
  const rawStroke={type:isE?'eraser':'pen',color:COLORS[ci],w:ew,pts:drawPts};
  let simplified;
  if(workerReady&&drawPts.length>2){
    const spts=await workerSimplify(drawPts,rawStroke.type,ew);
    simplified=spts?{...rawStroke,pts:spts}:simplifySync(rawStroke);
  }else{
    simplified=simplifySync(rawStroke);
  }
  if(recording&&recordStart!=null) replayLog.push({t:performance.now()-recordStart,s:JSON.parse(JSON.stringify(simplified))});
  strokes=[...strokes,simplified];pushHistory();
  if(!isE){if(workerReady)workerRedraw();else renderStroke(getFallbackCtx(),simplified);clearLive();}
  drawPts=[];
}

function cancelStroke(){drawPts=[];clearLive();if(tool==='eraser')scheduleRedraw();}

function startDraw(sx,sy){
  isDrawing=true;
  const p=s2w(sx,sy);drawPts=[p];
  const isE=tool==='eraser',ew=isE?ERASER_W[wi]:PEN_W[wi];
  if(!isE){applyVP(lctx);lctx.fillStyle=COLORS[ci];lctx.beginPath();lctx.arc(p.x,p.y,ew/2,0,Math.PI*2);lctx.fill();}
  else{const ctx=getFallbackCtx();if(ctx){applyVP(ctx);ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(p.x,p.y,ew/2,0,Math.PI*2);ctx.fill();}}
}

function continueDraw(sx,sy){
  if(!isDrawing)return;
  const p=s2w(sx,sy),last=drawPts[drawPts.length-1];
  const dsx=(p.x-last.x)*vp.scale,dsy=(p.y-last.y)*vp.scale;
  if(dsx*dsx+dsy*dsy<MIN_D2)return;
  drawPts.push(p);
  const isE=tool==='eraser';
  const ctx=isE?getFallbackCtx():lctx;
  if(ctx)appendLiveSeg(ctx,drawPts,isE?'#fff':COLORS[ci],isE?ERASER_W[wi]:PEN_W[wi]);
}

const endDraw=()=>{if(isDrawing){isDrawing=false;commitStroke();}};

const activePointers=new Map();
let drawingPid=-1,pinchGest=null;
function _pairGest(){
  const it=activePointers.values();
  const a=it.next().value,b=it.next().value;
  if(!b)return null;
  return{mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},dist:Math.hypot(b.x-a.x,b.y-a.y)};
}

live.addEventListener('pointerdown',e=>{
  e.preventDefault();live.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  const isMouse=e.pointerType==='mouse';
  if(isMouse&&e.button===1){if(isDrawing){cancelStroke();drawingPid=-1;}midPanning=true;panStart={x:e.clientX,y:e.clientY};vpAtPanStart={...vp};live.style.cursor='grabbing';return;}
  if(spaceDown&&isMouse&&e.button===0){if(isDrawing){cancelStroke();drawingPid=-1;}mousePanning=true;panStart={x:e.clientX,y:e.clientY};vpAtPanStart={...vp};live.style.cursor='grabbing';return;}
  if(activePointers.size>=2){if(isDrawing){cancelStroke();drawingPid=-1;}pinchGest=_pairGest();return;}
  if(pinchGest||(isMouse&&e.button!==0))return;
  if(tool==='text'){openTextInput(e.clientX,e.clientY);return;}
  drawingPid=e.pointerId;startDraw(e.clientX,e.clientY);
});

live.addEventListener('pointermove',e=>{
  e.preventDefault();
  if(e.pointerType!=='touch'){curSX=e.clientX;curSY=e.clientY;drawCursorAt(curSX,curSY);}
  if(!activePointers.has(e.pointerId))return;
  activePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(mousePanning||midPanning){vp.x=vpAtPanStart.x+(e.clientX-panStart.x);vp.y=vpAtPanStart.y+(e.clientY-panStart.y);scheduleRedraw();return;}
  if(pinchGest&&activePointers.size>=2){
    const g=_pairGest();if(!g)return;
    const ns=Math.max(MIN_SCALE,Math.min(MAX_SCALE,vp.scale*g.dist/pinchGest.dist));
    const rf=ns/vp.scale;
    vp.x=pinchGest.mid.x-(pinchGest.mid.x-vp.x)*rf+(g.mid.x-pinchGest.mid.x);
    vp.y=pinchGest.mid.y-(pinchGest.mid.y-vp.y)*rf+(g.mid.y-pinchGest.mid.y);
    vp.scale=ns;pinchGest=g;ZH.textContent=Math.round(ns*100)+'%';scheduleRedraw();
    if(tool==='eraser')drawCursorAt(curSX,curSY);return;
  }
  if(isDrawing&&e.pointerId===drawingPid)continueDraw(e.clientX,e.clientY);
});

function _pointerEnd(e){
  e.preventDefault();activePointers.delete(e.pointerId);
  if(mousePanning||midPanning){
    if(!e.buttons||e.button===1){mousePanning=midPanning=false;live.style.cursor=tool==='text'?'text':'none';if(spaceDown)live.style.cursor='grab';}
    return;
  }
  if(e.pointerId===drawingPid){drawingPid=-1;endDraw();return;}
  if(activePointers.size<2)pinchGest=null;
}
live.addEventListener('pointerup',_pointerEnd);
live.addEventListener('pointercancel',e=>{
  e.preventDefault();activePointers.delete(e.pointerId);
  if(e.pointerId===drawingPid){cancelStroke();drawingPid=-1;}
  if(activePointers.size<2)pinchGest=null;
  mousePanning=midPanning=false;live.style.cursor=tool==='text'?'text':'none';
});
live.addEventListener('pointerleave',e=>{if(!activePointers.has(e.pointerId)){curSX=-999;curSY=-999;drawCursorAt(-1,-1);}});

live.addEventListener('wheel',e=>{
  e.preventDefault();if(isDrawing)return;
  if(e.ctrlKey||e.metaKey)zoomAt(Math.pow(0.998,e.deltaY),e.clientX,e.clientY);
  else{vp.x-=e.deltaX*1.2;vp.y-=e.deltaY*1.2;ZH.textContent=Math.round(vp.scale*100)+'%';}
  scheduleRedraw();if(tool==='eraser'&&curSX>0)drawCursorAt(curSX,curSY);
},{passive:false});

document.addEventListener('keydown',e=>{
  if(ti.style.display==='block')return;
  if(e.code==='Space'&&!spaceDown&&!isDrawing&&!e.repeat){spaceDown=true;e.preventDefault();live.style.cursor='grab';}
  const mod=e.ctrlKey||e.metaKey;
  if(mod&&e.key==='z'){e.preventDefault();BU.click();}
  if(mod&&(e.key==='y'||(e.shiftKey&&e.key==='Z'))){e.preventDefault();BR.click();}
  if(!mod&&!e.shiftKey){
    if(e.key==='p')$('btn-pen').click();
    if(e.key==='t')$('btn-text').click();
    if(e.key==='e')$('btn-eraser').click();
    if(e.key==='0'){vp.x=0;vp.y=0;vp.scale=1;ZH.textContent='100%';scheduleRedraw();}
  }
});
document.addEventListener('keyup',e=>{if(e.code==='Space'){spaceDown=false;mousePanning=false;live.style.cursor=tool==='text'?'text':'none';}});

let _txC=false;
function openTextInput(sx,sy){
  const p=s2w(sx,sy),fs=FONT_SZ[wi],sfs=fs*vp.scale;
  ti.style.cssText=`display:block;left:${sx}px;top:${sy-sfs*.82}px;font-size:${sfs}px;color:${COLORS[ci]};height:auto;min-height:${sfs*1.35}px`;
  ti.value='';ti.dataset.wx=p.x;ti.dataset.wy=p.y;ti.dataset.fs=fs;ti.dataset.ci=ci;ti.focus();
}
ti.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ti.style.display='none';return;}
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();commitText();return;}
  setTimeout(()=>{ti.style.height='auto';ti.style.height=ti.scrollHeight+'px';},0);
});
ti.addEventListener('blur',()=>{if(!_txC)commitText();});
function commitText(){
  if(_txC||ti.style.display==='none')return;
  _txC=true;ti.style.display='none';
  const txt=ti.value.trim();
  if(txt){
    const s={type:'text',text:txt,color:COLORS[+ti.dataset.ci],x:+ti.dataset.wx,y:+ti.dataset.wy,fs:+ti.dataset.fs};
    if(recording&&recordStart!=null)replayLog.push({t:performance.now()-recordStart,s:JSON.parse(JSON.stringify(s))});
    strokes=[...strokes,s];pushHistory();if(workerReady)workerRedraw();else renderStroke(getFallbackCtx(),s);
  }
  _txC=false;
}

BU.addEventListener('click',()=>{if(histIdx>0){histIdx--;strokes=JSON.parse(JSON.stringify(undoStack[histIdx]));redrawBase();_updBtns();}});
BR.addEventListener('click',()=>{if(histIdx<undoStack.length-1){histIdx++;strokes=JSON.parse(JSON.stringify(undoStack[histIdx]));redrawBase();_updBtns();}});

const TOOL_BTNS=['pen','text','eraser'].map(t=>$('btn-'+t));
TOOL_BTNS.forEach(btn=>{
  btn.addEventListener('click',()=>{TOOL_BTNS.forEach(b=>b.classList.remove('on'));btn.classList.add('on');tool=btn.id.slice(4);if(ti.style.display==='block')commitText();setCursorStyle(tool);drawCursorAt(curSX,curSY);});
});
document.querySelectorAll('.cb').forEach((b,i)=>{
  b.addEventListener('click',()=>{document.querySelectorAll('.cb').forEach(x=>x.classList.remove('on'));b.classList.add('on');ci=i;if(ti.style.display==='block')ti.style.color=COLORS[i];drawCursorAt(curSX,curSY);});
});
document.querySelectorAll('.wb').forEach((b,i)=>{
  b.addEventListener('click',()=>{document.querySelectorAll('.wb').forEach(x=>x.classList.remove('on'));b.classList.add('on');wi=i;drawCursorAt(curSX,curSY);});
});
$('zoom-hud').addEventListener('click',()=>{vp.x=0;vp.y=0;vp.scale=1;ZH.textContent='100%';scheduleRedraw();drawCursorAt(curSX,curSY);});

/* ── Binary codec ── */
function _vw(o,v){v=v>>>0;do{let b=v&127;v>>>=7;o.push(v?b|128:b)}while(v)}
function _zw(o,v){_vw(o,v>=0?v*2:(-v-1)*2+1)}
function _vr(b,p){let v=0,s=0;do{const x=b[p.i++];v|=(x&127)<<s;s+=7;if(!(x&128))break}while(1);return v>>>0}
function _zr(b,p){const v=_vr(b,p);return(v&1)?-((v+1)>>1):v>>1}

function encodeBody(ss,viewport){
  const out=[];
  if(viewport){const su=Math.round(viewport.scale*1000)&0xFFFF;out.push(su&255,su>>8);_zw(out,Math.round(viewport.cx));_zw(out,Math.round(viewport.cy));}
  out.push(ss.length&255,ss.length>>8);
  for(const s of ss){
    const tc=s.type==='eraser'?1:s.type==='text'?2:s.type==='circle'?3:0;
    const col=Math.max(0,COLORS.indexOf(s.color));
    const wId=s.type==='text'?Math.max(0,FONT_SZ.indexOf(s.fs)):s.type==='eraser'?Math.max(0,ERASER_W.indexOf(s.w)):Math.max(0,PEN_W.indexOf(s.w));
    out.push((tc<<6)|(col<<3)|(wId&3));
    if(s.type==='circle'){_zw(out,Math.round(s.cx));_zw(out,Math.round(s.cy));_vw(out,Math.max(0,Math.round(s.r)));}
    else if(s.type==='text'){
      const x=Math.max(0,Math.min(65535,Math.round(s.x)+32768));
      const y=Math.max(0,Math.min(65535,Math.round(s.y)+32768));
      out.push(x&255,x>>8,y&255,y>>8);
      const tb=new TextEncoder().encode((s.text||'').slice(0,500));
      _vw(out,tb.length);for(const b of tb)out.push(b);
    }else{
      const pts=s.pts||[];out.push(pts.length&255,pts.length>>8);
      if(!pts.length)continue;
      const x0=Math.max(0,Math.min(65535,Math.round(pts[0].x)+32768));
      const y0=Math.max(0,Math.min(65535,Math.round(pts[0].y)+32768));
      out.push(x0&255,x0>>8,y0&255,y0>>8);
      let px=Math.round(pts[0].x),py=Math.round(pts[0].y);
      for(let i=1;i<pts.length;i++){const x=Math.round(pts[i].x),y=Math.round(pts[i].y);_zw(out,x-px);_zw(out,y-py);px=x;py=y;}
    }
  }
  return new Uint8Array(out);
}

function encodeReplayLog(log){
  const out=[];_vw(out,log.length);
  let prevT=0;
  for(const {t,s} of log){
    _vw(out,Math.round(t-prevT));prevT=t;
    const tc=s.type==='eraser'?1:s.type==='text'?2:s.type==='circle'?3:0;
    const col=Math.max(0,COLORS.indexOf(s.color));
    const wId=s.type==='text'?Math.max(0,FONT_SZ.indexOf(s.fs)):s.type==='eraser'?Math.max(0,ERASER_W.indexOf(s.w)):Math.max(0,PEN_W.indexOf(s.w));
    out.push((tc<<6)|(col<<3)|(wId&3));
    if(s.type==='circle'){_zw(out,Math.round(s.cx));_zw(out,Math.round(s.cy));_vw(out,Math.max(0,Math.round(s.r)));}
    else if(s.type==='text'){
      const x=Math.max(0,Math.min(65535,Math.round(s.x)+32768));
      const y=Math.max(0,Math.min(65535,Math.round(s.y)+32768));
      out.push(x&255,x>>8,y&255,y>>8);
      const tb=new TextEncoder().encode((s.text||'').slice(0,500));
      _vw(out,tb.length);for(const b of tb)out.push(b);
    }else{
      const pts=s.pts||[];out.push(pts.length&255,pts.length>>8);
      if(!pts.length)continue;
      const x0=Math.max(0,Math.min(65535,Math.round(pts[0].x)+32768));
      const y0=Math.max(0,Math.min(65535,Math.round(pts[0].y)+32768));
      out.push(x0&255,x0>>8,y0&255,y0>>8);
      let px=Math.round(pts[0].x),py=Math.round(pts[0].y);
      for(let i=1;i<pts.length;i++){const x=Math.round(pts[i].x),y=Math.round(pts[i].y);_zw(out,x-px);_zw(out,y-py);px=x;py=y;}
    }
  }
  return new Uint8Array(out);
}

function decodeReplayLog(bytes,p){
  const count=_vr(bytes,p);const log=[];let t=0;
  for(let li=0;li<count;li++){
    const dt=_vr(bytes,p);t+=dt;
    const flags=bytes[p.i++],tc=(flags>>6)&3,col=(flags>>3)&7,wId=flags&3;
    const color=COLORS[Math.min(col,5)];
    const type=tc===1?'eraser':tc===2?'text':tc===3?'circle':'pen';
    let s;
    if(type==='circle'){const cx=_zr(bytes,p),cy=_zr(bytes,p),r=_vr(bytes,p);s={type:'circle',cx,cy,r,color,w:PEN_W[wId]||PEN_W[0]};}
    else if(type==='text'){
      const x=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;
      const y=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;
      const tl=_vr(bytes,p);const text=new TextDecoder().decode(bytes.slice(p.i,p.i+tl));p.i+=tl;
      s={type:'text',text,color,x,y,fs:FONT_SZ[wId]||FONT_SZ[0]};
    }else{
      const ptc=bytes[p.i]|(bytes[p.i+1]<<8);p.i+=2;const pts=[];
      if(ptc>0){let x=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;let y=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;pts.push({x,y});for(let i=1;i<ptc;i++){x+=_zr(bytes,p);y+=_zr(bytes,p);pts.push({x,y});}}
      s={type,color,w:type==='eraser'?(ERASER_W[wId]||ERASER_W[0]):(PEN_W[wId]||PEN_W[0]),pts};
    }
    log.push({t,s});
  }
  return log;
}

function decodeBody(bytes,hasVP){
  const p={i:0};let rvp=null;
  if(hasVP){const su=bytes[p.i]|(bytes[p.i+1]<<8);p.i+=2;rvp={scale:su/1000,cx:_zr(bytes,p),cy:_zr(bytes,p)};}
  const count=bytes[p.i]|(bytes[p.i+1]<<8);p.i+=2;
  const ss=[];
  for(let si=0;si<count;si++){
    const flags=bytes[p.i++],tc=(flags>>6)&3,col=(flags>>3)&7,wId=flags&3;
    const color=COLORS[Math.min(col,5)];
    const type=tc===1?'eraser':tc===2?'text':tc===3?'circle':'pen';
    if(type==='circle'){const cx=_zr(bytes,p),cy=_zr(bytes,p),r=_vr(bytes,p);ss.push({type:'circle',cx,cy,r,color,w:PEN_W[wId]||PEN_W[0]});}
    else if(type==='text'){
      const x=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;
      const y=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;
      const tl=_vr(bytes,p);const text=new TextDecoder().decode(bytes.slice(p.i,p.i+tl));p.i+=tl;
      ss.push({type:'text',text,color,x,y,fs:FONT_SZ[wId]||FONT_SZ[0]});
    }else{
      const ptc=bytes[p.i]|(bytes[p.i+1]<<8);p.i+=2;const pts=[];
      if(ptc>0){let x=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;let y=(bytes[p.i]|(bytes[p.i+1]<<8))-32768;p.i+=2;pts.push({x,y});for(let i=1;i<ptc;i++){x+=_zr(bytes,p);y+=_zr(bytes,p);pts.push({x,y});}}
      ss.push({type,color,w:type==='eraser'?(ERASER_W[wId]||ERASER_W[0]):(PEN_W[wId]||PEN_W[0]),pts});
    }
  }
  // Check for replay log after strokes
  let log=null;
  if(p.i<bytes.length){try{log=decodeReplayLog(bytes,p);}catch{}}
  return{strokes:ss,vp:rvp,log};
}

const toB64u=b=>{let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')};
const fromB64u=s=>{const b=atob(s.replace(/-/g,'+').replace(/_/g,'/'));const r=new Uint8Array(b.length);for(let i=0;i<b.length;i++)r[i]=b.charCodeAt(i);return r};

// ── Feature 2: ReadableStream + CompressionStream ──
async function compress(bytes){
  if(!('CompressionStream' in window))return{b:bytes,v:false};
  try{
    const cs=new CompressionStream('deflate-raw');
    const writer=cs.writable.getWriter();
    const CHUNK=65536;
    for(let i=0;i<bytes.length;i+=CHUNK)writer.write(bytes.subarray(i,i+CHUNK));
    writer.close();
    const chunks=[];const reader=cs.readable.getReader();
    while(true){const{done,value}=await reader.read();if(done)break;chunks.push(value);}
    const total=chunks.reduce((n,c)=>n+c.length,0);
    const out=new Uint8Array(total);let off=0;
    for(const c of chunks){out.set(c,off);off+=c.length;}
    return out.length<bytes.length?{b:out,v:true}:{b:bytes,v:false};
  }catch{return{b:bytes,v:false};}
}

async function decompress(bytes){
  if(!('DecompressionStream' in window))return bytes;
  try{
    const ds=new DecompressionStream('deflate-raw');
    const writer=ds.writable.getWriter();writer.write(bytes);writer.close();
    const chunks=[];const reader=ds.readable.getReader();
    while(true){const{done,value}=await reader.read();if(done)break;chunks.push(value);}
    const total=chunks.reduce((n,c)=>n+c.length,0);
    const out=new Uint8Array(total);let off=0;
    for(const c of chunks){out.set(c,off);off+=c.length;}
    return out;
  }catch{return bytes;}
}

async function strokesToHash(ss,includeReplay){
  const W=innerWidth,H=innerHeight;
  const body=encodeBody(ss,{scale:vp.scale,cx:Math.round((-vp.x+W/2)/vp.scale),cy:Math.round((-vp.y+H/2)/vp.scale)});
  let full;
  if(includeReplay&&replayLog.length){
    const rlog=encodeReplayLog(replayLog);
    full=new Uint8Array(body.length+rlog.length);
    full.set(body);full.set(rlog,body.length);
  }else{full=body;}
  const{b:payload,v:deflated}=await compress(full);
  const pkg=new Uint8Array(2+payload.length);
  pkg[0]=0xAB;pkg[1]=deflated?5:4;pkg.set(payload,2);
  return toB64u(pkg);
}

async function hashToStrokes(hash){
  try{
    const bytes=fromB64u(hash);
    if(bytes[0]===0xAB){
      const v=bytes[1],hasVP=v===4||v===5;
      let body=bytes.slice(2);
      if(v===3||v===5)body=await decompress(body);
      return decodeBody(body,hasVP);
    }
  }catch(e){console.warn('bin:',e);}
  try{
    if(typeof LZString!=='undefined'){
      const json=LZString.decompressFromEncodedURIComponent(hash);
      if(json){
        const CV={'var(--c0)':'#363028','var(--c1)':'#C9A89A','var(--c2)':'#8FA89A','var(--c3)':'#8A9BAE','var(--c4)':'#C4B49A','var(--c5)':'#A898AE'};
        return{strokes:JSON.parse(json).map(s=>({...s,color:CV[s.color]||s.color||COLORS[0]})),vp:null,log:null};
      }
    }
  }catch(e){console.warn('lz:',e);}
  return null;
}

// ── Feature 5: Auto-save draft with Temporal API ──
const DRAFT_KEY='cicada_draft_v2';
let draftTimer=null;

function saveDraft(){
  clearTimeout(draftTimer);
  draftTimer=setTimeout(async()=>{
    try{
      const hash=await strokesToHash(strokes,false);
      const ts=('Temporal' in globalThis)
        ?Temporal.Now.instant().epochMilliseconds
        :Date.now();
      localStorage.setItem(DRAFT_KEY,JSON.stringify({hash,ts,count:strokes.length}));
    }catch{}
  },1500);
}

function loadDraft(){
  try{
    const raw=localStorage.getItem(DRAFT_KEY);if(!raw)return null;
    const{hash,ts,count}=JSON.parse(raw);
    const age=Date.now()-ts;
    if(age>7*24*3600*1000){localStorage.removeItem(DRAFT_KEY);return null;}
    return{hash,age,count};
  }catch{return null;}
}
const clearDraft=()=>localStorage.removeItem(DRAFT_KEY);

// ── Feature 1: Replay ──
let replayActive=false;
async function startReplay(log){
  if(!log?.length||replayActive)return;
  replayActive=true;
  const savedStrokes=strokes.slice();
  strokes=[];clearLive();redrawBase();
  const temp=[];
  const t0=performance.now(),t_start=log[0].t;
  await new Promise(resolve=>{
    let i=0;
    function frame(now){
      const elapsed=now-t0;
      while(i<log.length&&log[i].t-t_start<=elapsed){temp.push(log[i].s);i++;}
      strokes=temp.slice();
      if(workerReady)workerRedraw();else redrawBase();
      if(i<log.length)requestAnimationFrame(frame);else resolve();
    }
    requestAnimationFrame(frame);
  });
  strokes=savedStrokes;redrawBase();
  replayActive=false;
}

// ── Feature 3: Share popover ──
function showSharePopover(btn){
  const existing=$('share-pop');
  if(existing){existing.remove();return;}
  const pop=document.createElement('div');pop.id='share-pop';
  pop.innerHTML=`<button id="sp-png">Save as PNG</button><button id="sp-svg">Copy SVG</button><button id="sp-link">Copy link</button>`;
  document.body.appendChild(pop);
  const r=btn.getBoundingClientRect();
  pop.style.cssText=`position:fixed;z-index:50;bottom:${innerHeight-r.top+8}px;left:${r.left+r.width/2}px;transform:translateX(-50%);background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:.5px solid var(--glass-border);border-radius:14px;padding:6px;display:flex;flex-direction:column;gap:2px;box-shadow:0 4px 28px rgba(0,0,0,.13);animation:fadeIn .18s ease both`;
  const close=e=>{if(!pop.contains(e.target)&&e.target!==btn){pop.remove();document.removeEventListener('pointerdown',close);}};
  setTimeout(()=>document.addEventListener('pointerdown',close),10);
  $('sp-png').onclick=()=>{pop.remove();savePNG();};
  $('sp-svg').onclick=()=>{pop.remove();copySVG();};
  $('sp-link').onclick=()=>{pop.remove();copyLink();};
}

async function savePNG(){
  const pad=40;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const s of strokes){
    if(s.type==='text'){x0=Math.min(x0,s.x);y0=Math.min(y0,s.y-s.fs);x1=Math.max(x1,s.x+400);y1=Math.max(y1,s.y+40);}
    else if(s.type==='circle'){x0=Math.min(x0,s.cx-s.r);y0=Math.min(y0,s.cy-s.r);x1=Math.max(x1,s.cx+s.r);y1=Math.max(y1,s.cy+s.r);}
    else if(s.pts?.length)for(const p of s.pts){x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);}
  }
  if(x0===Infinity){x0=0;y0=0;x1=800;y1=600;}
  const W=Math.max(1,x1-x0+pad*2),H=Math.max(1,y1-y0+pad*2);
  const oc=new OffscreenCanvas(Math.round(W*2),Math.round(H*2));
  const octx=oc.getContext('2d');
  octx.scale(2,2);octx.fillStyle='#fff';octx.fillRect(0,0,W,H);
  octx.translate(-x0+pad,-y0+pad);
  for(const s of strokes)renderStroke(octx,s);
  const blob=await oc.convertToBlob({type:'image/png'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='cicada.png';a.click();URL.revokeObjectURL(a.href);
  toast('PNG saved');
}

function copySVG(){
  let paths='';
  for(const s of strokes){
    if(s.type==='pen'||s.type==='eraser'){
      const p=s.pts||[];if(!p.length)continue;
      let d=`M${p[0].x},${p[0].y}`;
      for(let i=1;i<p.length-1;i++)d+=`Q${p[i].x},${p[i].y} ${(p[i].x+p[i+1].x)/2},${(p[i].y+p[i+1].y)/2}`;
      if(p.length>1)d+=`L${p[p.length-1].x},${p[p.length-1].y}`;
      paths+=`<path d="${d}" stroke="${s.type==='eraser'?'#fff':s.color}" stroke-width="${s.w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    }else if(s.type==='circle'){
      paths+=`<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" stroke="${s.color}" stroke-width="${s.w}" fill="none"/>`;
    }else if(s.type==='text'){
      paths+=`<text x="${s.x}" y="${s.y}" font-size="${s.fs}" fill="${s.color}" font-family="Georgia,serif">${s.text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</text>`;
    }
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" style="background:#fff">${paths}</svg>`;
  navigator.clipboard.writeText(svg).then(()=>toast('SVG copied')).catch(()=>toast('Copy failed'));
}

async function copyLink(){
  const btn=$('btn-save');btn.disabled=true;btn.style.opacity='.25';
  try{
    const hash=await strokesToHash(strokes,recording);
    const url=location.origin+location.pathname+'#'+hash;
    history.replaceState(null,'','#'+hash);
    await navigator.clipboard.writeText(url).catch(()=>{});
    toast(`Link copied · ${(hash.length*.75/1024).toFixed(1)} KB`);
  }catch(e){console.error(e);toast('Save failed');}
  finally{btn.disabled=false;btn.style.opacity='';}
}

$('btn-save').addEventListener('click',()=>showSharePopover($('btn-save')));

let _tT;
function toast(msg){TT.textContent=msg;TT.classList.add('show');clearTimeout(_tT);_tT=setTimeout(()=>TT.classList.remove('show'),3000);}

function fitContent(){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const s of strokes){
    if(s.type==='text'){x0=Math.min(x0,s.x);y0=Math.min(y0,s.y-s.fs);x1=Math.max(x1,s.x+200);y1=Math.max(y1,s.y+20);}
    else if(s.type==='circle'){x0=Math.min(x0,s.cx-s.r);y0=Math.min(y0,s.cy-s.r);x1=Math.max(x1,s.cx+s.r);y1=Math.max(y1,s.cy+s.r);}
    else if(s.pts?.length)for(const p of s.pts){x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);}
  }
  if(x0===Infinity)return;
  const W=innerWidth,H=innerHeight,pad=80;
  vp.scale=Math.min(W/(x1-x0+pad*2),H/(y1-y0+pad*2),1);
  vp.x=(W-(x1-x0+pad*2)*vp.scale)/2-x0*vp.scale+pad*vp.scale;
  vp.y=(H-(y1-y0+pad*2)*vp.scale)/2-y0*vp.scale+pad*vp.scale;
  ZH.textContent=Math.round(vp.scale*100)+'%';scheduleRedraw();
}

// ── Popover + record toggle styles ──
const styleEl=document.createElement('style');
styleEl.textContent=`
#share-pop button{display:block;width:100%;padding:9px 18px;border:none;background:transparent;font-size:13px;font-weight:500;text-align:left;cursor:pointer;border-radius:9px;color:var(--label);transition:background .1s}
#share-pop button:hover{background:var(--fill)}
#btn-record.on{color:#ff3b30;opacity:1}
`;
document.head.appendChild(styleEl);

// ── Init ──
(async()=>{
  initWorker();
  resize();redrawBase();_updBtns();setCursorStyle('pen');

  const recBtn=$('btn-record');
  recBtn.addEventListener('click',()=>{
    recording=!recording;
    recBtn.classList.toggle('on',recording);
    recBtn.title=recording?'Recording on — replay will be included in shared link':'Recording off — replay disabled';
    toast(recording?'Replay recording on':'Replay recording off');
  });
  recBtn.classList.add('on');

  const h=location.hash.slice(1);
  if(h){
    try{
      const result=await hashToStrokes(h);
      if(result?.strokes?.length){
        strokes=result.strokes;
        undoStack=[[],JSON.parse(JSON.stringify(strokes))];histIdx=1;
        if(result.vp){
          vp.scale=result.vp.scale;
          vp.x=innerWidth/2-result.vp.cx*vp.scale;
          vp.y=innerHeight/2-result.vp.cy*vp.scale;
          ZH.textContent=Math.round(vp.scale*100)+'%';
        }else fitContent();
        redrawBase();_updBtns();
        clearDraft();
        // Auto-play replay if embedded
        if(result.log?.length){
          setTimeout(()=>startReplay(result.log),400);
        }
      }
    }catch(e){console.warn('load:',e);}
  }else{
    const draft=loadDraft();
    if(draft&&draft.count>0){
      const ageMin=Math.round(draft.age/60000);
      const label=ageMin<60?`${ageMin}m ago`:`${Math.round(ageMin/60)}h ago`;
      TT.innerHTML=`Draft from ${label} — <span id="dr" style="text-decoration:underline;cursor:pointer">Restore</span>&ensp;<span id="dd" style="opacity:.6;cursor:pointer">Discard</span>`;
      TT.classList.add('show');
      $('dr').onclick=async()=>{
        TT.classList.remove('show');
        const result=await hashToStrokes(draft.hash);
        if(result?.strokes?.length){
          strokes=result.strokes;undoStack=[[],JSON.parse(JSON.stringify(strokes))];histIdx=1;
          if(result.vp){vp.scale=result.vp.scale;vp.x=innerWidth/2-result.vp.cx*vp.scale;vp.y=innerHeight/2-result.vp.cy*vp.scale;ZH.textContent=Math.round(vp.scale*100)+'%';}
          else fitContent();redrawBase();_updBtns();
        }
      };
      $('dd').onclick=()=>{clearDraft();TT.classList.remove('show');};
    }
  }

  recordStart=performance.now();
})();
