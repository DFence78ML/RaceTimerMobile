import { TimingMath } from '../src/geometry/CrossingEngine.js';
import { ByteTracker } from '../src/tracker/ByteTrack.js';
import { RunnerPipeline } from '../src/pipeline/RunnerPipeline.js';
import { MockDetector } from '../src/pipeline/MockDetector.js';

let passed = 0;
let failed = 0;

function assert(description, condition) {
  if (condition) {
    console.log(`\x1b[32m[PASS]\x1b[0m ${description}`);
    passed++;
  } else {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${description}`);
    failed++;
  }
}

console.log('--- RUNNING RIGOROUS RACE TIMING UNIT & INTEGRATION TESTS ---\n');

// 1. Parametric Line Crossing Geometry
{
  const lineP1 = { x: 0.5, y: 0.0 };
  const lineP2 = { x: 0.5, y: 1.0 };
  const engine = new CrossingEngine(lineP1, lineP2, 'ltr');

  // Valid LTR crossing
  const cross1 = engine.evaluateCrossing({ x: 0.45, y: 0.5, timestamp: 1000 }, { x: 0.55, y: 0.5, timestamp: 1040 });
  assert('Geometry: Valid LTR crossing detected', cross1 !== null);
  assert('Geometry: Exact 50% midpoint alpha calculated correctly', Math.abs(cross1.alpha - 0.5) < 0.001);
  assert('Geometry: Exact interpolated timestamp matches midpoint (1020ms)', Math.abs(cross1.exactCrossingTime - 1020) < 0.1);

  // Rejected RTL crossing in LTR mode
  const crossRev = engine.evaluateCrossing({ x: 0.55, y: 0.5, timestamp: 1000 }, { x: 0.45, y: 0.5, timestamp: 1040 });
  assert('Geometry: Reverse (RTL) movement rejected when configured as LTR', crossRev === null);

  // Runner passing outside vertical endpoint bounds
  const crossOut = engine.evaluateCrossing({ x: 0.45, y: 1.2, timestamp: 1000 }, { x: 0.55, y: 1.2, timestamp: 1040 });
  assert('Geometry: Crossing rejected if outside finite finish line segment', crossOut === null);
}

// 2. Tracking ID Persistence During Occlusion
{
  const tracker = new ByteTracker(0.5, 0.2, 10);

  // Frame 1: Runner visible
  tracker.update([{ bbox: { x: 0.2, y: 0.3, width: 0.1, height: 0.4 }, score: 0.9 }], 1000);
  const trackId = tracker.tracks[0].id;

  // Frame 2 & 3: Runner occluded (detection missed)
  tracker.update([], 1033);
  tracker.update([], 1066);
  assert('Occlusion: Track retained across 2 frames of total absence', tracker.tracks.length === 1);

  // Frame 4: Runner re-emerges with low score
  tracker.update([{ bbox: { x: 0.24, y: 0.3, width: 0.1, height: 0.4 }, score: 0.35 }], 1100);
  assert('Occlusion: Runner reacquired with matching ID through low-confidence pool', tracker.tracks[0].id === trackId);
}

// 3. Dense Pack Crossing & Anti-Double-Counting Integration Test
{
  const pipeline = new RunnerPipeline({
    lineP1: { x: 0.5, y: 0.0 },
    lineP2: { x: 0.5, y: 1.0 },
    direction: 'ltr'
  });

  pipeline.startRace(1000);
  const mock = new MockDetector('pack_crossing');

  let totalFinishers = 0;
  for (let f = 1; f <= 35; f++) {
    const timestamp = 1000 + f * 33.3; // 30 FPS simulated
    const detections = mock.generateFrame(timestamp);
    const { newFinishers } = pipeline.processFrame(detections, timestamp);
    totalFinishers += newFinishers.length;
  }

  assert('Pack Crossing: Exactly 2 runners registered from dense pack', pipeline.finishers.length === 2);
  assert('Order: Runner 1 finished before Runner 2', pipeline.finishers[0].trackId === 1 && pipeline.finishers[1].trackId === 2);
  assert('Anti-Double-Count: No duplicate finish events recorded for same tracks', totalFinishers === 2);
}

// 4. Reversal at Line (No False Triggers)
{
  const pipeline = new RunnerPipeline({
    lineP1: { x: 0.5, y: 0.0 },
    lineP2: { x: 0.5, y: 1.0 },
    direction: 'ltr'
  });

  pipeline.startRace(1000);
  const mock = new MockDetector('reversal_no_finish');

  for (let f = 1; f <= 30; f++) {
    const timestamp = 1000 + f * 33.3;
    const detections = mock.generateFrame(timestamp);
    pipeline.processFrame(detections, timestamp);
  }

  assert('Reversal: Runner approaching and walking backwards records 0 finishes', pipeline.finishers.length === 0);
}

console.log(`\nTest Suite Complete: ${passed} Passed, ${failed} Failed`);
if (failed > 0) process.exit(1);