/**
 * Server-side image-processing orchestrator.
 *
 * This module is not a generative model. For eyebrows it finds a conservative
 * two-brow ROI, asks the existing provider to edit that registered crop, checks
 * edge drift, and pastes only feathered target regions into the oriented source.
 * Any analysis/registration failure falls back to the existing full-image path.
 */

import sharp from 'sharp';
import type { ParsedImage } from '@/providers/http';
import { parseDataUri } from '@/providers/http';
import type { AttemptLog, Provider, ProviderInput } from '@/providers/types';

export type AgentService = 'eyebrows' | 'lips' | 'eyeliner' | 'removal';

export interface ImageAgentRequest {
  service: AgentService;
  styleKey: string;
  prompt: string;
  image: ParsedImage;
  referenceImage?: ParsedImage;
}

export interface AgentProviderResult {
  provider: Provider;
  image: string;
  attempts: AttemptLog[];
  ms: number;
}

export interface ImageAgentResult extends AgentProviderResult {
  agent: {
    applied: boolean;
    reason: string;
    confidence?: number;
    qa?: 'accepted' | 'rejected' | 'not-run';
  };
}

export type ProviderRunner = (input: ProviderInput) => Promise<AgentProviderResult>;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface BrowRegion {
  bbox: Rect;
  center: { x: number; y: number };
}

interface BrowAnalysis {
  width: number;
  height: number;
  roi: Rect;
  left: BrowRegion;
  right: BrowRegion;
  confidence: number;
  normalizedJpeg: Buffer;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dataUri(buffer: Buffer, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function rectAround(center: { x: number; y: number }, width: number, height: number, imageWidth: number, imageHeight: number): Rect {
  const left = clamp(Math.round(center.x - width / 2), 0, Math.max(0, imageWidth - 1));
  const top = clamp(Math.round(center.y - height / 2), 0, Math.max(0, imageHeight - 1));
  return {
    left,
    top,
    width: Math.max(1, Math.min(Math.round(width), imageWidth - left)),
    height: Math.max(1, Math.min(Math.round(height), imageHeight - top)),
  };
}

/**
 * Locate dark, brow-like ridges independently on each side of the upper central
 * face. This is deliberately conservative: low contrast/confidence disables the
 * ROI path instead of guessing geometry.
 */
export async function analyzeEyebrowGeometry(image: ParsedImage): Promise<BrowAnalysis | null> {
  const normalizedJpeg = await sharp(image.bytes).rotate().jpeg({ quality: 94 }).toBuffer();
  const metadata = await sharp(normalizedJpeg).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 160 || height < 160) return null;

  const analysisWidth = Math.min(384, width);
  const analysisHeight = Math.max(1, Math.round(height * analysisWidth / width));
  const { data, info } = await sharp(normalizedJpeg)
    .resize(analysisWidth, analysisHeight, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Find a connected skin-colour region before looking for dark brow ridges.
  // This prevents hair/background edges from winning the darkness projection.
  const pixelCount = info.width * info.height;
  const skin = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * info.channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const cb = 128 - 0.169 * r - 0.331 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.419 * g - 0.081 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (r > 55 && g > 35 && b > 20 && r > g * 1.015 && cr >= 132 && cr <= 184 && cb >= 72 && cb <= 137 && chroma > 12) {
      skin[index] = 1;
    }
  }
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let faceBounds: Rect | null = null;
  let faceScore = 0;
  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (!skin[seed] || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    let minX = info.width;
    let maxX = 0;
    let minY = info.height;
    let maxY = 0;
    let count = 0;
    while (head < tail) {
      const current = queue[head++];
      const x = current % info.width;
      const y = Math.floor(current / info.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      count += 1;
      const neighbours = [current - 1, current + 1, current - info.width, current + info.width];
      for (const next of neighbours) {
        if (next < 0 || next >= pixelCount || visited[next] || !skin[next]) continue;
        const nextX = next % info.width;
        if (Math.abs(nextX - x) > 1) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    if (count < pixelCount * 0.008 || componentWidth < info.width * 0.1 || componentHeight < info.height * 0.1) continue;
    if (componentWidth > info.width * 0.75 || componentHeight > info.height * 0.82) continue;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centrality = 1 - Math.min(1, Math.hypot(centerX / info.width - 0.5, centerY / info.height - 0.43));
    const fill = count / (componentWidth * componentHeight);
    const score = count * (0.55 + centrality * 0.3 + fill * 0.15);
    if (score > faceScore) {
      faceScore = score;
      faceBounds = { left: minX, top: minY, width: componentWidth, height: componentHeight };
    }
  }
  if (!faceBounds) return null;
  const faceCenterX = faceBounds.left + faceBounds.width / 2;
  const browY0 = faceBounds.top + faceBounds.height * 0.12;
  const browY1 = faceBounds.top + faceBounds.height * 0.48;
  const grayAt = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
  };

  const findSide = (xStart: number, xEnd: number): { center: { x: number; y: number }; confidence: number } | null => {
    const x0 = clamp(Math.floor(xStart), 0, info.width - 1);
    const x1 = clamp(Math.ceil(xEnd), x0 + 1, info.width);
    const y0 = clamp(Math.floor(browY0), 0, info.height - 1);
    const y1 = clamp(Math.ceil(browY1), y0 + 1, info.height);
    let bestY = -1;
    let bestScore = 0;
    let regionMean = 0;
    let regionCount = 0;

    for (let y = y0; y < y1; y += 1) {
      let rowDarkness = 0;
      for (let x = x0; x < x1; x += 1) {
        const value = grayAt(x, y);
        regionMean += value;
        regionCount += 1;
        rowDarkness += 255 - value;
      }
      const score = rowDarkness / Math.max(1, x1 - x0);
      if (score > bestScore) {
        bestScore = score;
        bestY = y;
      }
    }
    if (bestY < 0 || !regionCount) return null;
    regionMean /= regionCount;
    const threshold = clamp(regionMean - 24, 35, 185);
    const band = Math.max(2, Math.round(info.height * 0.035));
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;
    let selected = 0;
    for (let y = Math.max(y0, bestY - band); y <= Math.min(y1 - 1, bestY + band); y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const value = grayAt(x, y);
        if (value < threshold) {
          const weight = threshold - value;
          weightedX += x * weight;
          weightedY += y * weight;
          totalWeight += weight;
          selected += 1;
        }
      }
    }
    if (selected < Math.max(8, (x1 - x0) * 0.1) || totalWeight <= 0) return null;
    const density = selected / Math.max(1, (x1 - x0) * (band * 2 + 1));
    const contrast = (bestScore - (255 - regionMean)) / 80;
    return {
      center: {
        x: weightedX / totalWeight * width / info.width,
        y: weightedY / totalWeight * height / info.height,
      },
      confidence: clamp(contrast * 0.65 + density * 0.8, 0, 1),
    };
  };

  const sideInset = faceBounds.width * 0.04;
  const centerGap = faceBounds.width * 0.025;
  const leftCandidate = findSide(faceBounds.left + sideInset, faceCenterX - centerGap);
  const rightCandidate = findSide(faceCenterX + centerGap, faceBounds.left + faceBounds.width - sideInset);
  if (!leftCandidate || !rightCandidate) return null;
  const verticalMismatch = Math.abs(leftCandidate.center.y - rightCandidate.center.y) / height;
  const separation = Math.abs(leftCandidate.center.x - rightCandidate.center.x) / width;
  const confidence = clamp(
    Math.min(leftCandidate.confidence, rightCandidate.confidence) - verticalMismatch * 1.6 + (separation > 0.18 ? 0.12 : -0.15),
    0,
    1,
  );
  if (confidence < 0.32) return null;

  const browWidth = clamp(separation * width * 0.72, width * 0.13, width * 0.3);
  const browHeight = clamp(browWidth * 0.34, height * 0.025, height * 0.11);
  const left = { center: leftCandidate.center, bbox: rectAround(leftCandidate.center, browWidth, browHeight, width, height) };
  const right = { center: rightCandidate.center, bbox: rectAround(rightCandidate.center, browWidth, browHeight, width, height) };
  const minX = Math.min(left.bbox.left, right.bbox.left);
  const maxX = Math.max(left.bbox.left + left.bbox.width, right.bbox.left + right.bbox.width);
  const minY = Math.min(left.bbox.top, right.bbox.top);
  const maxY = Math.max(left.bbox.top + left.bbox.height, right.bbox.top + right.bbox.height);
  const roiPaddingX = width * 0.045;
  const roiPaddingY = height * 0.055;
  const roiLeft = clamp(Math.floor(minX - roiPaddingX), 0, width - 1);
  const roiTop = clamp(Math.floor(minY - roiPaddingY), 0, height - 1);
  const roiRight = clamp(Math.ceil(maxX + roiPaddingX), roiLeft + 1, width);
  const roiBottom = clamp(Math.ceil(maxY + roiPaddingY), roiTop + 1, height);

  return {
    width,
    height,
    left,
    right,
    confidence,
    roi: { left: roiLeft, top: roiTop, width: roiRight - roiLeft, height: roiBottom - roiTop },
    normalizedJpeg,
  };
}

function geometryInstruction(analysis: BrowAnalysis): string {
  const relative = (region: BrowRegion) => ({
    x: (region.center.x - analysis.roi.left) / analysis.roi.width,
    y: (region.center.y - analysis.roi.top) / analysis.roi.height,
    width: region.bbox.width / analysis.roi.width,
    height: region.bbox.height / analysis.roi.height,
  });
  const left = relative(analysis.left);
  const right = relative(analysis.right);
  return ` ROI GEOMETRY: this input is a registered crop of the customer's own two-brow area. ` +
    `Approximate left target center (${left.x.toFixed(3)},${left.y.toFixed(3)}) size (${left.width.toFixed(3)},${left.height.toFixed(3)}); ` +
    `right target center (${right.x.toFixed(3)},${right.y.toFixed(3)}) size (${right.width.toFixed(3)},${right.height.toFixed(3)}). ` +
    `Preserve the crop dimensions and all skin/eyes outside these two targets pixel-aligned. Refine start, body, arch and tapered tail within these proportional targets; fill sparse gaps with locally matched strokes, never paste a complete stock brow.`;
}

async function meanEdgeDifference(original: Buffer, generated: Buffer, width: number, height: number): Promise<number> {
  const sampleWidth = Math.min(256, width);
  const sampleHeight = Math.max(1, Math.round(height * sampleWidth / width));
  const [a, b] = await Promise.all([
    sharp(original).resize(sampleWidth, sampleHeight, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(generated).resize(sampleWidth, sampleHeight, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
  ]);
  const edge = Math.max(2, Math.round(Math.min(sampleWidth, sampleHeight) * 0.08));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      if (x >= edge && x < sampleWidth - edge && y >= edge && y < sampleHeight - edge) continue;
      const offset = (y * sampleWidth + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        sum += Math.abs(a[offset + channel] - b[offset + channel]);
        count += 1;
      }
    }
  }
  return count ? sum / count : Number.POSITIVE_INFINITY;
}

async function registerBrowResult(analysis: BrowAnalysis, generated: ParsedImage): Promise<{ image: string; accepted: boolean }> {
  const originalRoi = await sharp(analysis.normalizedJpeg).extract(analysis.roi).jpeg({ quality: 94 }).toBuffer();
  const generatedRoi = await sharp(generated.bytes)
    .rotate()
    .resize(analysis.roi.width, analysis.roi.height, { fit: 'fill' })
    .jpeg({ quality: 94 })
    .toBuffer();
  const edgeDifference = await meanEdgeDifference(originalRoi, generatedRoi, analysis.roi.width, analysis.roi.height);
  if (!Number.isFinite(edgeDifference) || edgeDifference > 58) return { image: '', accepted: false };

  const localRect = (region: BrowRegion) => ({
    x: region.bbox.left - analysis.roi.left,
    y: region.bbox.top - analysis.roi.top,
    width: region.bbox.width,
    height: region.bbox.height,
  });
  const left = localRect(analysis.left);
  const right = localRect(analysis.right);
  const blur = clamp(Math.min(left.height, right.height) * 0.18, 1.5, 12);
  const maskSvg = Buffer.from(
    `<svg width="${analysis.roi.width}" height="${analysis.roi.height}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><filter id="b"><feGaussianBlur stdDeviation="${blur.toFixed(2)}"/></filter></defs>` +
    `<g fill="white" filter="url(#b)">` +
    `<ellipse cx="${left.x + left.width / 2}" cy="${left.y + left.height / 2}" rx="${left.width * 0.55}" ry="${left.height * 0.68}"/>` +
    `<ellipse cx="${right.x + right.width / 2}" cy="${right.y + right.height / 2}" rx="${right.width * 0.55}" ry="${right.height * 0.68}"/>` +
    `</g></svg>`,
  );
  const isolated = await sharp(generatedRoi)
    .composite([{ input: maskSvg, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const registered = await sharp(analysis.normalizedJpeg)
    .composite([{ input: isolated, left: analysis.roi.left, top: analysis.roi.top, blend: 'over' }])
    .jpeg({ quality: 94 })
    .toBuffer();
  return { image: dataUri(registered), accepted: true };
}

async function direct(
  request: ImageAgentRequest,
  runProvider: ProviderRunner,
  reason: string,
  prior?: AgentProviderResult,
): Promise<ImageAgentResult> {
  const result = await runProvider({
    prompt: request.prompt,
    image: request.image,
    referenceImage: request.referenceImage,
  });
  return {
    ...result,
    attempts: prior ? [...prior.attempts, ...result.attempts] : result.attempts,
    ms: prior ? prior.ms + result.ms : result.ms,
    agent: { applied: false, reason, qa: prior ? 'rejected' : 'not-run' },
  };
}

/** Entry point used by /api/generate. Only eyebrows take the advanced path. */
export async function runImageAgent(request: ImageAgentRequest, runProvider: ProviderRunner): Promise<ImageAgentResult> {
  if (request.service !== 'eyebrows') return direct(request, runProvider, 'service-uses-existing-path');

  let analysis: BrowAnalysis | null;
  try {
    analysis = await analyzeEyebrowGeometry(request.image);
  } catch (error) {
    console.error(`[IMAGE-AGENT] analysis fail-open | ${error instanceof Error ? error.message : String(error)}`);
    return direct(request, runProvider, 'analysis-error');
  }
  if (!analysis) return direct(request, runProvider, 'low-geometry-confidence');

  const roiBuffer = await sharp(analysis.normalizedJpeg).extract(analysis.roi).jpeg({ quality: 94 }).toBuffer();
  const roiDataUri = dataUri(roiBuffer);
  const roiImage: ParsedImage = {
    bytes: roiBuffer,
    mime: 'image/jpeg',
    extension: 'jpg',
    base64: roiBuffer.toString('base64'),
    dataUri: roiDataUri,
  };
  const generated = await runProvider({
    prompt: request.prompt + geometryInstruction(analysis),
    image: roiImage,
    referenceImage: request.referenceImage,
  });

  try {
    const parsed = parseDataUri(generated.image);
    if (!parsed) throw new Error('provider result is not an image data URI');
    const registered = await registerBrowResult(analysis, parsed);
    if (!registered.accepted) {
      console.error('[IMAGE-AGENT] QA rejected ROI drift; using full-image provider fallback');
      return direct(request, runProvider, 'qa-rejected-roi-drift', generated);
    }
    return {
      ...generated,
      image: registered.image,
      agent: { applied: true, reason: 'registered-eyebrow-roi', confidence: analysis.confidence, qa: 'accepted' },
    };
  } catch (error) {
    console.error(`[IMAGE-AGENT] registration fail-open | ${error instanceof Error ? error.message : String(error)}`);
    return direct(request, runProvider, 'registration-error', generated);
  }
}
