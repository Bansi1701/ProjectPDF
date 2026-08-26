/**
 * Scan to PDF — the worker half.
 *
 * The camera lives on the main thread: there is no `navigator.mediaDevices`,
 * no `<video>` and no DOM in here. The capture UI shoots a frame, encodes it,
 * and hands this module the same `InputFile[]` every other tool receives. Two
 * reasons for bytes rather than `ImageBitmap`, even though a bitmap is
 * transferable:
 *
 *  1. The permission-denied fallback is `<input type="file" capture>`, which
 *     yields a `File`. Taking bytes means the camera path and the fallback path
 *     are the same path, and the request travels through `postMessage(request,
 *     payload.map((f) => f.bytes))` unchanged.
 *  2. A capture UI holds every shot until the user presses Done. Twenty
 *     `ImageBitmap`s is twenty full-resolution surfaces pinned in memory —
 *     roughly 300 MB for a modern phone sensor. Twenty JPEGs is about 8 MB, and
 *     bytes cannot be accidentally `close()`d out from under the retake button.
 *
 * What this does that "photograph the page and embed it" does not: find the
 * sheet of paper inside the frame, remove the perspective so it is a rectangle
 * again, and flatten the lighting so the shadow of your own hand is not baked
 * into the document. The last step is the one people notice — a phone photo of
 * a page is legible on the phone and a grey smear once printed.
 *
 * Nothing here reaches a network. The frames are document content under the
 * project's privacy rule, so they are decoded, processed and encoded in this
 * worker and nowhere else.
 */
import { MAX_CANVAS_PIXELS, imagesToPdf } from './images';
import type { InputFile, OpResult, PageSize } from './types';

/* ------------------------------------------------------------------ *
 * Types the capture UI needs
 * ------------------------------------------------------------------ */

/**
 * How the page is rendered once it has been straightened.
 *
 * `text` is the scanner default and the reason this tool exists. `grey` and
 * `colour` exist because Sauvola binarisation is *wrong* for pictorial content
 * (see the note on `sauvola` below) and a receipt with a logo, or a page with a
 * photograph on it, needs the greys kept.
 */
export type ScanMode = 'text' | 'grey' | 'colour';

export interface Point {
  x: number;
  y: number;
}

/** The four corners of a detected page, clockwise from top-left. */
export type Quad = readonly [Point, Point, Point, Point];

export interface QuadDetection {
  quad: Quad;
  /**
   * 0–1. How strongly the four candidate edges sit on real intensity edges in
   * the frame. Below `MIN_CONFIDENCE` the quad is discarded and the whole frame
   * is used instead.
   */
  confidence: number;
}

/**
 * A bare pixel buffer. `ImageData` satisfies this structurally, which is the
 * point: every function below that touches pixels takes and returns one of
 * these, so the entire pipeline runs — and can be tested — without a canvas.
 * Only decode, resample and encode need `OffscreenCanvas`.
 */
export interface ImageLike {
  /**
   * Spelled with its buffer type because `ImageData` is
   * `Uint8ClampedArray<ArrayBuffer>` — the bare `Uint8ClampedArray` widens to
   * `ArrayBufferLike`, which includes `SharedArrayBuffer` and so will not go
   * back into an `ImageData` constructor. This project cannot have a
   * `SharedArrayBuffer` anyway; cross-origin isolation is off by policy.
   */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Compute budget
 * ------------------------------------------------------------------ */

/**
 * Detection runs on a copy no larger than this on its long edge.
 *
 * A current phone shoots 12 MP. Sobel, Otsu, a flood fill and a hull over 12
 * million pixels is several seconds of main-thread-equivalent work per page,
 * and it buys nothing: a page edge located to ±1 px at 1024 is ±4 px at 4032,
 * which after bilinear unwarp is below what the eye or the paper can resolve.
 * 1024 keeps the analysis pass around 0.7 MP and well under 100 ms.
 */
const ANALYSIS_MAX_EDGE = 1024;

/**
 * The resolution the unwarp *samples from*.
 *
 * Sampling a 4032 px source into a 2200 px output with bilinear taps is point
 * sampling with extra steps: it aliases, and text picks up the shimmer. So the
 * frame is first resampled down to a little over the output size by the
 * browser's own image scaler, which box-filters properly, and the unwarp reads
 * from that. It also bounds the ImageData to about 20 MB per frame.
 */
const WORK_MAX_EDGE = 2600;

/**
 * A4 at 200 DPI is 1654 × 2339. That is comfortably past what a phone camera
 * actually resolves through a page's worth of field, and it is the resolution
 * at which OCR and printing both stop improving. Cap the long edge here and the
 * area at the shared canvas ceiling.
 */
const OUTPUT_MAX_EDGE = 2200;

/* ------------------------------------------------------------------ *
 * Detection thresholds
 * ------------------------------------------------------------------ */

/** Below this the quad is not believed and the frame is kept whole. */
const MIN_CONFIDENCE = 0.22;

/** A page that fills less than this much of the frame is probably not the page. */
const MIN_AREA_FRACTION = 0.1;

/** At this much the "page" is the whole frame and unwarping it is a no-op. */
const MAX_AREA_FRACTION = 0.995;

/**
 * A rectangle seen through a normal phone lens at a normal distance keeps its
 * corners near square. Anything outside this is a shadow, a table edge, or two
 * objects the mask has fused together.
 */
const MIN_CORNER_DEGREES = 50;
const MAX_CORNER_DEGREES = 132;

/** Widest and narrowest page worth believing — a 1:6 sliver is a table edge. */
const MAX_ASPECT = 6;

/** Deskew hunts within this much of upright. Beyond it, the user turned the page. */
const MAX_DESKEW_DEGREES = 12;

/* ------------------------------------------------------------------ *
 * Pixel primitives
 * ------------------------------------------------------------------ */

/** Rec. 601 luma. Perceptual weighting matters here — ink is rarely neutral. */
function toGrey(image: ImageLike): Uint8ClampedArray {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return out;
}

/**
 * Summed-area table, one row and column bigger than the image.
 *
 * Every local statistic below — the Sauvola window, the illumination estimate,
 * the pre-detection blur — is a box mean, and a summed-area table makes a box
 * mean cost four lookups no matter how large the box is. Without it the
 * illumination estimate alone (a window an eighth of the page wide) would be
 * the slowest thing in the tool.
 */
function integral(src: ArrayLike<number>, width: number, height: number): Float64Array {
  const stride = width + 1;
  const out = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += src[y * width + x];
      out[(y + 1) * stride + x + 1] = out[y * stride + x + 1] + row;
    }
  }
  return out;
}

/** Sum over the inclusive box [x0,x1] × [y0,y1], already clamped by the caller. */
function boxSum(
  table: Float64Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  return (
    table[(y1 + 1) * stride + x1 + 1] -
    table[y0 * stride + x1 + 1] -
    table[(y1 + 1) * stride + x0] +
    table[y0 * stride + x0]
  );
}

/** Sobel gradient magnitude. Border pixels are left at zero. */
function gradient(grey: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = grey[i - width - 1];
      const tc = grey[i - width];
      const tr = grey[i - width + 1];
      const ml = grey[i - 1];
      const mr = grey[i + 1];
      const bl = grey[i + width - 1];
      const bc = grey[i + width];
      const br = grey[i + width + 1];
      const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
      const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** Otsu's threshold: the split maximising between-class variance. */
function otsu(values: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i += 1) hist[values[i] | 0] += 1;

  const total = values.length;
  let weighted = 0;
  for (let t = 0; t < 256; t += 1) weighted += t * hist[t];

  let sumBelow = 0;
  let countBelow = 0;
  let best = -1;
  let threshold = 127;

  for (let t = 0; t < 256; t += 1) {
    countBelow += hist[t];
    if (countBelow === 0) continue;
    const countAbove = total - countBelow;
    if (countAbove === 0) break;

    sumBelow += t * hist[t];
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (weighted - sumBelow) / countAbove;
    const between = countBelow * countAbove * (meanBelow - meanAbove) ** 2;

    if (between > best) {
      best = between;
      threshold = t;
    }
  }

  return threshold;
}

/** Value at a given rank of the sorted data, without sorting the whole array. */
function percentile(values: Float32Array, fraction: number): number {
  let max = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i];
  if (max <= 0) return 0;

  const buckets = 512;
  const hist = new Int32Array(buckets);
  for (let i = 0; i < values.length; i += 1) {
    hist[Math.min(buckets - 1, ((values[i] / max) * buckets) | 0)] += 1;
  }

  const target = values.length * fraction;
  let seen = 0;
  for (let b = 0; b < buckets; b += 1) {
    seen += hist[b];
    if (seen >= target) return ((b + 0.5) / buckets) * max;
  }
  return max;
}

/* ------------------------------------------------------------------ *
 * Page detection
 * ------------------------------------------------------------------ */

/**
 * Largest 4-connected run of set pixels, returned as its per-row extremes.
 *
 * Only the extremes are kept because the convex hull of a region is exactly the
 * convex hull of its row extremes: any pixel strictly between the leftmost and
 * rightmost pixel of its own row lies on the segment joining them, so it can
 * never be a hull vertex. That turns "collect the boundary" from a contour
 * trace into two numbers per row.
 */
function largestBlob(
  mask: Uint8Array,
  width: number,
  height: number
): { points: Point[]; area: number } | null {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const minX = new Int32Array(height);
  const maxX = new Int32Array(height);
  const bestMinX = new Int32Array(height);
  const bestMaxX = new Int32Array(height);

  let bestArea = 0;
  let bestTop = 0;
  let bestBottom = -1;

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || seen[start] === 1) continue;

    minX.fill(width);
    maxX.fill(-1);

    let top = height;
    let bottom = -1;
    let area = 0;
    let top_ = 0;
    stack[top_++] = start;
    seen[start] = 1;

    while (top_ > 0) {
      const i = stack[--top_];
      const y = (i / width) | 0;
      const x = i - y * width;

      area += 1;
      if (x < minX[y]) minX[y] = x;
      if (x > maxX[y]) maxX[y] = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;

      if (x > 0 && mask[i - 1] === 1 && seen[i - 1] === 0) {
        seen[i - 1] = 1;
        stack[top_++] = i - 1;
      }
      if (x + 1 < width && mask[i + 1] === 1 && seen[i + 1] === 0) {
        seen[i + 1] = 1;
        stack[top_++] = i + 1;
      }
      if (y > 0 && mask[i - width] === 1 && seen[i - width] === 0) {
        seen[i - width] = 1;
        stack[top_++] = i - width;
      }
      if (y + 1 < height && mask[i + width] === 1 && seen[i + width] === 0) {
        seen[i + width] = 1;
        stack[top_++] = i + width;
      }
    }

    if (area > bestArea) {
      bestArea = area;
      bestTop = top;
      bestBottom = bottom;
      bestMinX.set(minX);
      bestMaxX.set(maxX);
    }
  }

  if (bestBottom < bestTop) return null;

  const points: Point[] = [];
  for (let y = bestTop; y <= bestBottom; y += 1) {
    if (bestMaxX[y] < 0) continue;
    points.push({ x: bestMinX[y], y });
    if (bestMaxX[y] !== bestMinX[y]) points.push({ x: bestMaxX[y], y });
  }

  return { points, area: bestArea };
}

const cross = (o: Point, a: Point, b: Point): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Andrew's monotone chain. Returns the hull without its repeated first point. */
function convexHull(points: Point[]): Point[] {
  if (points.length < 4) return points.slice();

  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const build = (source: Point[]): Point[] => {
    const chain: Point[] = [];
    for (const point of source) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };

  return [...build(sorted), ...build(sorted.reverse())];
}

/**
 * Drop hull vertices until at most `limit` remain, always removing the one
 * whose removal loses the least area.
 *
 * This exists purely to bound the corner search below. Douglas–Peucker would do
 * the same job but needs an epsilon tuned to the image scale, and a wrong
 * epsilon silently collapses a real corner; "remove the cheapest vertex" needs
 * no tuning at all.
 */
function simplifyHull(hull: Point[], limit: number): Point[] {
  const points = hull.slice();
  while (points.length > limit) {
    let victim = 0;
    let least = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const previous = points[(i - 1 + points.length) % points.length];
      const next = points[(i + 1) % points.length];
      const loss = Math.abs(cross(previous, points[i], next));
      if (loss < least) {
        least = loss;
        victim = i;
      }
    }
    points.splice(victim, 1);
  }
  return points;
}

const polygonArea = (points: Point[]): number => {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
};

/**
 * The maximum-area quadrilateral inscribed in the hull.
 *
 * A sheet of paper *is* a quadrilateral, so its hull is that quadrilateral plus
 * the noise the mask picked up along each side. The largest quad you can
 * inscribe in such a hull has its vertices at the four true corners — noise
 * only ever cuts a corner off, never adds area. With the hull capped at 24
 * vertices the exhaustive search is about ten thousand shoelace evaluations.
 */
function largestQuad(hull: Point[]): Point[] | null {
  if (hull.length < 4) return null;
  if (hull.length === 4) return hull.slice();

  const n = hull.length;
  let best: Point[] | null = null;
  let bestArea = 0;

  for (let i = 0; i < n - 3; i += 1) {
    for (let j = i + 1; j < n - 2; j += 1) {
      for (let k = j + 1; k < n - 1; k += 1) {
        for (let l = k + 1; l < n; l += 1) {
          const candidate = [hull[i], hull[j], hull[k], hull[l]];
          const area = polygonArea(candidate);
          if (area > bestArea) {
            bestArea = area;
            best = candidate;
          }
        }
      }
    }
  }

  return best;
}

/**
 * Put four corners in a known order: clockwise on screen, starting top-left.
 *
 * Sorting by angle about the centroid rather than by x+y and y−x, because the
 * sum/difference trick silently mislabels a page rotated near 45° — which is
 * exactly the page a scanner most needs to fix.
 */
function orderCorners(points: Point[]): Quad {
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;

  // Screen y grows downwards, so ascending atan2 walks clockwise as seen.
  const ring = points
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  let start = 0;
  let least = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const corner = ring[i].x + ring[i].y;
    if (corner < least) {
      least = corner;
      start = i;
    }
  }

  return [ring[start], ring[(start + 1) % 4], ring[(start + 2) % 4], ring[(start + 3) % 4]] as Quad;
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Carry a quad between two copies of the same frame scaled about the origin. */
export const scaleQuad = (quad: Quad, factor: number): Quad =>
  [
    { x: quad[0].x * factor, y: quad[0].y * factor },
    { x: quad[1].x * factor, y: quad[1].y * factor },
    { x: quad[2].x * factor, y: quad[2].y * factor },
    { x: quad[3].x * factor, y: quad[3].y * factor },
  ] as Quad;

/** Every interior angle within the plausible range, and no reflex vertex. */
function plausibleShape(quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const previous = quad[(i + 3) % 4];
    const current = quad[i];
    const next = quad[(i + 1) % 4];

    const turn = cross(previous, current, next);
    if (turn === 0) return false;
    const way = turn > 0 ? 1 : -1;
    if (sign === 0) sign = way;
    else if (sign !== way) return false; // reflex corner: not convex

    const ax = previous.x - current.x;
    const ay = previous.y - current.y;
    const bx = next.x - current.x;
    const by = next.y - current.y;
    const degrees =
      (Math.acos(
        Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by))))
      ) *
        180) /
      Math.PI;

    if (degrees < MIN_CORNER_DEGREES || degrees > MAX_CORNER_DEGREES) return false;
  }

  const width = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const height = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
  if (width < 8 || height < 8) return false;

  const aspect = width / height;
  return aspect <= MAX_ASPECT && aspect >= 1 / MAX_ASPECT;
}

/**
 * Ridge-to-ambient ratio a boundary must clear to count as a real page edge.
 *
 * Tuned against the failure it exists to stop: on a frame of pure sensor noise
 * the ridge search below scores about 1.7, because taking the strongest of five
 * neighbouring samples inflates any noisy field by roughly that much. A genuine
 * paper-to-desk step scores in the tens. 2.5 sits in the empty ground between.
 */
const MIN_EDGE_CONTRAST = 2.5;

/**
 * How much of a real intensity edge each side of the quad actually sits on.
 *
 * This is the check that stops the tool confidently unwarping a shadow. The
 * mask that produced the quad only knows about brightness; the gradient field
 * knows about boundaries. If the two agree along all four sides, there is a
 * physical edge there. The perpendicular ±2 px search is because a Sobel ridge
 * is a couple of pixels wide and the mask boundary lands on one shoulder of it.
 *
 * Two numbers come back, because one is not enough. `support` — the ridge
 * strength against the frame's own strongest edges — says the boundary is
 * sharp, but on a frame that is *entirely* edges (noise, gravel, a patterned
 * tablecloth) everything is sharp and support alone happily certifies a
 * quadrilateral drawn through the middle of nothing. `contrast` compares the
 * ridge to the gradient 8 px either side of it, which is the property that
 * actually distinguishes a boundary from a texture: paper is flat and a desk is
 * flat, so a real page edge is a spike between two calm regions.
 */
function edgeConfidence(
  quad: Quad,
  edges: Float32Array,
  width: number,
  height: number,
  scale: number
): { support: number; contrast: number } {
  const nowhere = { support: 0, contrast: 0 };
  if (scale <= 0) return nowhere;

  const at = (x: number, y: number): number => {
    const px = Math.max(0, Math.min(width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(height - 1, Math.round(y)));
    return edges[py * width + px];
  };

  let support = 0;
  let ridge = 0;
  let ambient = 0;
  let samples = 0;

  for (let side = 0; side < 4; side += 1) {
    const from = quad[side];
    const to = quad[(side + 1) % 4];
    const length = distance(from, to);
    if (length < 2) return nowhere;

    const nx = -(to.y - from.y) / length;
    const ny = (to.x - from.x) / length;
    const steps = Math.max(8, Math.min(64, Math.round(length / 4)));

    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;

      let peak = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const value = at(x + nx * offset, y + ny * offset);
        if (value > peak) peak = value;
      }

      support += Math.min(1, peak / scale);
      ridge += peak;
      ambient += (at(x + nx * 8, y + ny * 8) + at(x - nx * 8, y - ny * 8)) / 2;
      samples += 1;
    }
  }

  if (samples === 0) return nowhere;
  return {
    support: support / samples,
    contrast: ambient <= 1e-6 ? Infinity : ridge / ambient,
  };
}

/** One candidate quad from one binarisation polarity, or null. */
function candidate(
  mask: Uint8Array,
  width: number,
  height: number,
  edges: Float32Array,
  scale: number
): QuadDetection | null {
  const blob = largestBlob(mask, width, height);
  if (!blob) return null;

  const fraction = blob.area / (width * height);
  if (fraction < MIN_AREA_FRACTION || fraction > MAX_AREA_FRACTION) return null;

  const quadPoints = largestQuad(simplifyHull(convexHull(blob.points), 24));
  if (!quadPoints) return null;

  const quad = orderCorners(quadPoints);
  if (!plausibleShape(quad)) return null;

  // The corner search may have cut into the blob; re-check against the frame.
  const quadFraction = polygonArea([...quad]) / (width * height);
  if (quadFraction < MIN_AREA_FRACTION || quadFraction > MAX_AREA_FRACTION) return null;

  const { support, contrast } = edgeConfidence(quad, edges, width, height, scale);
  if (contrast < MIN_EDGE_CONTRAST) return null;

  return { quad, confidence: support };
}

/**
 * Find the page in a frame, or return null and let the caller keep the photo.
 *
 * Pure: no canvas, no DOM. The capture UI on the main thread can call this on a
 * downscaled video frame to draw a live outline over the viewfinder.
 *
 * Both polarities are tried because the page is not reliably the brighter
 * thing — white paper on a white desk under a warm lamp routinely comes out
 * *darker* than its surroundings. Rather than guess, build a mask each way and
 * let the gradient confidence pick the winner.
 */
export function detectPageQuad(image: ImageLike): QuadDetection | null {
  const { width, height } = image;
  if (width < 32 || height < 32) return null;

  const grey = toGrey(image);

  // A 3×3 box blur before thresholding. Sensor noise at phone ISO speckles the
  // mask, and speckle costs the flood fill far more than the blur costs.
  const table = integral(grey, width, height);
  const stride = width + 1;
  const smooth = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      smooth[y * width + x] = boxSum(table, stride, x0, y0, x1, y1) / count;
    }
  }

  const edges = gradient(smooth, width, height);
  // Normalise the confidence against the frame's own strongest edges: an
  // absolute threshold would be meaningless across exposures.
  const scale = percentile(edges, 0.98);

  const threshold = otsu(smooth);
  const bright = new Uint8Array(width * height);
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < smooth.length; i += 1) {
    if (smooth[i] > threshold) bright[i] = 1;
    else dark[i] = 1;
  }

  const options = [
    candidate(bright, width, height, edges, scale),
    candidate(dark, width, height, edges, scale),
  ].filter((option): option is QuadDetection => option !== null);

  if (options.length === 0) return null;

  const best = options.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return best.confidence >= MIN_CONFIDENCE ? best : null;
}

/* ------------------------------------------------------------------ *
 * Perspective correction
 * ------------------------------------------------------------------ */

/**
 * The 8 coefficients of the homography carrying `from` onto `to`.
 *
 *   x = (a·u + b·v + c) / (g·u + h·v + 1)
 *   y = (d·u + e·v + f) / (g·u + h·v + 1)
 *
 * Four point pairs give eight equations; solve by Gaussian elimination with
 * partial pivoting. `from` is the *destination* rectangle and `to` the source
 * quad, because the unwarp walks output pixels and asks where each one came
 * from — the forward direction would leave holes.
 */
function homography(from: Quad, to: Quad): Float64Array | null {
  const m: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x: u, y: v } = from[i];
    const { x, y } = to[i];
    m.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    m.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }

  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-10) return null; // degenerate quad
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const lead = m[col][col];
    for (let c = col; c < 9; c += 1) m[col][c] /= lead;

    for (let row = 0; row < 8; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      if (factor === 0) continue;
      for (let c = col; c < 9; c += 1) m[row][c] -= factor * m[col][c];
    }
  }

  const out = new Float64Array(8);
  for (let i = 0; i < 8; i += 1) out[i] = m[i][8];
  return out;
}

/** Bilinear tap with edge clamping. */
function sample(image: ImageLike, x: number, y: number, out: Uint8ClampedArray, at: number): void {
  const { data, width, height } = image;
  const cx = Math.max(0, Math.min(width - 1.001, x));
  const cy = Math.max(0, Math.min(height - 1.001, y));

  const x0 = cx | 0;
  const y0 = cy | 0;
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  for (let c = 0; c < 3; c += 1) {
    const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
    const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
    out[at + c] = top + (bottom - top) * fy;
  }
  out[at + 3] = 255;
}

/**
 * The size the straightened page should be.
 *
 * The longer of each opposing pair of sides, because the far edge of a tilted
 * page is foreshortened and the near edge is not. This is the usual estimate
 * and it is not exact: recovering the true aspect ratio needs the camera's
 * focal length, which the homography alone does not determine. In practice it
 * is off by a percent or two on a normal desk photo — invisible on the page,
 * and `pageSize: 'a4'` re-fits the result anyway.
 */
function unwarpSize(quad: Quad): { width: number; height: number } {
  const width = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const height = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));

  let scale = Math.min(1, OUTPUT_MAX_EDGE / Math.max(width, height));
  if (width * scale * height * scale > MAX_CANVAS_PIXELS) {
    scale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
  }

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Perspective-correct `quad` out of `image` into an upright rectangle. */
export function unwarp(image: ImageLike, quad: Quad): ImageLike | null {
  const { width, height } = unwarpSize(quad);

  const rect: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  const h = homography(rect, quad);
  if (!h) return null;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let v = 0; v < height; v += 1) {
    const vy = v + 0.5;
    for (let u = 0; u < width; u += 1) {
      const ux = u + 0.5;
      const w = h[6] * ux + h[7] * vy + 1;
      sample(
        image,
        (h[0] * ux + h[1] * vy + h[2]) / w,
        (h[3] * ux + h[4] * vy + h[5]) / w,
        data,
        (v * width + u) * 4
      );
    }
  }

  return { data, width, height };
}

/* ------------------------------------------------------------------ *
 * Deskew — the fallback when no page was found
 * ------------------------------------------------------------------ */

/**
 * The rotation, in radians, that makes the text lines horizontal.
 *
 * Projection-profile scoring rather than a Hough transform: rotate the ink
 * coordinates through each candidate angle, sum ink per output row, and score
 * the profile by the squared differences between neighbouring rows. At the true
 * angle every line of text piles into one row and the gaps stay empty, so the
 * profile is a comb and the score spikes. Hough would find the same answer
 * through an accumulator an order of magnitude larger, and this only has to
 * search ±12°.
 *
 * Returns 0 unless the best angle beats upright by a clear margin — rotating a
 * page on the strength of noise is worse than leaving it alone.
 */
export function deskewAngle(image: ImageLike): number {
  const grey = toGrey(image);
  const { width, height } = image;

  // Subsample to about 600 px on the long edge. Line *spacing* is what is being
  // measured, and that survives decimation far below stroke width.
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 600));
  const sw = Math.floor(width / step);
  const sh = Math.floor(height / step);
  if (sw < 16 || sh < 16) return 0;

  const small = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) small[y * sw + x] = grey[y * step * width + x * step];
  }

  // Ink is what is dark *relative to its own surroundings*, not dark in
  // absolute terms. A global threshold looks reasonable until the fallback
  // fires on a photo that still has the desk in it: the desk is darker than the
  // paper, Otsu puts the split between them, and the entire background is
  // labelled ink. Its row profile is a smooth slab that swamps the text, and
  // the measurement collapses to zero. Sauvola's rule ignores any flat region,
  // dark or light, so only real strokes are counted.
  const squares = new Float64Array(small.length);
  for (let i = 0; i < small.length; i += 1) squares[i] = small[i] * small[i];
  const sums = integral(small, sw, sh);
  const sumSquares = integral(squares, sw, sh);
  const stride = sw + 1;
  const radius = Math.max(6, Math.round(Math.min(sw, sh) / 32));

  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < sh; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(sh - 1, y + radius);
    for (let x = 0; x < sw; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(sw - 1, x + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = boxSum(sums, stride, x0, y0, x1, y1) / count;
      const variance = boxSum(sumSquares, stride, x0, y0, x1, y1) / count - mean * mean;
      const deviation = Math.sqrt(Math.max(0, variance));
      if (small[y * sw + x] < mean * (1 + SAUVOLA_K * (deviation / SAUVOLA_R - 1))) {
        xs.push(x * step);
        ys.push(y * step);
      }
    }
  }

  if (xs.length < 200) return 0;

  const cx = width / 2;
  const cy = height / 2;
  const rows = Math.ceil(height / step) + 2;
  const profile = new Float64Array(rows);

  const score = (radians: number): number => {
    profile.fill(0);
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    for (let i = 0; i < xs.length; i += 1) {
      const row = ((-(xs[i] - cx) * sin + (ys[i] - cy) * cos + cy) / step) | 0;
      if (row >= 0 && row < rows) profile[row] += 1;
    }
    let sum = 0;
    for (let r = 1; r < rows; r += 1) sum += (profile[r] - profile[r - 1]) ** 2;
    return sum;
  };

  const upright = score(0);
  let best = upright;
  let bestAngle = 0;

  const limit = (MAX_DESKEW_DEGREES * Math.PI) / 180;
  const stepAngle = (0.25 * Math.PI) / 180;
  for (let a = -limit; a <= limit + 1e-9; a += stepAngle) {
    const value = score(a);
    if (value > best) {
      best = value;
      bestAngle = a;
    }
  }

  return best > upright * 1.15 ? bestAngle : 0;
}

/** Rotate about the centre onto a canvas large enough to hold the corners. */
export function rotateImage(image: ImageLike, radians: number): ImageLike {
  if (radians === 0) return image;

  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const width = Math.ceil(image.width * cos + image.height * sin);
  const height = Math.ceil(image.width * sin + image.height * cos);

  const data = new Uint8ClampedArray(width * height * 4);
  // Paper, not black: the corners the rotation exposes have to look like page.
  data.fill(255);

  const cs = Math.cos(-radians);
  const sn = Math.sin(-radians);
  const cx = width / 2;
  const cy = height / 2;
  const sx = image.width / 2;
  const sy = image.height / 2;

  for (let y = 0; y < height; y += 1) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - cx;
      const ox = dx * cs - dy * sn + sx;
      const oy = dx * sn + dy * cs + sy;
      if (ox < 0 || oy < 0 || ox >= image.width || oy >= image.height) continue;
      sample(image, ox - 0.5, oy - 0.5, data, (y * width + x) * 4);
    }
  }

  return { data, width, height };
}

/* ------------------------------------------------------------------ *
 * Enhancement
 * ------------------------------------------------------------------ */

/** Sauvola's sensitivity. Lower keeps faint pencil; higher whitens harder. */
const SAUVOLA_K = 0.18;

/** Sauvola's dynamic range constant, standard for 8-bit input. */
const SAUVOLA_R = 128;

/**
 * Sauvola adaptive binarisation.
 *
 *   T(x,y) = m(x,y) · [ 1 + k · ( s(x,y)/R − 1 ) ]
 *
 * Why this and not a plain local-mean threshold (Bradley/Wellner): on blank
 * paper the local mean *is* the paper, so half the noise falls either side of
 * it and the margin fills with salt-and-pepper speckle. Sauvola scales the
 * threshold by the local standard deviation, which is near zero on blank paper
 * — so T drops well below the mean and the whole region stays white — and rises
 * where a stroke creates real local contrast, so ink is still caught. That
 * single term is the difference between a clean scan and a dirty one.
 *
 * Why not Niblack: Niblack's `m + k·s` has the same collapse in reverse and
 * produces the classic noisy background. Why not global Otsu: one threshold
 * cannot serve a page that is lit from one side, which is every phone photo.
 *
 * The window is scaled to the image rather than fixed at 15 px, because 15 px
 * at 200 DPI is thinner than the stroke of a heading, and a window narrower
 * than a stroke hollows the stroke out into an outline.
 */
export function sauvola(image: ImageLike, k = SAUVOLA_K): ImageLike {
  const { width, height } = image;
  const grey = toGrey(image);

  const radius = Math.max(7, Math.round(Math.min(width, height) / 48));
  const stride = width + 1;

  const squares = new Float64Array(grey.length);
  for (let i = 0; i < grey.length; i += 1) squares[i] = grey[i] * grey[i];

  const sums = integral(grey, width, height);
  const sumSquares = integral(squares, width, height);

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);

      const mean = boxSum(sums, stride, x0, y0, x1, y1) / count;
      const variance = boxSum(sumSquares, stride, x0, y0, x1, y1) / count - mean * mean;
      const deviation = Math.sqrt(Math.max(0, variance));

      const threshold = mean * (1 + k * (deviation / SAUVOLA_R - 1));
      const value = grey[y * width + x] > threshold ? 255 : 0;

      const at = (y * width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = value;
      data[at + 3] = 255;
    }
  }

  return { data, width, height };
}

/** Where the flattened white point lands. Not 255 — leave the paper some texture. */
const FLAT_WHITE = 242;

/**
 * Shading correction: divide the image by an estimate of its own illumination.
 *
 * The estimate is a box mean over a window an eighth of the short edge across —
 * far wider than any glyph, so text averages out and what is left is the lamp,
 * the window and the shadow of the phone. Dividing by it removes the lighting
 * and keeps the greys, which is what a page with a photograph or a coloured
 * logo on it needs and what Sauvola would destroy.
 *
 * In colour, one gain is computed from the luma and applied to all three
 * channels, so the correction changes exposure without shifting hue.
 */
export function flattenIllumination(image: ImageLike, colour: boolean): ImageLike {
  const { data, width, height } = image;
  const grey = toGrey(image);

  const radius = Math.max(16, Math.round(Math.min(width, height) / 8));
  const stride = width + 1;
  const sums = integral(grey, width, height);

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);

      const background = Math.max(1, boxSum(sums, stride, x0, y0, x1, y1) / count);
      const gain = FLAT_WHITE / background;

      const i = y * width + x;
      const at = i * 4;
      if (colour) {
        out[at] = data[at] * gain;
        out[at + 1] = data[at + 1] * gain;
        out[at + 2] = data[at + 2] * gain;
      } else {
        const value = grey[i] * gain;
        out[at] = out[at + 1] = out[at + 2] = value;
      }
      out[at + 3] = 255;
    }
  }

  return { data: out, width, height };
}

/* ------------------------------------------------------------------ *
 * Canvas glue — the only part that needs a browser
 * ------------------------------------------------------------------ */

function surface(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser would not give us a drawing surface to scan into.');
  return ctx;
}

/** Draw a bitmap down to at most `maxEdge` and read the pixels back. */
function resample(bitmap: ImageBitmap, maxEdge: number): ImageLike {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = surface(width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  ctx.canvas.width = ctx.canvas.height = 0;
  return image;
}

/** Returns the raw buffer, which is what `InputFile` takes on the way to the PDF. */
async function encode(image: ImageLike, type: string, quality?: number): Promise<ArrayBuffer> {
  const ctx = surface(image.width, image.height);
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const blob = await ctx.canvas.convertToBlob(
    quality === undefined ? { type } : { type, quality }
  );
  ctx.canvas.width = ctx.canvas.height = 0;
  return blob.arrayBuffer();
}

/* ------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------ */

/** What happened to one frame, so the receipt can be specific. */
interface FrameOutcome {
  bytes: ArrayBuffer;
  extension: 'png' | 'jpg';
  detected: boolean;
  deskewed: number;
}

async function processFrame(
  file: InputFile,
  mode: ScanMode,
  detect: boolean
): Promise<FrameOutcome> {
  const bitmap = await createImageBitmap(new Blob([file.bytes as BlobPart]));

  let work: ImageLike;
  let found: QuadDetection | null = null;
  try {
    work = resample(bitmap, WORK_MAX_EDGE);
    if (detect) {
      const analysis = resample(bitmap, ANALYSIS_MAX_EDGE);
      found = detectPageQuad(analysis);
      if (found) {
        // Detection ran on the small copy. Both copies are the same frame
        // scaled about the origin, so the corners carry over by the ratio of
        // the two widths.
        found = { ...found, quad: scaleQuad(found.quad, work.width / analysis.width) };
      }
    }
  } finally {
    bitmap.close();
  }

  let page = found ? unwarp(work, found.quad) : null;

  let deskewed = 0;
  if (!page) {
    // No page boundary, or a degenerate one. Keep the photograph — a scanner
    // that refuses is worse than one that hands back what you shot — and at
    // least straighten the text.
    // `deskewAngle` reports the tilt the page has; the correction is its
    // negation.
    const angle = deskewAngle(work);
    deskewed = (-angle * 180) / Math.PI;
    page = rotateImage(work, -angle);
  }

  const enhanced =
    mode === 'text' ? sauvola(page) : flattenIllumination(page, mode === 'colour');

  // Bilevel output is all runs, so PNG beats JPEG on both size and fidelity;
  // continuous tone is the other way round.
  const text = mode === 'text';
  const bytes = await encode(enhanced, text ? 'image/png' : 'image/jpeg', text ? undefined : 0.88);

  return { bytes, extension: text ? 'png' : 'jpg', detected: found !== null, deskewed };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function scanToPdf(
  files: InputFile[],
  mode: ScanMode,
  pageSize: PageSize,
  detect: boolean
): Promise<OpResult> {
  if (files.length === 0) {
    return { ok: false, error: 'Take at least one photo of a page first.' };
  }

  const started = performance.now();

  // Captured up front: `imagesToPdf` will report the size of the *processed*
  // images, and the honest input figure is what the camera produced.
  const bytesIn = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

  const pages: InputFile[] = [];
  let detected = 0;
  let straightened = 0;
  let skew = 0;
  const failed: number[] = [];

  for (const [index, file] of files.entries()) {
    let outcome: FrameOutcome;
    try {
      outcome = await processFrame(file, mode, detect);
    } catch {
      failed.push(index + 1);
      continue;
    }

    if (outcome.detected) detected += 1;
    if (Math.abs(outcome.deskewed) >= 0.25) {
      straightened += 1;
      skew = Math.max(skew, Math.abs(outcome.deskewed));
    }

    pages.push({
      name: `scan-${String(index + 1).padStart(2, '0')}.${outcome.extension}`,
      bytes: outcome.bytes,
    });
  }

  if (pages.length === 0) {
    return {
      ok: false,
      error:
        'None of those photos could be opened. Try shooting them again, or pick JPG or PNG files instead.',
    };
  }

  // PDF assembly is `imagesToPdf`'s job and it already does it losslessly —
  // PNG and JPEG both go into the document byte-for-byte. Re-implementing page
  // boxes and placement here would only be a second copy to keep in step.
  const assembled = await imagesToPdf(pages, pageSize);
  if (!assembled.ok || !('files' in assembled)) return assembled;

  const notes: string[] = [];
  if (detected > 0) {
    notes.push(
      `Found the page edges in ${plural(detected, 'photo')} and corrected the perspective, so ${detected === 1 ? 'it is' : 'they are'} a rectangle again rather than a trapezium.`
    );
  }
  const kept = pages.length - detected;
  if (kept > 0) {
    notes.push(
      detect
        ? `Could not find a page boundary in ${plural(kept, 'photo')}, so the whole frame was kept rather than nothing. Shooting against a background a different shade from the paper is what helps most.`
        : `Edge detection was off, so ${kept === 1 ? 'the photo was' : `${kept} photos were`} kept whole.`
    );
  }
  if (straightened > 0) {
    notes.push(
      `Straightened ${plural(straightened, 'page')} by up to ${skew.toFixed(1)}°, measured from the slant of the text lines.`
    );
  }
  notes.push(
    mode === 'text'
      ? 'Each page was thresholded locally (Sauvola), which removes uneven lighting and shadows and leaves black text on white. Photographs and coloured logos will come out as flat black — use Greyscale or Colour for those.'
      : 'The lighting was flattened by dividing each page by its own illumination, so shadows go without the greys going with them.'
  );
  if (failed.length > 0) {
    notes.push(`Skipped ${plural(failed.length, 'photo')} (${failed.join(', ')}) that could not be decoded.`);
  }
  notes.push('Every frame was processed in this tab. Nothing was uploaded.');

  const [document] = assembled.files;
  if (!document) {
    return { ok: false, error: 'The pages were processed but no PDF came back. Please report this.' };
  }

  return {
    ok: true,
    files: [{ name: 'scan.pdf', bytes: document.bytes, type: 'application/pdf' }],
    bytesIn,
    bytesOut: assembled.bytesOut,
    pages: assembled.pages,
    durationMs: performance.now() - started,
    summary: `${plural(assembled.pages, 'scanned page')}${detected > 0 ? `, ${detected} perspective-corrected` : ''}`,
    notes,
  };
}
