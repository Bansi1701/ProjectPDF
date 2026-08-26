/**
 * Overlay — laying one PDF over (or under) another.
 *
 * Two documents go in: a *base* and a *stamp*. Each stamp page becomes a form
 * XObject, and that form is painted onto a base page. Nothing is rasterised;
 * the stamp's text stays text and the base document keeps its own annotations,
 * links and form fields, because the base pages are edited in place rather
 * than rebuilt into a new file.
 *
 * Three things make this harder than "draw a picture at x, y", and all three
 * are geometry:
 *
 *   1. **A page's visible area is not `[0 0 width height]`.** It is the
 *      CropBox intersected with the MediaBox, and either can be offset from
 *      the origin. An anchor resolved against the MediaBox lands in the
 *      margin of any page that has ever been cropped or imposed — and a
 *      letterhead is exactly the kind of file that has been.
 *
 *   2. **`/Rotate` means the page is stored one way and read another.** The
 *      user picks "top-right" meaning the top-right of what they can see. On a
 *      page with `/Rotate 90` that corner is somewhere else in the page's own
 *      coordinates, and the stamp also has to be turned so it reads upright
 *      rather than lying on its side. This is the case naive overlays get
 *      wrong, because it is invisible on the majority of documents that have
 *      no rotation at all. Both the base's rotation and the *stamp's* own
 *      rotation are handled — pdf-lib's `embedPage` ignores `/Rotate`
 *      entirely and defaults its bounding box to the MediaBox, so a rotated or
 *      pre-cropped stamp comes through sideways and padded unless the caller
 *      corrects it. The correction is the `stampMatrix` below.
 *
 *   3. **"Under" is not a drawing option.** PDF has no z-index: painting order
 *      *is* z-order. pdf-lib always appends, so an under-stamp is produced by
 *      appending and then moving the new stream to the front of the page's
 *      `/Contents` array. That is why letterhead works — the base document's
 *      text keeps painting last, on top of the letterhead, instead of being
 *      buried by it.
 */
import { PDFArray, PDFDocument, PDFName, PDFStream, degrees } from '@cantoo/pdf-lib';
import type { PDFEmbeddedPage, PDFPage, TransformationMatrix } from '@cantoo/pdf-lib';

import type { InputFile, OpResult } from './types';

/** How stamp pages are matched to base pages. */
export type OverlayMode = 'repeat' | 'pairwise';

/** Whether the stamp paints after the base content or before it. */
export type OverlayLayer = 'over' | 'under';

/** How the stamp is sized against the base page's visible area. */
export type OverlayFit = 'actual' | 'contain' | 'cover' | 'stretch';

/** The nine points a stamp can be pinned to, named as the reader sees them. */
export type OverlayAnchor =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'centre'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

export interface OverlayOptions {
  /**
   * `repeat` puts one stamp page on every selected base page — letterhead, a
   * DRAFT mark, a watermark PDF. `pairwise` puts stamp page N on base page N.
   * Default `repeat`.
   */
  mode?: OverlayMode;
  /** Default `over`. Use `under` for letterhead, so the base text stays legible. */
  layer?: OverlayLayer;
  /**
   * `actual` draws the stamp at the size it was authored (default — the least
   * surprising thing to do to a letterhead that is already page-sized).
   * `contain` shrinks or grows it to fit inside the page, `cover` to fill it,
   * both keeping its proportions. `stretch` forces it to the page exactly and
   * will distort it.
   */
  fit?: OverlayFit;
  /** Multiplier applied after `fit`. Default 1. */
  scale?: number;
  /** 0–1. Default 1. */
  opacity?: number;
  /** Default `centre`. */
  anchor?: OverlayAnchor;
  /** Points to the right, measured on the page as displayed. Default 0. */
  offsetX?: number;
  /** Points *downward*, measured on the page as displayed. Default 0. */
  offsetY?: number;
  /** `repeat` only: which stamp page to use, one-based. Default 1. */
  stampPage?: number;
  /** One-based base pages to stamp. Default: all of them. */
  pages?: number[];
}

/** A rectangle in PDF user space, lower-left origin. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How to walk the page as it is displayed, expressed in PDF user space.
 *
 * `origin` is the displayed top-left corner. `u` is one point to the right and
 * `v` is one point *down*, both as the reader sees them. Every anchor, offset
 * and overflow test below is written in this frame, which is why none of them
 * need to know what `/Rotate` the page carries.
 */
interface DisplayFrame {
  origin: { x: number; y: number };
  u: { x: number; y: number };
  v: { x: number; y: number };
  /** The page's size on screen. Swapped relative to user space at 90° and 270°. */
  width: number;
  height: number;
}

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/** Within this many points of the page edge still counts as "inside it". */
const EDGE_SLOP = 0.5;

/** Normalises `/Rotate` the way a reader does: a multiple of 90 in 0..270. */
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
 * The rectangle a reader actually shows.
 *
 * CropBox intersected with MediaBox, falling back to the MediaBox when the
 * CropBox is degenerate or misses it — the same rule pdf.js applies in its
 * `Page.view` getter, and the same one crop.ts follows. Agreeing with the
 * renderer matters here for the same reason it matters there: any difference
 * shows up as the stamp sitting off by the gap between the two boxes.
 */
const visibleBox = (page: PDFPage): Rect => {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  if (crop.width <= 0 || crop.height <= 0) return media;
  return intersect(crop, media) ?? media;
};

/**
 * The displayed frame of a page, derived from its visible box and `/Rotate`.
 *
 * Read the four cases as "where does the displayed top-left corner live, and
 * which way is right and down from there". At 90° the page is turned clockwise
 * for display, so the page's own bottom-left corner is what the reader sees at
 * the top-left, and walking right on screen walks *up* the stored page.
 */
const displayFrame = (box: Rect, rotation: number): DisplayFrame => {
  const { x, y, width: w, height: h } = box;
  switch (rotation) {
    case 90:
      return {
        origin: { x, y },
        u: { x: 0, y: 1 },
        v: { x: 1, y: 0 },
        width: h,
        height: w,
      };
    case 180:
      return {
        origin: { x: x + w, y },
        u: { x: -1, y: 0 },
        v: { x: 0, y: 1 },
        width: w,
        height: h,
      };
    case 270:
      return {
        origin: { x: x + w, y: y + h },
        u: { x: 0, y: -1 },
        v: { x: -1, y: 0 },
        width: h,
        height: w,
      };
    default:
      return {
        origin: { x, y: y + h },
        u: { x: 1, y: 0 },
        v: { x: 0, y: -1 },
        width: w,
        height: h,
      };
  }
};

/**
 * The matrix that turns a stamp page into an upright picture with its
 * bottom-left corner at the origin.
 *
 * pdf-lib builds a form XObject whose `/BBox` is the box we hand it — in the
 * stamp's own user space — and whose `/Matrix` maps that box somewhere useful.
 * Its default matrix only translates, which loses two things: a stamp whose
 * CropBox is smaller than its MediaBox arrives with its margins still attached
 * (fixed by passing the visible box as the bounding box), and a stamp with
 * `/Rotate` arrives lying on its side. Folding the rotation into the matrix
 * here means everything downstream can treat the form as a plain upright
 * rectangle `nw × nh`, which is what makes the placement maths below short
 * enough to check by eye.
 */
const stampMatrix = (box: Rect, rotation: number): TransformationMatrix => {
  const left = box.x;
  const bottom = box.y;
  const right = box.x + box.width;
  const top = box.y + box.height;
  switch (rotation) {
    // Turned a quarter clockwise: what was the left edge becomes the top.
    case 90:
      return [0, -1, 1, 0, -bottom, right];
    case 180:
      return [-1, 0, 0, -1, right, top];
    case 270:
      return [0, 1, -1, 0, top, -left];
    default:
      return [1, 0, 0, 1, -left, -bottom];
  }
};

/** Where a fraction of the free space puts the stamp, per anchor. */
const anchorFractions = (anchor: OverlayAnchor): { h: number; v: number } => {
  const h = anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? 1 : 0.5;
  const v = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5;
  // 'left' and 'right' on their own are mid-height; 'top'/'bottom' are centred
  // horizontally. The two tests above already produce that, because neither
  // string both starts and ends with a side name.
  return { h, v };
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One-based page list, de-duplicated and sorted; empty input means every page. */
const targetsFor = (pages: number[] | undefined, count: number): number[] => {
  if (!pages || pages.length === 0) return Array.from({ length: count }, (_, i) => i + 1);
  return [...new Set(pages)].filter((page) => Number.isInteger(page)).sort((a, b) => a - b);
};

/** What one stamp page looks like once it has been embedded and straightened. */
interface Stamp {
  embedded: PDFEmbeddedPage;
  /** Displayed size of the stamp, in points, after its own `/Rotate`. */
  width: number;
  height: number;
}

/**
 * `null` means the stamp page has no `/Contents` at all — a genuinely blank
 * page, which pdf-lib cannot turn into a form XObject. Found the hard way:
 * embedding is lazy, so left alone this surfaces as an exception thrown out of
 * `save()` long after the page that caused it went past, which is no use to
 * anyone. It is detected up front instead, and what happens next depends on
 * the mode: in `repeat` a blank stamp means the whole run would do nothing and
 * is worth stopping for, while in `pairwise` it is a legitimate way to say
 * "leave page 3 alone".
 */
type MaybeStamp = Stamp | null;

export async function overlay(files: InputFile[], options: OverlayOptions = {}): Promise<OpResult> {
  const baseFile = files[0];
  const stampFile = files[1];
  if (!baseFile) return { ok: false, error: 'Choose the PDF you want to stamp.' };
  if (!stampFile) {
    return { ok: false, error: 'Choose a second PDF to lay over it — the stamp, letterhead or watermark.' };
  }

  const mode: OverlayMode = options.mode ?? 'repeat';
  const layer: OverlayLayer = options.layer ?? 'over';
  const fit: OverlayFit = options.fit ?? 'actual';
  const anchor: OverlayAnchor = options.anchor ?? 'centre';
  const scale = options.scale ?? 1;
  const opacity = options.opacity ?? 1;
  const offsetX = options.offsetX ?? 0;
  const offsetY = options.offsetY ?? 0;

  if (!Number.isFinite(scale) || scale <= 0) {
    return { ok: false, error: 'Scale has to be a positive number — 1 keeps the stamp at its own size.' };
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    return { ok: false, error: 'Opacity has to be between 0 and 1.' };
  }
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
    return { ok: false, error: 'The offsets have to be numbers, in points.' };
  }

  const started = performance.now();
  const bytesIn = baseFile.bytes.byteLength + stampFile.bytes.byteLength;

  let base: PDFDocument;
  let stampDoc: PDFDocument;
  try {
    base = await PDFDocument.load(baseFile.bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return {
      ok: false,
      error: `${baseFile.name} could not be read. If it is password-protected, remove the password first with Unlock.`,
    };
  }
  try {
    stampDoc = await PDFDocument.load(stampFile.bytes, { ignoreEncryption: true });
  } catch {
    return {
      ok: false,
      error: `${stampFile.name} could not be read. If it is password-protected, remove the password first with Unlock.`,
    };
  }

  const baseCount = base.getPageCount();
  const stampCount = stampDoc.getPageCount();
  if (baseCount === 0) return { ok: false, error: `${baseFile.name} has no pages.` };
  if (stampCount === 0) return { ok: false, error: `${stampFile.name} has no pages.` };

  const stampPageNumber = options.stampPage ?? 1;
  if (mode === 'repeat' && (!Number.isInteger(stampPageNumber) || stampPageNumber < 1 || stampPageNumber > stampCount)) {
    return {
      ok: false,
      error:
        stampCount === 1
          ? `${stampFile.name} has only one page, so the stamp page has to be 1.`
          : `Choose a stamp page from 1 to ${stampCount}.`,
    };
  }

  const targets = targetsFor(options.pages, baseCount);
  if (targets.length === 0) {
    return { ok: false, error: 'No pages were selected, so there was nothing to stamp.' };
  }
  for (const page of targets) {
    if (page < 1 || page > baseCount) {
      return { ok: false, error: `Page ${page} does not exist — ${baseFile.name} has ${baseCount}.` };
    }
  }

  // Embedding copies the stamp's object graph into the base document, so it is
  // done once per distinct stamp page and cached. In `repeat` mode that is one
  // embed shared by every page, which is the difference between a letterhead
  // costing its own size and costing it once per page.
  const embedded = new Map<number, MaybeStamp>();
  const embedStamp = async (number: number): Promise<MaybeStamp> => {
    const cached = embedded.get(number);
    if (cached !== undefined) return cached;

    const page = stampDoc.getPage(number - 1);
    if (!page.node.Contents()) {
      embedded.set(number, null);
      return null;
    }

    const box = visibleBox(page);
    const rotation = rotationOf(page);
    const form = await base.embedPage(
      page,
      { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height },
      stampMatrix(box, rotation)
    );

    // Embedded now rather than at save time. pdf-lib defers this by default,
    // which means anything wrong with a stamp page is reported from inside
    // `save()` with no idea which page it was.
    await form.embed();

    if (opacity < 1) {
      // Without this, `/ca` applies to every painting operation inside the
      // stamp separately, so wherever the stamp overlaps itself — a logo with
      // a stroke over a fill, letters that touch — the overlap comes out
      // darker than the rest. Declaring the form a transparency group makes
      // the alpha apply to the finished stamp as one picture, which is what
      // "50% opacity" is understood to mean.
      const xobject = base.context.lookup(form.ref);
      if (xobject instanceof PDFStream) {
        xobject.dict.set(
          PDFName.of('Group'),
          base.context.obj({ Type: 'Group', S: 'Transparency' })
        );
      }
    }

    const quarterTurned = rotation === 90 || rotation === 270;
    const stamp: Stamp = {
      embedded: form,
      width: quarterTurned ? box.height : box.width,
      height: quarterTurned ? box.width : box.height,
    };
    embedded.set(number, stamp);
    return stamp;
  };

  let stamped = 0;
  let blankStampPages = 0;
  let rotatedBasePages = 0;
  let croppedBasePages = 0;
  let overflowing = 0;
  let unpaired = 0;
  const stampRotations = new Set<number>();
  const stampCrops = new Set<number>();

  for (const number of targets) {
    const stampNumber = mode === 'repeat' ? stampPageNumber : number;
    if (stampNumber > stampCount) {
      unpaired += 1;
      continue;
    }

    const stamp = await embedStamp(stampNumber);
    if (!stamp) {
      if (mode === 'repeat') {
        return {
          ok: false,
          error: `Page ${stampNumber} of ${stampFile.name} is blank — there is nothing on it to stamp with. Pick a different page.`,
        };
      }
      blankStampPages += 1;
      continue;
    }

    const stampSource = stampDoc.getPage(stampNumber - 1);
    if (rotationOf(stampSource) !== 0) stampRotations.add(stampNumber);
    const stampVisible = visibleBox(stampSource);
    const stampMedia = stampSource.getMediaBox();
    if (
      stampVisible.width < stampMedia.width - EDGE_SLOP ||
      stampVisible.height < stampMedia.height - EDGE_SLOP
    ) {
      stampCrops.add(stampNumber);
    }

    const page = base.getPage(number - 1);
    const box = visibleBox(page);
    const media = page.getMediaBox();
    const rotation = rotationOf(page);
    if (rotation !== 0) rotatedBasePages += 1;
    if (box.width < media.width - EDGE_SLOP || box.height < media.height - EDGE_SLOP) {
      croppedBasePages += 1;
    }

    const frame = displayFrame(box, rotation);

    // Size, in the displayed frame — the stamp's proportions are its displayed
    // ones, so this comparison is apples to apples on a rotated stamp too.
    let factorX: number;
    let factorY: number;
    switch (fit) {
      case 'contain':
      case 'cover': {
        const byWidth = frame.width / stamp.width;
        const byHeight = frame.height / stamp.height;
        const k = fit === 'contain' ? Math.min(byWidth, byHeight) : Math.max(byWidth, byHeight);
        factorX = k * scale;
        factorY = k * scale;
        break;
      }
      case 'stretch':
        factorX = (frame.width / stamp.width) * scale;
        factorY = (frame.height / stamp.height) * scale;
        break;
      default:
        factorX = scale;
        factorY = scale;
    }

    const drawnWidth = stamp.width * factorX;
    const drawnHeight = stamp.height * factorY;

    const { h, v } = anchorFractions(anchor);
    const left = (frame.width - drawnWidth) * h + offsetX;
    const top = (frame.height - drawnHeight) * v + offsetY;

    if (
      left < -EDGE_SLOP ||
      top < -EDGE_SLOP ||
      left + drawnWidth > frame.width + EDGE_SLOP ||
      top + drawnHeight > frame.height + EDGE_SLOP
    ) {
      overflowing += 1;
    }

    // The stamp's bottom-left corner, walked out in displayed points and then
    // read back in the page's own coordinates. `drawPage` composes
    // translate · rotate · scale, and the form is already an upright picture
    // rooted at its own origin, so this point plus the page's own rotation is
    // the whole transform.
    const bottom = top + drawnHeight;
    const x = frame.origin.x + left * frame.u.x + bottom * frame.v.x;
    const y = frame.origin.y + left * frame.u.y + bottom * frame.v.y;

    page.drawPage(stamp.embedded, {
      x,
      y,
      xScale: factorX,
      yScale: factorY,
      // Turning the stamp by the page's own rotation cancels the turn the
      // reader is about to apply, so the stamp reads upright on screen.
      rotate: degrees(rotation),
      ...(opacity < 1 ? { opacity } : {}),
    });

    if (layer === 'under') moveLastContentStreamToFront(page);
    stamped += 1;
  }

  if (stamped === 0) {
    if (blankStampPages > 0) {
      return {
        ok: false,
        error: `Every stamp page that lined up with the pages you picked is blank, so nothing would have changed.`,
      };
    }
    return {
      ok: false,
      error:
        mode === 'pairwise'
          ? `Nothing was stamped: ${stampFile.name} has ${plural(stampCount, 'page')}, and ` +
            `${stampCount === 1 ? 'it does not line up' : 'none of them line up'} with the base ` +
            'pages you picked. Switch to repeat mode if you want one stamp on every page.'
          : 'Nothing was stamped.',
    };
  }

  const bytes = await base.save({ useObjectStreams: true, addDefaultPage: false });

  const summary = [
    `${plural(stamped, 'page')} stamped`,
    layer === 'under' ? 'behind the page content' : 'on top',
    mode === 'repeat' ? `from stamp page ${stampPageNumber}` : 'page for page',
  ].join(' · ');

  const notes: string[] = [];

  notes.push(
    layer === 'under'
      ? 'The stamp paints before the page content, so the document’s own text and images stay on top of it. That is what makes letterhead readable rather than a cover-up.'
      : 'The stamp paints after the page content, so it sits on top of the text. Anything ' +
        'underneath it is still in the file and still selectable — this covers, it does not ' +
        'remove. Use Redact if something has to be gone.'
  );

  if (layer === 'under') {
    notes.push(
      'One thing cannot go under: annotations. Form fields, comments, highlights and link boxes are painted by the reader after all page content, so they stay above the stamp no matter what.'
    );
  }

  notes.push(
    mode === 'repeat'
      ? `Page ${stampPageNumber} of ${stampFile.name} was used on every selected page.${stampCount > 1 ? ` Its other ${plural(stampCount - 1, 'page')} ${stampCount === 2 ? 'was' : 'were'} not used.` : ''}`
      : 'Stamp page N went onto base page N.'
  );

  if (blankStampPages > 0) {
    notes.push(
      `${plural(blankStampPages, 'stamp page')} ${blankStampPages === 1 ? 'is' : 'are'} blank, so the base ${blankStampPages === 1 ? 'page it paired with was' : 'pages they paired with were'} left untouched.`
    );
  }
  if (mode === 'pairwise' && unpaired > 0) {
    notes.push(
      `${plural(unpaired, 'page')} of ${baseFile.name} had no matching stamp page and ` +
        `${unpaired === 1 ? 'was' : 'were'} left exactly as ${unpaired === 1 ? 'it' : 'they'} ` +
        'came in — nothing was repeated to fill the gap. Use repeat mode if you wanted one ' +
        'stamp everywhere.'
    );
  }
  if (mode === 'pairwise' && stampCount > baseCount) {
    notes.push(
      `${stampFile.name} has ${plural(stampCount - baseCount, 'page')} more than ${baseFile.name}; ${stampCount - baseCount === 1 ? 'it was' : 'they were'} dropped. The base document sets the page count.`
    );
  }

  notes.push(
    'The stamp was placed against each page’s visible area — its crop box, not the full sheet ' +
      '— and anchored to the page as you see it, so a page stored rotated still gets the stamp ' +
      'in the corner you picked.'
  );

  if (rotatedBasePages > 0) {
    notes.push(
      `${plural(rotatedBasePages, 'page')} of ${baseFile.name} ${rotatedBasePages === 1 ? 'is' : 'are'} stored rotated; the stamp was turned to match so it reads upright.`
    );
  }
  if (croppedBasePages > 0) {
    notes.push(
      `${plural(croppedBasePages, 'page')} of ${baseFile.name} ${croppedBasePages === 1 ? 'has' : 'have'} a crop box smaller than the sheet, so the stamp was measured against what you can actually see.`
    );
  }
  if (stampRotations.size > 0) {
    notes.push(
      `${plural(stampRotations.size, 'stamp page')} ${stampRotations.size === 1 ? 'is' : 'are'} stored rotated; ${stampRotations.size === 1 ? 'it was' : 'they were'} straightened before being drawn.`
    );
  }
  if (stampCrops.size > 0) {
    notes.push(
      `${plural(stampCrops.size, 'stamp page')} ${stampCrops.size === 1 ? 'has' : 'have'} a crop box smaller than the sheet; only the visible part was used, not the trimmed margins.`
    );
  }
  if (overflowing > 0) {
    notes.push(
      `On ${plural(overflowing, 'page')} the stamp reaches past the edge of the page and is clipped there. Reduce the scale, change the anchor, or pull it back with the offsets.`
    );
  }
  if (opacity < 1) {
    notes.push(
      `Drawn at ${Math.round(opacity * 100)}% opacity, applied to the stamp as one picture rather than to each mark inside it, so overlapping parts of the stamp do not come out darker.`
    );
  }

  notes.push(
    'What did not come across: only the stamp’s drawn content was copied. Links, form fields, ' +
      'comments, bookmarks and attachments belonging to the stamp file are not part of a page’s ' +
      'drawing, so they are not in the result. The base document keeps all of its own.'
  );
  notes.push(
    'Nothing was rasterised or re-encoded on either side. The stamp’s text is still text, and the base pages are the bytes they were plus one extra drawing instruction.'
  );
  notes.push('Everything happened in this tab. Nothing was uploaded.');

  return {
    ok: true,
    files: [{ name: `${baseName(baseFile.name)}-stamped.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: baseCount,
    durationMs: performance.now() - started,
    summary,
    notes,
  };
}

/**
 * Move the stream pdf-lib just appended to the front of `/Contents`.
 *
 * pdf-lib normalises a page's contents into an array wrapped in `q`/`Q` before
 * it appends anything, so the array is `[q, ...original..., Q, ours]` and this
 * makes it `[ours, q, ...original..., Q]`. The stamp's own operators are
 * balanced by `drawPage`, which brackets them in `q`/`Q` of its own, so moving
 * the stream cannot leak graphics state into the page that follows it.
 *
 * The alternative — rebuilding each page with the stamp drawn first — would
 * throw away the base document's annotations, form fields and links, which is
 * a far worse trade than reordering an array.
 */
function moveLastContentStreamToFront(page: PDFPage): void {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return;
  const last = contents.size() - 1;
  if (last <= 0) return;
  const ours = contents.get(last);
  contents.remove(last);
  contents.insert(0, ours);
}

/**
 * Why there is no "tile the stamp across the page" option, and no free
 * rotation.
 *
 * Tiling is a different operation wearing the same coat. Repeating a mark on a
 * grid needs its own spacing, its own edge behaviour and its own answer to
 * what happens at a page boundary, and folding it in here would mean four more
 * options that only make sense together. The watermark tool is the place for
 * it.
 *
 * Free rotation is left out for a sharper reason. `drawPage` composes
 * translate · rotate · scale in that order, so an arbitrary angle combined
 * with the non-uniform scaling that `stretch` produces is a shear, not a
 * rotation — the stamp would come out visibly skewed on exactly the
 * combination a user is most likely to try. Rotations that are multiples of 90
 * are safe because they commute with a swap of the scale factors, and those
 * are already handled: they are how `/Rotate` is honoured. A stamp that needs
 * to sit at 30° should be authored at 30°.
 */
