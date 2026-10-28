/**
 * AI Finish Line Mobile - Unified High-Speed Timing & Tracking Engine
 * MoveNet MultiPose + SORT Multi-Runner Tracking + Parametric Sub-Frame Math + Robust IndexedDB
 */

// ============================================================================
// 1. Precise Geometry & Sub-Frame Crossing Calculations
// ============================================================================
class TimingMath {
  /**
   * 2D Directed Line Signed Distance.
   * Defined from P1(x1, y1) to P2(x2, y2).
   * Positive = Right side of the vector; Negative = Left side of the vector.
   */
  static signedDistance(px, py, x1, y1, x2, y2) {
    return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  }

  /**
   * Verifies parametric intersection of runner movement with the finite line segment.
   * Solves: P_prev + t * (P_curr - P_prev) == L1 + u * (L2 - L1)
   */
  static evaluateSegmentCrossing(prevX, prevY, currX, currY, p1, p2, direction) {
    const sPrev = this.signedDistance(prevX, prevY, p1.x, p1.y, p2.x, p2.y);
    const sCurr = this.signedDistance(currX, currY, p1.x, p1.y, p2.x, p2.y);

    let crossedDirection = false;
    // For a top-to-bottom line (P1 to P2, y2 > y1):
    // Left side has s > 0, Right side has s < 0.
    if (direction === 'ltr') {
      if (sPrev > 0 && sCurr <= 0) crossedDirection = true;
    } else {
      if (sPrev < 0 && sCurr >= 0) crossedDirection = true;
    }

    if (!crossedDirection) return null;

    // Sub-frame linear interpolation fraction alpha in [0, 1]
    const denom = Math.abs(sPrev) + Math.abs(sCurr);
    const alpha = denom === 0 ? 0.5 : Math.abs(sPrev) / denom;

    const crossX = prevX + alpha * (currX - prevX);
    const crossY = prevY + alpha * (currY - prevY);

    // Parametric projection along the finite finish-line segment L1->L2
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lineLenSq = (dx * dx) + (dy * dy);
    if (lineLenSq < 1e-9) return null;

    const u = ((crossX - p1.x) * dx + (crossY - p1.y) * dy) / lineLenSq;

    // Reject crossings outside the finite segment endpoints (with 5% margin of tolerance)
    if (u < -0.05 || u > 1.05) return null;

    return { alpha, crossX, crossY, u: Math.max(0, Math.min(1, u)) };
  }
}

// ============================================================================
// 2. Multi-Runner Object Tracker (MOT)
// ============================================================================
class RunnerTrack {
  constructor(id, pose, timestamp) {
    this.id = id;
    this.history = []; // [{ x, y, timestamp, confidence, anchor }]
    this.state = 'APPROACHING'; // 'APPROACHING', 'CROSSED', 'COOLDOWN'
    this.framesUnseen = 0;
    this.lastCrossingTime = 0;
    this.finishRecord = null;
    this.update(pose, timestamp);
  }

  update(pose, timestamp) {
    this.framesUnseen = 0;
    const anchor = this.extractTorsoCentroid(pose);
    this.history.push({
      x: anchor.x,
      y: anchor.y,
      timestamp: timestamp,
      confidence: anchor.score,
      box: pose.box,
      anchorName: anchor.name
    });
    if (this.history.length > 20) this.history.shift();
  }

  /**
   * Fixed Torso Centroid anchor.
   * Avoids switching between head and feet to prevent artificial velocity spikes.
   */
  extractTorsoCentroid(pose) {
    const kp = pose.keypoints;
    const ls = kp[5], rs = kp[6], lh = kp[11], rh = kp[12];

    const validPoints = [ls, rs, lh, rh].filter(p => p && p.score > 0.2);
    if (validPoints.length >= 2) {
      let sumX = 0, sumY = 0, sumScore = 0;
      validPoints.forEach(p => {
        sumX += p.x;
        sumY += p.y;
        sumScore += p.score;
      });
      return {
        x: sumX / validPoints.length,
        y: sumY / validPoints.length,
        score: sumScore / validPoints.length,
        name: 'torso_centroid'
      };
    }

    // Fallback: Bounding box center
    if (pose.box) {
      return {
        x: (pose.box.xMin + pose.box.xMax) / 2,
        y: (pose.box.yMin + pose.box.yMax) / 2,
        score: pose.score || 0.3,
        name: 'box_center'
      };
    }

    return { x: 0.5, y: 0.5, score: 0.1, name: 'fallback' };
  }

  predictPosition(now) {
    if (this.history.length === 0) return { x: 0.5, y: 0.5 };
    if (this.history.length === 1) return { x: this.history[0].x, y: this.history[0].y };

    const p1 = this.history[this.history.length - 2];
    const p2 = this.history[this.history.length - 1];
    const dt = p2.timestamp - p1.timestamp;
    if (dt <= 0) return { x: p2.x, y: p2.y };

    const vx = (p2.x - p1.x) / dt;
    const vy = (p2.y - p1.y) / dt;
    const forwardDt = Math.min(100, Math.max(0, now - p2.timestamp));
    return {
      x: p2.x + vx * forwardDt,
      y: p2.y + vy * forwardDt
    };
  }

  currentPosition() {
    return this.history[this.history.length - 1] || { x: 0.5, y: 0.5 };
  }
}

class MultiRunnerTracker {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
    this.maxFramesUnseen = 12; // Track expiry window
  }

  update(poses, timestamp) {
    const assignedPoses = new Set();

    // Match candidates using proximity to projected velocities
    for (const track of this.tracks) {
      const pred = track.predictPosition(timestamp);
      let bestDist = Infinity;
      let bestIdx = -1;

      poses.forEach((pose, idx) => {
        if (assignedPoses.has(idx)) return;
        const anchor = track.extractTorsoCentroid(pose);
        const dist = Math.hypot(pred.x - anchor.x, pred.y - anchor.y);
        // Distance threshold in normalized 0-1 coordinates
        if (dist < 0.22 && dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
      });

      if (bestIdx !== -1) {
        track.update(poses[bestIdx], timestamp);
        assignedPoses.add(bestIdx);
      } else {
        track.framesUnseen++;
      }
    }

    // Allocate new tracks for unassociated detections
    poses.forEach((pose, idx) => {
      if (!assignedPoses.has(idx)) {
        this.tracks.push(new RunnerTrack(this.nextId++, pose, timestamp));
      }
    });

    // Prune expired tracks
    this.tracks = this.tracks.filter(t => t.framesUnseen <= this.maxFramesUnseen);
    return this.tracks;
  }
}

// ============================================================================
// 3. Durable Storage (IndexedDB)
// ============================================================================
class RaceStorage {
  constructor() {
    this.dbName = 'RaceTimerDB_v3';
    this.version = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('results')) {
          const resStore = db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
          resStore.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async saveSession(session) {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getLatestSession() {
    if (!this.db) return null;
    return new Promise((resolve) => {
      const tx = this.db.transaction('sessions', 'readonly');
      const req = tx.objectStore('sessions').getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        resolve(list.length ? list[list.length - 1] : null);
      };
      req.onerror = () => resolve(null);
    });
  }

  async saveFinisher(record) {
    if (!this.db) return -1;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('results', 'readwrite');
      const store = tx.objectStore('results');
      const req = store.add(record);
      req.onsuccess = () => {
        const generatedId = req.result;
        record.id = generatedId; // Ensure in-memory record has the persisted primary key
      };
      tx.oncomplete = () => resolve(record.id);
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteFinisher(id) {
    if (!this.db || !id) return;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('results', 'readwrite');
      tx.objectStore('results').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getSessionFinishers(sessionId) {
    if (!this.db || !sessionId) return [];
    return new Promise((resolve) => {
      const tx = this.db.transaction('results', 'readonly');
      const index = tx.objectStore('results').index('sessionId');
      const req = index.getAll(sessionId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async clearSessionResults(sessionId) {
    if (!this.db) throw new Error('Race storage is not initialized.');
    if (!sessionId) return;

    // Delete through the session index in ONE read/write transaction.
    // Avoid getAll() followed by a second transaction, which can race with
    // a finisher being saved at the same time the user presses Clear.
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction('results', 'readwrite');
        const store = tx.objectStore('results');
        const index = store.index('sessionId');
        const request = index.openKeyCursor(IDBKeyRange.only(sessionId));

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('Could not find session results.'));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Could not clear session results.'));
        tx.onabort = () => reject(tx.error || new Error('Clearing session results was cancelled.'));
      } catch (error) {
        if (tx) {
          try { tx.abort(); } catch (_) {}
        }
        reject(error);
      }
    });
  }
}

// ============================================================================
// 4. Main Application Controller
// ============================================================================
class RaceTimerApp {
  constructor() {
    this.db = new RaceStorage();
    this.tracker = new MultiRunnerTracker();
    this.detector = null;

    // Finish line coordinates in normalized [0, 1] video space
    this.line = { p1: { x: 0.5, y: 0.05 }, p2: { x: 0.5, y: 0.95 } };
    this.direction = 'ltr';

    this.raceState = 'STOPPED'; // 'STOPPED', 'RUNNING'
    this.raceStartTime = 0;
    this.currentSessionId = null;
    this.finishers = [];

    // Offscreen 192x192 buffer with center-crop to preserve aspect ratio
    this.cropCanvas = document.createElement('canvas');
    this.cropCanvas.width = 192;
    this.cropCanvas.height = 192;
    this.cropCtx = this.cropCanvas.getContext('2d', { willReadFrequently: true });

    // Independent FPS telemetry counters
    this.perf = {
      renderCount: 0, camCount: 0, infCount: 0,
      renderFps: 0, camFps: 0, infFps: 0,
      lastSec: performance.now(),
      lastFrameTime: performance.now(),
      isInferring: false,
      lastInferenceTimestamp: 0
    };

    this.wakeLock = null;
    this.facingMode = 'environment';
    this.videoElem = document.getElementById('webcam');
    this.canvasElem = document.getElementById('overlay');
    this.ctx = this.canvasElem.getContext('2d');
    this.activePointer = null;

    this.init();
  }

  async init() {
    this.setupUIEvents();
    this.setupExportEvents();
    this.setupLifecycle();
    this.registerServiceWorker();

    try {
      await this.db.init();
      await this.restoreSessionState();
      await this.initCamera();
      await this.initDetector();
      this.startRenderPipeline();
    } catch (err) {
      this.showAlert('Startup Notice', err.message || 'Initialization incomplete.');
    }
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.warn('Service Worker registration skipped:', err);
        });
      });
    }
  }

  // Viewport projection matrix: maps normalized video coordinates [0, 1] to screen pixels
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

    return { scale, offX, offY, vw, vh, sw, sh };
  }

  screenToNorm(sx, sy) {
    const { scale, offX, offY, vw, vh } = this.getVideoTransform();
    return {
      x: Math.max(0.005, Math.min(0.995, (sx - offX) / (vw * scale))),
      y: Math.max(0.005, Math.min(0.995, (sy - offY) / (vh * scale)))
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
    if (this.videoElem.srcObject) {
      this.videoElem.srcObject.getTracks().forEach(t => t.stop());
    }
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: 1280, min: 640 },
        height: { ideal: 720, min: 480 },
        frameRate: { ideal: 60, min: 30 }
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.videoElem.srcObject = stream;
    await new Promise(r => this.videoElem.onloadedmetadata = r);
    await this.videoElem.play();
    this.syncCanvas();

    if ('requestVideoFrameCallback' in this.videoElem) {
      const onFrame = (now, meta) => {
        this.perf.camCount++;
        this.perf.lastFrameTime = meta.captureTime || now;
        if (this.videoElem && !this.videoElem.paused) {
          this.videoElem.requestVideoFrameCallback(onFrame);
        }
      };
      this.videoElem.requestVideoFrameCallback(onFrame);
    }
  }

  async initDetector() {
    document.getElementById('status-pill').textContent = 'LOADING AI';
    try {
      await tf.ready();
      if (tf.getBackend() !== 'webgl') {
        await tf.setBackend('webgl').catch(() => {});
      }
      tf.env().set('WEBGL_FORCE_F16_TEXTURES', true);
      tf.env().set('WEBGL_PACK', true);

      // MoveNet MultiPose Lightning: detects up to 6 runners concurrently
      this.detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
          enableSmoothing: true,
          minPoseScore: 0.2
        }
      );

      document.getElementById('status-pill').textContent = 'READY';
      document.getElementById('btn-start').disabled = false;
    } catch (e) {
      document.getElementById('status-pill').textContent = 'AI OFFLINE';
      document.getElementById('status-pill').classList.add('warning');
      this.showAlert('AI Load Notice', 'Neural model weights failed to load. Please check your connection.');
    }
  }

  syncCanvas() {
    if (this.canvasElem.width !== window.innerWidth || this.canvasElem.height !== window.innerHeight) {
      this.canvasElem.width = window.innerWidth;
      this.canvasElem.height = window.innerHeight;
    }
  }

  setupLifecycle() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && this.raceState === 'RUNNING') {
        await this.acquireWakeLock();
        const gap = performance.now() - this.perf.lastFrameTime;
        if (gap > 500) {
          console.warn(`Camera suspension gap of ${Math.round(gap)}ms detected.`);
        }
      }
    });
    window.addEventListener('resize', () => this.syncCanvas());
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

  // ============================================================================
  // 5. Execution Pipeline (Render Loop & Center-Cropped Inference)
  // ============================================================================
  startRenderPipeline() {
    const loop = (now) => {
      this.perf.renderCount++;
      this.updateTelemetry(now);
      this.syncCanvas();

      // Pace inference to ~25–30 FPS to avoid thermal throttling
      if (this.detector && !this.perf.isInferring && this.videoElem.readyState >= 2 && (now - this.perf.lastInferenceTimestamp > 32)) {
        this.runInference(now);
      }

      this.renderOverlay();
      if (this.raceState === 'RUNNING') {
        document.getElementById('clock-display').textContent = this.formatTime(now - this.raceStartTime);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  async runInference(timestamp) {
    this.perf.isInferring = true;
    this.perf.lastInferenceTimestamp = timestamp;

    try {
      const vw = this.videoElem.videoWidth;
      const vh = this.videoElem.videoHeight;
      if (!vw || !vh) return;

      // Uniform Center-Crop to 192x192 without aspect distortion
      const side = Math.min(vw, vh);
      const sx = (vw - side) / 2;
      const sy = (vh - side) / 2;

      this.cropCtx.drawImage(this.videoElem, sx, sy, side, side, 0, 0, 192, 192);

      const rawPoses = await this.detector.estimatePoses(this.cropCanvas, { maxPoses: 6 });
      this.perf.infCount++;

      // Unproject keypoints from crop coordinates back to normalized [0, 1] video space
      const normalizedPoses = rawPoses.map(p => ({
        score: p.score,
        box: p.box ? {
          xMin: (sx + (p.box.xMin * side / 192)) / vw,
          yMin: (sy + (p.box.yMin * side / 192)) / vh,
          xMax: (sx + (p.box.xMax * side / 192)) / vw,
          yMax: (sy + (p.box.yMax * side / 192)) / vh
        } : null,
        keypoints: p.keypoints.map(kp => ({
          x: (sx + (kp.x * side / 192)) / vw,
          y: (sy + (kp.y * side / 192)) / vh,
          score: kp.score,
          name: kp.name
        }))
      }));

      const activeTracks = this.tracker.update(normalizedPoses, timestamp);
      document.getElementById('active-tracks').textContent = `${activeTracks.length} RUNNERS`;

      if (this.raceState === 'RUNNING') {
        this.evaluateTracks(activeTracks, timestamp);
      }
    } catch (e) {
      console.warn('Inference frame dropped:', e);
    } finally {
      this.perf.isInferring = false;
    }
  }

  evaluateTracks(tracks, now) {
    for (const track of tracks) {
      if (track.state !== 'APPROACHING' || track.history.length < 2) continue;

      const pPrev = track.history[track.history.length - 2];
      const pCurr = track.history[track.history.length - 1];

      const cross = TimingMath.evaluateSegmentCrossing(
        pPrev.x, pPrev.y,
        pCurr.x, pCurr.y,
        this.line.p1, this.line.p2,
        this.direction
      );

      if (cross) {
        // Individual per-runner crossing hysteresis (4s cooldown)
        if (now - track.lastCrossingTime < 4000) continue;
        track.lastCrossingTime = now;
        track.state = 'CROSSED';

        // Sub-frame finish calculation based on hardware video frame timing
        const frameDt = pCurr.timestamp - pPrev.timestamp;
        const exactFinishTime = pPrev.timestamp + (cross.alpha * frameDt);
        const elapsedRaceMs = Math.max(0, exactFinishTime - this.raceStartTime);

        this.recordFinisher({
          trackId: track.id,
          elapsedMs: elapsedRaceMs,
          alpha: cross.alpha,
          anchor: pCurr.anchorName,
          confidence: pCurr.confidence
        });
      }
    }
  }

  async recordFinisher(data) {
    const position = this.finishers.length + 1;
    const formatted = this.formatTime(data.elapsedMs);

    const record = {
      sessionId: this.currentSessionId,
      position: position,
      elapsedMs: Math.round(data.elapsedMs),
      formattedTime: formatted,
      alpha: Number(data.alpha.toFixed(3)),
      anchor: data.anchor,
      confidence: Number(data.confidence.toFixed(2)),
      recordedAt: new Date().toLocaleTimeString()
    };

    this.finishers.push(record);
    this.renderFinishersList();

    // Persist to IndexedDB and update record with generated ID
    try {
      await this.db.saveFinisher(record);
    } catch (e) {
      console.error('Failed to persist finisher:', e);
    }
  }

  renderOverlay() {
    this.ctx.clearRect(0, 0, this.canvasElem.width, this.canvasElem.height);

    // 1. Draw Active Track Dots & Identifiers
    for (const track of this.tracker.tracks) {
      const pos = track.currentPosition();
      const s = this.normToScreen(pos.x, pos.y);

      this.ctx.beginPath();
      this.ctx.arc(s.x, s.y, 6, 0, 2 * Math.PI);
      this.ctx.fillStyle = track.state === 'CROSSED' ? '#da3633' : '#2ea043';
      this.ctx.fill();

      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = 'bold 11px monospace';
      this.ctx.fillText(`R${track.id}`, s.x + 8, s.y - 6);
    }

    // 2. Draw Finish Line
    const p1s = this.normToScreen(this.line.p1.x, this.line.p1.y);
    const p2s = this.normToScreen(this.line.p2.x, this.line.p2.y);

    this.ctx.beginPath();
    this.ctx.moveTo(p1s.x, p1s.y);
    this.ctx.lineTo(p2s.x, p2s.y);
    this.ctx.strokeStyle = '#2ea043';
    this.ctx.lineWidth = 3.5;
    this.ctx.stroke();

    // 3. Touch Endpoint Handles
    this.drawHandle(p1s.x, p1s.y);
    this.drawHandle(p2s.x, p2s.y);
  }

  drawHandle(x, y) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, 16, 0, 2 * Math.PI);
    this.ctx.fillStyle = 'rgba(46, 160, 67, 0.4)';
    this.ctx.fill();
    this.ctx.beginPath();
    this.ctx.arc(x, y, 6, 0, 2 * Math.PI);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fill();
  }

  // ============================================================================
  // 6. User Interface, Controls & Modals
  // ============================================================================
  setupUIEvents() {
    const overlay = this.canvasElem;

    overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p1s = this.normToScreen(this.line.p1.x, this.line.p1.y);
      const p2s = this.normToScreen(this.line.p2.x, this.line.p2.y);

      if (Math.hypot(e.clientX - p1s.x, e.clientY - p1s.y) < 42) {
        this.activePointer = 'p1';
        overlay.setPointerCapture(e.pointerId);
      } else if (Math.hypot(e.clientX - p2s.x, e.clientY - p2s.y) < 42) {
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

    const release = (e) => {
      if (this.activePointer) {
        try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
        this.activePointer = null;
      }
    };
    overlay.addEventListener('pointerup', release);
    overlay.addEventListener('pointercancel', release);

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
    document.getElementById('btn-new-race').onclick = () => this.newRaceSession();
    document.getElementById('btn-clear-results').onclick = () => this.clearSessionPrompt();
    document.getElementById('btn-export').onclick = () => {
      if (!this.finishers.length) return alert('No finishes recorded yet.');
      document.getElementById('export-modal').classList.remove('hidden');
    };

    document.getElementById('btn-toggle-finishers').onclick = () => {
      const p = document.getElementById('finishers-panel');
      p.classList.toggle('collapsed');
      document.getElementById('btn-toggle-finishers').textContent = p.classList.contains('collapsed') ? '▲' : '▼';
    };

    document.getElementById('btn-modal-close').onclick = () => {
      document.getElementById('review-modal').classList.add('hidden');
    };
    document.getElementById('btn-alert-dismiss').onclick = () => {
      document.getElementById('alert-modal').classList.add('hidden');
    };
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

  async newRaceSession() {
    if (this.finishers.length > 0 && !confirm('Start a new race? Current results remain archived.')) {
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
    this.renderFinishersList();
    document.getElementById('clock-display').textContent = '00:00.000';
  }

  async clearSessionPrompt() {
    if (!this.finishers.length) return;
    if (!confirm('Clear current race finishers?')) return;

    const clearButton = document.getElementById('btn-clear-results');
    if (clearButton) clearButton.disabled = true;

    try {
      // Clear persisted rows first so a storage error does not silently
      // leave the screen and database showing different results.
      await this.db.clearSessionResults(this.currentSessionId);
      this.finishers = [];
      this.renderFinishersList();
    } catch (error) {
      console.error('Failed to clear current race finishers:', error);
      this.showAlert(
        'Could Not Clear Results',
        'The saved results could not be cleared. Please try again. Your current results have been kept.'
      );
    } finally {
      if (clearButton) clearButton.disabled = false;
    }
  }

  toggleDirection() {
    this.direction = this.direction === 'ltr' ? 'rtl' : 'ltr';
    document.getElementById('dir-pill').textContent = `DIR: ${this.direction === 'ltr' ? 'L → R' : 'R → L'}`;
  }

  renderFinishersList() {
    const list = document.getElementById('results-list');
    list.innerHTML = '';
    document.getElementById('finisher-count').textContent = this.finishers.length;

    // Render newest finishers at the top
    [...this.finishers].reverse().forEach((f) => {
      const li = document.createElement('li');
      li.className = 'finisher-compact-row';
      li.onclick = () => this.showAuditModal(f);
      li.innerHTML = `
        <span class="finisher-compact-pos">#${f.position}</span>
        <span class="finisher-compact-time">${f.formattedTime}</span>
      `;
      list.appendChild(li);
    });
  }

  showAuditModal(f) {
    document.getElementById('modal-title').textContent = `Finisher #${f.position} Audit`;
    document.getElementById('modal-details').innerHTML = `
      <strong>Elapsed Time:</strong> ${f.formattedTime} (${f.elapsedMs} ms)<br>
      <strong>Sub-frame Offset (α):</strong> ${f.alpha}<br>
      <strong>Anchor:</strong> ${f.anchor} (Confidence: ${f.confidence})<br>
      <strong>Recorded At:</strong> ${f.recordedAt}<br>
      <strong>Session ID:</strong> ${f.sessionId}
    `;

    document.getElementById('btn-modal-discard').onclick = async () => {
      if (confirm(`Remove finisher #${f.position}?`)) {
        if (f.id) await this.db.deleteFinisher(f.id);
        this.finishers = this.finishers.filter(x => x !== f);
        this.finishers.forEach((x, idx) => x.position = idx + 1);
        this.renderFinishersList();
        document.getElementById('review-modal').classList.add('hidden');
      }
    };
    document.getElementById('review-modal').classList.remove('hidden');
  }

  async restoreSessionState() {
    const lastSession = await this.db.getLatestSession();
    if (lastSession) {
      this.currentSessionId = lastSession.id;
      this.direction = lastSession.direction || 'ltr';
      document.getElementById('dir-pill').textContent = `DIR: ${this.direction === 'ltr' ? 'L → R' : 'R → L'}`;
      this.finishers = await this.db.getSessionFinishers(this.currentSessionId);
      this.renderFinishersList();
    }
  }

  updateTelemetry(now) {
    if (now - this.perf.lastSec >= 1000) {
      this.perf.renderFps = this.perf.renderCount;
      this.perf.camFps = this.perf.camCount;
      this.perf.infFps = this.perf.infCount;

      this.perf.renderCount = 0;
      this.perf.camCount = 0;
      this.perf.infCount = 0;
      this.perf.lastSec = now;

      document.getElementById('fps-render').textContent = `RND: ${this.perf.renderFps}`;
      document.getElementById('fps-cam').textContent = `CAM: ${this.perf.camFps}`;
      document.getElementById('fps-inf').textContent = `INF: ${this.perf.infFps}`;
    }
  }

  formatTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mil = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
  }

  formatParkrunTime(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ============================================================================
  // 7. Multi-Format CSV Export & System Web Share Engine
  // ============================================================================
  setupExportEvents() {
    const emailInput = document.getElementById('export-email');
    emailInput.value = localStorage.getItem('racetimer_export_email') || '';
    emailInput.onchange = () => localStorage.setItem('racetimer_export_email', emailInput.value.trim());

    document.getElementById('btn-export-cancel').onclick = () => {
      document.getElementById('export-modal').classList.add('hidden');
    };

    document.getElementById('btn-email-share').onclick = async () => {
      const email = emailInput.value.trim();
      const format = document.getElementById('export-format').value;
      const csv = this.buildCSV(format);
      const filename = `race_${Date.now()}_${format}.csv`;
      const file = new File([csv], filename, { type: 'text/csv' });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: 'Race Results CSV',
            text: email ? `Results intended for: ${email}` : 'Race Results',
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
      const format = document.getElementById('export-format').value;
      const csv = this.buildCSV(format);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `race_${Date.now()}_${format}.csv`;
      a.click();
      document.getElementById('export-modal').classList.add('hidden');
    };

    document.getElementById('btn-copy-csv').onclick = async () => {
      const csv = this.buildCSV(document.getElementById('export-format').value);
      try {
        await navigator.clipboard.writeText(csv);
        alert('CSV copied to clipboard.');
        document.getElementById('export-modal').classList.add('hidden');
      } catch (_) {
        alert('Clipboard write denied. Please choose Download or Share.');
      }
    };
  }

  buildCSV(format) {
    let out = '';
    if (format === 'parkrun_std') {
      out = 'Position,Time\n';
      this.finishers.forEach(f => out += `${f.position},${this.formatParkrunTime(f.elapsedMs)}\n`);
    } else if (format === 'parkrun_barcode') {
      out = 'Position,Time,Barcode\n';
      this.finishers.forEach(f => out += `${f.position},${this.formatParkrunTime(f.elapsedMs)},\n`);
    } else {
      out = 'Position,Time,Elapsed_Ms,Subframe_Alpha,Anchor,Confidence,Recorded_At,Session_ID\n';
      this.finishers.forEach(f => {
        out += `${f.position},${f.formattedTime},${f.elapsedMs},${f.alpha},${f.anchor},${f.confidence},${f.recordedAt},${f.sessionId}\n`;
      });
    }
    return out;
  }

  triggerMailto(email, csv) {
    const subject = encodeURIComponent(`Race Results (${this.finishers.length} Finishers)`);
    const body = encodeURIComponent(`Race Results:\n\n${csv.substring(0, 1800)}`);
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`;
    document.getElementById('export-modal').classList.add('hidden');
  }

  showAlert(title, message) {
    document.getElementById('alert-title').textContent = title;
    document.getElementById('alert-message').textContent = message;
    document.getElementById('alert-modal').classList.remove('hidden');
  }
}

// Global initialization
window.addEventListener('DOMContentLoaded', () => {
  window.raceApp = new RaceTimerApp();
});