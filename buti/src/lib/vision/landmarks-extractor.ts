/**
 * FaceMesh feature extraction in source-image pixel coordinates.
 * Indices follow MediaPipe's canonical 478-point face mesh connections.
 */

import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export interface Point2D {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EyebrowGeometry {
  start: Point2D;
  arch: Point2D;
  body: Point2D;
  tail: Point2D;
  angle: number;
  bbox: BoundingBox;
  length: number;
  thickness: number;
}

export interface EyeGeometry {
  innerCorner: Point2D;
  outerCorner: Point2D;
  upper: Point2D[];
  lower: Point2D[];
}

export interface FeatureLandmarks {
  leftEyebrow: Point2D[];
  rightEyebrow: Point2D[];
  leftEyebrowGeometry: EyebrowGeometry | null;
  rightEyebrowGeometry: EyebrowGeometry | null;
  /** Full outer mouth contour. Kept for backwards compatibility. */
  lipsOuter: Point2D[];
  /** Mouth opening contour. Kept for backwards compatibility. */
  lipsInner: Point2D[];
  lipsUpper: Point2D[];
  lipsLower: Point2D[];
  mouthOpening: Point2D[];
  leftEyeUpper: Point2D[];
  rightEyeUpper: Point2D[];
  leftEyeLower: Point2D[];
  rightEyeLower: Point2D[];
  leftEye: EyeGeometry | null;
  rightEye: EyeGeometry | null;
}

const LEFT_EYEBROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const RIGHT_EYEBROW = [296, 334, 293, 300, 276, 283, 282, 295, 285, 336];

// Separate vermilion polygons: outer edge left→right, then inner edge right→left.
// This is deliberately not inferred from neighbouring points: these are canonical
// MediaPipe lip connections.
const LIP_UPPER = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291,
  308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78,
];
const LIP_LOWER = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
  308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78,
];
const LIPS_OUTER = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291,
  375, 321, 405, 314, 17, 84, 181, 91, 146,
];
const MOUTH_OPENING = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308,
  324, 318, 402, 317, 14, 87, 178, 88, 95,
];

// Corner-to-corner eyelid curves. The lower curves are retained for geometry and
// validation; eyeliner is intentionally drawn only above the upper lash margin.
const LEFT_EYE_UPPER = [33, 246, 161, 160, 159, 158, 157, 173, 133];
const LEFT_EYE_LOWER = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const RIGHT_EYE_UPPER = [362, 398, 384, 385, 386, 387, 388, 466, 263];
const RIGHT_EYE_LOWER = [362, 382, 381, 380, 374, 373, 390, 249, 263];

function toPixels(
  indices: number[],
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): Point2D[] {
  return indices
    .filter((i) => i >= 0 && i < landmarks.length)
    .map((i) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height }));
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function extractEyebrowGeometry(points: Point2D[], faceCenterX: number): EyebrowGeometry | null {
  if (points.length < 4) return null;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const endpoints = points.reduce<Point2D[]>((acc, point) => {
    if (point.x === minX || point.x === maxX) acc.push(point);
    return acc;
  }, []);
  const start = endpoints.reduce((best, point) =>
    Math.abs(point.x - faceCenterX) < Math.abs(best.x - faceCenterX) ? point : best,
  endpoints[0] ?? points[0]);
  const tail = endpoints.reduce((best, point) =>
    Math.abs(point.x - faceCenterX) > Math.abs(best.x - faceCenterX) ? point : best,
  endpoints[0] ?? points[points.length - 1]);
  // Canvas y grows downwards, so the visually highest point is the arch apex.
  const arch = points.reduce((best, point) => point.y < best.y ? point : best, points[0]);
  const bodyPoints = points.filter((point) => distance(point, center) <= Math.max(maxX - minX, 1) * 0.42);
  const body = (bodyPoints.length ? bodyPoints : points).reduce(
    (sum, point) => ({ x: sum.x + point.x / (bodyPoints.length || points.length), y: sum.y + point.y / (bodyPoints.length || points.length) }),
    { x: 0, y: 0 },
  );

  return {
    start,
    arch,
    body,
    tail,
    angle: Math.atan2(tail.y - start.y, tail.x - start.x),
    bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    length: distance(start, arch) + distance(arch, tail),
    thickness: maxY - minY,
  };
}

function eyeGeometry(upper: Point2D[], lower: Point2D[], faceCenterX: number): EyeGeometry | null {
  if (upper.length < 3 || lower.length < 3) return null;
  const ends = [upper[0], upper[upper.length - 1]];
  const innerCorner = ends.reduce((best, point) =>
    Math.abs(point.x - faceCenterX) < Math.abs(best.x - faceCenterX) ? point : best,
  ends[0]);
  const outerCorner = ends[0] === innerCorner ? ends[1] : ends[0];
  return { innerCorner, outerCorner, upper, lower };
}

/** Convert normalized MediaPipe landmarks into source-image feature geometry. */
export function extractFeatureLandmarks(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): FeatureLandmarks {
  const leftEyebrow = toPixels(LEFT_EYEBROW, landmarks, width, height);
  const rightEyebrow = toPixels(RIGHT_EYEBROW, landmarks, width, height);
  const leftEyeUpper = toPixels(LEFT_EYE_UPPER, landmarks, width, height);
  const rightEyeUpper = toPixels(RIGHT_EYE_UPPER, landmarks, width, height);
  const leftEyeLower = toPixels(LEFT_EYE_LOWER, landmarks, width, height);
  const rightEyeLower = toPixels(RIGHT_EYE_LOWER, landmarks, width, height);
  const mouthOpening = toPixels(MOUTH_OPENING, landmarks, width, height);

  return {
    leftEyebrow,
    rightEyebrow,
    leftEyebrowGeometry: extractEyebrowGeometry(leftEyebrow, width / 2),
    rightEyebrowGeometry: extractEyebrowGeometry(rightEyebrow, width / 2),
    lipsOuter: toPixels(LIPS_OUTER, landmarks, width, height),
    lipsInner: mouthOpening,
    lipsUpper: toPixels(LIP_UPPER, landmarks, width, height),
    lipsLower: toPixels(LIP_LOWER, landmarks, width, height),
    mouthOpening,
    leftEyeUpper,
    rightEyeUpper,
    leftEyeLower,
    rightEyeLower,
    leftEye: eyeGeometry(leftEyeUpper, leftEyeLower, width / 2),
    rightEye: eyeGeometry(rightEyeUpper, rightEyeLower, width / 2),
  };
}
