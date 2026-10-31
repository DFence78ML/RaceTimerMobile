import { KalmanBoxTracker } from './KalmanFilter.js';
import { RunnerState } from '../types.js';

function computeIoU(boxA, boxB) {
  const x1 = Math.max(boxA.x, boxB.x);
  const y1 = Math.max(boxA.y, boxB.y);
  const x2 = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const y2 = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = boxA.width * boxA.height;
  const areaB = boxB.width * boxB.height;
  const union = areaA + areaB - intersection;

  return union <= 0 ? 0 : intersection / union;
}

export class Tracklet {
  constructor(id, detection, timestamp) {
    this.id = id;
    this.kf = new KalmanBoxTracker(detection.bbox);
    this.score = detection.score;
    this.state = RunnerState.APPROACHING;
    this.framesUnseen = 0;
    this.age = 1;
    this.trajectory = [];
    this.hasCrossed = false;
    this.crossingEvent = null;

    this.recordPoint(detection.bbox, timestamp, detection.score);
  }

  recordPoint(bbox, timestamp, score) {
    // Anchor point: Torso Center (50% x, 40% down from top of box)
    const anchorX = bbox.x + bbox.width * 0.5;
    const anchorY = bbox.y + bbox.height * 0.4;

    this.trajectory.push({
      x: anchorX,
      y: anchorY,
      width: bbox.width,
      height: bbox.height,
      timestamp,
      score
    });

    if (this.trajectory.length > 30) {
      this.trajectory.shift();
    }
  }

  predict(dt) {
    return this.kf.predict(dt);
  }

  update(detection, timestamp) {
    this.kf.update(detection.bbox);
    this.score = detection.score;
    this.framesUnseen = 0;
    this.age++;
    this.recordPoint(this.kf.getBBox(), timestamp, detection.score);
  }

  markMissed() {
    this.framesUnseen++;
    this.age++;
  }
}

export class ByteTracker {
  constructor(highScoreThresh = 0.5, lowScoreThresh = 0.2, maxLostFrames = 25) {
    this.highScoreThresh = highScoreThresh;
    this.lowScoreThresh = lowScoreThresh;
    this.maxLostFrames = maxLostFrames;
    this.tracks = [];
    this.nextTrackId = 1;
  }

  update(detections, timestamp, dt = 1.0) {
    // 1. Predict track locations via Kalman Filter
    for (const track of this.tracks) {
      track.predict(dt);
    }

    // 2. Partition detections into high and low confidence pools
    const dHigh = [];
    const dLow = [];
    for (const d of detections) {
      if (d.score >= this.highScoreThresh) {
        dHigh.push(d);
      } else if (d.score >= this.lowScoreThresh) {
        dLow.push(d);
      }
    }

    // 3. Match Phase 1: High-score detections against active tracks
    const [matches1, unmatchedTracks1, unmatchedDHigh] = this.associate(this.tracks, dHigh, 0.3);
    for (const [tIdx, dIdx] of matches1) {
      this.tracks[tIdx].update(dHigh[dIdx], timestamp);
    }

    // 4. Match Phase 2: Low-score detections (handles partially occluded runners)
    const remainingTracks = unmatchedTracks1.map(idx => this.tracks[idx]);
    const [matches2, unmatchedTracks2] = this.associate(remainingTracks, dLow, 0.4);
    for (const [tIdx, dIdx] of matches2) {
      remainingTracks[tIdx].update(dLow[dIdx], timestamp);
    }

    // 5. Handle unassociated tracks
    for (const track of unmatchedTracks2.map(i => remainingTracks[i])) {
      track.markMissed();
    }

    // 6. Spawn new tracks from remaining unmatched high-confidence detections
    for (const dIdx of unmatchedDHigh) {
      const newTrack = new Tracklet(this.nextTrackId++, dHigh[dIdx], timestamp);
      this.tracks.push(newTrack);
    }

    // 7. Remove dead tracks
    this.tracks = this.tracks.filter(t => t.framesUnseen <= this.maxLostFrames);

    return this.tracks;
  }

  associate(tracks, detections, iouThreshold) {
    const matches = [];
    const unmatchedTracks = [];
    const unmatchedDetections = new Set(detections.map((_, i) => i));

    for (let t = 0; t < tracks.length; t++) {
      const trackBox = tracks[t].kf.getBBox();
      let bestIoU = 0;
      let bestD = -1;

      for (let d = 0; d < detections.length; d++) {
        if (!unmatchedDetections.has(d)) continue;
        const iou = computeIoU(trackBox, detections[d].bbox);
        if (iou > bestIoU && iou >= iouThreshold) {
          bestIoU = iou;
          bestD = d;
        }
      }

      if (bestD !== -1) {
        matches.push([t, bestD]);
        unmatchedDetections.delete(bestD);
      } else {
        unmatchedTracks.push(t);
      }
    }

    return [matches, unmatchedTracks, Array.from(unmatchedDetections)];
  }
}