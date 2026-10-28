/**
 * AI Finish Line Mobile - Ultra-Fast Performance Engine
 * MoveNet SinglePose Lightning + 192x192 Downscaled Buffer + Sub-Millisecond Crossings
 */

// ==========================================
// 1. Lightweight Persistence (IndexedDB)
// ==========================================
class FastDB {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve) => {
      const req = indexedDB.open('FastRaceDB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('results')) {
          db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      req.onerror = () => resolve();
    });
  }

  async saveResult(item) {
    if (!this.db) return;
    const tx = this.db.transaction('results', 'readwrite');
    tx.objectStore('results').add(item);
  }

  async getAllResults() {
    if (!this.db) return [];
    return new Promise((resolve) => {
      const tx = this.db.transaction('results', 'readonly');
      const req = tx.objectStore('results').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async clearAll() {
    if (!this.db) return;
    const tx = this.db.transaction('results', 'readwrite');
    tx.objectStore('results').clear();
  }

  async deleteResult(id) {
    if (!this.db) return;
    const tx = this.db.transaction('results', 'readwrite');
    tx.objectStore('results').delete(id);
  }
}

// ==========================================
// 2. High-Speed Sub-Frame Line Math
// ==========================================
class FastMath {
  static signedDistance(px, py, x1, y1, x2, y2) {
    return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  }

  static checkCrossing(prevX, prevY, currX, currY, p1, p2, dir) {
    const s1 = (p2.x - p1.x) * (prevY - p1.y) - (p2.y - p1.y) * (prevX - p1.x);
    const s2 = (p2.x - p1.x) * (currY - p1.y) - (p2.y - p1.y) * (currX - p1.x);

    let crossed = false;
    if (dir === 'ltr') {
      if (s1 < 0 && s2 >= 0) crossed = true;
    } else {
      if (s1 > 0 && s2 <= 0) crossed = true;
    }

    if (!crossed) return null;

    const denom = Math.abs(s1) + Math.abs(s2);
    const alpha = denom === 0 ? 0.5 : Math.abs(s1) / denom;
    return alpha;
  }
}

// ==========================================
// 3. Ultra-Fast Application Controller
// ==========================================
class FastRaceApp {
  constructor() {
    this.db = new FastDB();
    this.detector = null;

    // Finish line coordinates in normalized [0, 1] video space
    this.line = { p1: { x: 0.5, y: 0.05 }, p2: { x: 0.5, y: 0.95 } };
    this.direction = 'ltr';

    this.raceState = 'STOPPED';
    this.raceStartTime = 0;
    this.finishers = [];

    // Offscreen 192x192 downscaled buffer for fast inference
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = 192;
    this.offscreenCanvas.height = 192;
    this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });

    // Performance metrics
    this.fpsCount = 0;
    this.fpsLastSec = performance.now();
    this.isInferring = false;
    this.lastInferenceTime = 0;

    // Tracking state for crossing detection
    this.lastTrackPoint = null;
    this.lastCrossingAttempt = 0;

    this.facingMode = 'environment';
    this.videoElem = document.getElementById('webcam');
    this.canvasElem = document.getElementById('overlay');
    this.ctx = this.canvasElem.getContext('2d');
    this.activePointer = null;

    this.init();
  }

  async init() {
    this.setupUI();
    this.setupEmailExport();
    await this.db.init();
    await this.loadSavedResults();
    await this.initCamera();
    this.initMoveNetLightning();
    this.startMainLoop();
  }

  // Clamped 1x DPR coordinate transformations to avoid 3x retina fill overhead
  getVideoTransform() {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const vw = this.videoElem.videoWidth || sw;
    const vh = this.videoElem.videoHeight || sh;

    const scale = Math.max(sw / vw, sh / vh);
    const offX = (sw - (vw * scale)) / 2;
    const offY = (sh - (vh * scale)) / 2;
    return { scale, offX, offY, vw, vh };
  }

  screenToNorm(sx, sy) {
    const { scale, offX, offY, vw, vh } = this.getVideoTransform();
    return {
      x: Math.max(0.01, Math.min(0.99, (sx - offX) / (vw * scale))),
      y: Math.max(0.01, Math.min(0.99, (sy - offY) / (vh * scale)))
    };
  }

  normToScreen(nx, ny) {
    const { scale, offX, offY, vw, vh } = this.getVideoTransform();
    return {
      x: (nx * vw) * scale + offX,
      y: (ny * vh) * scale + offY
    };
  }

  async initCamera() {
    try {
      if (this.videoElem.srcObject) {
        this.videoElem.srcObject.getTracks().forEach(t => t.stop());
      }
      // Target standard 720p/1080p: fast camera hardware pipeline
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 480 }
        }
      });
      this.videoElem.srcObject = stream;
      await new Promise(r => this.videoElem.onloadedmetadata = r);
      await this.videoElem.play();
      this.syncCanvas();
    } catch (e) {
      console.warn('Camera permission or device error:', e);
    }
  }

  async initMoveNetLightning() {
    try {
      await tf.ready();
      tf.env().set('WEBGL_FORCE_F16_TEXTURES', true);
      tf.env().set('WEBGL_PACK', true);

      // SinglePose Lightning: the fastest pose model for mobile
      this.detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
          enableSmoothing: false,
          minPoseScore: 0.25
        }
      );
    } catch (e) {
      console.warn('TensorFlow MoveNet initialization error:', e);
    }
  }

  syncCanvas() {
    // 1x viewport dimensions: stops mobile phones from rendering 3x Retina pixels
    if (this.canvasElem.width !== window.innerWidth || this.canvasElem.height !== window.innerHeight) {
      this.canvasElem.width = window.innerWidth;
      this.canvasElem.height = window.innerHeight;
    }
  }

  startMainLoop() {
    const tick = (now) => {
      this.fpsCount++;
      if (now - this.fpsLastSec >= 1000) {
        document.getElementById('fps-metric').textContent = `${this.fpsCount} FPS`;
        this.fpsCount = 0;
        this.fpsLastSec = now;
      }

      this.syncCanvas();

      // Paced inference: 40ms interval (~25 inferences/sec) keeps the phone cool and UI fast
      if (this.detector && !this.isInferring && this.videoElem.readyState >= 2 && (now - this.lastInferenceTime > 40)) {
        this.runFastInference(now);
      }

      this.render();
      if (this.raceState === 'RUNNING') {
        document.getElementById('clock-display').textContent = this.formatTime(now - this.raceStartTime);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async runFastInference(now) {
    this.isInferring = true;
    this.lastInferenceTime = now;

    try {
      // Scale video frame into 192x192 offscreen buffer
      this.offscreenCtx.drawImage(this.videoElem, 0, 0, 192, 192);

      const poses = await this.detector.estimatePoses(this.offscreenCanvas, { maxPoses: 1 });
      if (poses && poses.length > 0) {
        const pose = poses[0];
        const kp = pose.keypoints;

        // Fastest hierarchical keypoint: Ankle -> Hip -> Torso
        let target = (kp[15]?.score > 0.3) ? kp[15] : (kp[16]?.score > 0.3 ? kp[16] : null);
        if (!target) {
          target = (kp[11]?.score > 0.25) ? kp[11] : (kp[12]?.score > 0.25 ? kp[12] : kp[0]);
        }

        if (target && target.score > 0.2) {
          // Normalize coordinates back to [0, 1]
          const currentPoint = {
            x: target.x / 192,
            y: target.y / 192,
            timestamp: now
          };

          if (this.raceState === 'RUNNING' && this.lastTrackPoint) {
            this.evaluateCrossing(this.lastTrackPoint, currentPoint);
          }
          this.lastTrackPoint = currentPoint;
        }
      }
    } catch (_) {
    } finally {
      this.isInferring = false;
    }
  }

  evaluateCrossing(pPrev, pCurr) {
    // 3.5s cooldown stops duplicate crossings for the same runner
    if (pCurr.timestamp - this.lastCrossingAttempt < 3500) return;

    const alpha = FastMath.checkCrossing(
      pPrev.x, pPrev.y,
      pCurr.x, pCurr.y,
      this.line.p1, this.line.p2,
      this.direction
    );

    if (alpha !== null) {
      this.lastCrossingAttempt = pCurr.timestamp;
      const exactTime = pPrev.timestamp + (alpha * (pCurr.timestamp - pPrev.timestamp));
      const elapsed = Math.max(0, exactTime - this.raceStartTime);

      this.recordFinisher(elapsed, alpha);
    }
  }

  async recordFinisher(elapsedMs, alpha) {
    const position = this.finishers.length + 1;
    const formatted = this.formatTime(elapsedMs);

    const record = {
      position: position,
      elapsedMs: Math.round(elapsedMs),
      formattedTime: formatted,
      alpha: Number(alpha.toFixed(3)),
      date: new Date().toLocaleTimeString()
    };

    this.finishers.push(record);
    await this.db.saveResult(record);
    this.renderFinishers();
  }

  render() {
    this.ctx.clearRect(0, 0, this.canvasElem.width, this.canvasElem.height);

    // 1. Draw runner point
    if (this.lastTrackPoint) {
      const s = this.normToScreen(this.lastTrackPoint.x, this.lastTrackPoint.y);
      this.ctx.fillStyle = '#2ea043';
      this.ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
    }

    // 2. Draw finish line
    const p1s = this.normToScreen(this.line.p1.x, this.line.p1.y);
    const p2s = this.normToScreen(this.line.p2.x, this.line.p2.y);

    this.ctx.beginPath();
    this.ctx.moveTo(p1s.x, p1s.y);
    this.ctx.lineTo(p2s.x, p2s.y);
    this.ctx.strokeStyle = '#2ea043';
    this.ctx.lineWidth = 3;
    this.ctx.stroke();

    // 3. Touch handles
    this.drawHandle(p1s.x, p1s.y);
    this.drawHandle(p2s.x, p2s.y);
  }

  drawHandle(x, y) {
    this.ctx.fillStyle = 'rgba(46, 160, 67, 0.4)';
    this.ctx.beginPath();
    this.ctx.arc(x, y, 16, 0, 6.28);
    this.ctx.fill();
    this.ctx.fillStyle = '#fff';
    this.ctx.beginPath();
    this.ctx.arc(x, y, 6, 0, 6.28);
    this.ctx.fill();
  }

  setupUI() {
    const overlay = this.canvasElem;

    overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p1s = this.normToScreen(this.line.p1.x, this.line.p1.y);
      const p2s = this.normToScreen(this.line.p2.x, this.line.p2.y);

      if (Math.hypot(e.clientX - p1s.x, e.clientY - p1s.y) < 40) {
        this.activePointer = 'p1';
        overlay.setPointerCapture(e.pointerId);
      } else if (Math.hypot(e.clientX - p2s.x, e.clientY - p2s.y) < 40) {
        this.activePointer = 'p2';
        overlay.setPointerCapture(e.pointerId);
      }
    });

    overlay.addEventListener('pointermove', (e) => {
      if (!this.activePointer) return;
      e.preventDefault();
      const norm = this.screenToNorm(e.clientX, e.clientY);
      if (this.activePointer === 'p1') this.line.p1 = norm;
      else if (this.activePointer === 'p2') this.line.p2 = norm;
    });

    const endP = (e) => {
      if (this.activePointer) {
        try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
        this.activePointer = null;
      }
    };
    overlay.addEventListener('pointerup', endP);
    overlay.addEventListener('pointercancel', endP);

    document.getElementById('btn-start').onclick = () => this.startRace();
    document.getElementById('btn-stop').onclick = () => this.stopRace();
    document.getElementById('btn-dir').onclick = () => this.toggleDirection();
    document.getElementById('btn-reset-line').onclick = () => {
      this.line = { p1: { x: 0.5, y: 0.05 }, p2: { x: 0.5, y: 0.95 } };
    };
    document.getElementById('btn-flip-cam').onclick = async () => {
      this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
      await this.initCamera();
    };
    document.getElementById('btn-new-race').onclick = () => {
      if (this.finishers.length && confirm('Start a fresh race?')) {
        this.stopRace();
        this.finishers = [];
        this.renderFinishers();
        document.getElementById('clock-display').textContent = '00:00.000';
      }
    };
    document.getElementById('btn-clear-results').onclick = async () => {
      if (confirm('Clear results?')) {
        this.finishers = [];
        await this.db.clearAll();
        this.renderFinishers();
      }
    };
    document.getElementById('btn-export').onclick = () => {
      if (!this.finishers.length) return alert('No finishes recorded yet.');
      document.getElementById('export-modal').classList.remove('hidden');
    };
    document.getElementById('btn-export-cancel').onclick = () => {
      document.getElementById('export-modal').classList.add('hidden');
    };
    document.getElementById('btn-modal-close').onclick = () => {
      document.getElementById('review-modal').classList.add('hidden');
    };
  }

  setupEmailExport() {
    const emailInput = document.getElementById('export-email');
    emailInput.value = localStorage.getItem('fast_timer_email') || '';
    emailInput.onchange = () => localStorage.setItem('fast_timer_email', emailInput.value.trim());

    document.getElementById('btn-email-share').onclick = async () => {
      const email = emailInput.value.trim();
      const csv = this.buildCSV(document.getElementById('export-format').value);
      const file = new File([csv], `race_results_${Date.now()}.csv`, { type: 'text/csv' });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: 'Race Results',
            text: email ? `Results for: ${email}` : 'Race Results',
            files: [file]
          });
          document.getElementById('export-modal').classList.add('hidden');
          return;
        } catch (_) {}
      }
      this.triggerMailto(email, csv);
    };

    document.getElementById('btn-email-mailto').onclick = () => {
      const email = emailInput.value.trim();
      const csv = this.buildCSV(document.getElementById('export-format').value);
      this.triggerMailto(email, csv);
    };

    document.getElementById('btn-download-csv').onclick = () => {
      const csv = this.buildCSV(document.getElementById('export-format').value);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `results_${Date.now()}.csv`;
      a.click();
      document.getElementById('export-modal').classList.add('hidden');
    };

    document.getElementById('btn-copy-csv').onclick = async () => {
      const csv = this.buildCSV(document.getElementById('export-format').value);
      await navigator.clipboard.writeText(csv);
      alert('Copied CSV to clipboard!');
      document.getElementById('export-modal').classList.add('hidden');
    };
  }

  buildCSV(format) {
    let out = '';
    if (format === 'parkrun_std') {
      out = 'Position,Time\n';
      this.finishers.forEach(f => out += `${f.position},${this.formatParkrun(f.elapsedMs)}\n`);
    } else if (format === 'parkrun_barcode') {
      out = 'Position,Time,Barcode\n';
      this.finishers.forEach(f => out += `${f.position},${this.formatParkrun(f.elapsedMs)},\n`);
    } else {
      out = 'Position,Time,Elapsed_Ms,Subframe_Alpha,Time_Of_Day\n';
      this.finishers.forEach(f => out += `${f.position},${f.formattedTime},${f.elapsedMs},${f.alpha},${f.date}\n`);
    }
    return out;
  }

  triggerMailto(email, csv) {
    const subject = encodeURIComponent(`Race Results (${this.finishers.length} Finishers)`);
    const body = encodeURIComponent(`Race Results:\n\n${csv.substring(0, 1800)}`);
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`;
    document.getElementById('export-modal').classList.add('hidden');
  }

  startRace() {
    this.raceState = 'RUNNING';
    this.raceStartTime = performance.now();
    document.getElementById('status-pill').textContent = 'RUNNING';
    document.getElementById('status-pill').classList.add('active');
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-stop').disabled = false;
  }

  stopRace() {
    this.raceState = 'STOPPED';
    document.getElementById('status-pill').textContent = 'STOPPED';
    document.getElementById('status-pill').classList.remove('active');
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
  }

  toggleDirection() {
    this.direction = this.direction === 'ltr' ? 'rtl' : 'ltr';
    document.getElementById('dir-pill').textContent = `DIR: ${this.direction === 'ltr' ? 'L → R' : 'R → L'}`;
  }

  renderFinishers() {
    const list = document.getElementById('results-list');
    list.innerHTML = '';
    document.getElementById('finisher-count').textContent = this.finishers.length;

    // Display only Position and Time
    [...this.finishers].reverse().forEach((f) => {
      const li = document.createElement('li');
      li.className = 'finisher-compact-row';
      li.onclick = () => {
        document.getElementById('modal-title').textContent = `Finisher #${f.position}`;
        document.getElementById('modal-details').innerHTML = `
          <strong>Time:</strong> ${f.formattedTime}<br>
          <strong>Exact Milliseconds:</strong> ${f.elapsedMs} ms<br>
          <strong>Recorded:</strong> ${f.date}<br>
          <strong>Sub-Frame Alpha:</strong> ${f.alpha}
        `;
        document.getElementById('btn-modal-discard').onclick = async () => {
          this.finishers = this.finishers.filter(x => x.position !== f.position);
          this.finishers.forEach((x, i) => x.position = i + 1);
          if (f.id) await this.db.deleteResult(f.id);
          this.renderFinishers();
          document.getElementById('review-modal').classList.add('hidden');
        };
        document.getElementById('review-modal').classList.remove('hidden');
      };

      li.innerHTML = `
        <span class="finisher-compact-pos">#${f.position}</span>
        <span class="finisher-compact-time">${f.formattedTime}</span>
      `;
      list.appendChild(li);
    });
  }

  async loadSavedResults() {
    this.finishers = await this.db.getAllResults();
    this.renderFinishers();
  }

  formatTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mil = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
  }

  formatParkrun(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.fastApp = new FastRaceApp();
});