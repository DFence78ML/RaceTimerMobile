/**
 * AI Finish Line Mobile - Complete PWA Timing Engine
 * Implements monotonic timing, sub-frame linear crossing interpolation,
 * MoveNet pose tracking, touch drag adjustments, and Parkrun CSV export.
 */

// Configuration
const CONFIG = {
  keypointThreshold: 0.4,
  maxGapSeconds: 0.35,
  minVelocityPxS: 50.0,
  lateralTolerancePct: 0.1,
  leftAnkleIdx: 15,
  rightAnkleIdx: 16
};

// Geometry Class (ported from finish_line.py)
class FinishLineGeometry {
  constructor(w, h) {
    this.p1 = { x: Math.round(w * 0.70), y: Math.round(h * 0.05) };
    this.p2 = { x: Math.round(w * 0.70), y: Math.round(h * 0.95) };
    this.directionSign = -1; // -1: Left->Right, 1: Right->Left, 0: Either
    this.updateNormals();
  }

  updateNormals() {
    this.dx = this.p2.x - this.p1.x;
    this.dy = this.p2.y - this.p1.y;
    this.length = Math.hypot(this.dx, this.dy) || 1e-6;
    this.nx = -this.dy / this.length;
    this.ny = this.dx / this.length;
  }

  signedDistance(pt) {
    return (pt.x - this.p1.x) * this.nx + (pt.y - this.p1.y) * this.ny;
  }

  checkIntersection(prev, curr) {
    const rx = curr.x - prev.x;
    const ry = curr.y - prev.y;
    const sx = this.p2.x - this.p1.x;
    const sy = this.p2.y - this.p1.y;
    const denom = rx * sy - ry * sx;

    if (Math.abs(denom) < 1e-6) return { valid: false, alpha: 0 };

    const qpx = this.p1.x - prev.x;
    const qpy = this.p1.y - prev.y;
    const alpha = (qpx * sy - qpy * sx) / denom;
    const beta = (qpx * ry - qpy * rx) / denom;

    if (alpha < 0.0 || alpha > 1.0) return { valid: false, alpha };
    if (beta < -CONFIG.lateralTolerancePct || beta > (1.0 + CONFIG.lateralTolerancePct)) {
      return { valid: false, alpha };
    }

    const d0 = this.signedDistance(prev);
    const d1 = this.signedDistance(curr);
    const negToPos = d0 < 0 && d1 >= 0 && d1 > d0;
    const posToNeg = d0 > 0 && d1 <= 0 && d1 < d0;

    let allowed = false;
    if (this.directionSign < 0) allowed = posToNeg;
    else if (this.directionSign > 0) allowed = negToPos;
    else allowed = posToNeg || negToPos;

    return { valid: allowed, alpha };
  }
}

// Global App State
const state = {
  video: document.getElementById('webcam'),
  canvas: document.getElementById('overlay-canvas'),
  ctx: document.getElementById('overlay-canvas').getContext('2d'),
  detector: null,
  geometry: null,
  facingMode: "environment",
  isRaceRunning: false,
  raceStartMonoMs: 0,
  tracks: new Map(), // trackId -> { history: [{pt, timeMs}], confirmed: bool }
  nextTrackId: 1,
  results: [],
  selectedHandle: null,
  touchDragOffset: { x: 0, y: 0 },
  fpsCounter: { count: 0, lastTick: performance.now(), value: 0 },
  wakeLock: null
};

// Format seconds into MM:SS.mmm
function formatTime(totalSec) {
  const m = Math.floor(Math.max(0, totalSec) / 60);
  const s = (Math.max(0, totalSec) % 60).toFixed(3).padStart(6, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

// Initialize Camera
async function setupCamera() {
  const constraints = {
    audio: false,
    video: {
      facingMode: state.facingMode,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, min: 30 }
    }
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.video.srcObject = stream;

  return new Promise((resolve) => {
    state.video.onloadedmetadata = () => {
      state.video.play();
      state.canvas.width = state.video.videoWidth;
      state.canvas.height = state.video.videoHeight;
      if (!state.geometry) {
        state.geometry = new FinishLineGeometry(state.canvas.width, state.canvas.height);
      }
      resolve();
    };
  });
}

// Request Screen Wake Lock so phone doesn't sleep mid-race
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    console.warn("Wake lock failed: ", e);
  }
}

// Load MoveNet Model
async function initDetector() {
  const model = poseDetection.SupportedModels.MoveNet;
  state.detector = await poseDetection.createDetector(model, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    enableSmoothing: true
  });
}

// Timing point extraction from pose (ankles or fallback)
function extractTimingPoint(pose) {
  if (!pose || !pose.keypoints) return null;
  const lAnkle = pose.keypoints[CONFIG.leftAnkleIdx];
  const rAnkle = pose.keypoints[CONFIG.rightAnkleIdx];
  const lValid = lAnkle && lAnkle.score >= CONFIG.keypointThreshold;
  const rValid = rAnkle && rAnkle.score >= CONFIG.keypointThreshold;

  if (lValid && rValid) {
    return {
      x: (lAnkle.x + rAnkle.x) / 2,
      y: (lAnkle.y + rAnkle.y) / 2,
      conf: (lAnkle.score + rAnkle.score) / 2,
      source: "ANKLE_MIDPOINT"
    };
  }
  if (lValid) return { x: lAnkle.x, y: lAnkle.y, conf: lAnkle.score, source: "LEFT_ANKLE" };
  if (rValid) return { x: rAnkle.x, y: rAnkle.y, conf: rAnkle.score, source: "RIGHT_ANKLE" };
  return null;
}

// Process track logic and check crossings
function updateTracking(point, nowMonoMs) {
  let matchedTrackId = null;
  let minDist = 120; // Max jump radius in pixels

  // Find nearest track
  for (const [id, tr] of state.tracks.entries()) {
    if (tr.confirmed) continue;
    const lastPt = tr.history[tr.history.length - 1].pt;
    const d = Math.hypot(point.x - lastPt.x, point.y - lastPt.y);
    if (d < minDist) {
      minDist = d;
      matchedTrackId = id;
    }
  }

  if (matchedTrackId === null) {
    matchedTrackId = state.nextTrackId++;
    state.tracks.set(matchedTrackId, {
      history: [{ pt: point, timeMs: nowMonoMs }],
      confirmed: false
    });
    return;
  }

  const track = state.tracks.get(matchedTrackId);
  const prevObservation = track.history[track.history.length - 1];
  track.history.push({ pt: point, timeMs: nowMonoMs });

  if (track.history.length < 2 || track.confirmed) return;

  const dt = (nowMonoMs - prevObservation.timeMs) / 1000.0;
  if (dt <= 0 || dt > CONFIG.maxGapSeconds) return;

  const speed = Math.hypot(point.x - prevObservation.pt.x, point.y - prevObservation.pt.y) / dt;
  if (speed < CONFIG.minVelocityPxS) return;

  // Intersect line
  const { valid, alpha } = state.geometry.checkIntersection(prevObservation.pt, point);
  if (valid) {
    track.confirmed = true;
    const crossingMonoMs = prevObservation.timeMs + alpha * (nowMonoMs - prevObservation.timeMs);
    const elapsedSec = (crossingMonoMs - state.raceStartMonoMs) / 1000.0;
    const isUncertain = dt > 0.25 || elapsedSec < 0;

    recordFinisher({
      position: state.results.length + 1,
      trackId: matchedTrackId,
      elapsedSec: elapsedSec,
      formattedTime: formatTime(elapsedSec),
      isUncertain: isUncertain,
      source: point.source
    });
  }
}

function recordFinisher(finisher) {
  state.results.push(finisher);
  state.results.sort((a, b) => a.elapsedSec - b.elapsedSec);
  state.results.forEach((r, idx) => r.position = idx + 1);

  // Update UI drawer
  document.getElementById('finisher-count').textContent = state.results.length;
  const list = document.getElementById('results-list');
  list.innerHTML = "";
  state.results.slice(-6).reverse().forEach(res => {
    const div = document.createElement('div');
    div.className = `result-row ${res.isUncertain ? 'uncertain' : ''}`;
    div.innerHTML = `<span><strong>P${res.position}</strong> (T${res.trackId})</span><span>${res.formattedTime}</span>`;
    list.appendChild(div);
  });
}

// Touch Handling for Dragging the Finish Line
function initTouchInteractions() {
  const canvas = state.canvas;

  function getCanvasCoords(touch) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (touch.clientX - rect.left) * scaleX,
      y: (touch.clientY - rect.top) * scaleY
    };
  }

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const pt = getCanvasCoords(e.touches[0]);
    const d1 = Math.hypot(pt.x - state.geometry.p1.x, pt.y - state.geometry.p1.y);
    const d2 = Math.hypot(pt.x - state.geometry.p2.x, pt.y - state.geometry.p2.y);

    if (d1 < 36) {
      state.selectedHandle = 'p1';
    } else if (d2 < 36) {
      state.selectedHandle = 'p2';
    } else {
      // Check proximity to whole line
      const dLine = state.geometry.signedDistance(pt);
      if (Math.abs(dLine) < 25) {
        state.selectedHandle = 'line';
        state.touchDragOffset = { x: pt.x, y: pt.y };
      }
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    if (!state.selectedHandle || e.touches.length !== 1) return;
    e.preventDefault();
    const pt = getCanvasCoords(e.touches[0]);

    if (state.selectedHandle === 'p1') {
      state.geometry.p1 = pt;
    } else if (state.selectedHandle === 'p2') {
      state.geometry.p2 = pt;
    } else if (state.selectedHandle === 'line') {
      const dx = pt.x - state.touchDragOffset.x;
      const dy = pt.y - state.touchDragOffset.y;
      state.geometry.p1.x += dx;
      state.geometry.p1.y += dy;
      state.geometry.p2.x += dx;
      state.geometry.p2.y += dy;
      state.touchDragOffset = { x: pt.x, y: pt.y };
    }
    state.geometry.updateNormals();
  });

  canvas.addEventListener('touchend', () => {
    state.selectedHandle = null;
  });
}

// Render Loop
async function mainLoop() {
  const now = performance.now();

  // FPS calculation
  state.fpsCounter.count++;
  if (now - state.fpsCounter.lastTick >= 1000) {
    state.fpsCounter.value = state.fpsCounter.count;
    state.fpsCounter.count = 0;
    state.fpsCounter.lastTick = now;
    document.getElementById('badge-fps').textContent = `FPS: ${state.fpsCounter.value}`;
  }

  // Draw Camera Frame
  state.ctx.drawImage(state.video, 0, 0, state.canvas.width, state.canvas.height);

  // If race is running, estimate pose and check crossing
  if (state.isRaceRunning && state.detector) {
    const elapsedSec = (now - state.raceStartMonoMs) / 1000.0;
    document.getElementById('race-clock').textContent = formatTime(elapsedSec);

    const poses = await state.detector.estimatePoses(state.video, { maxPoses: 1, flipHorizontal: false });
    if (poses.length > 0) {
      const pt = extractTimingPoint(poses[0]);
      if (pt) {
        updateTracking(pt, now);
        // Draw detected runner point
        state.ctx.beginPath();
        state.ctx.arc(pt.x, pt.y, 8, 0, 2 * Math.PI);
        state.ctx.fillStyle = "#00ffcc";
        state.ctx.fill();
      }
    }
  }

  // Draw Finish Line Overlays
  renderFinishLineOverlays();

  requestAnimationFrame(mainLoop);
}

function renderFinishLineOverlays() {
  const ctx = state.ctx;
  const geom = state.geometry;

  // Line
  ctx.beginPath();
  ctx.moveTo(geom.p1.x, geom.p1.y);
  ctx.lineTo(geom.p2.x, geom.p2.y);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#ff0055";
  ctx.stroke();

  // Handles
  [geom.p1, geom.p2].forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffcc00";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  });

  // Direction indicator arrow
  const mx = (geom.p1.x + geom.p2.x) / 2;
  const my = (geom.p1.y + geom.p2.y) / 2;
  const sign = geom.directionSign < 0 ? -1 : 1;
  const arrowLen = 45;
  const endX = mx + sign * arrowLen * geom.nx;
  const endY = my + sign * arrowLen * geom.ny;

  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(endX, endY);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#00ff66";
  ctx.stroke();
}

// UI Buttons and Event Listeners
function setupUIListeners() {
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnDir = document.getElementById('btn-dir');
  const btnReset = document.getElementById('btn-reset-line');
  const btnExport = document.getElementById('btn-export-parkrun');
  const btnFlip = document.getElementById('btn-toggle-cam');
  const badgeState = document.getElementById('badge-state');
  const badgeDir = document.getElementById('badge-dir');

  btnStart.addEventListener('click', () => {
    state.isRaceRunning = true;
    state.raceStartMonoMs = performance.now();
    state.tracks.clear();
    state.results = [];
    document.getElementById('results-list').innerHTML = "";
    document.getElementById('finisher-count').textContent = "0";

    badgeState.textContent = "RUNNING";
    badgeState.className = "badge running";
    btnStart.disabled = true;
    btnStop.disabled = false;
    acquireWakeLock();
  });

  btnStop.addEventListener('click', () => {
    state.isRaceRunning = false;
    badgeState.textContent = "STOPPED";
    badgeState.className = "badge stopped";
    btnStart.disabled = false;
    btnStop.disabled = true;
    if (state.wakeLock) state.wakeLock.release();
  });

  btnDir.addEventListener('click', () => {
    state.geometry.directionSign = state.geometry.directionSign === -1 ? 1 : (state.geometry.directionSign === 1 ? 0 : -1);
    badgeDir.textContent = state.geometry.directionSign === -1 ? "DIR: L → R" : (state.geometry.directionSign === 1 ? "DIR: R → L" : "DIR: EITHER");
  });

  btnReset.addEventListener('click', () => {
    state.geometry = new FinishLineGeometry(state.canvas.width, state.canvas.height);
  });

  btnFlip.addEventListener('click', async () => {
    state.facingMode = state.facingMode === "environment" ? "user" : "environment";
    await setupCamera();
  });

  btnExport.addEventListener('click', () => {
    if (state.results.length === 0) {
      alert("No finish results recorded yet.");
      return;
    }
    // Parkrun standard CSV format: Position,Time
    let csv = "Position,Time\n";
    state.results.forEach(r => {
      csv += `${r.position},${r.formattedTime}\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `parkrun_results_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// Bootstrap
window.addEventListener('DOMContentLoaded', async () => {
  await setupCamera();
  initTouchInteractions();
  setupUIListeners();
  await initDetector();
  requestAnimationFrame(mainLoop);
});