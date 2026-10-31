/**
 * Deterministic Synthetic Scenario Generator
 * Generates frame-by-frame runner bounding boxes to test occlusion,
 * simultaneous crossings, reversals, and close-proximity grouping.
 */
export class MockDetector {
  constructor(scenario = 'pack_crossing') {
    this.scenario = scenario;
    this.frameIndex = 0;
  }

  generateFrame(timestamp) {
    this.frameIndex++;
    const t = this.frameIndex;
    const detections = [];

    if (this.scenario === 'pack_crossing') {
      // Runner 1: Moves Left to Right smoothly
      detections.push({
        bbox: { x: 0.1 + t * 0.02, y: 0.3, width: 0.1, height: 0.4 },
        score: 0.9,
        classId: 0
      });
      // Runner 2: Close behind Runner 1 (crosses ~2 frames later)
      detections.push({
        bbox: { x: 0.06 + t * 0.02, y: 0.32, width: 0.1, height: 0.38 },
        score: 0.85,
        classId: 0
      });
    } else if (this.scenario === 'occlusion_and_cross') {
      // Runner 1: Foreground runner moving LTR
      detections.push({
        bbox: { x: 0.15 + t * 0.025, y: 0.28, width: 0.12, height: 0.45 },
        score: 0.95,
        classId: 0
      });

      // Runner 2: Background runner occluded between frames 10 and 15
      if (t < 10 || t > 15) {
        detections.push({
          bbox: { x: 0.18 + t * 0.022, y: 0.25, width: 0.09, height: 0.38 },
          score: t > 15 ? 0.45 : 0.88, // Score drops right after re-emergence
          classId: 0
        });
      }
    } else if (this.scenario === 'reversal_no_finish') {
      // Runner approaches line, stops, and walks backwards
      const posX = t <= 15 ? 0.2 + t * 0.018 : 0.47 - (t - 15) * 0.015;
      detections.push({
        bbox: { x: posX, y: 0.35, width: 0.1, height: 0.4 },
        score: 0.92,
        classId: 0
      });
    }

    return detections;
  }
}