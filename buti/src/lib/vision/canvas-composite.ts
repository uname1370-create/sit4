/**
 * Landmark-aware client composite. Masks are expressed in source-image pixels
 * and scaled from the detected feature rather than from one fixed resolution.
 */

import { FeatureLandmarks, Point2D, type EyebrowGeometry, type EyeGeometry } from './landmarks-extractor';

export type ServiceTarget = 'eyebrows' | 'lips' | 'eyeliner' | 'removal';

export interface CompositeOptions {
  /** Optional explicit override; normally feature-relative defaults are safer. */
  featherRadius?: number;
  opacity?: number;
  blendMode?: GlobalCompositeOperation;
  watermarkEnabled?: boolean;
}

export interface EyelinerPathGeometry {
  points: Point2D[];
  widths: number[];
  featherRadius: number;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src.substring(0, 50)}...`));
    img.src = src;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function drawPolygon(ctx: CanvasRenderingContext2D, points: Point2D[]) {
  if (points.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

function featureBounds(points: Point2D[]) {
  if (!points.length) return { width: 0, height: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Expand the native brow footprint just enough to fill sparse areas and permit
 * a proportional arch/tail design. Expansion remains anchored to detected
 * start/body/arch/tail geometry; it is not a pasted reference silhouette.
 */
export function calculateBrowTargetPolygon(points: Point2D[], geometry: EyebrowGeometry | null): Point2D[] {
  if (points.length < 3 || !geometry) return points;
  const center = geometry.body;
  const verticalScale = clamp(1.25 + geometry.thickness / Math.max(geometry.bbox.width, 1), 1.28, 1.48);
  const horizontalScale = 1.08;
  const tailVector = {
    x: geometry.tail.x - geometry.arch.x,
    y: geometry.tail.y - geometry.arch.y,
  };
  const tailLength = Math.max(Math.hypot(tailVector.x, tailVector.y), 1);

  return points.map((point) => {
    const tailDistance = Math.hypot(point.x - geometry.tail.x, point.y - geometry.tail.y);
    const nearTail = tailDistance <= Math.max(geometry.bbox.width * 0.2, geometry.thickness * 2);
    return {
      x: center.x + (point.x - center.x) * horizontalScale + (nearTail ? tailVector.x / tailLength * geometry.bbox.width * 0.04 : 0),
      y: center.y + (point.y - center.y) * verticalScale + (nearTail ? tailVector.y / tailLength * geometry.bbox.width * 0.04 : 0),
    };
  });
}

function orientInnerToOuter(eye: EyeGeometry): Point2D[] {
  const firstIsInner = eye.upper[0] === eye.innerCorner ||
    Math.hypot(eye.upper[0].x - eye.innerCorner.x, eye.upper[0].y - eye.innerCorner.y) < 1;
  return firstIsInner ? eye.upper : [...eye.upper].reverse();
}

/** Build a corner-to-corner, tapered upper-lid curve with a conservative wing. */
export function buildEyelinerPathGeometry(eye: EyeGeometry, includeWing = true): EyelinerPathGeometry {
  const upper = orientInnerToOuter(eye);
  const eyeWidth = Math.max(Math.hypot(
    eye.outerCorner.x - eye.innerCorner.x,
    eye.outerCorner.y - eye.innerCorner.y,
  ), 1);
  const maxWidth = clamp(eyeWidth * 0.065, 1.5, 10);
  const points = upper.map((point, index) => {
    const t = index / Math.max(upper.length - 1, 1);
    // Shift towards the lid skin, away from the eyeball. Canonical upper-lid
    // points lie above lower-lid points in source coordinates.
    const upperY = Math.min(...eye.upper.map((p) => p.y));
    const lowerY = Math.max(...eye.lower.map((p) => p.y));
    const skinDirection = upperY <= lowerY ? -1 : 1;
    return { x: point.x, y: point.y + skinDirection * maxWidth * (0.18 + t * 0.12) };
  });
  const widths = points.map((_, index) => {
    const t = index / Math.max(points.length - 1, 1);
    return maxWidth * (0.3 + Math.sin(t * Math.PI * 0.72) * 0.7);
  });

  if (includeWing && points.length >= 2) {
    const outer = points[points.length - 1];
    const previous = points[points.length - 2];
    const away = Math.sign(eye.outerCorner.x - eye.innerCorner.x) || 1;
    const naturalSlope = clamp((outer.y - previous.y) / Math.max(Math.abs(outer.x - previous.x), 1), -0.7, 0.7);
    points.push({
      x: outer.x + away * eyeWidth * 0.13,
      y: outer.y + naturalSlope * eyeWidth * 0.08 - eyeWidth * 0.045,
    });
    widths.push(Math.max(0.8, maxWidth * 0.16));
  }

  return { points, widths, featherRadius: clamp(eyeWidth * 0.018, 0.8, 4) };
}

function strokeTaperedCurve(ctx: CanvasRenderingContext2D, geometry: EyelinerPathGeometry) {
  const { points, widths } = geometry;
  if (points.length < 2) return;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const next = points[Math.min(index + 2, points.length - 1)];
    const control = index + 2 < points.length
      ? { x: end.x, y: end.y }
      : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const target = index + 2 < points.length
      ? { x: (end.x + next.x) / 2, y: (end.y + next.y) / 2 }
      : end;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.quadraticCurveTo(control.x, control.y, target.x, target.y);
    ctx.lineWidth = Math.max(0.8, (widths[index] + widths[index + 1]) / 2);
    ctx.stroke();
  }
}

function defaultFeather(features: FeatureLandmarks, target: ServiceTarget, width: number, height: number): number {
  if (target === 'lips') {
    const bounds = featureBounds([...features.lipsUpper, ...features.lipsLower]);
    return clamp(Math.max(bounds.height * 0.13, bounds.width * 0.018), 1.2, Math.max(width, height) * 0.015);
  }
  if (target === 'eyebrows') {
    const brows = [features.leftEyebrowGeometry, features.rightEyebrowGeometry].filter(Boolean) as EyebrowGeometry[];
    const thickness = brows.length ? brows.reduce((sum, brow) => sum + brow.thickness, 0) / brows.length : Math.max(width, height) * 0.01;
    return clamp(thickness * 0.35, 1.5, Math.max(width, height) * 0.012);
  }
  if (target === 'eyeliner') {
    const eye = features.leftEye ?? features.rightEye;
    return eye ? buildEyelinerPathGeometry(eye).featherRadius : clamp(Math.max(width, height) * 0.002, 1, 4);
  }
  return clamp(Math.max(width, height) * 0.006, 2, 12);
}

/** Two-stage feature-relative feathered mask. */
export function createDualStageFeatheredMask(
  width: number,
  height: number,
  features: FeatureLandmarks,
  target: ServiceTarget,
  options: { featherRadius?: number } = {},
): HTMLCanvasElement {
  const featherRadius = options.featherRadius ?? defaultFeather(features, target, width, height);
  const coreCanvas = document.createElement('canvas');
  coreCanvas.width = width;
  coreCanvas.height = height;
  const coreCtx = coreCanvas.getContext('2d');
  if (!coreCtx) throw new Error('Could not get core canvas context');
  coreCtx.fillStyle = '#FFFFFF';

  if (target === 'eyebrows') {
    drawPolygon(coreCtx, calculateBrowTargetPolygon(features.leftEyebrow, features.leftEyebrowGeometry));
    coreCtx.fill();
    drawPolygon(coreCtx, calculateBrowTargetPolygon(features.rightEyebrow, features.rightEyebrowGeometry));
    coreCtx.fill();
  } else if (target === 'lips') {
    // Upper and lower vermilion are explicit polygons. Removing the opening a
    // second time protects teeth/tongue even at touching-lip boundaries.
    drawPolygon(coreCtx, features.lipsUpper);
    coreCtx.fill();
    drawPolygon(coreCtx, features.lipsLower);
    coreCtx.fill();
    const opening = features.mouthOpening.length ? features.mouthOpening : features.lipsInner;
    if (opening.length >= 3) {
      coreCtx.globalCompositeOperation = 'destination-out';
      drawPolygon(coreCtx, opening);
      coreCtx.fill();
      coreCtx.globalCompositeOperation = 'source-over';
    }
  } else if (target === 'eyeliner') {
    if (features.leftEye) strokeTaperedCurve(coreCtx, buildEyelinerPathGeometry(features.leftEye));
    if (features.rightEye) strokeTaperedCurve(coreCtx, buildEyelinerPathGeometry(features.rightEye));
  }

  const finalMask = document.createElement('canvas');
  finalMask.width = width;
  finalMask.height = height;
  const finalCtx = finalMask.getContext('2d');
  if (!finalCtx) throw new Error('Could not get final mask context');
  finalCtx.filter = `blur(${Math.max(0.6, featherRadius * 1.45)}px)`;
  finalCtx.globalAlpha = 0.42;
  finalCtx.drawImage(coreCanvas, 0, 0);
  finalCtx.filter = `blur(${Math.max(0.4, featherRadius * 0.55)}px)`;
  finalCtx.globalAlpha = 0.88;
  finalCtx.drawImage(coreCanvas, 0, 0);
  finalCtx.filter = 'none';
  finalCtx.globalAlpha = 1;
  return finalMask;
}

export function applyPhotorealisticHardComposite(
  baseImage: HTMLImageElement | HTMLCanvasElement,
  generatedImage: HTMLImageElement | HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  _features: FeatureLandmarks,
  options: CompositeOptions = {},
): HTMLCanvasElement {
  const width = baseImage.width;
  const height = baseImage.height;
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;
  const ctx = outputCanvas.getContext('2d');
  if (!ctx) throw new Error('Could not get output canvas context');
  ctx.drawImage(baseImage, 0, 0, width, height);

  const isolatedOverlay = document.createElement('canvas');
  isolatedOverlay.width = width;
  isolatedOverlay.height = height;
  const overlayCtx = isolatedOverlay.getContext('2d');
  if (!overlayCtx) throw new Error('Could not get overlay context');
  overlayCtx.drawImage(generatedImage, 0, 0, width, height);
  overlayCtx.globalCompositeOperation = 'destination-in';
  overlayCtx.drawImage(maskCanvas, 0, 0, width, height);

  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.35;
  ctx.drawImage(isolatedOverlay, 0, 0, width, height);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = options.blendMode ?? 'source-over';
  ctx.globalAlpha = options.opacity ?? 0.9;
  ctx.drawImage(isolatedOverlay, 0, 0, width, height);
  ctx.restore();

  if (options.watermarkEnabled) {
    ctx.save();
    const fontSize = Math.max(12, Math.round(width * 0.024));
    ctx.font = `600 ${fontSize}px sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 4;
    ctx.fillText('Powered by Giso AI', 16, height - 16);
    ctx.restore();
  }
  return outputCanvas;
}

export async function executeClientComposite(
  baseSrc: string,
  generatedSrc: string,
  features: FeatureLandmarks,
  serviceTarget: ServiceTarget,
  options?: CompositeOptions,
): Promise<string> {
  const [baseImg, generatedImg] = await Promise.all([loadImage(baseSrc), loadImage(generatedSrc)]);
  const mask = createDualStageFeatheredMask(baseImg.width, baseImg.height, features, serviceTarget, {
    featherRadius: options?.featherRadius,
  });
  return applyPhotorealisticHardComposite(baseImg, generatedImg, mask, features, options)
    .toDataURL('image/jpeg', 0.94);
}
