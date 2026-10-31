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
    // Build the controller UI here so the prototype remains usable even if
    // the HTML is kept intentionally minimal.
    let controls = $('app-controls');
    if (!controls) {
      controls = document.createElement('section');
      controls.id = 'app-controls';
      controls.style.cssText = [
        'position:absolute','z-index:10','left:12px','right:12px','bottom:12px',
        'display:flex','flex-wrap:wrap','gap:8px','align-items:center',
        'padding:10px','background:rgba(22,27,34,.94)','border:1px solid #30363d',
        'border-radius:10px','backdrop-filter:blur(8px)'
      ].join(';');
      this.canvas.parentElement.appendChild(controls);
    }

    controls.innerHTML = `
      <button id="app-start" class="primary">Start race</button>
      <button id="app-stop">Stop</button>
      <button id="app-reset">Reset race</button>
      <button id="app-camera">Use camera</button>
      <button id="app-file">Load video</button>
      <button id="app-mock">Synthetic test</button>
      <select id="app-scenario" aria-label="Synthetic test scenario">
        <option value="pack_crossing">Pack crossing</option>
        <option value="occlusion_and_cross">Occlusion</option>
        <option value="reversal_no_finish">Reversal</option>
      </select>
      <select id="app-direction" aria-label="Crossing direction">
        <option value="ltr">Left to right</option>
        <option value="rtl">Right to left</option>
      </select>
      <button id="app-line">Set finish line</button>
      <button id="app-export">Export CSV</button>
      <input id="app-video-file" type="file" accept="video/*" hidden>
      <span id="app-mode" style="font-size:.75rem;color:#8b949e">Mode: synthetic</span>
    `;

    let telemetry = $('app-telemetry');
    if (!telemetry) {
      telemetry = document.createElement('div');
      telemetry.id = 'app-telemetry';
      telemetry.style.cssText = 'position:absolute;z-index:5;top:12px;left:12px;padding:8px 10px;background:rgba(13,17,23,.85);border:1px solid #30363d;border-radius:8px;font:12px monospace;line-height:1.7;color:#f0f6fc';
      this.canvas.parentElement.appendChild(telemetry);
    }

    let results = $('app-results');
    if (!results) {
      results = document.createElement('aside');
      results.id = 'app-results';
      results.style.cssText = 'position:absolute;z-index:5;top:12px;right:12px;width:min(270px,45%);max-height:45%;overflow:auto;padding:10px;background:rgba(13,17,23,.9);border:1px solid #30363d;border-radius:8px;color:#f0f6fc;font:12px monospace';
      results.innerHTML = '<strong>Finishers</strong><ol id="app-finisher-list" style="padding:8px 0 0 22px"></ol>';
      this.canvas.parentElement.appendChild(results);
    }

    const help = $('app-help');
    if (!help) {
      const note = document.createElement('div');
      note.id = 'app-help';
      note.style.cssText = 'font-size:11px;color:#8b949e;flex-basis:100%';
      note.textContent = 'Drag on the video to position the finish line after selecting “Set finish line”. Camera/video inference requires a real detector module; synthetic mode tests the tracking and timing pipeline.';
      controls.appendChild(note);
    }
  }

  bindEvents() {
    $('app-start').addEventListener('click', () => this.startRace());
    $('app-stop').addEventListener('click', () => this.stopRace());
    $('app-reset').addEventListener('click', () => this.resetRace());
    $('app-camera').addEventListener('click', () => this.startCamera());
    $('app-file').addEventListener('click', () => $('app-video-file').click());
    $('app-video-file').addEventListener('change', (e) => this.loadVideo(e.target.files?.[0]));
    $('app-mock').addEventListener('click', () => this.useMock());
    $('app-scenario').addEventListener('change', (e) => {
      this.mockDetector = new MockDetector(e.target.value);
      this.useMock();
    });
    $('app-direction').addEventListener('change', (e) => {
      this.pipeline.crossingEngine.direction = e.target.value;
    });
    $('app-line').addEventListener('click', () => {
      this.lineDrag = !this.lineDrag;
      $('app-line').textContent = this.lineDrag ? 'Tap line start point' : 'Set finish line';
      this.setStatus(this.lineDrag ? 'SELECT FINISH LINE' : (this.running ? 'TIMING ACTIVE' : 'STANDBY'), this.lineDrag ? 'warn' : 'ok');
    });
    $('app-export').addEventListener('click', () => this.exportCSV());

    this.canvas.addEventListener('pointerdown', (e) => this.onCanvasPointer(e));
    this.canvas.addEventListener('pointerup', () => {
      if (this.lineDrag && this.lineEnd === 'p2') {
        this.lineDrag = false;
        this.lineEnd = 'p1';
        $('app-line').textContent = 'Set finish line';
        this.setStatus(this.running ? 'TIMING ACTIVE' : 'STANDBY', 'ok');
      }
    });
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus('CAMERA API UNAVAILABLE — USE HTTPS', 'error');
      return;
    }
    try {
      this.stopMedia();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 }
        }
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.mode = 'camera';
      await this.initializeDetector();
      this.updateModeLabel();
      this.setStatus(this.detectorReady ? 'CAMERA READY' : 'CAMERA — NO DETECTOR', this.detectorReady ? 'ok' : 'warn');
    } catch (error) {
      this.setStatus('CAMERA ERROR: ' + error.message, 'error');
    }
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

  resetRace() {
    this.pipeline = this.createPipeline();
    this.running = false;
    this.renderResults();
    this.setStatus('RACE RESET', 'ok');
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

  async loop(now) {
    if (this.mode === 'file' && this.video.ended) {
      this.stopRace();
    }

    if (this.mode === 'mock' || (this.video.readyState >= 2 && this.detectorReady)) {
      // Prevent asynchronous inference calls from stacking up.
      if (!this.processingFrame) {
        this.processingFrame = true;
        const t0 = performance.now();
        try {
          const detections = await this.getDetections(now);
          this.pipeline.processFrame(detections, now);
          this.lastLatency = performance.now() - t0;
        } finally {
          this.processingFrame = false;
        }
      }
    }

    this.fpsFrames++;
    if (now - this.fpsStartedAt >= 1000) {
      this.fps = this.fpsFrames * 1000 / (now - this.fpsStartedAt);
      this.fpsFrames = 0;
      this.fpsStartedAt = now;
    }

    this.draw();
    this.updateTelemetry();
    this.rafId = requestAnimationFrame(this.loop);
  }

  draw() {
    const { canvas, ctx, video } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if ((this.mode === 'camera' || this.mode === 'file') && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#111820';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#8b949e';
      ctx.font = '16px monospace';
      ctx.fillText('Synthetic detection test', 20, 30);
    }

    const line = this.pipeline.crossingEngine;
    ctx.beginPath();
    ctx.moveTo(line.p1.x * w, line.p1.y * h);
    ctx.lineTo(line.p2.x * w, line.p2.y * h);
    ctx.strokeStyle = '#2ea043';
    ctx.lineWidth = Math.max(2, w / 500);
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const track of this.pipeline.tracker.tracks) {
      const b = track.kf.getBBox();
      const x = b.x * w, y = b.y * h, bw = b.width * w, bh = b.height * h;
      ctx.strokeStyle = track.hasCrossed ? '#da3633' : '#58a6ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, bw, bh);
      ctx.fillStyle = '#fff';
      ctx.font = '13px monospace';
      ctx.fillText('ID ' + track.id + ' · ' + track.score.toFixed(2), x, Math.max(14, y - 5));
      const point = track.trajectory[track.trajectory.length - 1];
      if (point) {
        ctx.beginPath();
        ctx.arc(point.x * w, point.y * h, 4, 0, Math.PI * 2);
        ctx.fillStyle = track.hasCrossed ? '#da3633' : '#2ea043';
        ctx.fill();
      }
    }
  }

  onCanvasPointer(event) {
    if (!this.lineDrag) return;
    const rect = this.canvas.getBoundingClientRect();
    const point = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    };
    if (this.lineEnd === 'p1') {
      this.pipeline.crossingEngine.p1 = point;
      this.lineEnd = 'p2';
      $('app-line').textContent = 'Tap line end point';
    } else {
      this.pipeline.crossingEngine.p2 = point;
      this.lineEnd = 'p1';
      this.lineDrag = false;
      $('app-line').textContent = 'Set finish line';
      this.setStatus(this.running ? 'TIMING ACTIVE' : 'STANDBY', 'ok');
    }
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

  renderResults() {
    const list = $('app-finisher-list');
    if (!list) return;
    list.replaceChildren();
    for (const event of this.pipeline.finishers) {
      const li = document.createElement('li');
      li.textContent = '#' + event.position + '  ' + event.formattedTime +
        '  (runner ' + event.trackId + ')' +
        (event.flags.length ? ' ⚠ ' + event.flags.join(', ') : '');
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
