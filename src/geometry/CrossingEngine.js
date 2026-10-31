/**
 * Finish Line Crossing Verification & Sub-Frame Temporal Interpolation
 */
export class CrossingEngine {
  constructor(lineP1 = { x: 0.5, y: 0.05 }, lineP2 = { x: 0.5, y: 0.95 }, direction = 'ltr') {
    this.p1 = lineP1;
    this.p2 = lineP2;
    this.direction = direction; // 'ltr' (Left-to-Right) or 'rtl' (Right-to-Left)
  }

  /**
   * Signed distance from point P to directed line segment A -> B
   * Sign indicates which side of the line the point is on.
   */
  signedDistance(px, py) {
    return (this.p2.x - this.p1.x) * (py - this.p1.y) - (this.p2.y - this.p1.y) * (px - this.p1.x);
  }

  /**
   * Evaluates if trajectory (pPrev -> pCurr) crosses the finite line segment.
   * Returns exact sub-frame crossing interpolation details, or null if no crossing occurs.
   */
  evaluateCrossing(pPrev, pCurr) {
    const s1 = this.signedDistance(pPrev.x, pPrev.y);
    const s2 = this.signedDistance(pCurr.x, pCurr.y);

    let crossesDirection = false;
    // For a line oriented from top to bottom (y2 > y1):
    // Left side: s > 0, Right side: s < 0
    if (this.direction === 'ltr') {
      if (s1 > 0 && s2 <= 0) crossesDirection = true;
    } else {
      if (s1 < 0 && s2 >= 0) crossesDirection = true;
    }

    if (!crossesDirection) return null;

    // Sub-frame linear interpolation factor alpha in [0, 1]
    const denom = Math.abs(s1) + Math.abs(s2);
    const alpha = denom === 0 ? 0.5 : Math.abs(s1) / denom;

    const crossX = pPrev.x + alpha * (pCurr.x - pPrev.x);
    const crossY = pPrev.y + alpha * (pCurr.y - pPrev.y);

    // Parametric test to ensure crossing lies within the physical line segment bounds
    const lineDx = this.p2.x - this.p1.x;
    const lineDy = this.p2.y - this.p1.y;
    const lengthSq = lineDx * lineDx + lineDy * lineDy;
    if (lengthSq < 1e-9) return null;

    const u = ((crossX - this.p1.x) * lineDx + (crossY - this.p1.y) * lineDy) / lengthSq;

    // Tolerance of 5% outside bounds to account for runner boundaries
    if (u < -0.05 || u > 1.05) return null;

    const dt = pCurr.timestamp - pPrev.timestamp;
    const exactCrossingTime = pPrev.timestamp + alpha * dt;

    return {
      alpha,
      exactCrossingTime,
      crossX,
      crossY,
      segmentParam: Math.max(0, Math.min(1, u))
    };
  }
}