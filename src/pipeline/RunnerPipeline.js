import { ByteTracker } from '../tracker/ByteTrack.js';
import { CrossingEngine } from '../geometry/CrossingEngine.js';
import { RunnerState } from '../types.js';

export class RunnerPipeline {
  constructor(config = {}) {
    this.tracker = new ByteTracker(config.highScoreThresh || 0.5, config.lowScoreThresh || 0.2);
    this.crossingEngine = new CrossingEngine(config.lineP1, config.lineP2, config.direction || 'ltr');
    this.finishers = [];
    this.raceStartTime = 0;
    this.isRunning = false;
    this.onFinisherDetected = config.onFinisherDetected || null;
  }

  startRace(startTimestamp) {
    this.raceStartTime = startTimestamp;
    this.isRunning = true;
    this.finishers = [];
  }

  stopRace() {
    this.isRunning = false;
  }

  processFrame(detections, frameTimestamp) {
    // 1. Update multi-object tracking states
    const activeTracks = this.tracker.update(detections, frameTimestamp);

    if (!this.isRunning) {
      return { activeTracks, newFinishers: [] };
    }

    const newFinishers = [];

    // 2. Evaluate crossing logic for each tracked runner
    for (const track of activeTracks) {
      if (track.hasCrossed || track.trajectory.length < 2) continue;

      const pPrev = track.trajectory[track.trajectory.length - 2];
      const pCurr = track.trajectory[track.trajectory.length - 1];

      const cross = this.crossingEngine.evaluateCrossing(pPrev, pCurr);
      if (cross) {
        track.hasCrossed = true;
        track.state = RunnerState.CROSSED;

        const flags = [];
        if (pCurr.score < 0.4) flags.push('LOW_CONFIDENCE');
        if (track.framesUnseen > 2) flags.push('OCCLUDED_PRIOR');

        const elapsedMs = Math.max(0, cross.exactCrossingTime - this.raceStartTime);
        const position = this.finishers.length + 1;

        const finishEvent = {
          position,
          trackId: track.id,
          exactTimestamp: cross.exactCrossingTime,
          elapsedMs,
          formattedTime: this.formatTime(elapsedMs),
          alpha: Number(cross.alpha.toFixed(3)),
          confidence: Number(pCurr.score.toFixed(2)),
          flags
        };

        track.crossingEvent = finishEvent;
        this.finishers.push(finishEvent);
        newFinishers.push(finishEvent);

        if (this.onFinisherDetected) {
          this.onFinisherDetected(finishEvent);
        }
      }
    }

    return { activeTracks, newFinishers };
  }

  formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const millis = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }
}