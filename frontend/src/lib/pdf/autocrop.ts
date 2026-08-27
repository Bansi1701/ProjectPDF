/**
 * Auto-crop — trimming a page down to the ink that is actually on it.
 *
 * This is the crop people actually want: a scanned book or a downloaded paper
 * with two inches of white around a column of text, and no desire to drag a
 * box on three hundred pages. It is a separate operation from crop.ts on
 * purpose, and the note at the foot of crop.ts explains why in full. The short
 * version, because it decides everything below:
 *
 *   The object model cannot find the ink. `Tj` positions a BASELINE, not a
 *   glyph extent, so a box built from text operands is short by a descender at
 *   the bottom — 2.17 pt for Helvetica at 10.5 pt, which is the tails of y, p,
 *   g and q. Clipped text is the one failure a crop tool must never produce,
 *   and without font metrics the error is not even detectable, so it could not
 *   be reported either. And a scanned page defeats the scan from the other
 *   side: it is one full-bleed image XObject drawn edge to edge, so an operand
 *   scan finds a box the size of the page and trims nothing, while the white
 *   margin the user wants gone lives inside the image's pixels where only a
 *   rasteriser can see it. That is precisely the document this tool exists for.
 *
 * So this one RENDERS. Each page goes through pdf.js onto an OffscreenCanvas,
 * the bitmap is scanned inward from all four sides for the first row and column
 * that is not background, and that box is mapped back through the viewport into
 * PDF user space. Only then does anything touch the document — and what it
 * touches is the same two rectangles crop.ts edits. The rendering is a
 * MEASUREMENT. It is thrown away. Nothing is rasterised into the output: the
 * content stream, fonts and images that come out are byte-for-byte the ones
 * that went in, exactly as with a hand-drawn crop.
 *
 * Three things decide whether the measurement is any good, and each of them is
 * a way this goes wrong:
 *
 *   1. THE BACKGROUND IS NOT WHITE. A scan's "white" is a noisy off-grey
 *      somewhere around 240, a photocopy's is beige, and a slide deck's may be
 *      navy. A hard `=== 255` threshold trims nothing on all three. The
 *      background is measured from the page's own border pixels and compared
 *      against with a tolerance scaled to how noisy those pixels are.
 *
 *   2. SPECKLE. One dust speck in a corner is enough to defeat the entire crop,
 *      because the first non-background pixel from that side is the speck. A
 *      row or column has to carry more than a trivial amount of ink before it
 *      counts as content; the rule is stated below and in the notes.
 *
 *   3. JITTER. Cropping every page to its own box makes a book flicker when you
 *      page through it, because a page with a short last line is a different
 *      height from the one before it. The default is therefore the UNION of
 *      every page's box, not each page's own.
 *
 * What this cannot do is stated in the notes rather than papered over: a page
 * whose border is not one consistent colour cannot be measured and is left
 * alone, a page that is ink from edge to edge has nothing to trim and is left
 * alone, and the box is inferred from a rendering rather than read from the
 * document, so it is only as right as the rendering is.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import type { PDFPage } from '@cantoo/pdf-lib';

import { MAX_CANVAS_PIXELS } from './images';
import { documentOptions, loadPdfjs } from './pdfjs';
import type { CropBox } from './crop';
import type { InputFile, OpResult } from './types';

export interface AutoCropOptions {
  /**
   * `uniform` (the default) crops every page to the union of all their content
   * boxes; `per-page` gives each page its own. See UNIFORM_DEFAULT below.
   */
  mode?: 'uniform' | 'per-page';
  /** Breathing room left around the ink, in points. Default 6 (~2 mm). */
  padding?: number;
  /** One-based pages to consider. Absent means every page. */
  pages?: number[];
  /** Render resolution. Only worth moving for a diagnosis; see DPI. */
  dpi?: number;
}

/** A rectangle in PDF user space, lower-left origin. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Geometry — kept deliberately in step with crop.ts
 *
 * crop.ts exports its `CropBox` type and its `crop` entry point and nothing
 * else; `visibleBox`, `rotationOf`, `toUserSpace` and `resolve` are module
 * private there, and crop.ts is not this change's file to edit. So the mapping
 * is restated here rather than imported, and it must stay identical: the two
 * files answer the same question ("where on the stored page is this point of
 * the displayed page?"), and any drift between them shows up as a crop that
 * lands in a different place depending on which tool the user reached for.
 * If these ever need to change, change them in both — or export them from
 * crop.ts and delete this block.
 * ------------------------------------------------------------------ */

/**
 * ISO 32000-1 Annex C puts the smallest legal page at 3 units on a side, and
 * Acrobat enforces it. Refusing beats handing over a file a reader repairs.
 */
const MIN_SIDE = 3;

/** Box coordinates are rounded to this many decimals so the file reads cleanly. */
const round = (n: number): number => Math.round(n * 10_000) / 10_000;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const clampTo = (n: number, low: number, high: number): number =>
  !Number.isFinite(n) ? low : n < low ? low : n > high ? high : n;

/** Normalises /Rotate the way a reader does: a multiple of 90 in 0..270. */
const rotationOf = (page: PDFPage): number => {
  const angle = page.getRotation().angle;
  if (!Number.isFinite(angle) || angle % 90 !== 0) return 0;
  return ((angle % 360) + 360) % 360;
};

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || top <= y) return null;
  return { x, y, width: right - x, height: top - y };
};

/**
 * The rectangle the reader actually shows.
 *
 * Mirrors pdf.js's own `Page.view` getter — CropBox intersected with MediaBox,
 * falling back to the MediaBox when the CropBox is degenerate or misses it.
 * It has to mirror it, because the box we are about to trim was measured on a
 * pdf.js rendering; any disagreement between the two is a crop offset by the
 * difference. `verifyViewport` below checks the two agree rather than assuming.
 */
const visibleBox = (page: PDFPage): Rect => {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  if (crop.width <= 0 || crop.height <= 0) return media;
  return intersect(crop, media) ?? media;
};

/**
 * One point of the displayed page, in PDF user space.
 *
 * `u` runs left→right and `v` runs top→bottom across the page as displayed,
 * both 0..1. For a quarter-turn the two axes swap: a page displayed at 90° is
 * `box.height` wide on screen, so `u` walks the box's y extent and `v` walks
 * its x extent.
 */
const toUserSpace = (
  box: Rect,
  rotation: number,
  u: number,
  v: number
): { x: number; y: number } => {
  switch (rotation) {
    case 90:
      return { x: box.x + v * box.width, y: box.y + u * box.height };
    case 180:
      return { x: box.x + (1 - u) * box.width, y: box.y + v * box.height };
    case 270:
      return { x: box.x + (1 - v) * box.width, y: box.y + (1 - u) * box.height };
    default:
      return { x: box.x + u * box.width, y: box.y + (1 - v) * box.height };
  }
};

/** Maps a rectangle on the displayed page onto the stored page, honouring /Rotate. */
const resolve = (box: Rect, rotation: number, crop: CropBox): Rect => {
  const a = toUserSpace(box, rotation, clamp01(crop.x), clamp01(crop.y));
  const b = toUserSpace(box, rotation, clamp01(crop.x + crop.width), clamp01(crop.y + crop.height));
  return {
    x: round(Math.min(a.x, b.x)),
    y: round(Math.min(a.y, b.y)),
    width: round(Math.abs(b.x - a.x)),
    height: round(Math.abs(b.y - a.y)),
  };
};

/** How big the visible box is as the reader draws it: rotation swaps the axes. */
const displaySize = (box: Rect, rotation: number): { width: number; height: number } =>
  rotation % 180 === 0
    ? { width: box.width, height: box.height }
    : { width: box.height, height: box.width };

/* ------------------------------------------------------------------ *
 * Detection constants
 * ------------------------------------------------------------------ */

/**
 * Render resolution, in DPI.
 *
 * We are looking for edges, not reading them, and the cost is quadratic: 300
 * DPI is nine times the pixels and nine times the scan for an answer nobody can
 * use. At 100 DPI one pixel is 0.72 pt, so the worst case edge error is well
 * under a point — an order of magnitude finer than the 6 pt of padding
 * deliberately added afterwards, and finer than the point-or-two anyone can
 * judge by eye. A Letter page is 850 × 1100 = 0.94 MP, which renders and scans
 * in a few milliseconds, so a 400-page book stays interactive.
 *
 * Going lower does start to cost accuracy that matters: at 72 DPI a hairline
 * rule and a row of small-caps both land on a single antialiased pixel, and the
 * tolerance has to be loosened to see them, which is the opposite of what a
 * noisy scan wants.
 */
const DPI = 100;
const MIN_DPI = 36;
const MAX_DPI = 300;

/**
 * Padding, in points.
 *
 * A crop that sits flush against the glyphs looks like a mistake even when it
 * is exactly right, and it leaves no room for the sub-pixel error above. 6 pt
 * is about 2 mm — visible as a margin, invisible as a waste of paper.
 */
const DEFAULT_PADDING = 6;
const MAX_PADDING = 144;

/**
 * How much has to come off a side before it is worth calling it a crop.
 *
 * Under a point is inside the measurement's own error. Rewriting the page boxes
 * to move an edge by half a point is churn that claims to be a result.
 */
const MIN_TRIM = 1;

/**
 * The band of pixels sampled to learn the page background, per side.
 *
 * Three pixels in from each edge. One row is enough for a clean render and not
 * enough for a scan, where the outermost row is often a compression artefact or
 * the edge of the platen.
 */
const BORDER_BAND = 3;

/** Enough border samples for a stable median; more is just sorting cost. */
const MAX_BORDER_SAMPLES = 4096;

/**
 * How far from the background a channel has to be before the pixel is ink,
 * on the 0–255 scale, as a floor and as a multiple of the border's own noise.
 *
 * The floor catches faint grey text on clean white. The noise term is what
 * makes a scan work: JPEG ringing and paper texture put the border's own
 * pixels several levels apart, and a threshold below that spread marks the
 * blank margin as content and trims nothing at all.
 */
const BASE_TOLERANCE = 12;
const NOISE_MULTIPLE = 4;
const MAX_TOLERANCE = 48;

/**
 * Above this much spread in the border pixels there is no single background to
 * measure against — the page bleeds to its edges, or it is a photograph. The
 * median would be an arbitrary colour and the crop would be an arbitrary box,
 * so the page is left alone and counted. Guessing here is how a crop tool eats
 * somebody's artwork.
 */
const MAD_LIMIT = 26;

/**
 * SPECKLE RULE. A row or column counts as content only when at least this many
 * of its pixels are ink: 4 pixels, or 0.15% of its length, whichever is larger
 * (0.15% is 2 px across a Letter page at 100 DPI, so 4 is the binding number on
 * anything page-shaped).
 *
 * Four pixels at 100 DPI is roughly a 1 mm mark. A dust speck, a scanner hot
 * pixel or a JPEG block artefact is one to three; a full stop is two to three;
 * the top row of a capital letter is several, and any row through a line of
 * text is dozens. So the rule loses at most the tip of an isolated ascender —
 * under a point, and inside the padding — and gains immunity to the single
 * corner speck that otherwise defeats the whole crop.
 *
 * It is a per-line count and nothing cleverer: ink is counted along the full
 * length of the row or column, so ten specks scattered down one column will
 * still hold that column. That is a known limit, and it is in the notes.
 */
const INK_MIN_PIXELS = 4;
const INK_MIN_FRACTION = 0.0015;

/**
 * UNIFORM_DEFAULT — why the union, and not each page's own box.
 *
 * Per-page is the tighter crop and the worse document. Pages of a book differ
 * by a short last line, a running head that appears only on rectos, a figure
 * that runs wider than the text block; crop each to itself and the text jumps
 * around as you page through, every page is a slightly different size, and the
 * file no longer prints on one sheet size. The union is the smallest single
 * rectangle that clips nothing anywhere, which is what "trim the margins off
 * this book" actually means. Per-page stays available for the case it is right
 * for — a stack of unrelated scans, receipts, a batch of tickets.
 *
 * The union is taken per page SIZE, not across the whole document: unioning an
 * A4 page with a landscape foldout produces a box that belongs to neither.
 */
const UNIFORM_DEFAULT: 'uniform' = 'uniform';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/** Parses the page list, one-based, into sorted unique indexes. */
const targetsFor = (pages: number[] | undefined, count: number): number[] => {
  if (!pages || pages.length === 0) return Array.from({ length: count }, (_, i) => i + 1);
  return [...new Set(pages)].filter((page) => Number.isInteger(page)).sort((a, b) => a - b);
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (high === undefined) return 0;
  if (sorted.length % 2 === 1 || low === undefined) return high;
  return (low + high) / 2;
};

/** Rec. 601 luma, integer weights. Only ever compared against itself. */
const luma = (r: number, g: number, b: number): number => (299 * r + 587 * g + 114 * b) / 1000;

/* ------------------------------------------------------------------ *
 * The measurement
 * ------------------------------------------------------------------ */

interface Background {
  r: number;
  g: number;
  b: number;
  /** Per-channel distance at which a pixel stops being background. */
  tolerance: number;
  /** Median absolute deviation of the border's luma — how noisy the paper is. */
  spread: number;
}

/**
 * What the page background is, learned from the page's own border.
 *
 * The median, not the mean: a coloured header bar or a black scanner edge that
 * touches one side puts a quarter of the ring far from the paper colour, and a
 * mean would be dragged toward it while a median ignores it entirely. The
 * spread is measured the same robust way, and it is what tells us whether
 * there is a background here at all.
 */
function sampleBackground(data: Uint8ClampedArray, width: number, height: number): Background {
  const band = Math.max(1, Math.min(BORDER_BAND, Math.floor(Math.min(width, height) / 8)));

  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  const perimeter = 2 * (width + height) * band;
  const stride = Math.max(1, Math.ceil(perimeter / MAX_BORDER_SAMPLES));
  let seen = 0;

  const take = (x: number, y: number): void => {
    if ((seen += 1) % stride !== 0) return;
    const at = (y * width + x) * 4;
    reds.push(data[at] ?? 255);
    greens.push(data[at + 1] ?? 255);
    blues.push(data[at + 2] ?? 255);
  };

  for (let y = 0; y < band && y < height; y += 1) {
    for (let x = 0; x < width; x += 1) take(x, y);
  }
  for (let y = Math.max(band, height - band); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) take(x, y);
  }
  for (let x = 0; x < band && x < width; x += 1) {
    for (let y = band; y < height - band; y += 1) take(x, y);
  }
  for (let x = Math.max(band, width - band); x < width; x += 1) {
    for (let y = band; y < height - band; y += 1) take(x, y);
  }

  const r = Math.round(median(reds));
  const g = Math.round(median(greens));
  const b = Math.round(median(blues));

  const centre = luma(r, g, b);
  const deviations = reds.map((red, i) =>
    Math.abs(luma(red, greens[i] ?? 0, blues[i] ?? 0) - centre)
  );
  const spread = median(deviations);

  return {
    r,
    g,
    b,
    tolerance: clampTo(BASE_TOLERANCE + NOISE_MULTIPLE * spread, BASE_TOLERANCE, MAX_TOLERANCE),
    spread,
  };
}

/** Why a page could not be measured, in the user's words. */
type Unmeasurable = 'blank' | 'no-background' | 'viewport-mismatch' | 'too-small';

/** The ink box in display-space pixels, or the reason there isn't one. */
type Ink = { ok: true; left: number; top: number; right: number; bottom: number } | { ok: false; why: Unmeasurable };

/**
 * Scan inward from every side for the first row and column carrying real ink.
 *
 * Ink is a per-channel distance from the background, not a luma distance: a red
 * stamp and a mid-grey rule can share a luma with the paper around them while
 * being obviously not it, and the channel-wise maximum sees both.
 */
function findInk(data: Uint8ClampedArray, width: number, height: number, bg: Background): Ink {
  if (bg.spread > MAD_LIMIT) return { ok: false, why: 'no-background' };

  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);
  const tol = bg.tolerance;

  for (let y = 0; y < height; y += 1) {
    let at = y * width * 4;
    let row = 0;
    for (let x = 0; x < width; x += 1, at += 4) {
      const dr = Math.abs((data[at] ?? 0) - bg.r);
      const dg = Math.abs((data[at + 1] ?? 0) - bg.g);
      const db = Math.abs((data[at + 2] ?? 0) - bg.b);
      if (dr > tol || dg > tol || db > tol) {
        row += 1;
        colInk[x] += 1;
      }
    }
    rowInk[y] = row;
  }

  const rowFloor = Math.max(INK_MIN_PIXELS, Math.ceil(width * INK_MIN_FRACTION));
  const colFloor = Math.max(INK_MIN_PIXELS, Math.ceil(height * INK_MIN_FRACTION));

  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    if ((rowInk[y] ?? 0) >= rowFloor) {
      if (top < 0) top = y;
      bottom = y;
    }
  }

  let left = -1;
  let right = -1;
  for (let x = 0; x < width; x += 1) {
    if ((colInk[x] ?? 0) >= colFloor) {
      if (left < 0) left = x;
      right = x;
    }
  }

  // Blank, or nothing above the speckle floor — which for our purposes is the
  // same thing: there is no content to crop to, and a box around a speck is
  // worse than no box at all.
  if (top < 0 || left < 0) return { ok: false, why: 'blank' };

  // Half-open on the far side: the last ink row is inside the box.
  return { ok: true, left, top, right: right + 1, bottom: bottom + 1 };
}

/* ------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------ */

/** One page, measured. Extents are display-space POINTS from the top-left. */
interface Measured {
  number: number;
  visible: Rect;
  rotation: number;
  display: { width: number; height: number };
  ink: { left: number; top: number; right: number; bottom: number } | null;
  why: Unmeasurable | null;
}

export async function autoCrop(
  files: InputFile[],
  options: AutoCropOptions = {}
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  const mode = options.mode === 'per-page' ? 'per-page' : UNIFORM_DEFAULT;
  const padding = clampTo(options.padding ?? DEFAULT_PADDING, 0, MAX_PADDING);
  const dpi = clampTo(options.dpi ?? DPI, MIN_DPI, MAX_DPI);

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  } catch {
    return {
      ok: false,
      error: `${file.name} could not be read. If it is password-protected, remove the password first with Unlock.`,
    };
  }

  const count = pdf.getPageCount();
  const targets = targetsFor(options.pages, count);
  if (targets.length === 0) {
    return { ok: false, error: 'No pages were selected, so there was nothing to crop.' };
  }
  for (const number of targets) {
    if (number < 1 || number > count) {
      return { ok: false, error: `Page ${number} does not exist — ${file.name} has ${count}.` };
    }
  }

  const api = await loadPdfjs();

  // pdf.js takes ownership of the buffer it is handed and detaches it, and
  // pdf-lib is holding a view onto `file.bytes` that it will read again at
  // save() time. The renderer gets its own copy or the saved file comes out
  // empty — a failure that only shows up at the very end, on every document.
  const raster = file.bytes.slice(0);

  let source: Awaited<ReturnType<typeof api.getDocument>['promise']>;
  try {
    source = await api.getDocument({ data: new Uint8Array(raster), ...documentOptions() }).promise;
  } catch {
    return {
      ok: false,
      error: `${file.name} could not be rendered, so there was no way to find where the content is. If it is password-protected, remove the password first with Unlock.`,
    };
  }

  const measured: Measured[] = [];

  try {
    for (const number of targets) {
      const leaf = pdf.getPage(number - 1);
      const visible = visibleBox(leaf);
      const rotation = rotationOf(leaf);
      const display = displaySize(visible, rotation);

      const blank: Measured = { number, visible, rotation, display, ink: null, why: null };

      if (display.width <= 0 || display.height <= 0) {
        measured.push({ ...blank, why: 'too-small' });
        continue;
      }

      const page = await source.getPage(number);
      const unit = page.getViewport({ scale: 1 });

      // pdf-lib resolves the page boxes from the object model; pdf.js resolves
      // them through its own inheritance and normalisation. They agree on every
      // document I have, and where they would not, the box measured on one
      // would be applied to the other and land somewhere the ink is not. Check
      // rather than trust: a page that disagrees is left alone and counted.
      if (
        Math.abs(unit.width - display.width) > 1 ||
        Math.abs(unit.height - display.height) > 1
      ) {
        measured.push({ ...blank, why: 'viewport-mismatch' });
        page.cleanup();
        continue;
      }

      let scale = dpi / 72;
      if (unit.width * scale * unit.height * scale > MAX_CANVAS_PIXELS) {
        scale = Math.sqrt(MAX_CANVAS_PIXELS / (unit.width * unit.height));
      }

      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        await source.destroy();
        return { ok: false, error: 'This browser would not give us a canvas to render into.' };
      }

      // The substrate a reader paints on. A PDF page has no background of its
      // own — what you see behind the ink is either something the page draws or
      // the viewer's white. Painting it here means a page that draws its own
      // background is measured against that colour (sampleBackground finds it),
      // and a page that draws none is measured against white, which is what
      // every reader shows.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
        canvas: canvas as unknown as HTMLCanvasElement,
        // ENABLE, not ENABLE_FORMS. ENABLE_FORMS omits widget annotations on
        // the assumption that an interactive form layer will draw them on top;
        // there is no such layer here, so a filled-in form field would be
        // invisible to the scan and cropped straight off the page.
        annotationMode: api.AnnotationMode.ENABLE,
      }).promise;

      const bitmap = ctx.getImageData(0, 0, width, height).data;
      const background = sampleBackground(bitmap, width, height);
      const ink = findInk(bitmap, width, height, background);
      page.cleanup();

      if (!ink.ok) {
        measured.push({ ...blank, why: ink.why });
        continue;
      }

      // Pixels → display-space points. `scale` is px per point in both axes.
      measured.push({
        ...blank,
        ink: {
          left: ink.left / scale,
          top: ink.top / scale,
          right: ink.right / scale,
          bottom: ink.bottom / scale,
        },
      });
    }
  } catch (error) {
    await source.destroy();
    return { ok: false, error: `Could not measure the pages: ${(error as Error).message}` };
  }

  await source.destroy();

  /* ---- decide the box(es) ---------------------------------------- */

  // Uniform mode unions within a page size, never across sizes. The key is the
  // size as DISPLAYED, so a portrait page stored landscape under /Rotate 90
  // groups with the portrait pages it looks like rather than the landscape ones
  // it is stored as.
  const sizeKey = (page: Measured): string =>
    `${Math.round(page.display.width)}x${Math.round(page.display.height)}`;

  type Extent = { left: number; top: number; right: number; bottom: number };
  const unions = new Map<string, Extent>();
  if (mode === 'uniform') {
    for (const page of measured) {
      if (!page.ink) continue;
      const key = sizeKey(page);
      const so_far = unions.get(key);
      unions.set(
        key,
        so_far
          ? {
              left: Math.min(so_far.left, page.ink.left),
              top: Math.min(so_far.top, page.ink.top),
              right: Math.max(so_far.right, page.ink.right),
              bottom: Math.max(so_far.bottom, page.ink.bottom),
            }
          : { ...page.ink }
      );
    }
  }

  /* ---- apply ------------------------------------------------------ */

  let cropped = 0;
  let blankPages = 0;
  let fullBleed = 0;
  let unreadableBackground = 0;
  let mismatched = 0;
  let alreadyTight = 0;
  let rotatedPages = 0;
  let previouslyCropped = 0;
  let tightenedPrintBoxes = 0;
  let blanksFollowedTheUnion = 0;

  const trims: Extent[] = [];
  const keptFractions: number[] = [];
  const beforeSizes = new Set<string>();
  const afterSizes = new Set<string>();

  for (const page of measured) {
    if (page.why === 'no-background') {
      unreadableBackground += 1;
      continue;
    }
    if (page.why === 'viewport-mismatch') {
      mismatched += 1;
      continue;
    }
    if (page.why === 'too-small') {
      alreadyTight += 1;
      continue;
    }

    // In uniform mode a blank page still takes the union: a blank verso in the
    // middle of a book that stayed full-size while its neighbours shrank is the
    // jitter this mode exists to avoid. In per-page mode there is no box to
    // give it, so it is left alone.
    const extent = mode === 'uniform' ? (unions.get(sizeKey(page)) ?? null) : page.ink;
    if (!extent) {
      blankPages += 1;
      continue;
    }
    const borrowedTheUnion = page.ink === null;

    const { width: W, height: H } = page.display;

    const left = Math.max(0, extent.left - padding);
    const top = Math.max(0, extent.top - padding);
    const right = Math.min(W, extent.right + padding);
    const bottom = Math.min(H, extent.bottom + padding);

    const trim = { left, top, right: W - right, bottom: H - bottom };

    // Nothing worth doing, in either of its two flavours: a page that is ink
    // from edge to edge (the full-bleed photograph, the scan with no margin),
    // and a page someone has already cropped tight. Both come out as four
    // trims under a point. Rewriting the boxes to move an edge by half a point
    // is churn dressed as a result, so the page is left exactly as it was.
    if (
      trim.left < MIN_TRIM &&
      trim.top < MIN_TRIM &&
      trim.right < MIN_TRIM &&
      trim.bottom < MIN_TRIM
    ) {
      fullBleed += 1;
      continue;
    }

    if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) {
      alreadyTight += 1;
      continue;
    }

    const leaf = pdf.getPage(page.number - 1);
    const media = leaf.getMediaBox();
    if (page.visible.width < media.width - 0.5 || page.visible.height < media.height - 0.5) {
      previouslyCropped += 1;
    }
    if (page.rotation !== 0) rotatedPages += 1;

    const kept = resolve(page.visible, page.rotation, {
      x: left / W,
      y: top / H,
      width: (right - left) / W,
      height: (bottom - top) / H,
    });

    // Both boxes, for the reason crop.ts sets both: the CropBox is what a
    // reader shows, the MediaBox is what every print pipeline and rasteriser
    // measures. Move one and the page is cropped in one tool and not the next.
    leaf.setCropBox(kept.x, kept.y, kept.width, kept.height);
    leaf.setMediaBox(kept.x, kept.y, kept.width, kept.height);

    // Bleed, trim and art boxes must sit inside the CropBox. Only pages that
    // already carry them are touched — adding them would be inventing prepress
    // intent the document never had.
    for (const [present, apply] of [
      [leaf.node.BleedBox(), (r: Rect) => leaf.setBleedBox(r.x, r.y, r.width, r.height)],
      [leaf.node.TrimBox(), (r: Rect) => leaf.setTrimBox(r.x, r.y, r.width, r.height)],
      [leaf.node.ArtBox(), (r: Rect) => leaf.setArtBox(r.x, r.y, r.width, r.height)],
    ] as const) {
      if (!present) continue;
      const existing = present.asRectangle();
      const tightened = intersect(existing, kept) ?? kept;
      apply(tightened);
      const moved =
        Math.abs(tightened.x - existing.x) > 0.01 ||
        Math.abs(tightened.y - existing.y) > 0.01 ||
        Math.abs(tightened.width - existing.width) > 0.01 ||
        Math.abs(tightened.height - existing.height) > 0.01;
      if (moved) tightenedPrintBoxes += 1;
    }

    cropped += 1;
    if (borrowedTheUnion) blanksFollowedTheUnion += 1;
    trims.push(trim);
    keptFractions.push(((right - left) * (bottom - top)) / (W * H));
    beforeSizes.add(`${Math.round(W)} × ${Math.round(H)}`);
    afterSizes.add(`${Math.round(right - left)} × ${Math.round(bottom - top)}`);
  }

  if (cropped === 0) {
    const reason =
      unreadableBackground > 0
        ? 'Every page runs to its edges or has no single background colour behind it, so there is no margin to find. Use Crop to draw the box yourself.'
        : blankPages + fullBleed > 0
          ? 'Nothing to trim — the pages are already tight to their content, or they are blank. Use Crop if you want to take more off.'
          : 'No page could be measured, so nothing was cropped. Use Crop to draw the box yourself.';
    return { ok: false, error: reason };
  }

  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });

  /* ---- report ----------------------------------------------------- */

  const trimmedPercent = Math.round(
    100 * (1 - keptFractions.reduce((sum, n) => sum + n, 0) / keptFractions.length)
  );

  const side = (pick: (t: Extent) => number): string => {
    const values = trims.map(pick);
    const low = Math.round(Math.min(...values));
    const high = Math.round(Math.max(...values));
    return low === high ? `${low}` : `${low}–${high}`;
  };

  const parts = [`${cropped} page${cropped === 1 ? '' : 's'} auto-cropped`];
  if (beforeSizes.size === 1 && afterSizes.size === 1) {
    parts.push(`${[...beforeSizes][0]} → ${[...afterSizes][0]} pt`);
  }
  parts.push(
    `${side((t) => t.left)} left, ${side((t) => t.right)} right, ${side((t) => t.top)} top, ${side((t) => t.bottom)} bottom trimmed`
  );
  parts.push(`${trimmedPercent}% of the page area removed`);

  const notes: string[] = [];

  notes.push(
    `Each page was rendered at ${Math.round(dpi)} DPI purely to find its edges, and the rendering was thrown away. Only the page boxes changed: the text, images and fonts in the file you get back are byte-for-byte the ones that went in. One pixel is ${(72 / dpi).toFixed(2)} pt, so an edge can be out by up to that much — well inside the ${Math.round(padding)} pt of padding.`
  );

  notes.push(
    `The background colour was measured from each page's own border pixels rather than assumed to be white, and a pixel counts as content when a colour channel is more than ${BASE_TOLERANCE}–${MAX_TOLERANCE} levels away from it — the looser end on a noisy scan, scaled to how much the border pixels vary among themselves.`
  );

  notes.push(
    `Speckle rule: a row or column has to carry at least ${INK_MIN_PIXELS} content pixels (about 1 mm) before it counts, so one dust speck or hot pixel cannot hold the crop open. The cost is that up to ${INK_MIN_PIXELS} pixels of an isolated thin mark — the very tip of a lone ascender — can fall below the rule; the padding is there to cover it. Ink is counted along the whole row or column, so several specks scattered down one line will still hold it.`
  );

  notes.push(
    mode === 'uniform'
      ? `Every page was cropped to the same box — the union of all the pages' content — so the text does not jump around as you page through. That box is per page size${unions.size > 1 ? `, and this file has ${unions.size} of them` : ''}. A single page with a wide figure therefore keeps the margins open for all of them; switch to per-page if you want each cropped as tight as it will go.`
      : 'Each page was cropped to its own content, so pages will differ in size and the text will shift as you page through. Use the uniform setting if this is a book or a report.'
  );

  if (blanksFollowedTheUnion > 0) {
    notes.push(
      `${blanksFollowedTheUnion} page${blanksFollowedTheUnion === 1 ? ' was' : 's were'} blank and had no content to measure, so ${blanksFollowedTheUnion === 1 ? 'it was' : 'they were'} given the same box as the rest rather than left at full size.`
    );
  }
  if (blankPages > 0) {
    notes.push(
      `${blankPages} page${blankPages === 1 ? ' was' : 's were'} blank, or carried nothing above the speckle rule, so ${blankPages === 1 ? 'it was' : 'they were'} left at full size.`
    );
  }
  if (fullBleed > 0) {
    notes.push(
      `${fullBleed} page${fullBleed === 1 ? ' runs' : 's run'} to the edges already — a full-bleed image, or a page cropped tight before — so ${fullBleed === 1 ? 'it was' : 'they were'} left untouched rather than shaved by a fraction of a point.`
    );
  }
  if (unreadableBackground > 0) {
    notes.push(
      `${unreadableBackground} page${unreadableBackground === 1 ? "'s" : "s'"} border was not one consistent colour — a photograph bleeding off the page, or a scan with a dark platen edge — so there was no background to measure content against and ${unreadableBackground === 1 ? 'it was' : 'they were'} left alone. Cropping those needs a box you draw yourself.`
    );
  }
  if (mismatched > 0) {
    notes.push(
      `${mismatched} page${mismatched === 1 ? "'s" : "s'"} size read differently through the renderer than through the document's own page boxes, so ${mismatched === 1 ? 'it was' : 'they were'} left alone rather than cropped to a box measured on a different rectangle. Please report a file that does this.`
    );
  }
  if (alreadyTight > 0) {
    notes.push(
      `${alreadyTight} page${alreadyTight === 1 ? ' was' : 's were'} too small to crop without falling under the 3-point minimum a PDF page is allowed to be, so ${alreadyTight === 1 ? 'it was' : 'they were'} left alone.`
    );
  }
  if (rotatedPages > 0) {
    notes.push(
      `${rotatedPages} page${rotatedPages === 1 ? ' was' : 's were'} stored rotated, so the box found on screen was mapped back into the page's own coordinates before cropping.`
    );
  }
  if (previouslyCropped > 0) {
    notes.push(
      `${previouslyCropped} page${previouslyCropped === 1 ? ' had' : 's had'} been cropped before, so the new box was measured against what you could actually see rather than the full sheet.`
    );
  }
  if (tightenedPrintBoxes > 0) {
    notes.push(
      `${tightenedPrintBoxes} bleed, trim or art box sat outside the new page and was pulled inside it, which is what the PDF spec requires.`
    );
  }

  // The honest limit of the whole method, and it is not a small one.
  notes.push(
    'The box was inferred from a picture of each page, not read from the document — so it is only as accurate as that picture. Content the renderer draws differently from your reader (a substituted font, a soft mask without its transfer curve) moves the box with it, and an annotation with no appearance of its own is not drawn at all and so is not protected.'
  );

  notes.push(
    'Cropping hides what falls outside the box; it does not delete it. Anything trimmed is still in the file and comes back if the page boxes are reset. If something needs to be gone for good, use Redact instead.'
  );
  notes.push('Everything happened in this tab. Nothing was uploaded.');

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-cropped.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: count,
    durationMs: performance.now() - started,
    summary: parts.join(' · '),
    notes,
  };
}
