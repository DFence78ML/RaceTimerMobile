/**
 * AI Finish Line Mobile - Fullscreen Viewport & Layered Overlays
 */

// ==========================================
// 1. Database & Persistence Layer (IndexedDB)
// ==========================================
class RaceDatabase {
  constructor() {
    this.dbName = 'RaceTimerDB';
    this.version = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('results')) {
          const resStore = db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
          resStore.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async saveSession(session) {
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(session);
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async getActiveSession() {
    const tx = this.db.transaction('sessions', 'readonly');
    const store = tx.objectStore('sessions');
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const sessions = req.result;
        if (!sessions || sessions.length === 0) resolve(null);
        else resolve(sessions[sessions.length - 1]);
      };
    });
  }

  async saveResult(result) {
    const tx = this.db.transaction('results', 'readwrite');
    tx.objectStore('results').add(result);
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async deleteResult(id) {
    const tx = this.db.transaction('results', 'readwrite');
    tx.objectStore('results').delete(id);
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async getSessionResults(sessionId) {
    const tx = this.db.transaction('results', 'readonly');
    const index = tx.objectStore('results').index('sessionId');
    return new Promise((resolve) => {
      const req = index.getAll(sessionId);
      req.onsuccess = () => resolve(req.result || []);
    });
  }

  async clearAll() {
    const tx = this.db.transaction(['sessions', 'results'], 'readwrite');
    tx.objectStore('sessions').clear();
    tx.objectStore('results').clear();
    return new Promise((res) => { tx.oncomplete = () => res(); });
  }
}

// ==========================================
// 2. Geometry & Sub-Frame Timing Mathematics
// ==========================================
class TimingGeometry {
  static signedDistanceToLine(px, py, x1, y1, x2, y2) {
    return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  }

  static evaluateCrossing(prevX, prevY, currX, currY, lineA, lineB, direction) {
    const s1 = this.signedDistanceToLine(prevX, prevY, lineA.x, lineA.y, lineB.x, lineB.y);
    const s2 = this.signedDistanceToLine(currX, currY, lineA.x, lineA.y, lineB.x, lineB.y);

    let crossed = false;
    if (direction === 'ltr') {
      if (s1 < 0 && s2 >= 0) crossed = true;
    } else {
      if (s1 > 0 && s2 <= 0) crossed = true;
    }

    if (!crossed) return null;

    const denom = Math.abs(s1) + Math.abs(s2);
    const alpha = denom === 0 ? 0.5 : Math.abs(s1) / denom;
    const crossX = prevX + alpha * (currX - prevX);
    const crossY = prevY + alpha * (currY - prevY);

    const minLineX = Math.min(lineA.x, lineB.x) - 0.05;
    const maxLineX = Math.max(lineA.x, lineB.x) + 0.05;
    const minLineY = Math.min(lineA.y, lineB.y) - 0.05;
    const maxLineY = Math.max(lineA.y, lineB.y) + 0.05;

    if (crossX < minLineX || crossX > maxLineX || crossY < minLineY || crossY > maxLineY) {
      return null;
    }
    return { alpha, crossX, crossY };
  }
}

// ==========================================
// 3. Multi-Person Tracker (MOT)
// ==========================================
class RunnerTrack {
  constructor(id, pose, timestamp) {
    this.id = id;
    this.history = [];
    this.status = 'active';
    this.framesUnseen = 0;
    this.lastCrossingAttempt = 0;
    this.update(pose, timestamp);
  }

  update(pose, timestamp) {
    this.framesUnseen = 0;
    const anchor = this.extractBestAnchor(pose.keypoints);
    this.history.push({
      x: anchor.x,
      y: anchor.y,
      timestamp: timestamp,
      keypointName: anchor.name,
      confidence: anchor.score,
      box: pose.box
    });
    if (this.history.length > 30) this.history.shift();
  }

  extractBestAnchor(keypoints) {
    const la = keypoints[15], ra = keypoints[16];
    const lk = keypoints[13], rk = keypoints[14];
    const lh = keypoints[11], rh = keypoints[12];
    const ls = keypoints[5],  rs = keypoints[6];

    if (la && ra && (la.score > 0.3 || ra.score > 0.3)) {
      const best = la.score > ra.score ? la : ra;
      return { x: best.x, y: best.y, score: best.score, name: 'ankle' };
    }
    if (lk && rk && (lk.score > 0.25 || rk.score > 0.25)) {
      const best = lk.score > rk.score ? lk : rk;
      return { x: best.x, y: best.y, score: best.score, name: 'knee_fallback' };
    }
    if (lh && rh && (lh.score > 0.2 || rh.score > 0.2)) {
      return { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, score: (lh.score + rh.score) / 2, name: 'hip_fallback' };
    }
    if (ls && rs && lh && rh) {
      return {
        x: (ls.x + rs.x + lh.x + rh.x) / 4,
        y: (ls.y + rs.y + lh.y + rh.y) / 4,
        score: (ls.score + rs.score) / 2,
        name: 'torso_fallback'
      };
    }
    return { x: 0.5, y: 0.5, score: 0.1, name: 'uncertain' };
  }

  predictPosition() {
    if (this.history.length < 2) return this.currentPosition();
    const p1 = this.history[this.history.length - 2];
    const p2 = this.history[this.history.length - 1];
    const dt = p2.timestamp - p1.timestamp;
    if (dt <= 0) return { x: p2.x, y: p2.y };
    const vx = (p2.x - p1.x) / dt;
    const vy = (p2.y - p1.y) / dt;
    const nowDt = performance.now() - p2.timestamp;
    return { x: p2.x + vx * nowDt, y: p2.y + vy * nowDt };
  }

  currentPosition() {
    return this.history[this.history.length - 1];
  }
}

class MultiPersonTracker {
  constructor() {
    this.tracks = [];
    this.nextTrackId = 1;
    this.maxFramesUnseen = 15;
  }

  update(detectedPoses, timestamp) {
    const assignedPoses = new Set();
    for (const track of this.tracks) {
      const pred = track.predictPosition();
      let bestDist = Infinity;
      let bestIdx = -1;

      detectedPoses.forEach((pose, idx) => {
        if (assignedPoses.has(idx)) return;
        const anchor = track.extractBestAnchor(pose.keypoints);
        const dist = Math.hypot(pred.x - anchor.x, pred.y - anchor.y);
        if (dist < 0.20 && dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
      });

      if (bestIdx !== -1) {
        track.update(detectedPoses[bestIdx], timestamp);
        assignedPoses.add(bestIdx);
      } else {
        track.framesUnseen++;
      }
    }

    detectedPoses.forEach((pose, idx) => {
      if (!assignedPoses.has(idx)) {
        this.tracks.push(new RunnerTrack(this.nextTrackId++, pose, timestamp));
      }
    });

    this.tracks = this.tracks.filter(t => t.framesUnseen <= this.maxFramesUnseen);
    return this.tracks;
  }
}

// ==========================================
// 4. Main Application Controller
// ==========================================
class AppController {
  constructor() {
    this.db = new RaceDatabase();
    this.tracker = new MultiPersonTracker();
    this.detector = null;

    // Line endpoints stored in normalized coordinates [0.0 - 1.0] of the video feed
    this.line = { p1: { x: 0.5, y: 0.05 }, p2: { x: 0.5, y: 0.95 } };
    this.direction = 'ltr';

    this.raceState = 'STOPPED';
    this.raceStartTime = 0;
    this.currentSessionId = null;
    this.finishers = [];

    this.perf = {
      camFrames: 0, renderFrames: 0, infFrames: 0,
      lastSec: performance.now(), camFps: 0, renderFps: 0, infFps: 0,
      isInferring: false, lastFrameTime: performance.now()
    };

    this.wakeLock = null;
    this.facingMode = 'environment';
    this.videoElem = document.getElementById('webcam');
    this.canvasElem = document.getElementById('overlay');
    this.ctx = this.canvasElem.getContext('2d', { willReadFrequently: true });
    this.activePointerHandle = null;
    this.touchThreshold = 44; // Touch target size in physical screen pixels

    this.init();
  }

  async init() {
    this.setupUIListeners();
    this.setupEmailExportListeners();
    this.setupVisibilityListener();
    await this.db.init();
    await this.restorePreviousSession();
    await this.initCamera();
    await this.initDetector();
    this.startRenderingLoop();
  }

  // Projection matrix between normalized video coordinates [0, 1] and fullscreen screen pixels
  getVideoTransform() {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const vw = this.videoElem.videoWidth || sw;
    const vh = this.videoElem.videoHeight || sh;

    const scale = Math.max(sw / vw, sh / vh);
    const rw = vw * scale;
    const rh = vh * scale;
    const offX = (sw - rw) / 2;
    const offY = (sh - rh) / 2;

    return { scale, offX, offY, sw, sh, vw, vh };
  }

  screenToNormVideo(sx, sy) {
    const { scale, offX, offY, vw, vh } = this.getVideoTransform();
    const vx = (sx - offX) / scale;
    const vy = (sy - offY) / scale;
    return {
      x: Math.max(0.001, Math.min(0.999, vx / vw)),
      y: Math.max(0.001, Math.min(0.999, vy / vh))
    };
  }

  normVideoToScreen(nx, ny) {
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
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1920, min: 640 },
          height: { ideal: 1080, min: 480 },
          frameRate: { ideal: 60, min: 30 }
        }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.videoElem.srcObject = stream;
      await new Promise(r => this.videoElem.onloadedmetadata = r);
      await this.videoElem.play();
      this.syncCanvasDimensions();

      if ('requestVideoFrameCallback' in this.videoElem) {
        const onFrame = (now, metadata) => {
          this.perf.camFrames++;
          this.perf.lastFrameTime = metadata.captureTime || now;
          if (this.videoElem && !this.videoElem.paused) {
            this.videoElem.requestVideoFrameCallback(onFrame);
          }
        };
        this.videoElem.requestVideoFrameCallback(onFrame);
      }
    } catch (err) {
      this.showAlert('Camera Error', `Could not access camera: ${err.message}. Please check permissions.`);
    }
  }

  async initDetector() {
    try {
      await tf.ready();
      if (tf.getBackend() !== 'webgl') {
        await tf.setBackend('webgl');
      }
      this.detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
          enableSmoothing: true,
          minPoseScore: 0.25
        }
      );
    } catch (err) {
      console.warn('MoveNet MultiPose initialization warning:', err);
    }
  }

  syncCanvasDimensions() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.canvasElem.width !== w * dpr || this.canvasElem.height !== h * dpr) {
      this.canvasElem.width = w * dpr;
      this.canvasElem.height = h * dpr;
      this.ctx.resetTransform?.();
      this.ctx.scale(dpr, dpr);
    }
  }

  setupVisibilityListener() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && this.raceState === 'RUNNING') {
        await this.acquireWakeLock();
      }
    });
    window.addEventListener('resize', () => this.syncCanvasDimensions());
  }

  async acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) {}
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  startRenderingLoop() {
    const loop = (now) => {
      this.perf.renderFrames++;
      this.updateFPS(now);
      this.syncCanvasDimensions();

      if (this.detector && !this.perf.isInferring && this.videoElem.readyState >= 2) {
        this.runInference(now);
      }

      this.renderOverlay();
      this.updateClockHUD(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  async runInference(timestamp) {
    this.perf.isInferring = true;
    try {
      const poses = await this.detector.estimatePoses(this.videoElem, { maxPoses: 6 });
      this.perf.infFrames++;

      const vw = this.videoElem.videoWidth || 1;
      const vh = this.videoElem.videoHeight || 1;
      const normalizedPoses = poses.map(p => ({
        box: p.box,
        score: p.score,
        keypoints: p.keypoints.map(kp => ({
          x: kp.x / vw,
          y: kp.y / vh,
          score: kp.score,
          name: kp.name
        }))
      }));

      const activeTracks = this.tracker.update(normalizedPoses, timestamp);
      document.getElementById('active-tracks').textContent = `${activeTracks.length} RUNNERS`;

      if (this.raceState === 'RUNNING') {
        this.checkCrossings(activeTracks, timestamp);
      }
    } catch (e) {
      console.warn('Inference error:', e);
    } finally {
      this.perf.isInferring = false;
    }
  }

  checkCrossings(tracks, currentTimestamp) {
    for (const track of tracks) {
      if (track.status !== 'active' || track.history.length < 2) continue;

      const pPrev = track.history[track.history.length - 2];
      const pCurr = track.history[track.history.length - 1];

      const crossing = TimingGeometry.evaluateCrossing(
        pPrev.x, pPrev.y,
        pCurr.x, pCurr.y,
        this.line.p1, this.line.p2,
        this.direction
      );

      if (crossing) {
        if (currentTimestamp - track.lastCrossingAttempt < 5000) continue;
        track.lastCrossingAttempt = currentTimestamp;
        track.status = 'crossed';

        const dt = pCurr.timestamp - pPrev.timestamp;
        const exactCrossingTimestamp = pPrev.timestamp + (crossing.alpha * dt);
        const elapsedRaceMs = Math.max(0, exactCrossingTimestamp - this.raceStartTime);

        this.recordFinisher({
          trackId: track.id,
          elapsedMs: elapsedRaceMs,
          crossingTime: exactCrossingTimestamp,
          keypoint: pCurr.keypointName,
          confidence: pCurr.confidence,
          alpha: crossing.alpha,
          crossPos: { x: crossing.crossX, y: crossing.crossY }
        });
      }
    }
  }

  async recordFinisher(data) {
    const position = this.finishers.length + 1;
    const formatted = this.formatTime(data.elapsedMs);
    const snapshotUrl = this.captureCrossingSnapshot(data.crossPos);

    const flags = [];
    if (data.confidence < 0.4) flags.push('LOW_CONF');
    if (data.keypoint.includes('fallback')) flags.push(data.keypoint.toUpperCase());
    if (this.finishers.length > 0) {
      const prev = this.finishers[this.finishers.length - 1];
      if (data.elapsedMs - prev.elapsedMs < 250) flags.push('PACK_FINISH');
    }

    const finisherRecord = {
      sessionId: this.currentSessionId,
      position: position,
      elapsedMs: Math.round(data.elapsedMs),
      formattedTime: formatted,
      keypointUsed: data.keypoint,
      confidence: Number(data.confidence.toFixed(2)),
      subframeAlpha: Number(data.alpha.toFixed(3)),
      flags: flags,
      snapshot: snapshotUrl,
      recordedAt: new Date().toISOString()
    };

    this.finishers.push(finisherRecord);
    await this.db.saveResult(finisherRecord);
    this.renderResultsList();
  }

  captureCrossingSnapshot(crossPos) {
    try {
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = 320;
      snapCanvas.height = 320;
      const sCtx = snapCanvas.getContext('2d');
      const vw = this.videoElem.videoWidth || 640;
      const vh = this.videoElem.videoHeight || 480;

      const cropW = vw * 0.4;
      const cropH = vh * 0.4;
      const cropX = Math.max(0, Math.min(vw - cropW, (crossPos.x * vw) - (cropW / 2)));
      const cropY = Math.max(0, Math.min(vh - cropH, (crossPos.y * vh) - (cropH / 2)));

      sCtx.drawImage(this.videoElem, cropX, cropY, cropW, cropH, 0, 0, 320, 320);
      return snapCanvas.toDataURL('image/jpeg', 0.8);
    } catch (_) {
      return '';
    }
  }

  renderOverlay() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.clearRect(0, 0, w, h);

    // 1. Draw Active Tracks & Skeletons mapped onto the screen
    for (const track of this.tracker.tracks) {
      const pos = track.currentPosition();
      const sPos = this.normVideoToScreen(pos.x, pos.y);

      this.ctx.beginPath();
      this.ctx.arc(sPos.x, sPos.y, 6, 0, 2 * Math.PI);
      this.ctx.fillStyle = track.status === 'crossed' ? '#da3633' : '#38ef7d';
      this.ctx.fill();

      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = 'bold 11px monospace';
      this.ctx.fillText(`ID:${track.id}`, sPos.x + 8, sPos.y - 8);
    }

    // 2. Draw Finish Line mapped onto the screen
    const p1s = this.normVideoToScreen(this.line.p1.x, this.line.p1.y);
    const p2s = this.normVideoToScreen(this.line.p2.x, this.line.p2.y);

    this.ctx.beginPath();
    this.ctx.moveTo(p1s.x, p1s.y);
    this.ctx.lineTo(p2s.x, p2s.y);
    this.ctx.strokeStyle = '#2ea043';
    this.ctx.lineWidth = 3.5;
    this.ctx.setLineDash([8, 4]);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // 3. Draw Touch Handles
    this.drawHandle(p1s.x, p1s.y);
    this.drawHandle(p2s.x, p2s.y);
  }

  drawHandle(x, y) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, 16, 0, 2 * Math.PI);
    this.ctx.fillStyle = 'rgba(46, 160, 67, 0.45)';
    this.ctx.fill();
    this.ctx.beginPath();
    this.ctx.arc(x, y, 7, 0, 2 * Math.PI);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fill();
  }

  setupUIListeners() {
    const overlay = this.canvasElem;

    overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;

      const p1s = this.normVideoToScreen(this.line.p1.x, this.line.p1.y);
      const p2s = this.normVideoToScreen(this.line.p2.x, this.line.p2.y);

      const d1 = Math.hypot(sx - p1s.x, sy - p1s.y);
      const d2 = Math.hypot(sx - p2s.x, sy - p2s.y);

      if (d1 < this.touchThreshold) {
        this.activePointerHandle = 'p1';
        overlay.setPointerCapture(e.pointerId);
      } else if (d2 < this.touchThreshold) {
        this.activePointerHandle = 'p2';
        overlay.setPointerCapture(e.pointerId);
      }
    });

    overlay.addEventListener('pointermove', (e) => {
      if (!this.activePointerHandle) return;
      e.preventDefault();
      const norm = this.screenToNormVideo(e.clientX, e.clientY);

      if (this.activePointerHandle === 'p1') {
        this.line.p1 = norm;
      } else if (this.activePointerHandle === 'p2') {
        this.line.p2 = norm;
      }
    });

    const endPointer = (e) => {
      if (this.activePointerHandle) {
        try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
        this.activePointerHandle = null;
      }
    };
    overlay.addEventListener('pointerup', endPointer);
    overlay.addEventListener('pointercancel', endPointer);

    document.getElementById('btn-start').onclick = () => this.startRace();
    document.getElementById('btn-stop').onclick = () => this.stopRace();
    document.getElementById('btn-dir').onclick = () => this.toggleDirection();
    document.getElementById('btn-reset-line').onclick = () => this.resetLineCoordinates();
    document.getElementById('btn-flip-cam').onclick = () => this.flipCamera();
    document.getElementById('btn-export').onclick = () => this.showExportModal();
    document.getElementById('btn-new-race').onclick = () => this.startNewSessionWithPrompt();
    document.getElementById('btn-clear-results').onclick = () => this.clearAllResultsPrompt();

    document.getElementById('btn-modal-close').onclick = () => {
      document.getElementById('review-modal').classList.add('hidden');
    };
    document.getElementById('btn-alert-dismiss').onclick = () => {
      document.getElementById('alert-modal').classList.add('hidden');
    };
  }

  // ==========================================
  // 5. Configurable Email & CSV Export Engine
  // ==========================================
  setupEmailExportListeners() {
    const emailInput = document.getElementById('export-email');
    const savedEmail = localStorage.getItem('race_timer_export_email');
    if (savedEmail) {
      emailInput.value = savedEmail;
    }
    emailInput.addEventListener('change', () => {
      localStorage.setItem('race_timer_export_email', emailInput.value.trim());
    });

    document.getElementById('btn-export-cancel').onclick = () => {
      document.getElementById('export-modal').classList.add('hidden');
    };

    document.getElementById('btn-email-share').onclick = async () => {
      await this.handleShareViaEmail();
    };

    document.getElementById('btn-email-mailto').onclick = () => {
      this.handleMailtoExport();
    };

    document.getElementById('btn-download-csv').onclick = () => {
      this.handleDownloadExport();
    };

    document.getElementById('btn-copy-csv').onclick = () => {
      this.handleCopyExport();
    };
  }

  showExportModal() {
    if (this.finishers.length === 0) {
      this.showAlert('Export CSV', 'No finishers have crossed the line yet.');
      return;
    }
    document.getElementById('export-modal').classList.remove('hidden');
  }

  generateCSVContent(format) {
    let content = '';
    if (format === 'parkrun_std') {
      content = 'Position,Time\n';
      this.finishers.forEach(f => {
        content += `${f.position},${this.formatParkrunTime(f.elapsedMs)}\n`;
      });
    } else if (format === 'parkrun_barcode') {
      content = 'Position,Time,Barcode\n';
      this.finishers.forEach(f => {
        content += `${f.position},${this.formatParkrunTime(f.elapsedMs)},\n`;
      });
    } else {
      content = 'Position,Time,Elapsed_Ms,Keypoint,Confidence,Alpha,Flags,Recorded_At\n';
      this.finishers.forEach(f => {
        content += `${f.position},${f.formattedTime},${f.elapsedMs},${f.keypointUsed},${f.confidence},${f.subframeAlpha},"${f.flags.join(';')}",${f.recordedAt}\n`;
      });
    }
    return content;
  }

  async handleShareViaEmail() {
    const email = document.getElementById('export-email').value.trim();
    if (email) localStorage.setItem('race_timer_export_email', email);

    const format = document.getElementById('export-format').value;
    const csvContent = this.generateCSVContent(format);
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `race_results_${dateStr}_${format}.csv`;
    const file = new File([csvContent], filename, { type: 'text/csv' });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: `Race Results (${dateStr})`,
          text: email ? `Results intended for: ${email}\nTotal Finishers: ${this.finishers.length}` : `Race Results: ${this.finishers.length} finishers.`,
          files: [file]
        });
        document.getElementById('export-modal').classList.add('hidden');
        return;
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('Share API error:', err);
        }
      }
    }
    this.handleMailtoExport();
  }

  handleMailtoExport() {
    const email = document.getElementById('export-email').value.trim();
    if (email) localStorage.setItem('race_timer_export_email', email);

    const format = document.getElementById('export-format').value;
    const csvContent = this.generateCSVContent(format);
    const dateStr = new Date().toISOString().split('T')[0];

    const subject = encodeURIComponent(`Race Results - ${dateStr} (${this.finishers.length} Finishers)`);
    let bodyText = `Attached are the race results for ${dateStr}.\n\nTotal Finishers: ${this.finishers.length}\n\n`;
    if (csvContent.length < 1800) {
      bodyText += csvContent;
    } else {
      bodyText += csvContent.substring(0, 1500) + '\n\n[...Truncated due to mail link size limits. Use Download CSV or Share File for the complete file...]';
    }

    const mailtoUrl = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(bodyText)}`;
    window.location.href = mailtoUrl;
    document.getElementById('export-modal').classList.add('hidden');
  }

  handleDownloadExport() {
    const format = document.getElementById('export-format').value;
    const csvContent = this.generateCSVContent(format);
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `race_results_${dateStr}_${format}.csv`;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 60000);
    document.getElementById('export-modal').classList.add('hidden');
  }

  async handleCopyExport() {
    const format = document.getElementById('export-format').value;
    const csvContent = this.generateCSVContent(format);
    try {
      await navigator.clipboard.writeText(csvContent);
      alert('CSV copied to clipboard! You can paste it into any email.');
      document.getElementById('export-modal').classList.add('hidden');
    } catch (_) {
      this.showAlert('Clipboard Error', 'Could not copy to clipboard. Please use Download or Share.');
    }
  }

  resetLineCoordinates() {
    this.line = { p1: { x: 0.5, y: 0.05 }, p2: { x: 0.5, y: 0.95 } };
  }

  toggleDirection() {
    this.direction = this.direction === 'ltr' ? 'rtl' : 'ltr';
    document.getElementById('dir-pill').textContent =
      `DIR: ${this.direction === 'ltr' ? 'L → R' : 'R → L'}`;
  }

  async flipCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.initCamera();
  }

  async startRace() {
    if (this.raceState === 'RUNNING') return;
    this.raceState = 'RUNNING';
    this.raceStartTime = performance.now();
    await this.acquireWakeLock();

    document.getElementById('status-pill').textContent = 'RUNNING';
    document.getElementById('status-pill').classList.add('active');
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-stop').disabled = false;

    if (!this.currentSessionId) {
      this.currentSessionId = 'race_' + Date.now();
      await this.db.saveSession({
        id: this.currentSessionId,
        date: new Date().toISOString(),
        direction: this.direction
      });
    }
  }

  stopRace() {
    if (this.raceState === 'STOPPED') return;
    this.raceState = 'STOPPED';
    this.releaseWakeLock();

    document.getElementById('status-pill').textContent = 'STOPPED';
    document.getElementById('status-pill').classList.remove('active');
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
  }

  async startNewSessionWithPrompt() {
    if (this.finishers.length > 0 && !confirm('Start a new race? Current results are stored in IndexedDB.')) {
      return;
    }
    this.stopRace();
    this.finishers = [];
    this.currentSessionId = 'race_' + Date.now();
    await this.db.saveSession({
      id: this.currentSessionId,
      date: new Date().toISOString(),
      direction: this.direction
    });
    this.renderResultsList();
    document.getElementById('clock-display').textContent = '00:00.000';
  }

  async clearAllResultsPrompt() {
    if (!confirm('Permanently delete all stored race results? This cannot be undone.')) return;
    this.stopRace();
    this.finishers = [];
    await this.db.clearAll();
    this.currentSessionId = null;
    this.renderResultsList();
    document.getElementById('clock-display').textContent = '00:00.000';
  }

  async restorePreviousSession() {
    const activeSess = await this.db.getActiveSession();
    if (activeSess) {
      this.currentSessionId = activeSess.id;
      this.direction = activeSess.direction || 'ltr';
      document.getElementById('dir-pill').textContent =
        `DIR: ${this.direction === 'ltr' ? 'L → R' : 'R → L'}`;
      this.finishers = await this.db.getSessionResults(this.currentSessionId);
      this.renderResultsList();
    }
  }

  updateClockHUD(now) {
    if (this.raceState === 'RUNNING') {
      const elapsed = now - this.raceStartTime;
      document.getElementById('clock-display').textContent = this.formatTime(elapsed);
    }
  }

  updateFPS(now) {
    if (now - this.perf.lastSec >= 1000) {
      this.perf.renderFps = this.perf.renderFrames;
      this.perf.camFps = this.perf.camFrames;
      this.perf.infFps = this.perf.infFrames;

      this.perf.renderFrames = 0;
      this.perf.camFrames = 0;
      this.perf.infFrames = 0;
      this.perf.lastSec = now;

      document.getElementById('fps-cam').textContent = `CAM: ${this.perf.camFps}`;
      document.getElementById('fps-inf').textContent = `INF: ${this.perf.infFps}`;
    }
  }

  formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const millis = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  formatParkrunTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ==========================================
  // Render Layered Finishers (Position & Time Only)
  // ==========================================
  renderResultsList() {
    const listElem = document.getElementById('results-list');
    listElem.innerHTML = '';
    document.getElementById('finisher-count').textContent = this.finishers.length;

    // Latest finishes appear at the top
    const sorted = [...this.finishers].reverse();
    sorted.forEach((finisher) => {
      const li = document.createElement('li');
      li.className = 'finisher-compact-row';
      li.onclick = () => this.showReviewModal(finisher);

      // Display strictly Position and Time as requested
      li.innerHTML = `
        <span class="finisher-compact-pos">#${finisher.position}</span>
        <span class="finisher-compact-time">${finisher.formattedTime}</span>
      `;
      listElem.appendChild(li);
    });
  }

  showReviewModal(finisher) {
    const modal = document.getElementById('review-modal');
    document.getElementById('modal-title').textContent = `Finisher #${finisher.position} Review`;
    document.getElementById('modal-snapshot').src = finisher.snapshot || '';
    document.getElementById('modal-details').innerHTML = `
      <strong>Elapsed Time:</strong> ${finisher.formattedTime} (${finisher.elapsedMs} ms)<br>
      <strong>Sub-Frame Alpha:</strong> ${finisher.subframeAlpha}<br>
      <strong>Keypoint:</strong> ${finisher.keypointUsed} (Score: ${finisher.confidence})<br>
      <strong>Recorded At:</strong> ${finisher.recordedAt}<br>
      <strong>Status Flags:</strong> ${finisher.flags.join(', ') || 'NONE (Accurate)'}
    `;

    document.getElementById('btn-modal-discard').onclick = async () => {
      if (confirm(`Remove finisher #${finisher.position}?`)) {
        this.finishers = this.finishers.filter(f => f.position !== finisher.position);
        this.finishers.forEach((f, idx) => f.position = idx + 1);
        if (finisher.id) await this.db.deleteResult(finisher.id);
        this.renderResultsList();
        modal.classList.add('hidden');
      }
    };
    modal.classList.remove('hidden');
  }

  showAlert(title, message) {
    document.getElementById('alert-title').textContent = title;
    document.getElementById('alert-message').textContent = message;
    document.getElementById('alert-modal').classList.remove('hidden');
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed:', err));
  });
}

window.addEventListener('DOMContentLoaded', () => {
  window.raceApp = new AppController();
});