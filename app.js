import { RunnerPipeline } from './src/pipeline/RunnerPipeline.js';
import { MockDetector } from './src/pipeline/MockDetector.js';

/*
 * Application controller for the standalone runner-tracking prototype.
 *
 * The existing modules provide tracking, Kalman prediction, crossing
 * interpolation and synthetic detections. There is not currently a real
 * person-detection model in this repository, so camera/video mode deliberately
 * displays the source but reports that detections are unavailable rather than
 * pretending that an empty detection list is a working AI detector.
 *
 * A future detector can be connected through window.runnerDetectorFactory:
 *   const detector = await window.runnerDetectorFactory();
 *   await detector.initialize();
 *   const detections = await detector.detect(video);
 * Each detection must be { bbox:{x,y,width,height}, score, classId:0 }
 * with normalised coordinates in the range 0..1.
 */

const $ = (id) => document.getElementById(id);

class RunnerTrackingApp {
  constructor() {
    this.canvas = $('stage');
    this.video = $('video-source');
    if (!this.canvas || !this.video) {
      console.error('Runner app requires #stage and #video-source elements.');
      return;
    }

    this.ctx = this.canvas.getContext('2d');
    this.mode = 'mock';
    this.mockDetector = new MockDetector('pack_crossing');
    this.detector = null;
    this.detectorReady = false;
    this.pipeline = this.createPipeline();
    this.running = false;
    this.rafId = null;
    this.lastFrameAt = 0;
    this.fpsFrames = 0;
    this.fpsStartedAt = performance.now();
    this.fps = 0;
    this.lastLatency = 0;
    this.objectUrl = null;
    this.stream = null;
    this.lineDrag = false;
    this.lineEnd = 'p1';
    this.reviewEvent = null;

    this.buildControls();
    this.bindEvents();
    this.setStatus('STANDBY', 'ok');
    this.renderResults();
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  createPipeline() {
    return new RunnerPipeline({
      lineP1: { x: 0.5, y: 0.05 },
      lineP2: { x: 0.5, y: 0.95 },
      direction: 'ltr',
      onFinisherDetected: (event) => this.onFinisher(event)
    });
  }

  buildControls() {
    const viewport = this.canvas.parentElement;
    viewport.style.cssText = 'position:relative;flex:1;min-width:0;min-height:0;width:100%;height:100%;overflow:hidden;background:#000;touch-action:pan-y';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;display:block';
    this.video.style.cssText = 'display:none';
    let controls = $('app-controls');
    if (!controls) { controls = document.createElement('section'); controls.id = 'app-controls'; viewport.appendChild(controls); }
    controls.innerHTML = `
      <button id="app-start" class="primary">START</button>
      <button id="app-stop">STOP</button>
      <button id="app-more" aria-expanded="false">MORE</button>
      <div id="app-more-menu" hidden>
        <button id="app-line">Set finish line</button>
        <button id="app-direction">Direction: left → right</button>
        <button id="app-export">Export as CSV</button>
        <button id="app-flip">Flip camera</button>
        <button id="app-new">New race</button>
      </div>`;
    controls.style.cssText = 'position:absolute;z-index:20;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:8px;background:rgba(13,17,23,.88);border:1px solid rgba(255,255,255,.16);border-radius:16px;box-shadow:0 8px 30px #0008;backdrop-filter:blur(12px);max-width:calc(100% - 20px)';
    controls.querySelectorAll('button').forEach(b=>b.style.cssText='min-height:46px;min-width:66px;padding:0 15px;border:1px solid #424b57;border-radius:11px;background:#212936;color:#f0f6fc;font-weight:700;font-size:13px;letter-spacing:.04em;touch-action:manipulation;white-space:nowrap');
    $('app-start').style.background='#16833b'; $('app-stop').style.background='#a52b2b';
    const menu=$('app-more-menu');
    menu.style.cssText='position:absolute;bottom:calc(100% + 10px);right:0;min-width:190px;padding:7px;gap:5px;flex-direction:column;background:rgba(22,27,34,.97);border:1px solid #424b57;border-radius:13px;box-shadow:0 8px 30px #0009';
    menu.querySelectorAll('button').forEach(b=>b.style.cssText='width:100%;min-height:44px;text-align:left;padding:0 12px;border:0;border-radius:8px;background:#212936;color:#f0f6fc;font-size:13px;touch-action:manipulation');
    let status=$('status-tag');
    if(!status){status=document.createElement('div');status.id='status-tag';viewport.appendChild(status);}
    status.style.cssText='position:absolute;z-index:10;top:max(12px,env(safe-area-inset-top));left:12px;padding:7px 10px;border-radius:9px;background:#0d1117cc;color:#2ea043;font:12px monospace;pointer-events:none';
    let results=$('app-results');
    if(!results){results=document.createElement('aside');results.id='app-results';viewport.appendChild(results);}
    results.innerHTML='<div style="font:12px monospace;color:#fff">FINISHERS <span id="app-finisher-count">0</span></div><ol id="app-finisher-list" style="padding:5px 0 0 22px;margin:0;font:12px monospace;color:#fff"></ol>';
    results.style.cssText='position:absolute;z-index:10;top:max(12px,env(safe-area-inset-top));right:12px;width:min(210px,42%);max-height:32%;overflow:auto;padding:9px;background:#0d1117cc;border:1px solid #ffffff26;border-radius:9px;pointer-events:auto';
    let telemetry=$('app-telemetry');
    if(!telemetry){telemetry=document.createElement('div');telemetry.id='app-telemetry';viewport.appendChild(telemetry);}
    telemetry.style.cssText='position:absolute;z-index:8;left:12px;top:52px;max-width:70%;padding:5px 7px;background:#0d1117a8;border-radius:6px;color:#d0d7de;font:10px monospace;pointer-events:none';
  }

  bindEvents() {
    $('app-start').addEventListener('click',()=>this.startRace());
    $('app-stop').addEventListener('click',()=>this.stopRace());
    $('app-more').addEventListener('click',()=>{
      const menu=$('app-more-menu'),open=menu.hidden;
      menu.hidden=!open;menu.style.display=open?'flex':'none';
      $('app-more').setAttribute('aria-expanded',String(open));
    });
    $('app-line').addEventListener('click',()=>{
      this.lineDrag=true;this.lineEnd='p1';$('app-line').textContent='Tap start point…';
      $('app-more-menu').hidden=true;$('app-more-menu').style.display='none';
      $('app-more').setAttribute('aria-expanded','false');this.setStatus('TAP TWO POINTS TO SET LINE','warn');
    });
    $('app-direction').addEventListener('click',()=>{
      const line=this.pipeline.crossingEngine;line.direction=line.direction==='ltr'?'rtl':'ltr';
      $('app-direction').textContent=line.direction==='ltr'?'Direction: left → right':'Direction: right → left';
    });
    $('app-export').addEventListener('click',()=>this.exportCSV());
    $('app-flip').addEventListener('click',()=>this.flipCamera());
    $('app-new').addEventListener('click',()=>{
      if(confirm('Start a new race and clear the current results?'))this.resetRace();
    });
    this.canvas.addEventListener('pointerdown',e=>this.onCanvasPointer(e));
  }

  async startCamera() {
    if(!navigator.mediaDevices?.getUserMedia){this.setStatus('CAMERA UNAVAILABLE — OPEN OVER HTTPS','error');return;}
    try{
      this.stopMedia();
      this.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{
        facingMode:{ideal:this.cameraFacing||'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:60}
      }});
      this.video.srcObject=this.stream;await this.video.play();this.mode='camera';this.resizeCanvas();
      await this.initializeDetector();
      this.setStatus(this.detectorReady?'CAMERA READY':'CAMERA READY · DETECTOR NOT CONNECTED',this.detectorReady?'ok':'warn');
    }catch(error){this.setStatus('CAMERA ERROR: '+error.message,'error');}
  }

  async flipCamera(){
    this.cameraFacing=this.cameraFacing==='environment'?'user':'environment';
    await this.startCamera();
    $('app-more-menu').hidden=true;$('app-more-menu').style.display='none';$('app-more').setAttribute('aria-expanded','false');
  }

  resizeCanvas(){
    const rect=this.canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
    const width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
    if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;}
  }

  async loadVideo(file) {
    if (!file) return;
    this.stopMedia();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.video.srcObject = null;
    this.video.src = this.objectUrl;
    this.video.loop = false;
    try {
      await this.video.play();
      this.mode = 'file';
      await this.initializeDetector();
      this.updateModeLabel();
      this.setStatus(this.detectorReady ? 'VIDEO PLAYING' : 'VIDEO — NO DETECTOR', this.detectorReady ? 'ok' : 'warn');
    } catch (error) {
      this.setStatus('VIDEO ERROR: ' + error.message, 'error');
    }
  }

  async initializeDetector() {
    this.detectorReady = false;
    this.detector = null;
    if (typeof window.runnerDetectorFactory !== 'function') return;
    try {
      this.detector = await window.runnerDetectorFactory();
      await this.detector.initialize?.();
      this.detectorReady = typeof this.detector.detect === 'function';
    } catch (error) {
      console.error('Detector initialisation failed:', error);
      this.setStatus('DETECTOR ERROR: ' + error.message, 'error');
    }
  }

  useMock() {
    this.stopMedia();
    this.mode = 'mock';
    this.mockDetector = new MockDetector($('app-scenario').value);
    this.updateModeLabel();
    this.setStatus('SYNTHETIC TEST MODE', 'ok');
  }

  startRace() {
    if (this.running) return;
    this.pipeline.startRace(performance.now());
    this.running = true;
    this.setStatus('TIMING ACTIVE', 'ok');
  }

  stopRace() {
    if (!this.running) return;
    this.pipeline.stopRace();
    this.running = false;
    this.setStatus('STOPPED', 'error');
  }

  resetRace(){
    this.pipeline=this.createPipeline();this.running=false;this.lineDrag=false;this.lineEnd='p1';
    $('app-line').textContent='Set finish line';this.renderResults();this.setStatus('NEW RACE · STANDBY','ok');
    $('app-more-menu').hidden=true;$('app-more-menu').style.display='none';$('app-more').setAttribute('aria-expanded','false');
  }

  stopMedia() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video.srcObject) this.video.srcObject = null;
    this.video.pause();
  }

  async getDetections(now) {
    if (this.mode === 'mock') return this.mockDetector.generateFrame(now);
    if (!this.detectorReady || !this.detector || this.video.readyState < 2) return [];
    try {
      const detections = await this.detector.detect(this.video);
      return Array.isArray(detections) ? detections : [];
    } catch (error) {
      console.error('Detection failed:', error);
      this.setStatus('DETECTION ERROR', 'error');
      return [];
    }
  }

  async loop(now){
    if(this.mode==='file'&&this.video.ended)this.stopRace();
    this.resizeCanvas();
    if(this.mode==='mock'||(this.video.readyState>=2&&this.detectorReady)){
      if(!this.processingFrame){
        this.processingFrame=true;const t0=performance.now();
        try{const detections=await this.getDetections(now);this.pipeline.processFrame(detections,now);this.lastLatency=performance.now()-t0;}
        finally{this.processingFrame=false;}
      }
    }
    this.fpsFrames++;
    if(now-this.fpsStartedAt>=1000){this.fps=this.fpsFrames*1000/(now-this.fpsStartedAt);this.fpsFrames=0;this.fpsStartedAt=now;}
    this.draw();this.updateTelemetry();this.rafId=requestAnimationFrame(this.loop);
  }

  draw(){
    const {canvas,ctx,video}=this,w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);
    if((this.mode==='camera'||this.mode==='file')&&video.readyState>=2){
      const vw=video.videoWidth||w,vh=video.videoHeight||h,scale=Math.max(w/vw,h/vh),dw=vw*scale,dh=vh*scale;
      ctx.drawImage(video,(w-dw)/2,(h-dh)/2,dw,dh);
    }else{ctx.fillStyle='#080b10';ctx.fillRect(0,0,w,h);ctx.fillStyle='#8b949e';ctx.font='16px monospace';ctx.fillText('Waiting for camera…',20,32);}
    const line=this.pipeline.crossingEngine;
    ctx.beginPath();ctx.moveTo(line.p1.x*w,line.p1.y*h);ctx.lineTo(line.p2.x*w,line.p2.y*h);
    ctx.strokeStyle='#2ea043';ctx.lineWidth=Math.max(3,w/450);ctx.setLineDash([10,7]);ctx.stroke();ctx.setLineDash([]);
    for(const track of this.pipeline.tracker.tracks){
      const b=track.kf.getBBox(),x=b.x*w,y=b.y*h,bw=b.width*w,bh=b.height*h;
      ctx.strokeStyle=track.hasCrossed?'#da3633':'#58a6ff';ctx.lineWidth=Math.max(2,w/700);ctx.strokeRect(x,y,bw,bh);
      ctx.fillStyle='#fff';ctx.font='14px monospace';ctx.fillText('ID '+track.id,x,Math.max(16,y-5));
    }
  }

  onCanvasPointer(event){
    if(!this.lineDrag)return;
    const rect=this.canvas.getBoundingClientRect(),point={
      x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),
      y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))
    };
    if(this.lineEnd==='p1'){this.pipeline.crossingEngine.p1=point;this.lineEnd='p2';$('app-line').textContent='Tap end point…';}
    else{this.pipeline.crossingEngine.p2=point;this.lineEnd='p1';this.lineDrag=false;$('app-line').textContent='Set finish line';this.setStatus(this.running?'TIMING ACTIVE':'STANDBY','ok');}
  }

  onFinisher(event) {
    this.renderResults();
    const log = $('finisher-log');
    if (log) {
      const li = document.createElement('li');
      li.textContent = 'ID ' + event.trackId + ' — ' + event.formattedTime +
        (event.flags.length ? ' — ' + event.flags.join(', ') : '');
      log.prepend(li);
    }
    if (event.flags.length) {
      this.setStatus('FINISH RECORDED — REVIEW FLAGGED RESULT', 'warn');
    }
  }

  renderResults(){
    const list=$('app-finisher-list'),count=$('app-finisher-count');
    if(count)count.textContent=String(this.pipeline.finishers.length);
    if(!list)return;list.replaceChildren();
    for(const event of this.pipeline.finishers){
      const li=document.createElement('li');
      li.textContent='#'+event.position+'  '+event.formattedTime+'  (ID '+event.trackId+')'+(event.flags.length?' ⚠':'');
      list.appendChild(li);
    }
  }

  updateTelemetry() {
    const el = $('app-telemetry');
    if (!el) return;
    el.textContent = [
      'FPS: ' + this.fps.toFixed(1),
      'Pipeline latency: ' + this.lastLatency.toFixed(1) + ' ms',
      'Tracks: ' + this.pipeline.tracker.tracks.length,
      'Finishers: ' + this.pipeline.finishers.length,
      'Input: ' + this.mode,
      'Detector: ' + (this.mode === 'mock' ? 'synthetic' : this.detectorReady ? 'connected' : 'not connected')
    ].join('  |  ');
  }

  updateModeLabel() {
    $('app-mode').textContent = 'Mode: ' + this.mode;
  }

  setStatus(message, kind = 'ok') {
    const el = $('status-tag');
    if (!el) return;
    el.textContent = message;
    el.style.color = kind === 'error' ? '#da3633' : kind === 'warn' ? '#d29922' : '#2ea043';
  }

  exportCSV() {
    const rows = [
      ['Position','Runner ID','Time','Elapsed ms','Crossing timestamp','Confidence','Alpha','Flags'],
      ...this.pipeline.finishers.map(f => [
        f.position, f.trackId, f.formattedTime, f.elapsedMs,
        f.exactTimestamp, f.confidence, f.alpha, f.flags.join(';')
      ])
    ];
    const csv = rows.map(row => row.map(value => {
      const s = String(value ?? '');
      return '"' + s.replaceAll('"', '""') + '"';
    }).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'race-results-' + new Date().toISOString().replaceAll(':','-') + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.runnerApp = new RunnerTrackingApp();
});
