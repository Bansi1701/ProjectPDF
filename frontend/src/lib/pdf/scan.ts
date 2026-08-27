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
 * `colour` exist because binarisation is *wrong* for pictorial content: `text`
 * has exactly two output values, so a photograph on the page becomes a
 * halftone-ish patch of black and a coloured logo becomes a solid black shape.
 * A receipt with a logo, or a page with a picture on it, needs the greys, and
 * that is what those two modes keep.
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
   * 0–1. How strong the page boundary is against the strongest edges in the
   * frame — which is to say, against the ink on the page. It is a quality
   * reading, not the accept/reject decision: a genuine white sheet on a pale
   * desk scores about 0.1, because its boundary really is a tenth of the step
   * that its own text makes. What decides whether a quad comes back at all is
   * `MIN_EDGE_STRENGTH`, `MIN_EDGE_CONTRAST` and `MIN_EDGE_COVERAGE`, which do
   * not depend on the page's contents.
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
 * browser's own image scaler, which box-filters properly in native code, and
 * the unwarp reads from that. It also bounds the ImageData to about 20 MB per
 * frame.
 *
 * `unwarp` copes with minification on its own now, so this is no longer the
 * only thing standing between the sensor and a moiré pattern. It stays because
 * the browser's scaler is faster than building a pyramid in JavaScript, and
 * because holding one 12 MP RGBA buffer per page is what a phone runs out of
 * memory doing. Leaving it at 2600 means the unwarp is never minifying by more
 * than about 1.2×, which is inside what a bilinear tap resolves correctly.
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

/**
 * Below this share of the frame's own strongest edges the quad is not believed.
 *
 * Low, and deliberately so. This number used to be the main defence against
 * unwarping something that is not a page, and it was the wrong number for the
 * job: it measures the page boundary against the *ink* on the page, and a white
 * sheet on a pale desk has a boundary a fifth as strong as its own text. That
 * is a real page scoring 0.11, next to a photograph of a hand scoring 0.68. The
 * gates that actually separate those two are `MIN_EDGE_STRENGTH` and
 * `MIN_EDGE_CONTRAST`, which are absolute and local respectively; this one is
 * left as a floor against a boundary that is barely there at all.
 */
const MIN_CONFIDENCE = 0.05;

/** A page that fills less than this much of the frame is probably not the page. */
const MIN_AREA_FRACTION = 0.1;

/**
 * At this much the "page" is the whole frame, and unwarping it is a no-op that
 * the fallback — keep the photograph — already does, without the crop.
 */
const MAX_AREA_FRACTION = 0.97;

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

function histogram(values: ArrayLike<number>): Float64Array {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i += 1) hist[values[i] | 0] += 1;
  return hist;
}

/**
 * Otsu's threshold: the split maximising between-class variance.
 *
 * Restricted to levels `lo`…`hi` so it can be run a second time *inside* one of
 * its own classes. That is what finds a white page on a pale desk: the first
 * split lands between ink and everything else, putting paper and desk together
 * in one class, and the second split, run on that class alone, separates them.
 * Returns `lo` when the band is empty or has nothing to split, which the caller
 * reads as "no useful second threshold".
 */
function otsu(hist: Float64Array, lo = 0, hi = 255): number {
  let total = 0;
  let weighted = 0;
  for (let t = lo; t <= hi; t += 1) {
    total += hist[t];
    weighted += t * hist[t];
  }
  if (total === 0) return lo;

  let sumBelow = 0;
  let countBelow = 0;
  let best = -1;
  let threshold = lo;

  for (let t = lo; t <= hi; t += 1) {
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
 *
 * It is the weakest of the three edge gates and is kept for the case it was
 * built for. `MIN_EDGE_STRENGTH` and `MIN_EDGE_COVERAGE` below do most of the
 * work now, and they do it on properties this one cannot see.
 */
const MIN_EDGE_CONTRAST = 2.5;

/**
 * The absolute Sobel ridge a page boundary has to reach, in levels per pixel.
 *
 * `contrast` is a ratio, and a ratio has no opinion about scale: on a frame
 * whose gradients are all in the single digits — a wall, a palm over the lens,
 * a smooth ramp where quantisation is the only structure — a quadrilateral
 * drawn through nothing scores 3 to 5 and gets in. Measured over the frames
 * this is tested against, a real page boundary scores 55 to 578 and every
 * page-less frame scores 1.6 to 4.9. There is an order of magnitude of empty
 * space between them.
 *
 * 20 sits low in that gap on purpose: a step of Δ levels through the 3×3 blur
 * comes out at roughly 8Δ/3, so 20 says the paper must differ from whatever it
 * is lying on by about 8 levels out of 255. Below that there is nothing to find
 * from brightness alone, and null is the honest answer.
 */
const MIN_EDGE_STRENGTH = 20;

/**
 * How much of the quad's perimeter has to sit on a real edge.
 *
 * The other three numbers are averages, and an average is exactly what a
 * scattering of bright shapes on a dark ground can fake: a handful of the
 * sampled points land on the edge of a blob, score enormously, and carry the
 * mean for the three quarters of the perimeter that are crossing empty
 * background. Asking instead what *fraction* of the perimeter is on an edge
 * separates them completely — measured, a real page boundary comes back at
 * 1.000 whatever the desk, and a field of discs or blurred noise at 0.14 to
 * 0.48. A page is a closed boundary; half a boundary is not a page.
 *
 * The cost of this gate is a page with one side against something its own
 * colour, or a hand over a corner. Those now return null, and null means the
 * whole photograph is kept — which still contains the page.
 */
const MIN_EDGE_COVERAGE = 0.75;

/**
 * How close to the frame's border a side may run before the page is taken to be
 * cut off by it.
 *
 * A page with a corner outside the frame is not a page this can straighten: the
 * mask stops at the border, the hull follows the border, and the "corner" that
 * comes back is wherever the picture happened to end. The result looks
 * plausible and is wrong — a trapezium sliced off flat down one side. Two
 * corners of a side sitting on the same border is what that looks like from
 * here, and it is worth failing on, because the fallback keeps the whole
 * photograph and the whole photograph still contains all of the page that was
 * ever captured.
 */
const FRAME_MARGIN_FRACTION = 0.004;

/**
 * How much of a real intensity edge each side of the quad actually sits on.
 *
 * This is the check that stops the tool confidently unwarping a shadow. The
 * mask that produced the quad only knows about brightness; the gradient field
 * knows about boundaries. If the two agree along all four sides, there is a
 * physical edge there. The perpendicular ±2 px search is because a Sobel ridge
 * is a couple of pixels wide and the mask boundary lands on one shoulder of it.
 *
 * Four numbers come back, because no one of them is enough, and each covers a
 * failure the others let through:
 *
 *  - `support`, the ridge against the frame's own strongest edges. Reported
 *    rather than gated on — see `MIN_CONFIDENCE` for why it is a poor gate.
 *  - `contrast`, the ridge against the gradient 8 px either side of it. Paper
 *    is flat and a desk is flat, so a real page edge is a spike between two
 *    calm regions, where a patterned tablecloth is loud everywhere.
 *  - `strength`, the ridge in absolute levels. Ratios have no opinion about
 *    scale, and a frame whose gradients are all in the single digits — a wall,
 *    a hand over the lens — can produce a perfectly good-looking ratio out of
 *    quantisation noise.
 *  - `coverage`, the share of the perimeter that is on an edge at all. The
 *    other three are averages, and a few enormous samples carry an average a
 *    long way; this is the one that tells a closed boundary from four lines
 *    drawn between some bright shapes.
 */
function edgeConfidence(
  quad: Quad,
  edges: Float32Array,
  width: number,
  height: number,
  scale: number
): { support: number; contrast: number; strength: number; coverage: number } {
  const nowhere = { support: 0, contrast: 0, strength: 0, coverage: 0 };
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
  let covered = 0;

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
      if (peak >= MIN_EDGE_STRENGTH) covered += 1;
      ridge += peak;
      ambient += (at(x + nx * 8, y + ny * 8) + at(x - nx * 8, y - ny * 8)) / 2;
      samples += 1;
    }
  }

  if (samples === 0) return nowhere;
  return {
    support: support / samples,
    contrast: ambient <= 1e-6 ? Infinity : ridge / ambient,
    strength: ridge / samples,
    coverage: covered / samples,
  };
}

/**
 * How far a side may travel when it is refit, in pixels of the analysis copy.
 *
 * Deliberately short. The bias being corrected measured 0 to 5 px, and a wider
 * window lets a side jump to something that is not the page edge — a printed
 * rule, the first line of text, the shadow the sheet casts on the desk.
 */
const REFIT_SEARCH = 8;

/** A ridge weaker than this share of the frame's strongest edges is not a page edge. */
const REFIT_MIN_RIDGE = 0.12;

/** Bilinear read of the gradient field, clamped at the border. */
function edgeAt(edges: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.max(0, Math.min(width - 1.001, x));
  const cy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = cx | 0;
  const y0 = cy | 0;
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = edges[y0 * width + x0] + (edges[y0 * width + x1] - edges[y0 * width + x0]) * fx;
  const bottom = edges[y1 * width + x0] + (edges[y1 * width + x1] - edges[y1 * width + x0]) * fx;
  return top + (bottom - top) * fy;
}

const median = (values: number[]): number => {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Slide each side of the quad onto the intensity edge it is meant to lie on.
 *
 * The coarse quad comes out of a *mask*: a threshold says which pixels are
 * page, a hull wraps them, and the largest inscribed quadrilateral cuts chords
 * across whatever noise the mask picked up along the way. Chords land inside
 * the true boundary, and — this is the part that shows — by a different amount
 * on each side. Measured against known-truth corners on 2600 px frames, the
 * four sides came in at −4.9, −4.1, −2.8 and +0.2 px. One edge of the finished
 * page therefore kept a strip of desk that the opposite edge did not, which is
 * exactly what a sliver along one edge looks like.
 *
 * The gradient field has no such bias: the ridge sits on the boundary itself.
 * So each side is re-measured against it — walk along the side, find the ridge
 * across it, refine the crossing to sub-pixel by fitting a parabola to the
 * three samples around the peak, discard the samples that disagree with the
 * rest, fit a straight line to what survives, and intersect neighbouring lines
 * for the corners. Fitting a *line* rather than moving corners individually is
 * the point: a page edge is straight, so twenty noisy crossings constrain it far
 * better than the two endpoints do.
 *
 * Returns the original quad unchanged whenever the refit does not clearly win —
 * too few crossings found, a side that wants to rotate further than the search
 * window, or a result that no longer looks like a page.
 */
function refineQuad(
  quad: Quad,
  edges: Float32Array,
  width: number,
  height: number,
  scale: number
): Quad {
  if (!(scale > 0)) return quad;

  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const floor = scale * REFIT_MIN_RIDGE;

  const sides: { ax: number; ay: number; bx: number; by: number }[] = [];

  for (let side = 0; side < 4; side += 1) {
    const from = quad[side];
    const to = quad[(side + 1) % 4];
    const length = distance(from, to);
    if (length < 24) return quad;

    const dx = (to.x - from.x) / length;
    const dy = (to.y - from.y) / length;
    let nx = dy;
    let ny = -dx;
    if ((from.x - cx) * nx + (from.y - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }

    const steps = Math.max(10, Math.min(48, Math.round(length / 12)));
    const offsets: number[] = [];
    const along: number[] = [];

    for (let s = 0; s <= steps; s += 1) {
      // The middle three quarters only: near a corner the two sides' ridges
      // merge and the crossing is not one side's to measure.
      const t = length * (0.125 + (0.75 * s) / steps);
      const px = from.x + dx * t;
      const py = from.y + dy * t;

      let peak = -1;
      let peakAt = 0;
      for (let o = -REFIT_SEARCH; o <= REFIT_SEARCH; o += 1) {
        const value = edgeAt(edges, width, height, px + nx * o, py + ny * o);
        if (value > peak) {
          peak = value;
          peakAt = o;
        }
      }
      // A peak against the wall of the window is a ridge that carries on
      // outside it, so where it really is remains unknown.
      if (peak < floor || Math.abs(peakAt) === REFIT_SEARCH) continue;

      const before = edgeAt(edges, width, height, px + nx * (peakAt - 1), py + ny * (peakAt - 1));
      const after = edgeAt(edges, width, height, px + nx * (peakAt + 1), py + ny * (peakAt + 1));
      const curve = before - 2 * peak + after;
      const shift = curve < 0 ? (0.5 * (before - after)) / curve : 0;

      offsets.push(peakAt + (Math.abs(shift) <= 1 ? shift : 0));
      along.push(t);
    }

    if (offsets.length < Math.max(8, (steps + 1) * 0.4)) return quad;

    // Throw away crossings that landed on something else — a printed rule, a
    // fold, a hand. Median and MAD rather than mean and standard deviation
    // because two or three such crossings would drag a mean straight to them.
    const centre = median(offsets);
    const spread = median(offsets.map((value) => Math.abs(value - centre)));
    const limit = Math.max(1.5, 3 * spread);

    let n = 0;
    let sumT = 0;
    let sumTT = 0;
    let sumO = 0;
    let sumTO = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      if (Math.abs(offsets[i] - centre) > limit) continue;
      n += 1;
      sumT += along[i];
      sumTT += along[i] * along[i];
      sumO += offsets[i];
      sumTO += along[i] * offsets[i];
    }
    if (n < 8) return quad;

    const determinant = n * sumTT - sumT * sumT;
    if (Math.abs(determinant) < 1e-6) return quad;
    const slope = (n * sumTO - sumT * sumO) / determinant;
    const intercept = (sumO - slope * sumT) / n;

    // A side that wants to rotate further than the window is wide is not being
    // corrected, it is being replaced.
    if (Math.abs(intercept) > REFIT_SEARCH || Math.abs(intercept + slope * length) > REFIT_SEARCH) {
      return quad;
    }

    sides.push({
      ax: from.x + nx * intercept,
      ay: from.y + ny * intercept,
      bx: to.x + nx * (intercept + slope * length),
      by: to.y + ny * (intercept + slope * length),
    });
  }

  const corners: Point[] = [];
  for (let i = 0; i < 4; i += 1) {
    const a = sides[(i + 3) % 4];
    const b = sides[i];
    const adx = a.bx - a.ax;
    const ady = a.by - a.ay;
    const bdx = b.bx - b.ax;
    const bdy = b.by - b.ay;
    const determinant = adx * bdy - ady * bdx;
    if (Math.abs(determinant) < 1e-9) return quad;
    const t = ((b.ax - a.ax) * bdy - (b.ay - a.ay) * bdx) / determinant;
    const corner = { x: a.ax + adx * t, y: a.ay + ady * t };
    // A refit corner that has moved further than the search window could
    // reach is arithmetic, not measurement.
    if (distance(corner, quad[i]) > REFIT_SEARCH * 2) return quad;
    corners.push(corner);
  }

  const refined = corners as unknown as Quad;
  return plausibleShape(refined) ? refined : quad;
}

/** Does a side of this quad lie along the edge of the frame? */
function clipped(quad: Quad, width: number, height: number): boolean {
  const margin = Math.max(2, Math.round(Math.min(width, height) * FRAME_MARGIN_FRACTION));
  const right = width - 1 - margin;
  const bottom = height - 1 - margin;

  for (let side = 0; side < 4; side += 1) {
    const a = quad[side];
    const b = quad[(side + 1) % 4];
    if (a.x < margin && b.x < margin) return true;
    if (a.y < margin && b.y < margin) return true;
    if (a.x > right && b.x > right) return true;
    if (a.y > bottom && b.y > bottom) return true;
  }
  return false;
}

/** One candidate quad from one binarisation, or null. */
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

  const coarse = orderCorners(quadPoints);
  if (!plausibleShape(coarse)) return null;

  const quad = refineQuad(coarse, edges, width, height, scale);

  // The corner search may have cut into the blob; re-check against the frame.
  const quadFraction = polygonArea([...quad]) / (width * height);
  if (quadFraction < MIN_AREA_FRACTION || quadFraction > MAX_AREA_FRACTION) return null;

  if (clipped(quad, width, height)) return null;

  const { support, contrast, strength, coverage } = edgeConfidence(
    quad,
    edges,
    width,
    height,
    scale
  );
  if (contrast < MIN_EDGE_CONTRAST) return null;
  if (strength < MIN_EDGE_STRENGTH || coverage < MIN_EDGE_COVERAGE) return null;

  return { quad, confidence: support };
}

/**
 * A class holding more than this much of the frame probably has the page *and*
 * its background inside it, and is worth splitting again.
 */
const CLASS_SPLIT_FRACTION = 0.5;

/**
 * Find the page in a frame, or return null and let the caller keep the photo.
 *
 * Pure: no canvas, no DOM. The capture UI on the main thread can call this on a
 * downscaled video frame to draw a live outline over the viewfinder.
 *
 * Several binarisations are tried rather than one, because there is no reliable
 * answer to "is the page the bright thing?". White paper on a white desk under
 * a warm lamp routinely comes out *darker* than its surroundings, so both
 * polarities of the first Otsu split are tried. And when paper and desk are
 * close enough in tone that the first split lands between ink and everything
 * else — a white page on a pale desk, the case this used to fail outright —
 * the crowded class is split a second time inside itself. Each mask produces at
 * most one candidate, every candidate has to clear the same shape, area and
 * edge-contrast gates, and the gradient confidence picks the winner. Nothing
 * here guesses; it enumerates and then checks.
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

  const hist = histogram(smooth);
  const threshold = otsu(hist);

  const bands: [number, number][] = [
    [threshold + 1, 255],
    [0, threshold],
  ];

  const share = (lo: number, hi: number): number => {
    let count = 0;
    for (let t = lo; t <= hi; t += 1) count += hist[t];
    return count / (width * height);
  };

  if (share(threshold + 1, 255) > CLASS_SPLIT_FRACTION) {
    const second = otsu(hist, threshold + 1, 255);
    if (second > threshold + 1 && second < 255) {
      bands.push([second + 1, 255], [threshold + 1, second]);
    }
  }
  if (share(0, threshold) > CLASS_SPLIT_FRACTION) {
    const second = otsu(hist, 0, threshold);
    if (second > 0 && second < threshold) {
      bands.push([second + 1, threshold], [0, second]);
    }
  }

  const mask = new Uint8Array(width * height);
  const options: QuadDetection[] = [];
  for (const [lo, hi] of bands) {
    for (let i = 0; i < smooth.length; i += 1) {
      mask[i] = smooth[i] >= lo && smooth[i] <= hi ? 1 : 0;
    }
    const found = candidate(mask, width, height, edges, scale);
    if (found) options.push(found);
  }

  if (options.length === 0) return null;

  const best = options.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return best.confidence >= MIN_CONFIDENCE ? best : null;
}

/* ------------------------------------------------------------------ *
 * The homography
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

/* ------------------------------------------------------------------ *
 * Resampling
 * ------------------------------------------------------------------ */

/**
 * One level of a mip pyramid. Same shape as `ImageLike`, named apart because
 * these are private scratch buffers rather than anything a caller sees.
 */
interface Layer {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Box-average 2×2 down to half size. Odd rows and columns average what exists. */
function halve(layer: Layer): Layer {
  const width = Math.max(1, layer.width >> 1);
  const height = Math.max(1, layer.height >> 1);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const y0 = y * 2;
    const y1 = Math.min(layer.height - 1, y0 + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = x * 2;
      const x1 = Math.min(layer.width - 1, x0 + 1);
      const a = (y0 * layer.width + x0) * 4;
      const b = (y0 * layer.width + x1) * 4;
      const c = (y1 * layer.width + x0) * 4;
      const d = (y1 * layer.width + x1) * 4;
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        data[at + channel] =
          (layer.data[a + channel] +
            layer.data[b + channel] +
            layer.data[c + channel] +
            layer.data[d + channel]) /
          4;
      }
      data[at + 3] = 255;
    }
  }

  return { data, width, height };
}

/** Bilinear tap into `out[0..2]`, with edge clamping. */
function tap(layer: Layer, x: number, y: number, out: Float64Array): void {
  const { data, width, height } = layer;
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

  for (let channel = 0; channel < 3; channel += 1) {
    const top = data[i00 + channel] + (data[i10 + channel] - data[i00 + channel]) * fx;
    const bottom = data[i01 + channel] + (data[i11 + channel] - data[i01 + channel]) * fx;
    out[channel] = top + (bottom - top) * fy;
  }
}

/**
 * Bilinear tap straight into an RGBA buffer.
 *
 * The same arithmetic as `tap`, written out again rather than wrapping it,
 * because this runs once per output pixel on the path where nothing is being
 * minified — the common one — and going through a scratch array to copy three
 * numbers back cost about 40% of the unwarp.
 */
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

  for (let channel = 0; channel < 3; channel += 1) {
    const top = data[i00 + channel] + (data[i10 + channel] - data[i00 + channel]) * fx;
    const bottom = data[i01 + channel] + (data[i11 + channel] - data[i01 + channel]) * fx;
    out[at + channel] = top + (bottom - top) * fy;
  }
  out[at + 3] = 255;
}

const scratch = new Float64Array(3);
const scratchLow = new Float64Array(3);

/**
 * A coordinate in level-0 pixel-index units, expressed in level-`level` units.
 *
 * Pixel *index* x means the centre of pixel x, so the continuous position is
 * x + 0.5; that halves per level, and the half goes back off at the end.
 */
const atLevel = (x: number, level: number): number => (x + 0.5) / (1 << level) - 0.5;

/**
 * Which mip level a source footprint `rho` output pixels across wants.
 *
 * `log2(rho)` is the textbook answer and it is half a level too eager here,
 * because the tap taken at that level is itself bilinear: a bilinear tent is
 * about a pixel and a half wide, so it has already done the first half-level of
 * averaging. Subtracting that is not a fudge, it is the difference between
 * matching an ideal area average and blurring past it — measured over gratings
 * from 3 to 20 px at minifications from 1.36x to 4.09x, the bias moves the mean
 * amplitude from 0.80x of the ideal area average to 0.998x, and it keeps
 * minifications up to ~1.4x on the plain bilinear path they were already
 * resolving correctly.
 */
const LOD_BIAS = 0.5;
const lodOf = (rho: number): number => (rho > 1 ? Math.max(0, Math.log2(rho) - LOD_BIAS) : 0);

/* ------------------------------------------------------------------ *
 * Perspective correction
 * ------------------------------------------------------------------ */

/**
 * How far inside the supplied outline the sampler starts, in source pixels.
 *
 * The reason there is an inset at all: the page edge in a *photograph* is not a
 * step. Measured across the boundary of the test frames at the 2600 px working
 * resolution, desk-to-paper takes 5–8 px to complete — lens MTF, the demosaic,
 * the paper's own thickness and the hairline shadow under it, then JPEG chroma
 * subsampling on top. `refineQuad` puts the outline on the *middle* of that
 * ramp, which is the right place for it to be and the wrong place to start
 * sampling from: half the ramp is still ahead. One more pixel goes on top
 * because a bilinear tap reaches a pixel past its own centre, and so does a mip
 * tap.
 *
 * So 5 px: four for the far half of a typical ramp, one for the tap. Swept
 * against synthetic frames whose boundaries ramp over 5, 8 and 11 px, 5 px
 * leaves nothing of the background on any edge of the first two and one row on
 * the third — a frame that is genuinely out of focus at the paper's edge. On a
 * 1400 px page it costs 0.35% off each side: margin, not content. It is capped
 * at 0.6% of the shorter side, so the thumbnail-sized rehearsal the capture UI
 * runs gives up proportionally less rather than the same five pixels.
 */
const EDGE_INSET = 5;
const MAX_INSET_FRACTION = 0.006;

/**
 * Complain about a quad in the words the person dragging it needs to hear.
 *
 * A homography maps a rectangle to a *convex* quadrilateral and nothing else —
 * projective maps take lines to lines, so convexity is not a preference here,
 * it is what the maths can represent. Hand `unwarp` a bow tie and Gaussian
 * elimination still returns eight numbers; they just fold the page over itself.
 * Better to say so than to render the fold.
 *
 * Returns null when the quad is fine.
 */
export function quadProblem(quad: Quad): string | null {
  if (!Array.isArray(quad) || quad.length !== 4) {
    return 'A page needs exactly four corners.';
  }

  for (const corner of quad) {
    if (!corner || !Number.isFinite(corner.x) || !Number.isFinite(corner.y)) {
      return 'One of the corners is not a real position. Drag it back onto the photo.';
    }
  }

  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const previous = quad[(i + 3) % 4];
    const current = quad[i];
    const next = quad[(i + 1) % 4];

    if (distance(current, next) < 2) {
      return 'Two of the corners are on top of each other. Pull them apart.';
    }

    const turn = cross(previous, current, next);
    if (turn === 0) {
      return 'Three of the corners are in a straight line, so there is no page between them.';
    }
    const way = turn > 0 ? 1 : -1;
    if (sign === 0) sign = way;
    else if (sign !== way) {
      return 'The outline crosses over itself. Drag the corners so it is a simple four-sided shape.';
    }
  }

  // Screen y grows downwards, so a clockwise-on-screen ring turns positive.
  // An anticlockwise one is representable and produces a page that is the right
  // shape and mirrored, which is worse than a refusal.
  if (sign < 0) {
    return 'The corners run the wrong way round, so the page would come out mirrored. Take them clockwise, starting at the top-left of the page.';
  }

  const width = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const height = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
  if (width < 8 || height < 8) return 'That area is too small to be a page.';

  return null;
}

/**
 * Slide every side of a convex quad `by` pixels towards the middle.
 *
 * Sides, not corners: pulling each corner along its diagonal shrinks a long
 * thin page far more across its width than along its length. Shifting the four
 * *lines* and re-intersecting them moves every edge by the same distance
 * whatever the shape, which is what an inset is supposed to mean.
 */
function insetQuad(quad: Quad, by: number): Quad {
  if (by <= 0) return quad;

  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // Each side as n·p = c, with n the outward unit normal, then c pulled in.
  const lines: { nx: number; ny: number; c: number }[] = [];
  for (let side = 0; side < 4; side += 1) {
    const from = quad[side];
    const to = quad[(side + 1) % 4];
    const length = distance(from, to);
    let nx = (to.y - from.y) / length;
    let ny = -(to.x - from.x) / length;
    if ((from.x - cx) * nx + (from.y - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    lines.push({ nx, ny, c: from.x * nx + from.y * ny - by });
  }

  const corners: Point[] = [];
  for (let i = 0; i < 4; i += 1) {
    const a = lines[(i + 3) % 4];
    const b = lines[i];
    const determinant = a.nx * b.ny - a.ny * b.nx;
    if (Math.abs(determinant) < 1e-9) return quad; // parallel sides: leave it alone
    corners.push({
      x: (a.c * b.ny - b.c * a.ny) / determinant,
      y: (a.nx * b.c - b.nx * a.c) / determinant,
    });
  }

  return corners as unknown as Quad;
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
 *
 * Exported because a corner editor has to show the page at the shape the
 * corners currently imply, and that shape is this function's opinion, not the
 * outline's bounding box. Returns null for a quad `unwarp` would refuse, so the
 * two always agree about what is possible.
 */
export function unwarpOutputSize(quad: Quad): { width: number; height: number } | null {
  if (quadProblem(quad) !== null) return null;
  return unwarpSize(quad);
}

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

/**
 * Perspective-correct `quad` out of `image` into an upright rectangle.
 *
 * The quad is in the image's own pixel coordinates, clockwise from the corner
 * that should end up top-left; `unwarpOutputSize` says how big the result will
 * be. A quad `quadProblem` rejects gets null back rather than a folded page.
 *
 * Two things happen here that a plain "map every output pixel back and take a
 * bilinear tap" does not do, both of them measured defects of exactly that:
 *
 *  - the sampled outline is pulled `EDGE_INSET` px inside the one supplied, so
 *    the strip of desk that lives in the boundary's transition ramp does not
 *    survive into the page. The output *size* still comes from the outline the
 *    caller gave, so an editor's preview and the finished page agree.
 *  - where the map minifies — a large frame going to a page-sized raster — the
 *    taps come from a mip level whose pixels are the size of the output pixel's
 *    footprint. Bilinear alone samples about a quarter of the pixels that
 *    should contribute at 2× and beats the rest into moiré.
 */
export function unwarp(image: ImageLike, quad: Quad): ImageLike | null {
  if (quadProblem(quad) !== null) return null;

  const { width, height } = unwarpSize(quad);

  const rect: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  const shorter = Math.min(
    Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2])),
    Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]))
  );
  const inset = Math.min(EDGE_INSET, shorter * MAX_INSET_FRACTION);

  const h = homography(rect, insetQuad(quad, inset));
  if (!h) return null;

  // How many source pixels wide one output pixel is. The map is projective, so
  // this varies across the page and is largest at whichever corner is furthest
  // away; the four corners and the middle are enough to find that, and the
  // largest of them decides how deep the pyramid has to go.
  const footprint = (ux: number, vy: number): number => {
    const w = h[6] * ux + h[7] * vy + 1;
    if (!(Math.abs(w) > 1e-9)) return 1;
    const x = (h[0] * ux + h[1] * vy + h[2]) / w;
    const y = (h[3] * ux + h[4] * vy + h[5]) / w;
    const dxdu = (h[0] - x * h[6]) / w;
    const dydu = (h[3] - y * h[6]) / w;
    const dxdv = (h[1] - x * h[7]) / w;
    const dydv = (h[4] - y * h[7]) / w;
    return Math.max(Math.hypot(dxdu, dydu), Math.hypot(dxdv, dydv));
  };

  let worst = 0;
  for (const [ux, vy] of [
    [0.5, 0.5],
    [width - 0.5, 0.5],
    [width - 0.5, height - 0.5],
    [0.5, height - 0.5],
    [width / 2, height / 2],
  ]) {
    const value = footprint(ux, vy);
    if (Number.isFinite(value) && value > worst) worst = value;
  }

  const levels: Layer[] = [image];
  if (lodOf(worst) > 0) {
    const depth = Math.min(8, Math.ceil(lodOf(worst)) + 1);
    for (let level = 1; level <= depth; level += 1) {
      const previous = levels[level - 1];
      if (previous.width <= 1 && previous.height <= 1) break;
      levels.push(halve(previous));
    }
  }
  const top = levels.length - 1;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let v = 0; v < height; v += 1) {
    const vy = v + 0.5;
    for (let u = 0; u < width; u += 1) {
      const ux = u + 0.5;
      const w = h[6] * ux + h[7] * vy + 1;
      const x = (h[0] * ux + h[1] * vy + h[2]) / w;
      const y = (h[3] * ux + h[4] * vy + h[5]) / w;
      const at = (v * width + u) * 4;

      if (top === 0) {
        sample(image, x, y, data, at);
        continue;
      }

      const dxdu = (h[0] - x * h[6]) / w;
      const dydu = (h[3] - y * h[6]) / w;
      const dxdv = (h[1] - x * h[7]) / w;
      const dydv = (h[4] - y * h[7]) / w;
      const rho = Math.max(Math.hypot(dxdu, dydu), Math.hypot(dxdv, dydv));
      const lod = lodOf(rho);

      // A tenth of a level is well under a tenth of a pixel of blur; taking a
      // second tap for that is pure cost.
      if (lod < 0.1) {
        sample(image, x, y, data, at);
        continue;
      }

      const low = Math.min(top, lod | 0);
      const high = Math.min(top, low + 1);
      tap(levels[low], atLevel(x, low), atLevel(y, low), scratchLow);
      if (high === low) {
        data[at] = scratchLow[0];
        data[at + 1] = scratchLow[1];
        data[at + 2] = scratchLow[2];
      } else {
        const blend = Math.min(1, lod - low);
        tap(levels[high], atLevel(x, high), atLevel(y, high), scratch);
        data[at] = scratchLow[0] + (scratch[0] - scratchLow[0]) * blend;
        data[at + 1] = scratchLow[1] + (scratch[1] - scratchLow[1]) * blend;
        data[at + 2] = scratchLow[2] + (scratch[2] - scratchLow[2]) * blend;
      }
      data[at + 3] = 255;
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

/** Where the flattened white point lands. Not 255 — leave the paper some texture. */
const FLAT_WHITE = 242;

/**
 * An estimate of the paper's own white point, as a coarse grid over the page.
 *
 * Both enhancement modes need the same thing: "how bright is *paper* here?" —
 * the lamp, the window, the shadow of the phone, with the document's own
 * content taken out. The obvious estimate is a wide box mean, and it is wrong
 * in one specific and very visible way: a box mean over a region that is mostly
 * dark returns something dark, so a photograph printed on the page reads as
 * "this part of the page is badly lit" and gets multiplied back up to white.
 * Measured on a test page with a 595 × 561 px photograph on it, the box-mean
 * estimate blew 9.8% of the photograph to pure white and stretched its
 * standard deviation from 22 to 57. The picture came out as a poster.
 *
 * So: split the page into cells, take a high percentile of each cell (paper,
 * not ink), and then run a morphological *closing* over the grid — a max
 * filter followed by a min filter. Closing is the classic background estimator
 * for exactly this: the max filter fills in any dark feature narrower than the
 * structuring element, the min filter puts the edges of everything wider back
 * where they were, and what survives is the slow field. A photograph is a dark
 * feature; a shadow across the page is a slow field; the two stop being
 * confused.
 */
interface Field {
  cells: Float32Array;
  cols: number;
  rows: number;
  cell: number;
}

/**
 * Cells about a 24th of the short edge, so the grid is ~24 × 30 on a page.
 * Fine enough to follow a hand's shadow, coarse enough that a cell almost
 * always contains some paper.
 */
const FIELD_CELLS = 24;

/**
 * The closing radius, in cells. 5 fills any dark object up to ten cells across
 * — about 40% of the page's short edge, which covers a full-width photograph
 * or a solid banner and stops short of "the page is dark".
 */
const FIELD_CLOSE = 5;

/** Paper is the bright end of a cell, not its middle. */
const FIELD_PERCENTILE = 0.85;

/**
 * A cell is taken to be covered — by a photograph, a filled block, a hand —
 * when its own paper reading is this far below what the closing filled in for
 * it. Above the line, the cell's own reading is trusted, because the closing
 * lifts a smoothly-lit page as well as a covered one and only the covered case
 * wants lifting.
 *
 * Swept against a page lit by a lamp off one corner: at 0.88 the darkest corner
 * of the page finished 28 levels short of paper white, because a cell there
 * fell just the wrong side of the line and inherited the brighter reading five
 * cells inboard. At 0.84 no blank-paper probe anywhere on the page is more than
 * 7 levels off, and the photograph on it still clips nothing.
 */
const COVERED_CELL = 0.84;

function illuminationField(grey: ArrayLike<number>, width: number, height: number): Field {
  const cell = Math.max(8, Math.round(Math.min(width, height) / FIELD_CELLS));
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));

  const cells = new Float32Array(cols * rows);
  const hist = new Int32Array(64);

  for (let row = 0; row < rows; row += 1) {
    const y0 = row * cell;
    const y1 = Math.min(height, y0 + cell);
    for (let col = 0; col < cols; col += 1) {
      const x0 = col * cell;
      const x1 = Math.min(width, x0 + cell);

      hist.fill(0);
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          hist[grey[y * width + x] >> 2] += 1;
          count += 1;
        }
      }

      const target = count * FIELD_PERCENTILE;
      let seen = 0;
      let bucket = 63;
      for (let b = 0; b < 64; b += 1) {
        seen += hist[b];
        if (seen >= target) {
          bucket = b;
          break;
        }
      }
      cells[row * cols + col] = bucket * 4 + 2;
    }
  }

  // Closing: dilate then erode, each separable. Out-of-grid neighbours are the
  // nearest edge cell rather than nothing — skipping them makes every filter at
  // the border one-sided, and a one-sided filter on a field that slopes towards
  // the corner reports the interior's brightness for the corner. That showed up
  // as the darkest corner of the page finishing 6% grey.
  const clamp = (value: number, limit: number): number =>
    value < 0 ? 0 : value >= limit ? limit - 1 : value;

  const pass = (source: Float32Array, pick: (a: number, b: number) => number): Float32Array => {
    const middle = new Float32Array(source.length);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        let best = source[row * cols + col];
        for (let d = -FIELD_CLOSE; d <= FIELD_CLOSE; d += 1) {
          best = pick(best, source[row * cols + clamp(col + d, cols)]);
        }
        middle[row * cols + col] = best;
      }
    }
    const out = new Float32Array(source.length);
    for (let col = 0; col < cols; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        let best = middle[row * cols + col];
        for (let d = -FIELD_CLOSE; d <= FIELD_CLOSE; d += 1) {
          best = pick(best, middle[clamp(row + d, rows) * cols + col]);
        }
        out[row * cols + col] = best;
      }
    }
    return out;
  };

  const closed = pass(pass(cells, Math.max), Math.min);

  // Closing only ever raises a value, and on a *smooth* field — which is what
  // the lighting is where nothing covers it — it raises the shaded side by
  // whatever the light does across the structuring element. Measured, that put
  // clean paper out by 9%: the page came back at 221 rather than 242. So the
  // closed field is used only where it actually filled something in; a cell
  // whose own reading survived the closing keeps its own reading, which is the
  // paper, exactly.
  const field = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i += 1) {
    field[i] = cells[i] < closed[i] * COVERED_CELL ? closed[i] : cells[i];
  }

  // One 3 × 3 mean over the grid. The closing leaves flat plateaus with steps
  // between them; interpolating a step gives a visible crease across the page.
  const smooth = new Float32Array(field.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let sum = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          sum += field[clamp(row + dr, rows) * cols + clamp(col + dc, cols)];
        }
      }
      smooth[row * cols + col] = Math.max(1, sum / 9);
    }
  }

  return { cells: smooth, cols, rows, cell };
}

/** The field at a pixel, bilinear between cell centres. */
function fieldAt(field: Field, x: number, y: number): number {
  const { cells, cols, rows, cell } = field;
  const gx = Math.max(0, Math.min(cols - 1, x / cell - 0.5));
  const gy = Math.max(0, Math.min(rows - 1, y / cell - 0.5));
  const c0 = gx | 0;
  const r0 = gy | 0;
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fx = gx - c0;
  const fy = gy - r0;

  const top = cells[r0 * cols + c0] + (cells[r0 * cols + c1] - cells[r0 * cols + c0]) * fx;
  const bottom = cells[r1 * cols + c0] + (cells[r1 * cols + c1] - cells[r1 * cols + c0]) * fx;
  return top + (bottom - top) * fy;
}

/** Sauvola's sensitivity. Lower keeps faint pencil; higher whitens harder. */
const SAUVOLA_K = 0.18;

/** Sauvola's dynamic range constant, standard for 8-bit input. */
const SAUVOLA_R = 128;

/**
 * Anything darker than this fraction of the local paper white is ink, whatever
 * the local statistics say.
 *
 * Sauvola on its own has one failure that is not subtle. Its threshold is
 * `m·(1 + k(s/R − 1))`, and inside a large region of *flat dark tone* the local
 * mean is that tone and the local deviation is nearly zero, so the threshold
 * collapses to `m·(1 − k)` = 0.82 m — just below the pixels themselves, which
 * therefore come out white. Measured before this floor existed: a 150 × 400 px
 * block at every grey level from 20 to 120 came back with a black outline and a
 * white middle. Pure #000 survived only because 0 > 0 is false.
 *
 * That is not an edge case on a photographed page: a filled heading bar, a
 * black-on-white logo, a solid table header are all "flat and dark", and none
 * of them photographs as exactly zero. 0.55 puts the line at a 45%-grey, which
 * is darker than any paper this pipeline produces and lighter than any fill
 * meant to read as solid.
 */
const INK_FLOOR = 0.55;

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
 * than a stroke hollows the stroke out into an outline. A twenty-fourth of the
 * short edge measured best over a text page at 1654 × 2339, 1418 × 1410 and
 * 420 × 560 — but only just: across windows from 17 to 69 px and k from 0.10 to
 * 0.34, ink recall never left 99.97–100%. The window is not the thing that
 * decides whether this works. `INK_FLOOR` is.
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
  const field = illuminationField(grey, width, height);

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
      const here = grey[y * width + x];
      const ink = here <= threshold || here < fieldAt(field, x, y) * INK_FLOOR;
      const value = ink ? 0 : 255;

      const at = (y * width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = value;
      data[at + 3] = 255;
    }
  }

  return { data, width, height };
}

/**
 * The gain is clamped. Below 0.5 the image is being *darkened* by more than a
 * stop, which only happens where the estimate has gone wrong; above 4 the
 * estimate says the paper here is under a quarter of its white point, which is
 * a region so dark that multiplying it up amplifies sensor noise more than
 * detail.
 */
const MIN_GAIN = 0.5;
const MAX_GAIN = 4;

/**
 * Shading correction: divide the image by an estimate of its own illumination.
 *
 * This is the mode for a page that is not only text — a photograph, a coloured
 * logo, a stamp — where Sauvola would flatten every tone to black or white. The
 * lighting goes; the greys stay.
 *
 * The estimate comes from `illuminationField`, which is the whole reason this
 * mode is usable on a page with a picture on it. See that comment for what a
 * plain wide box mean does to the picture.
 *
 * In colour, one gain is computed from the luma and applied to all three
 * channels, so the correction changes exposure without shifting hue.
 */
export function flattenIllumination(image: ImageLike, colour: boolean): ImageLike {
  const { data, width, height } = image;
  const grey = toGrey(image);
  const field = illuminationField(grey, width, height);

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gain = Math.max(
        MIN_GAIN,
        Math.min(MAX_GAIN, FLAT_WHITE / Math.max(1, fieldAt(field, x, y)))
      );

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

/**
 * Corners somebody set by hand, as fractions of their frame.
 *
 * Fractions rather than pixels because the frame is resampled on the way in:
 * a corner placed on the displayed photo has to survive that, and a ratio does
 * while a coordinate does not.
 */
export type FractionQuad = readonly [Point, Point, Point, Point];

async function processFrame(
  file: InputFile,
  mode: ScanMode,
  detect: boolean,
  given: FractionQuad | null = null
): Promise<FrameOutcome> {
  const bitmap = await createImageBitmap(new Blob([file.bytes as BlobPart]));

  let work: ImageLike;
  let found: QuadDetection | null = null;
  try {
    work = resample(bitmap, WORK_MAX_EDGE);

    // Corners the user placed are not a hint to be improved on. Detection is
    // good on a clean frame and wrong on a hard one, which is the entire
    // reason the editor exists — so where somebody has said where the page is,
    // that is where the page is.
    if (given) {
      const scaled = given.map((point) => ({
        x: point.x * work.width,
        y: point.y * work.height,
      })) as unknown as Quad;
      if (!quadProblem(scaled)) found = { quad: scaled, confidence: 1 };
    }

    if (!found && detect) {
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
  detect: boolean,
  /** Per file, aligned with `files`. Null means "find the page yourself". */
  quads: (FractionQuad | null)[] = []
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
      outcome = await processFrame(file, mode, detect, quads[index] ?? null);
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
      `Found the page edges in ${plural(detected, 'photo')} and corrected the perspective, so ${detected === 1 ? 'it is' : 'they are'} a rectangle again rather than a trapezium. The crop stops a few pixels inside the edge it found — about a third of a percent of the page — because the boundary in a photograph is a soft ramp and the last pixels of it are desk, not paper.`
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
