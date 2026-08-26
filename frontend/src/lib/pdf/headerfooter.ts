/**
 * Headers, footers and Bates numbering.
 *
 * `edit.ts` already stamps a page number: `drawText` at `x = width - 76,
 * y = 24`, once per page. That is the right amount of code for a demo and the
 * wrong amount for a document. It reads the MediaBox rather than the CropBox,
 * so on a page whose visible area starts at `[20 20 615 812]` — every scan out
 * of a departmental copier — the number lands twenty points off. It ignores
 * `/Rotate`, so on a landscape page stored upright the number appears sideways
 * along an edge. It cannot say "Page 3 of 48". And it draws through pdf-lib's
 * WinAnsi encoder, so a Japanese prefix comes out as question marks.
 *
 * This file is that tool done properly, and `edit.ts`'s `pageNumbers` should
 * delegate to `stampPageNumbers` at the foot of this file rather than the two
 * living side by side — a page number is a footer with one slot filled in, not
 * a separate feature.
 *
 * Three things here are harder than they look.
 *
 *   1. **Where the top of the page is.** A page has a MediaBox (the sheet), a
 *      CropBox (what a reader shows) and a `/Rotate` (a quarter-turn applied at
 *      display time). "Top of the page" means the top of the CropBox as
 *      rotated, which on a `/Rotate 90` page is an edge of the stored one.
 *      Rather than four sets of coordinate arithmetic sprinkled through the
 *      drawing code, the page is entered through a transformation matrix that
 *      makes the displayed page look like a plain `0,0`-based rectangle, and
 *      every measurement below is taken in that frame. pdf-lib's `drawText` and
 *      `drawImage` each wrap themselves in `q`/`Q`, so they inherit the matrix
 *      and cannot escape it.
 *
 *   2. **Bates numbers are not page numbers.** They run across an entire
 *      production — every page, in order, no gaps, no restarts, zero-padded to
 *      a fixed width so `ABC000009` and `ABC000010` sort as strings. A second
 *      batch starts where the first stopped, which is why `start` exists. The
 *      padding width is load-bearing: it appears in privilege logs, in
 *      deposition transcripts and in court orders, and a number that outgrows
 *      its padding must get *wider*, never be truncated — so this counts that
 *      case and says so rather than quietly producing `ABC0000010`. For the
 *      same reason the stamp is never shortened to fit, never moved by the
 *      mirroring option, and never skipped by the clean-title-page option: a
 *      production number that hops corners or misses the cover is one nobody
 *      can cite.
 *
 *   3. **Something is already there.** A PDF has no header region to write
 *      into; there is only the page, and ink lands on top of whatever it hits.
 *      There is no honest way to detect an existing header from the object
 *      model — that would mean interpreting the content stream, for the same
 *      reasons `crop.ts` refuses to guess where the content is. So the choice
 *      is offered instead of guessed: by default this overprints and says so,
 *      and `shrink: true` scales the existing content down into the space that
 *      is left, which is the only way to be *sure* nothing is buried.
 */
import {
  PDFArray,
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from '@cantoo/pdf-lib';
import type { PDFFont, PDFPage, RGB } from '@cantoo/pdf-lib';

import { TextPainter } from './text';
import type { InputFile, OpResult, OutputFile } from './types';

// ── options ─────────────────────────────────────────────────────────────

/** Where in a row a piece of text sits. */
export type Slot = 'left' | 'center' | 'right';

/** One row — header or footer — with its three independent slots. */
export interface HeaderFooterText {
  left?: string;
  center?: string;
  right?: string;
}

/**
 * A Bates stamp: a fixed prefix, a zero-padded running number, an optional
 * suffix. `start` lets a second production continue where the first ended.
 */
export interface BatesOptions {
  prefix?: string;
  suffix?: string;
  /** Number given to the very first page. Default 1. */
  start?: number;
  /** Digits the number is padded to. Default 6, the discovery convention. */
  padding?: number;
  /** Which row the stamp sits in. Default the footer. */
  place?: 'header' | 'footer';
  /** Which slot of that row. Default the right — bottom-right is the norm. */
  slot?: Slot;
}

export interface HeaderFooterOptions {
  header?: HeaderFooterText;
  footer?: HeaderFooterText;
  bates?: BatesOptions;
  /** Value of `{page}` on the first page of each file. Default 1. */
  startNumber?: number;
  /** Leading pages left clean, so a title page stays bare. Bates ignores this. */
  skipPages?: number;
  /** Swap the left and right slots on even sheets, for double-sided printing. */
  mirror?: boolean;
  /** Distance from the edge of the visible page to the text, in points. */
  margin?: number;
  fontSize?: number;
  bold?: boolean;
  /** `#rgb` or `#rrggbb`. Default a near-black grey. */
  colour?: string;
  /** Scale the existing content down to make room, instead of drawing over it. */
  shrink?: boolean;
  /** How `{date}` is spelled. Default the reader's own locale. */
  dateFormat?: 'locale' | 'iso';
}

// ── small shared pieces ─────────────────────────────────────────────────

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A rectangle in PDF user space, lower-left origin. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULTS = {
  margin: 36,
  fontSize: 9,
  padding: 6,
  /** Points of clear air between two slots that would otherwise touch. */
  gap: 10,
  /**
   * Vertical space a stamped row occupies, as a multiple of the font size,
   * counted from the margin inwards. A Helvetica line box is about 1.2 em;
   * the rest is the gap that keeps shrunk content from kissing the header.
   */
  band: 1.5,
} as const;

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
 * Deliberately the same rule as `crop.ts` and as pdf.js's own `Page.view`:
 * CropBox intersected with MediaBox, falling back to the MediaBox when the
 * CropBox is degenerate. `crop.ts` does not export it, and the two must agree
 * — a header placed against the MediaBox on a page the reader crops sits at
 * the wrong distance from the edge the user can see, which is one of the bugs
 * this file exists to fix.
 */
const visibleBox = (page: PDFPage): Rect => {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  if (crop.width <= 0 || crop.height <= 0) return media;
  return intersect(crop, media) ?? media;
};

/** Six-number PDF matrix, in the order the `cm` operator wants them. */
type Matrix = [number, number, number, number, number, number];

/**
 * A matrix that turns the displayed page into an ordinary rectangle.
 *
 * Under it, `(0, 0)` is the bottom-left corner of what the reader sees, `x`
 * runs right across the screen and `y` runs up it, whatever the page's
 * `/Rotate` and wherever its CropBox happens to start. It is a counter-clockwise
 * rotation by the page's own angle — the reader turns the page clockwise to
 * display it, so content pre-turned the other way arrives upright — followed by
 * a shift onto the corner that ends up at the bottom-left after the turn.
 */
const displayFrame = (box: Rect, rotation: number): Matrix => {
  switch (rotation) {
    case 90:
      return [0, 1, -1, 0, box.x + box.width, box.y];
    case 180:
      return [-1, 0, 0, -1, box.x + box.width, box.y + box.height];
    case 270:
      return [0, -1, 1, 0, box.x, box.y + box.height];
    default:
      return [1, 0, 0, 1, box.x, box.y];
  }
};

/** The size of the visible page as displayed: a quarter-turn swaps the axes. */
const displaySize = (box: Rect, rotation: number): { width: number; height: number } =>
  rotation % 180 === 0
    ? { width: box.width, height: box.height }
    : { width: box.height, height: box.width };

/** The same counter-clockwise turn `displayFrame` applies, on a bare vector. */
const turnVector = (rotation: number, x: number, y: number): { x: number; y: number } => {
  switch (rotation) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
};

/**
 * Parses `#rgb` / `#rrggbb`. Anything else falls back rather than throwing —
 * a mistyped colour should not cost the user their stamp.
 */
const parseColour = (value: string | undefined): RGB => {
  const fallback = rgb(0.2, 0.2, 0.2);
  if (!value) return fallback;
  const hex = value.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((character) => character + character)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback;
  const packed = parseInt(full, 16);
  return rgb(((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255);
};

// ── tokens ──────────────────────────────────────────────────────────────

/**
 * The token vocabulary, in the words the notes will use.
 *
 * Kept deliberately small and stated in the result, because a token nobody can
 * discover is the same as a token that does not exist.
 */
export const TOKEN_HELP =
  '{page} the page number, {pages} the number of pages, {bates} the Bates number, ' +
  "{date} today's date, {filename} the name of the file. " +
  'Write {{ and }} for a literal brace.';

interface TokenValues {
  page: number;
  pages: number;
  date: string;
  filename: string;
  bates: string;
}

/** What a pass over the templates learned, for the notes at the end. */
interface TokenReport {
  unknown: Set<string>;
  used: Set<string>;
}

const valueOf = (name: string, values: TokenValues): string | null => {
  switch (name) {
    case 'page':
      return String(values.page);
    case 'pages':
      return String(values.pages);
    case 'date':
      return values.date;
    case 'filename':
      return values.filename;
    case 'bates':
      return values.bates;
    default:
      return null;
  }
};

/**
 * Substitutes tokens in one slot's text.
 *
 * An unrecognised token is left exactly as the user typed it and reported,
 * rather than silently becoming an empty string. Someone who writes `{autor}`
 * has made a typo, and a blank space in the corner of 400 pages is a much
 * worse way to find that out than seeing `{autor}` printed there.
 */
function expand(template: string, values: TokenValues, report: TokenReport): string {
  let out = '';
  for (let i = 0; i < template.length; i += 1) {
    const character = template[i];
    if ((character === '{' || character === '}') && template[i + 1] === character) {
      out += character;
      i += 1;
      continue;
    }
    if (character !== '{') {
      out += character;
      continue;
    }
    const close = template.indexOf('}', i + 1);
    if (close === -1) {
      // An unclosed brace is a brace, not the start of something.
      out += character;
      continue;
    }
    const name = template.slice(i + 1, close).trim().toLowerCase();
    const value = valueOf(name, values);
    if (value === null) {
      report.unknown.add(name);
      out += template.slice(i, close + 1);
    } else {
      report.used.add(name);
      out += value;
    }
    i = close;
  }
  return out;
}

/**
 * Makes arbitrary text safe to drop into a template.
 *
 * A user's literal prefix may perfectly reasonably contain a brace; without
 * this, `Exhibit {A}` would report `a` as an unknown token and print it back.
 */
export const escapeTokens = (value: string): string =>
  value.replace(/\{/g, '{{').replace(/\}/g, '}}');

// ── the Bates stamp ─────────────────────────────────────────────────────

interface ResolvedBates {
  prefix: string;
  suffix: string;
  start: number;
  padding: number;
  place: 'header' | 'footer';
  slot: Slot;
}

/**
 * `padStart` is the whole trick, and its behaviour past the padding width is
 * exactly why it is the right one: a number wider than its padding comes back
 * intact. Truncating would break the single property the stamp exists for —
 * that every page in a production has a distinct, sortable identifier.
 */
const batesLabel = (bates: ResolvedBates, n: number): string =>
  `${bates.prefix}${String(n).padStart(bates.padding, '0')}${bates.suffix}`;

// ── laying out one row ──────────────────────────────────────────────────

interface Cell {
  slot: Slot;
  text: string;
  /** True for the Bates stamp: shortened last, and reported if it ever is. */
  protected?: boolean;
}

interface RowStyle {
  size: number;
  bold: boolean;
  color: RGB;
}

interface RowResult {
  /** How many pieces of text had to be shortened to fit. */
  trimmed: number;
  /** How many had so little room that nothing legible was left of them. */
  dropped: number;
  /** Whether the Bates stamp itself was shortened. */
  stampCut: boolean;
}

/**
 * Places up to three pieces of text on one line, left, centred and right.
 *
 * When they do not all fit, the Bates stamp is served first at its full width
 * — a shortened production number is worse than a shortened title — and what
 * is left is divided among the others in proportion to what they asked for.
 * Trimming only the longest would mangle one slot while another sat in empty
 * space. `painter.fit` marks a cut with an ellipsis, so a trim is visible in
 * the output rather than a silent loss of the last few words.
 *
 * A slot can still end up with too little room for even one character and an
 * ellipsis, in which case `fit` returns nothing at all. That is counted apart
 * from an ordinary trim: text that quietly failed to appear is the one outcome
 * the user has no way of noticing for themselves.
 */
async function drawRow(
  page: PDFPage,
  painter: TextPainter,
  font: PDFFont,
  style: RowStyle,
  cells: Cell[],
  left: number,
  usable: number,
  baseline: number
): Promise<RowResult> {
  const present = cells.filter((cell) => cell.text.length > 0);
  if (present.length === 0 || usable <= 0) return { trimmed: 0, dropped: 0, stampCut: false };

  const gap = DEFAULTS.gap;
  const natural = present.map((cell) => painter.width(cell.text, font, style));
  const asked = natural.reduce((sum, width) => sum + width, 0);
  const fits = asked + gap * (present.length - 1) <= usable;
  const room = Math.max(0, usable - gap * (present.length - 1));

  const reserved = present.reduce(
    (sum, cell, index) => (cell.protected ? sum + Math.min(natural[index], room) : sum),
    0
  );
  const shared = present.reduce(
    (sum, cell, index) => (cell.protected ? sum : sum + natural[index]),
    0
  );

  let trimmed = 0;
  let dropped = 0;
  let stampCut = false;

  const laid = present.map((cell, index) => {
    if (fits) return { slot: cell.slot, text: cell.text, width: natural[index] };
    const allowance = cell.protected
      ? Math.min(natural[index], room)
      : shared > 0 ? ((room - reserved) * natural[index]) / shared : 0;
    const text = painter.fit(cell.text, font, style, Math.max(0, allowance));
    if (text.length === 0) dropped += 1;
    else if (text !== cell.text) {
      trimmed += 1;
      if (cell.protected) stampCut = true;
    }
    return { slot: cell.slot, text, width: painter.width(text, font, style) };
  });

  const at = (slot: Slot) => laid.find((cell) => cell.slot === slot);
  const leftCell = at('left');
  const rightCell = at('right');
  const centreCell = at('center');

  if (leftCell) {
    await painter.draw(page, leftCell.text, left, baseline, font, style);
  }
  if (rightCell) {
    const x = left + usable - rightCell.width;
    await painter.draw(page, rightCell.text, x, baseline, font, style);
  }
  if (centreCell) {
    // Centred, then pushed aside if that would land it on a neighbour.
    const lower = leftCell ? leftCell.width + gap : 0;
    const upper = usable - (rightCell ? rightCell.width + gap : 0) - centreCell.width;
    const ideal = (usable - centreCell.width) / 2;
    const x = upper < lower ? lower : Math.min(Math.max(ideal, lower), upper);
    await painter.draw(page, centreCell.text, left + x, baseline, font, style);
  }

  return { trimmed, dropped, stampCut };
}

// ── making room ─────────────────────────────────────────────────────────

/**
 * Scales a page's existing content into the space the stamps do not use.
 *
 * `wrapContentStreams` puts operators *before* everything already on the page
 * and closes them after, which is the only way to affect content pdf-lib never
 * parsed. `normalize()` has already balanced the original stream in its own
 * `q`/`Q`, so the matrix pushed here cannot be undone by a stray `Q` inside it.
 * The header drawn afterwards goes into a stream appended past the closing
 * `Q`, so it is not scaled along with the body.
 *
 * Returns false when the page has no content stream to wrap — an empty page
 * has nothing to move out of the way, so there is nothing to report either.
 */
function shrinkContent(
  page: PDFPage,
  box: Rect,
  rotation: number,
  scale: number,
  shiftX: number,
  shiftY: number
): boolean {
  page.node.normalize();
  if (!(page.node.Contents() instanceof PDFArray)) return false;

  // The scaling is described in the frame the *reader* sees, but the matrix has
  // to be expressed in the page's own space. Composing frame · scale · frame⁻¹
  // leaves a plain scale — rotation and uniform scaling commute — with a
  // translation carrying both the frame's origin and the reserved band.
  const frame = displayFrame(box, rotation);
  const shift = turnVector(rotation, shiftX, shiftY);
  const matrix: Matrix = [
    scale,
    0,
    0,
    scale,
    (1 - scale) * frame[4] + shift.x,
    (1 - scale) * frame[5] + shift.y,
  ];

  const { context } = page.doc;
  const start = context.register(
    context.contentStream([pushGraphicsState(), concatTransformationMatrix(...matrix)])
  );
  return page.node.wrapContentStreams(start, context.getPopGraphicsStateContentStream());
}

// ── the tool ────────────────────────────────────────────────────────────

const rowIsEmpty = (row: HeaderFooterText | undefined): boolean =>
  !row || [row.left, row.center, row.right].every((value) => (value ?? '').trim().length === 0);

const slotText = (row: HeaderFooterText | undefined, slot: Slot): string =>
  ((slot === 'left' ? row?.left : slot === 'right' ? row?.right : row?.center) ?? '').trim();

const opposite = (slot: Slot): Slot =>
  slot === 'left' ? 'right' : slot === 'right' ? 'left' : 'center';

/**
 * Stamps headers, footers and Bates numbers onto every file given, in order.
 *
 * `{page}` and `{pages}` are per file — a header saying "Page 3 of 12" means
 * this file's third of twelve. Bates numbering is the opposite by design: it
 * runs unbroken across the whole batch, so handing over three files produces
 * one continuous production rather than three sequences that collide.
 */
export async function headerFooter(
  files: InputFile[],
  options: HeaderFooterOptions = {}
): Promise<OpResult> {
  if (files.length === 0) return { ok: false, error: 'Choose a PDF.' };

  const header = options.header;
  const footer = options.footer;

  if (rowIsEmpty(header) && rowIsEmpty(footer) && !options.bates) {
    return {
      ok: false,
      error:
        'Type some header or footer text, or turn on Bates numbering — there is nothing to stamp yet.',
    };
  }

  const startNumber = options.startNumber ?? 1;
  if (!Number.isInteger(startNumber) || startNumber < 1) {
    return { ok: false, error: 'The first page number must be a whole number, 1 or higher.' };
  }

  const skipPages = options.skipPages ?? 0;
  if (!Number.isInteger(skipPages) || skipPages < 0) {
    return { ok: false, error: 'The number of pages to leave clean must be 0 or more.' };
  }

  const fontSize = options.fontSize ?? DEFAULTS.fontSize;
  if (!Number.isFinite(fontSize) || fontSize < 4 || fontSize > 72) {
    return { ok: false, error: 'Choose a text size between 4 and 72 points.' };
  }

  const margin = options.margin ?? DEFAULTS.margin;
  if (!Number.isFinite(margin) || margin < 0 || margin > 200) {
    return { ok: false, error: 'Choose a margin between 0 and 200 points.' };
  }

  let bates: ResolvedBates | null = null;
  if (options.bates) {
    const start = options.bates.start ?? 1;
    const padding = options.bates.padding ?? DEFAULTS.padding;
    if (!Number.isInteger(start) || start < 0 || start > 999_999_999_999) {
      return { ok: false, error: 'The first Bates number must be a whole number, 0 or higher.' };
    }
    if (!Number.isInteger(padding) || padding < 1 || padding > 15) {
      return { ok: false, error: 'Pad Bates numbers to between 1 and 15 digits.' };
    }
    bates = {
      prefix: options.bates.prefix ?? '',
      suffix: options.bates.suffix ?? '',
      start,
      padding,
      place: options.bates.place ?? 'footer',
      slot: options.bates.slot ?? 'right',
    };
  }

  // Where the Bates number goes. A `{bates}` token anywhere means the user has
  // said explicitly, and nothing is placed automatically; otherwise the stamp
  // takes a slot of its own, and that slot has to be free. Mirroring can bring
  // the opposite slot's text into it on even sheets, so both are checked.
  const probe: TokenReport = { unknown: new Set(), used: new Set() };
  const probeValues: TokenValues = { page: 1, pages: 1, date: '', filename: '', bates: '' };
  for (const row of [header, footer]) {
    for (const slot of ['left', 'center', 'right'] as const) {
      expand(slotText(row, slot), probeValues, probe);
    }
  }
  const batesByToken = probe.used.has('bates');

  if (bates && !batesByToken) {
    const row = bates.place === 'header' ? header : footer;
    const clash =
      slotText(row, bates.slot) ||
      (options.mirror && bates.slot !== 'center' ? slotText(row, opposite(bates.slot)) : '');
    if (clash) {
      return {
        ok: false,
        error: `The ${bates.place}'s ${bates.slot} slot already has text in it, so the Bates number has nowhere to sit. Either move the stamp to a free slot, or write {bates} inside that text to say exactly where the number belongs.`,
      };
    }
  }

  const started = performance.now();
  const bytesIn = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const colour = parseColour(options.colour);
  const bold = options.bold ?? false;
  const today =
    options.dateFormat === 'iso'
      ? new Date().toISOString().slice(0, 10)
      : new Date().toLocaleDateString();

  // Reserved from the configuration rather than page by page, so every page
  // scales by the same fraction. A title page left at full size next to
  // shrunken body pages reads as a mistake even though nothing is covered.
  const bandFor = (row: HeaderFooterText | undefined, place: 'header' | 'footer'): number =>
    !rowIsEmpty(row) || (bates !== null && !batesByToken && bates.place === place)
      ? margin + fontSize * DEFAULTS.band
      : 0;
  const headerReserve = bandFor(header, 'header');
  const footerReserve = bandFor(footer, 'footer');

  const report: TokenReport = { unknown: new Set(), used: new Set() };
  const fallbackNotes = new Set<string>();
  const outputs: OutputFile[] = [];
  const usedNames = new Set<string>();

  let totalPages = 0;
  let stamped = 0;
  let rotatedPages = 0;
  let croppedPages = 0;
  let trimmedCells = 0;
  let droppedCells = 0;
  let stampsCut = 0;
  let shrunkPages = 0;
  let tooNarrow = 0;
  let overflowed = 0;
  let batesDrawn = 0;
  let charactersLost = 0;
  let batesNumber = bates ? bates.start : 0;
  const batesFirst = bates ? batesLabel(bates, bates.start) : '';
  let batesLast = batesFirst;

  for (const file of files) {
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(file.bytes, {
        ignoreEncryption: true,
        // The original Producer, CreationDate and ModDate are left exactly as
        // they were. A stamped production is evidence, and quietly rewriting
        // its metadata is not this tool's business.
        updateMetadata: false,
      });
    } catch {
      return {
        ok: false,
        error: `${file.name} could not be read. If it is password-protected, remove the password first with Unlock.`,
      };
    }

    const pages = doc.getPages();
    const count = pages.length;
    if (count === 0) {
      return { ok: false, error: `${file.name} has no pages, so there is nothing to stamp.` };
    }
    if (skipPages >= count && !bates) {
      return {
        ok: false,
        error: `Leaving the first ${plural(skipPages, 'page')} clean would leave nothing to stamp — ${file.name} has ${count}.`,
      };
    }

    const font = await doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
    const painter = new TextPainter(doc);
    const style: RowStyle = { size: fontSize, bold, color: colour };
    const name = baseName(file.name);

    for (let index = 0; index < count; index += 1) {
      const page = pages[index];
      const sheet = index + 1;

      // The counter advances on every page whatever else happens to it, so a
      // page that could not be stamped costs its number rather than shifting
      // every number after it.
      const label = bates ? batesLabel(bates, batesNumber) : '';
      if (bates) {
        if (String(batesNumber).length > bates.padding) overflowed += 1;
        batesLast = label;
        batesNumber += 1;
      }

      const box = visibleBox(page);
      const rotation = rotationOf(page);
      const size = displaySize(box, rotation);
      const usable = size.width - margin * 2;

      if (usable <= fontSize) {
        // A page narrower than its own margins. Leaving it alone beats
        // stamping a lone ellipsis into the gutter and calling it a header.
        tooNarrow += 1;
        continue;
      }

      if (options.shrink) {
        const room = size.height - headerReserve - footerReserve;
        if (room > size.height * 0.25) {
          const scale = room / size.height;
          const shrank = shrinkContent(
            page,
            box,
            rotation,
            scale,
            ((1 - scale) * size.width) / 2,
            footerReserve
          );
          if (shrank) shrunkPages += 1;
        }
      }

      // Mirroring is for the reader's benefit — the outer edge of a bound page
      // swaps sides every sheet, counted by physical sheet rather than by the
      // number printed on it. The Bates stamp is deliberately not mirrored.
      const skipped = sheet <= skipPages;
      const flip = (options.mirror ?? false) && sheet % 2 === 0;
      const values: TokenValues = {
        page: startNumber + index,
        pages: count,
        date: today,
        filename: name,
        bates: label,
      };

      const rowCells = (row: HeaderFooterText | undefined, place: 'header' | 'footer'): Cell[] =>
        (['left', 'center', 'right'] as const).map((slot) => {
          const owns =
            bates !== null && !batesByToken && bates.place === place && bates.slot === slot;
          if (owns) return { slot, text: label, protected: true };
          const template = skipped ? '' : slotText(row, flip ? opposite(slot) : slot);
          return { slot, text: template ? expand(template, values, report) : '' };
        });

      const headerCells = rowCells(header, 'header');
      const footerCells = rowCells(footer, 'footer');
      const all = [...headerCells, ...footerCells];
      if (all.every((cell) => cell.text.length === 0)) continue;

      if (rotation !== 0) rotatedPages += 1;
      const media = page.getMediaBox();
      if (box.width < media.width - 0.5 || box.height < media.height - 0.5) croppedPages += 1;
      if (bates && all.some((cell) => cell.text.includes(label))) batesDrawn += 1;

      // Everything from here is measured on the page as displayed: the matrix
      // makes (0, 0) the bottom-left of what the reader sees.
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...displayFrame(box, rotation))
      );
      for (const [cells, baseline] of [
        [headerCells, size.height - margin - fontSize],
        [footerCells, margin],
      ] as const) {
        const row = await drawRow(page, painter, font, style, cells, margin, usable, baseline);
        trimmedCells += row.trimmed;
        droppedCells += row.dropped;
        if (row.stampCut) stampsCut += 1;
      }
      page.pushOperators(popGraphicsState());
      stamped += 1;
    }

    totalPages += count;

    const fallback = painter.note();
    if (fallback) fallbackNotes.add(fallback);
    charactersLost += painter.lost;

    const suffix = bates && rowIsEmpty(header) && rowIsEmpty(footer) ? 'bates' : 'stamped';
    let outName = `${name}-${suffix}.pdf`;
    for (let n = 2; usedNames.has(outName); n += 1) outName = `${name}-${n}-${suffix}.pdf`;
    usedNames.add(outName);

    const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
    outputs.push({ name: outName, bytes });
  }

  const bytesOut = outputs.reduce((sum, out) => sum + out.bytes.length, 0);

  // ── what to tell the user ─────────────────────────────────────────────
  const notes: string[] = [];

  const rows: string[] = [];
  if (!rowIsEmpty(header)) rows.push('header');
  if (!rowIsEmpty(footer)) rows.push('footer');
  if (rows.length > 0) {
    notes.push(
      `Tokens you can put in ${rows.join(' or ')} text: ${TOKEN_HELP} Anything else in braces is printed exactly as typed. {page} and {pages} count within each file; {filename} is the name of the file you chose, without the extension.`
    );
  }

  if (bates) {
    notes.push(
      `Bates numbers run ${batesFirst} to ${batesLast}, one per page, padded to ${plural(bates.padding, 'digit')} so they sort correctly as text. They continue unbroken across ${plural(files.length, 'file')} in the order you added them — to carry a later batch on from here, start the next run at ${batesNumber}.`
    );
    if (batesDrawn < totalPages) {
      notes.push(
        `${plural(totalPages - batesDrawn, 'page')} did not get a visible stamp, because the Bates number was placed inside header or footer text that those pages do not show. The numbers were still spent on them, so every later page keeps the number it would have had — but if you need a mark on every page, give the stamp a slot of its own instead of a {bates} token.`
      );
    } else {
      notes.push(
        `Every page carries one, including ${skipPages > 0 ? 'the pages left clean of headers and ' : ''}any cover sheet, and the stamp keeps the same corner on every page even with mirrored headers on. That is what a production expects: a number that skipped a page or moved about could not be cited.`
      );
    }
    if (overflowed > 0) {
      notes.push(
        `${plural(overflowed, 'number')} needed more than ${plural(bates.padding, 'digit')} and ${overflowed === 1 ? 'was' : 'were'} printed in full rather than cut short. They are still unique, but wider than the rest — a larger padding would keep the column even.`
      );
    }
    if (stampsCut > 0) {
      notes.push(
        `On ${plural(stampsCut, 'page')} the Bates number itself was too wide for the space and had to be shortened. Do not rely on those: use a smaller text size or a narrower margin and stamp again.`
      );
    }
  }

  if (skipPages > 0) {
    notes.push(
      skipPages === 1
        ? 'The first page of each file was left clean of headers and footers.'
        : `The first ${skipPages} pages of each file were left clean of headers and footers.`
    );
  }

  if (options.mirror) {
    notes.push(
      'Mirrored: the left and right slots swap on even-numbered sheets, so the outer edge stays the outer edge when the document is printed double-sided. Odd and even are counted by physical sheet, not by the number printed on the page.'
    );
  }

  if (options.shrink) {
    notes.push(
      shrunkPages > 0
        ? `The existing content on ${plural(shrunkPages, 'page')} was scaled down and shifted to clear the band the stamps sit in, so nothing already on the page is covered. Links, form fields and other annotations are stored outside the page content and do not scale with it, so they stay where they were — check anything interactive near the edges.`
        : 'Nothing needed scaling: no page had content to move.'
    );
  } else {
    notes.push(
      'This draws on top of the page. A PDF has no reserved header area, and there is no reliable way to tell from the file whether something already sits where a stamp lands — if your pages have tight margins or headers of their own, turn on the shrink option, which scales the content down to make real room.'
    );
  }

  if (rotatedPages > 0) {
    notes.push(
      `${plural(rotatedPages, 'page')} ${rotatedPages === 1 ? 'is' : 'are'} stored rotated, so the stamps were turned to match — a header sits at the top of the page as you see it, not at the top of how it happens to be stored.`
    );
  }
  if (croppedPages > 0) {
    notes.push(
      `${plural(croppedPages, 'page')} ${croppedPages === 1 ? 'has' : 'have'} a crop box smaller than the sheet, so the margin was measured from the edge you can actually see rather than from the paper.`
    );
  }
  if (trimmedCells > 0) {
    notes.push(
      `${plural(trimmedCells, 'piece')} of text ${trimmedCells === 1 ? 'was' : 'were'} wider than the space available and ${trimmedCells === 1 ? 'was' : 'were'} cut short with an ellipsis. Shorter text, a smaller size or a narrower margin will fit more in.`
    );
  }
  if (droppedCells > 0) {
    notes.push(
      `${plural(droppedCells, 'piece')} of text had too little room for even one character and ${droppedCells === 1 ? 'was' : 'were'} left out of the page entirely — not shortened, absent. Three slots on one line need the width for it; drop one, shrink the text or narrow the margin, and stamp again.`
    );
  }
  if (tooNarrow > 0) {
    notes.push(
      `${plural(tooNarrow, 'page')} ${tooNarrow === 1 ? 'was' : 'were'} narrower than twice the margin, leaving no room for text at all, and ${tooNarrow === 1 ? 'was' : 'were'} left untouched.`
    );
  }

  if (report.unknown.size > 0) {
    const listed = [...report.unknown].map((name) => `{${name}}`).join(', ');
    notes.push(
      `Not ${report.unknown.size === 1 ? 'a token' : 'tokens'} this tool knows: ${listed}. ${report.unknown.size === 1 ? 'It was' : 'They were'} printed literally, exactly as typed. If you meant a brace rather than a token, write {{ and }}.`
    );
  }
  for (const fallback of fallbackNotes) notes.push(fallback);
  if (charactersLost > 0) {
    // TextPainter counts every run it draws, and a header is drawn once per
    // page — so the number above is attempts, not distinct characters. Said
    // here rather than left to be misread.
    notes.push(
      'That count is one per page: the same character in a repeated header is counted again each time it is drawn.'
    );
  }

  notes.push(
    'Only the stamps were added. The pages, fonts and document metadata are otherwise untouched, and everything happened in this tab — nothing was uploaded.'
  );

  const parts = [`${plural(stamped, 'page')} stamped`];
  if (bates) parts.push(`Bates ${batesFirst}–${batesLast}`);
  if (files.length > 1) parts.push(plural(files.length, 'file'));

  return {
    ok: true,
    files: outputs,
    bytesIn,
    bytesOut,
    pages: totalPages,
    durationMs: performance.now() - started,
    summary: parts.join(' · '),
    notes,
  };
}

/**
 * The page-number tool, expressed as what it actually is.
 *
 * Same signature as `edit.ts`'s `pageNumbers` so the worker need not change
 * shape, but it inherits the crop box, the rotation and the non-Latin text
 * handling for free. The prefix is escaped: someone stamping `Exhibit {A} — `
 * means those braces literally.
 */
export function stampPageNumbers(
  files: InputFile[],
  start: number,
  prefix: string
): Promise<OpResult> {
  return headerFooter(files, {
    footer: { right: `${escapeTokens(prefix ?? '')}{page}` },
    startNumber: start,
  });
}
