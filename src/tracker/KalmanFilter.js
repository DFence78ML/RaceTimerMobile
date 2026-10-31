/**
 * 8-State Kalman Filter for 2D bounding boxes:
 * State: [center_x, center_y, aspect_ratio, height, vx, vy, va, vh]
 * Provides smooth motion predictions through occlusions and missed frames.
 */
export class KalmanBoxTracker {
  constructor(bbox) {
    // Initial state vector
    this.x = [
      bbox.x + bbox.width / 2,
      bbox.y + bbox.height / 2,
      bbox.width / bbox.height,
      bbox.height,
      0, 0, 0, 0
    ];

    // Covariance matrix
    this.P = [
      10, 0, 0, 0, 0, 0, 0, 0,
      0, 10, 0, 0, 0, 0, 0, 0,
      0, 0, 10, 0, 0, 0, 0, 0,
      0, 0, 0, 10, 0, 0, 0, 0,
      0, 0, 0, 0, 1000, 0, 0, 0,
      0, 0, 0, 0, 0, 1000, 0, 0,
      0, 0, 0, 0, 0, 0, 1000, 0,
      0, 0, 0, 0, 0, 0, 0, 1000
    ];

    this.Q_std = 0.01;
    this.R_std = 0.05;
  }

  predict(dt = 1.0) {
    // Constant velocity state transition
    this.x[0] += this.x[4] * dt;
    this.x[1] += this.x[5] * dt;
    this.x[2] += this.x[6] * dt;
    this.x[3] += this.x[7] * dt;

    // Process noise inflation
    for (let i = 0; i < 8; i++) {
      this.P[i * 8 + i] += this.Q_std * (i >= 4 ? 2.0 : 1.0);
    }
    return this.getBBox();
  }

  update(bbox) {
    const z = [
      bbox.x + bbox.width / 2,
      bbox.y + bbox.height / 2,
      bbox.width / bbox.height,
      bbox.height
    ];

    // Kalman gain approximation for low-overhead mobile execution
    for (let i = 0; i < 4; i++) {
      const residual = z[i] - this.x[i];
      const s = this.P[i * 8 + i] + this.R_std;
      const k = this.P[i * 8 + i] / (s === 0 ? 1e-6 : s);
      this.x[i] += k * residual;
      this.x[i + 4] += (k * 0.5) * residual;
      this.P[i * 8 + i] *= (1.0 - k);
    }
  }

  getBBox() {
    const w = this.x[2] * this.x[3];
    const h = this.x[3];
    return {
      x: this.x[0] - w / 2,
      y: this.x[1] - h / 2,
      width: Math.max(0.001, w),
      height: Math.max(0.001, h)
    };
  }
}