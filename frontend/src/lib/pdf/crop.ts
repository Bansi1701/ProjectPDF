/**
 * Crop — trimming the margins off a page.
 *
 * Cropping a PDF is not a pixel operation. Nothing is rasterised, re-encoded or
 * thrown away: a page carries a set of rectangles in its dictionary, and a crop
 * is an edit to two of them. That is why this file is geometry and almost
 * nothing else, and why the result is lossless in the strict sense — the
 * content stream that comes out is the one that went in.
 *
 * The geometry is where the bodies are buried, and there are three graves:
 *
 *   1. A page's visible area is NOT `[0 0 width height]`. Scanners and
 *      imposition tools routinely emit a MediaBox like `[20 20 615 812]`, and
 *      a page that has been cropped once already has a CropBox smaller than
 *      its MediaBox. The user drew their box on a rendering of the visible
 *      area, so the fractions have to be resolved against that same rectangle
 *      — origin included — or the crop lands somewhere the user never pointed.
 *      Documents with an offset or pre-cropped box are exactly the documents
 *      people reach for a crop tool to fix, so getting this wrong fails on the
 *      whole population that matters.
 *
 *   2. A page with /Rotate 90 is stored one way and displayed another. The
 *      rectangle arrives in the coordinates of the *displayed* page and has to
 *      be rotated back into the page's own coordinates before it means
 *      anything. All four angles are handled below.
 *
 *   3. The PDF y-axis runs up from the bottom of the page; a rectangle dragged
 *      with a pointer runs down from the top. Every mapping here flips it.
 *
 * What this deliberately does not do: guess where the content is. The note at
 * the foot of this file says why, and what it would actually take.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import type { PDFPage } from '@cantoo/pdf-lib';

import type { InputFile, OpResult } from './types';

/**
 * The rectangle to keep, in fractions of the page AS THE USER SAW IT.
 *
 * Same shape and same reasoning as `RedactionBox` in types.ts: 0..1 on both
 * axes with `y` measured downward from the top edge, so the numbers survive
 * whatever scale the page happened to be rendered at. Rotation is already
 * applied — these are coordinates on the displayed page, not on the stored one.
 */
export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in PDF user space, lower-left origin. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/**
 * ISO 32000-1 Annex C puts the smallest legal page at 3 units on a side, and
 * Acrobat enforces it. Refusing here beats handing over a file that a reader
 * silently repairs back to full size.
 */
const MIN_SIDE = 3;

/**
 * How close to the page edge still counts as "the whole page".
 *
 * 0.1% of a side is about half a point on A4 — under a pointer's own accuracy,
 * so a box this close to the edges was meant to be the edge.
 */
const EDGE_SLOP = 0.001;

/** Box coordinates are rounded to this many decimals so the file reads cleanly. */
const round = (n: number): number => Math.round(n * 10_000) / 10_000;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

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
 * The rectangle the reader actually shows, which is what the user drew on.
 *
 * This mirrors pdf.js's own `Page.view` getter step for step — CropBox
 * intersected with MediaBox, falling back to the MediaBox when the CropBox is
 * degenerate or misses it entirely. It has to mirror it, because the fractions
 * we are handed were measured against a pdf.js rendering; any disagreement
 * between the two shows up as a crop offset by the difference.
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
 * its x extent. Derived against pdf.js's viewport transform rather than by
 * intuition — the sign errors in this function are invisible on a square crop
 * of a symmetric page and glaring on everything else.
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

/** Maps the drawn rectangle onto one page's visible box, honouring /Rotate. */
const resolve = (box: Rect, rotation: number, crop: CropBox): Rect => {
  const u0 = clamp01(crop.x);
  const v0 = clamp01(crop.y);
  const u1 = clamp01(crop.x + crop.width);
  const v1 = clamp01(crop.y + crop.height);

  const a = toUserSpace(box, rotation, u0, v0);
  const b = toUserSpace(box, rotation, u1, v1);

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x: round(x),
    y: round(y),
    width: round(Math.abs(b.x - a.x)),
    height: round(Math.abs(b.y - a.y)),
  };
};

/** Parses the page list, one-based, into sorted unique indexes. */
const targetsFor = (pages: number[] | undefined, count: number): number[] => {
  if (!pages || pages.length === 0) return Array.from({ length: count }, (_, i) => i + 1);
  return [...new Set(pages)].filter((page) => Number.isInteger(page)).sort((a, b) => a - b);
};

export async function crop(files: InputFile[], box: CropBox, pages?: number[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  const finite =
    Number.isFinite(box?.x) &&
    Number.isFinite(box?.y) &&
    Number.isFinite(box?.width) &&
    Number.isFinite(box?.height);
  if (!finite || box.width <= 0 || box.height <= 0) {
    return { ok: false, error: 'Drag a box over the part of the page you want to keep first.' };
  }

  const left = clamp01(box.x);
  const top = clamp01(box.y);
  const right = clamp01(box.x + box.width);
  const bottom = clamp01(box.y + box.height);
  if (right - left <= 0 || bottom - top <= 0) {
    return { ok: false, error: 'That box sits off the edge of the page, so it would keep nothing. Drag it back over the page.' };
  }
  if (left <= EDGE_SLOP && top <= EDGE_SLOP && right >= 1 - EDGE_SLOP && bottom >= 1 - EDGE_SLOP) {
    return { ok: false, error: 'That box covers the whole page, so there is nothing to trim. Drag a smaller one.' };
  }

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
  const targets = targetsFor(pages, count);
  if (targets.length === 0) {
    return { ok: false, error: 'No pages were selected, so there was nothing to crop.' };
  }
  for (const page of targets) {
    if (page < 1 || page > count) {
      return { ok: false, error: `Page ${page} does not exist — ${file.name} has ${count}.` };
    }
  }

  let rotatedPages = 0;
  let alreadyCropped = 0;
  let tightenedPrintBoxes = 0;
  const sizes = new Set<string>();

  for (const number of targets) {
    const page = pdf.getPage(number - 1);
    const media = page.getMediaBox();
    const visible = visibleBox(page);
    const wasCropped =
      visible.width < media.width - 0.5 || visible.height < media.height - 0.5;
    if (wasCropped) alreadyCropped += 1;

    const rotation = rotationOf(page);
    if (rotation !== 0) rotatedPages += 1;

    const kept = resolve(visible, rotation, box);
    if (kept.width < MIN_SIDE || kept.height < MIN_SIDE) {
      return {
        ok: false,
        error: `That box would leave page ${number} at ${Math.round(kept.width)} × ${Math.round(kept.height)} points, below the 3-point minimum a PDF page is allowed to be. Drag a larger box.`,
      };
    }

    // Both boxes, deliberately.
    //
    // The CropBox is the region a reader displays and prints; the MediaBox is
    // the sheet the page is imposed on. Setting only the CropBox is the
    // reversible crop — the trimmed margins stay one dictionary edit away from
    // coming back — but it also means every tool that reads the MediaBox to
    // answer "how big is this page" (print pipelines, most rasterisers,
    // pdf-lib's own getSize) still reports the old size, so the page looks
    // cropped in one place and uncropped in the next. When someone says "crop",
    // they mean the page is now this size, everywhere. So the MediaBox moves
    // with it, and the two stay equal.
    page.setCropBox(kept.x, kept.y, kept.width, kept.height);
    page.setMediaBox(kept.x, kept.y, kept.width, kept.height);

    // Bleed, trim and art boxes are required to sit inside the CropBox. A page
    // that declares them and is then cropped past them is malformed, and
    // prepress tools are the ones that notice. Only pages that actually carry
    // these keys are touched — adding them where they were absent would be
    // inventing prepress intent the document never had.
    for (const [present, apply] of [
      [page.node.BleedBox(), (r: Rect) => page.setBleedBox(r.x, r.y, r.width, r.height)],
      [page.node.TrimBox(), (r: Rect) => page.setTrimBox(r.x, r.y, r.width, r.height)],
      [page.node.ArtBox(), (r: Rect) => page.setArtBox(r.x, r.y, r.width, r.height)],
    ] as const) {
      if (!present) continue;
      const existing = present.asRectangle();
      const tightened = intersect(existing, kept) ?? kept;
      apply(tightened);

      // Count it only when it MOVED. A print-ready page whose TrimBox already
      // sits inside the new crop is untouched, and reporting it as "pulled
      // inside" describes something that did not happen.
      const moved =
        Math.abs(tightened.x - existing.x) > 0.01 ||
        Math.abs(tightened.y - existing.y) > 0.01 ||
        Math.abs(tightened.width - existing.width) > 0.01 ||
        Math.abs(tightened.height - existing.height) > 0.01;
      if (moved) tightenedPrintBoxes += 1;
    }

    sizes.add(`${Math.round(kept.width)} × ${Math.round(kept.height)}`);
  }

  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });

  const n = targets.length;
  const keptPercent = Math.round((right - left) * (bottom - top) * 100);

  const parts = [`${n} page${n === 1 ? '' : 's'} cropped`];
  if (sizes.size === 1) parts.push(`${[...sizes][0]} pt`);
  parts.push(`${keptPercent}% of the page kept`);

  const notes = [
    'Only the page boxes changed. The text, images and fonts are byte-for-byte what they were — nothing was rasterised or re-encoded.',
  ];
  if (rotatedPages > 0) {
    notes.push(
      `${rotatedPages} page${rotatedPages === 1 ? ' was' : 's were'} stored rotated, so the box you drew was mapped back into the page's own coordinates before cropping.`
    );
  }
  if (alreadyCropped > 0) {
    notes.push(
      `${alreadyCropped} page${alreadyCropped === 1 ? ' had' : 's had'} been cropped before, so the new box was measured against what you could actually see rather than the full sheet.`
    );
  }
  if (tightenedPrintBoxes > 0) {
    notes.push(
      `${tightenedPrintBoxes} bleed, trim or art box sat outside the new page and was pulled inside it, which is what the PDF spec requires.`
    );
  }
  notes.push(
    'Cropping hides what falls outside the box; it does not delete it. If something needs to be gone for good, use Redact instead.'
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

/**
 * Why there is no auto-crop-to-content here.
 *
 * It cannot be done honestly with pdf-lib alone. pdf-lib is an object-model
 * library: it can hand back a page's content stream as bytes, but it has no
 * content-stream interpreter, no graphics state, no font metrics and no
 * knowledge of what any operator paints. Finding the ink means running the
 * page, and running the page is a renderer.
 *
 * A stream scan that looked for drawing operators and took the bounding box of
 * their operands would be wrong in both directions on the two documents people
 * most want auto-crop for. A scanned page is a single full-bleed image XObject
 * drawn edge to edge, so an operand scan finds a bounding box the size of the
 * page and trims nothing — while the white border the user wanted gone is
 * inside the image's pixels, invisible to anything but a rasteriser. A text
 * page is the opposite: `Tj` positions a baseline, not a glyph extent, so
 * without font metrics the box is short by an ascender at the top and a
 * descender at the bottom, and clipped text is the one failure a crop tool must
 * never produce. Neither error is detectable from the object model, so neither
 * could even be reported.
 *
 * Doing it properly means rasterising each page with pdf.js, scanning the
 * bitmap for the first non-background row and column on each side, and mapping
 * that back through the viewport — real, and a different operation with a
 * different cost and a different set of honest caveats. It belongs in its own
 * function, not smuggled in behind a checkbox on this one.
 */
