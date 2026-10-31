/**
 * Core domain contracts and data types
 */

/**
 * @typedef {Object} Rect
 * @property {number} x - Top-left x [0, 1]
 * @property {number} y - Top-left y [0, 1]
 * @property {number} width - Normalized width [0, 1]
 * @property {number} height - Normalized height [0, 1]
 */

/**
 * @typedef {Object} Detection
 * @property {Rect} bbox
 * @property {number} score
 * @property {number} classId
 */

/**
 * @typedef {Object} FinishEvent
 * @property {number} trackId - Consistent runner ID
 * @property {number} position - Finishing position (1, 2, 3...)
 * @property {number} exactTimestamp - Hardware/sub-frame interpolated timestamp (ms)
 * @property {string} formattedTime - Display string (mm:ss.sss)
 * @property {number} alpha - Sub-frame interpolation factor [0, 1]
 * @property {number} confidence - Tracking confidence score at crossing
 * @property {Array<string>} flags - Uncertainty flags: 'OCCLUDED', 'LOW_CONFIDENCE', 'FAST_CROSSING'
 */

export const RunnerState = {
  APPROACHING: 'APPROACHING',
  CROSSED: 'CROSSED',
  COOLDOWN: 'COOLDOWN',
  DEPARTED: 'DEPARTED'
};