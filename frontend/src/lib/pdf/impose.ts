/**
 * Imposition — putting pages onto sheets.
 *
 * Three tools that look unrelated on a menu are one operation underneath:
 *
 *   N-up      many source pages → one sheet, tiled in a grid
 *   Booklet   many source pages → one sheet, two at a time, in FOLDING order
 *   Poster    one source page   → many sheets, enlarged and cut up
 *
 * All three reduce to "draw a rectangle of a source page into a rectangle of a
 * destination sheet", which pdf-lib gives us as `embedPage` + `drawPage`. The
 * source page becomes a Form XObject and is placed by a transform. Nothing is
 * rasterised: text stays selectable, vectors stay vectors, images are the same
 * bytes. What the three layouts differ in is only which rectangles go where,
 * so the placement maths lives in one function and the three layouts are the
 * three things that call it.
 *
 * Four traps, all of which produce output that looks plausible and is wrong:
 *
 *   1. `embedPage`'s bounding box DEFAULTS TO THE MEDIABOX. That is not what a
 *      reader shows. A page that has been cropped — by us, by a scanner, by an
 *      earlier imposition — displays its CropBox, and imposing the MediaBox
 *      puts the trimmed-off margins back on the sheet and shrinks the part the
 *      user cares about to make room. So every embed here passes an explicit
 *      bounding box of CropBox ∩ MediaBox. That box is also the XObject's
 *      /BBox, which means the PDF viewer clips to it for free — content that
 *      spilled outside the crop cannot bleed into the neighbouring cell.
 *
 *   2. `/Rotate` IS NOT CARRIED INTO THE XOBJECT. The embedder copies the
 *      content stream and the resources; the page dictionary's rotation is
 *      left behind. A landscape-by-rotation page embedded naively comes out
 *      portrait and sideways. Every placement below applies the rotation
 *      itself, and swaps the width and height for the quarter turns.
 *
 *   3. `drawPage` rotates about the ORIGIN, not about the placement's centre or
 *      corner: the operator order is translate → rotate → scale. So the
 *      translation has to pre-compensate for where the rotation throws the
 *      rectangle, which is a different corner for each of the four angles.
 *      `place()` is that table, derived rather than guessed.
 *
 *   4. Booklet order is not "pages in pairs". Getting it wrong yields a file
 *      that prints, folds, and is unreadable — the one failure mode where the
 *      user only finds out after using the paper. `bookletOrder` is exported
 *      on its own so the arithmetic can be printed and checked without going
 *      near a PDF.
 *
 * What imposition cannot preserve, and why it is stated in every result: an
 * embedded page is a content stream plus resources. Annotations are not part
 * of the content stream. Links, form fields, comments and bookmarks are page-
 * and document-level dictionaries, and there is nowhere on a tiled sheet to
 * put them that would still mean what they meant. They are dropped, not
 * silently degraded, and the notes say so.
 */
import {
  PDFDocument,
  clip,
  closePath,
  degrees,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineWidth,
  setStrokingColor,
  stroke,
} from '@cantoo/pdf-lib';
import type { PDFEmbeddedPage, PDFPage } from '@cantoo/pdf-lib';

import type { InputFile, OpResult, OutputFile } from './types';

// --- options -----------------------------------------------------------

/** A named paper size, the source page's own size, or exact points. */
export type SheetSize =
  | 'a3'
  | 'a4'
  | 'a5'
  | 'letter'
  | 'legal'
  | 'tabloid'
  | 'source'
  | { width: number; height: number };

export type SheetOrientation = 'portrait' | 'landscape' | 'auto';

/** How many source pages share a sheet. Each has one sensible grid. */
export type NUpCount = 2 | 4 | 6 | 8 | 9 | 16;

/**
 * Which cell the next page goes in.
 *
 * `row` is reading order and is what a handout wants. `column` fills top to
 * bottom first, which is what you need when the sheets will be guillotined
 * into stacks and collated. The `-rtl` variants mirror the columns for
 * right-to-left documents, where reading order runs the other way.
 */
export type NUpOrder = 'row' | 'column' | 'row-rtl' | 'column-rtl';

export interface NUpOptions {
  kind: 'n-up';
  perSheet: NUpCount;
  sheet?: SheetSize;
  orientation?: SheetOrientation;
  /** Points of blank paper around the whole grid. Default 18 (¼ inch). */
  margin?: number;
  /** Points of blank paper between cells. Default 0. */
  gutter?: number;
  /** Hairlines on the cell boundaries, to cut along. Default false. */
  separators?: boolean;
  order?: NUpOrder;
}

export interface BookletOptions {
  kind: 'booklet';
  /** Used in landscape whatever way round it is given: the fold is vertical. */
  sheet?: SheetSize;
  margin?: number;
  /** Points of blank paper at the fold, split between the two pages. */
  gutter?: number;
  /** A hairline down the fold. Default false. */
  separators?: boolean;
}

export interface PosterOptions {
  kind: 'poster';
  /** One-based page, counted across all input files. Default 1. */
  page?: number;
  /** Sheets across and down. At least one must be greater than 1. */
  across: number;
  down: number;
  sheet?: SheetSize;
  orientation?: SheetOrientation;
  margin?: number;
  /**
   * Points of content each sheet repeats from its neighbour, so the seams can
   * be trimmed and butted rather than guessed at. Default 18 (¼ inch).
   */
  overlap?: number;
  /** Hairlines showing where to cut. Default true — a poster needs them. */
  marks?: boolean;
}

export type ImposeOptions = NUpOptions | BookletOptions | PosterOptions;

// --- paper -------------------------------------------------------------

/** Points, portrait. ISO sizes are rounded to the ⅓ point PDF writers use. */
const PAPER: Record<string, { width: number; height: number }> = {
  a3: { width: 841.89, height: 1190.55 },
  a4: { width: 595.28, height: 841.89 },
  a5: { width: 419.53, height: 595.28 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  tabloid: { width: 792, height: 1224 },
};

/** ISO 32000-1 Annex C: the smallest page a reader will accept is 3 units. */
const MIN_SIDE = 3;

/** Thin enough to cut along, thick enough that a laser printer renders it. */
const HAIRLINE = 0.4;

const GUIDE = rgb(0.62, 0.62, 0.62);

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

const round = (n: number): number => Math.round(n * 1000) / 1000;

// --- source geometry ---------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || top <= y) return null;
  return { x, y, width: right - x, height: top - y };
};

/**
 * The rectangle a reader displays: CropBox ∩ MediaBox, MediaBox if that is
 * degenerate. Deliberately identical to the rule in crop.ts and to pdf.js's
 * own `Page.view`, because a disagreement between the thumbnail the user
 * picked from and the sheet we produce is a bug the user cannot diagnose.
 */
const visibleBox = (page: PDFPage): Rect => {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  if (crop.width <= 0 || crop.height <= 0) return media;
  return intersect(crop, media) ?? media;
};

/** /Rotate as a reader normalises it: a multiple of 90 in 0..270. */
const rotationOf = (page: PDFPage): number => {
  const angle = page.getRotation().angle;
  if (!Number.isFinite(angle) || angle % 90 !== 0) return 0;
  return ((angle % 360) + 360) % 360;
};

/** One source page, measured once and reused for every sheet it appears on. */
interface Source {
  page: PDFPage;
  /** Which input file it came from, and its one-based page number there. */
  file: number;
  number: number;
  box: Rect;
  rotation: number;
  /** Size as seen — width and height swapped for the quarter turns. */
  shownWidth: number;
  shownHeight: number;
}

const measure = (page: PDFPage, file: number, number: number): Source => {
  const box = visibleBox(page);
  const rotation = rotationOf(page);
  const quarter = rotation === 90 || rotation === 270;
  return {
    page,
    file,
    number,
    box,
    rotation,
    shownWidth: quarter ? box.height : box.width,
    shownHeight: quarter ? box.width : box.height,
  };
};

/**
 * A window of the page as displayed, expressed as the page's own rectangle.
 *
 * `wx`/`wy` are measured from the bottom-left of the DISPLAYED page and run
 * right and up. Rotation is undone here: for a quarter turn the two axes swap
 * and one of them reverses. The four cases were derived by mapping the corners
 * — a clockwise quarter turn sends the page's bottom-left corner to the
 * display's top-left, which is the fact the signs fall out of — because the
 * errors here are invisible on a square window of a square page and obvious on
 * everything else.
 */
const windowToBox = (
  source: Source,
  wx: number,
  wy: number,
  ww: number,
  wh: number
): { left: number; bottom: number; right: number; top: number } => {
  const { box, rotation } = source;
  const corners: { a: number; b: number }[] = [];
  for (const [dx, dy] of [
    [wx, wy],
    [wx + ww, wy + wh],
  ] as const) {
    switch (rotation) {
      case 90:
        corners.push({ a: box.width - dy, b: dx });
        break;
      case 180:
        corners.push({ a: box.width - dx, b: box.height - dy });
        break;
      case 270:
        corners.push({ a: dy, b: box.height - dx });
        break;
      default:
        corners.push({ a: dx, b: dy });
    }
  }
  const [p, q] = corners;
  return {
    left: round(box.x + Math.min(p.a, q.a)),
    bottom: round(box.y + Math.min(p.b, q.b)),
    right: round(box.x + Math.max(p.a, q.a)),
    top: round(box.y + Math.max(p.b, q.b)),
  };
};

// --- placement ---------------------------------------------------------

/**
 * Draw an embedded page so that its displayed rectangle lands exactly on
 * `target`, honouring the source page's own rotation.
 *
 * `drawPage` emits translate → rotate → scale → Do, and the rotation is about
 * the origin. After scaling, the unrotated XObject occupies [0,sw] × [0,sh];
 * rotating that by −90° (PDF's positive rotation is anticlockwise, /Rotate is
 * clockwise) sends it to [0,sh] × [−sw,0], so the translation has to add `sw`
 * to y to bring it back. Each angle drops the rectangle in a different
 * quadrant, which is what the four cases below are.
 *
 * `target` may extend past the sheet: the poster relies on that, and on a clip
 * being in force to cut it back.
 */
const place = (
  sheet: PDFPage,
  embedded: PDFEmbeddedPage,
  rotation: number,
  target: Rect
): void => {
  const quarter = rotation === 90 || rotation === 270;
  const scale = quarter ? target.width / embedded.height : target.width / embedded.width;
  const sw = embedded.width * scale;
  const sh = embedded.height * scale;

  let x = target.x;
  let y = target.y;
  let angle = 0;
  switch (rotation) {
    case 90:
      y += sw;
      angle = -90;
      break;
    case 180:
      x += sw;
      y += sh;
      angle = 180;
      break;
    case 270:
      x += sh;
      angle = 90;
      break;
  }

  sheet.drawPage(embedded, { x, y, width: sw, height: sh, rotate: degrees(angle) });
};

/** Largest rectangle of the given aspect that fits `cell`, centred in it. */
const fitCentred = (cell: Rect, shownWidth: number, shownHeight: number): Rect | null => {
  if (shownWidth <= 0 || shownHeight <= 0) return null;
  const scale = Math.min(cell.width / shownWidth, cell.height / shownHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = shownWidth * scale;
  const height = shownHeight * scale;
  return {
    x: cell.x + (cell.width - width) / 2,
    y: cell.y + (cell.height - height) / 2,
    width,
    height,
  };
};

const clipTo = (sheet: PDFPage, rect: Rect): void => {
  sheet.pushOperators(
    pushGraphicsState(),
    moveTo(rect.x, rect.y),
    lineTo(rect.x + rect.width, rect.y),
    lineTo(rect.x + rect.width, rect.y + rect.height),
    lineTo(rect.x, rect.y + rect.height),
    closePath(),
    clip(),
    endPath()
  );
};

const unclip = (sheet: PDFPage): void => {
  sheet.pushOperators(popGraphicsState());
};

const hairline = (sheet: PDFPage, x1: number, y1: number, x2: number, y2: number): void => {
  sheet.pushOperators(
    pushGraphicsState(),
    setLineWidth(HAIRLINE),
    setStrokingColor(GUIDE),
    moveTo(x1, y1),
    lineTo(x2, y2),
    stroke(),
    popGraphicsState()
  );
};

// --- booklet arithmetic ------------------------------------------------

/**
 * The order pages must be printed in for a saddle-stitched booklet.
 *
 * Returns one entry per half-sheet, two per emitted landscape sheet, so the
 * flat list reads: sheet 1 front left, sheet 1 front right, sheet 1 back left,
 * sheet 1 back right, sheet 2 front left, … `null` is a blank, which is what
 * the padding to a multiple of four becomes.
 *
 * The derivation, so it can be checked rather than trusted. A stack of sheets
 * folded together nests: the outermost sheet carries the first and last pages,
 * the next one in carries the second and second-last, and so on. Fold a sheet
 * in half with the spine on the left and the right half of the front becomes
 * the cover; the left half of the front wraps around to become the back cover.
 * So for `n` pages on sheet `i` (zero-based):
 *
 *   front  [ n − 2i , 1 + 2i ]        back  [ 2 + 2i , n − 1 − 2i ]
 *
 * The back looks reversed relative to the front because it is: turn the sheet
 * over about its short (vertical) edge and what was on the right is now on the
 * left. That is also why the file must be duplexed flipping on the SHORT edge
 * — long-edge duplex on a landscape sheet turns every other page upside down.
 *
 * Six pages pads to eight, so the outer sheet is [blank, 1] and [2, blank]:
 * the two blanks land on the inside back and the outside back, exactly where a
 * printer would put them.
 */
export function bookletOrder(pageCount: number): (number | null)[] {
  if (pageCount <= 0) return [];
  const padded = Math.ceil(pageCount / 4) * 4;
  const at = (n: number): number | null => (n >= 1 && n <= pageCount ? n : null);

  const order: (number | null)[] = [];
  for (let sheet = 0; sheet * 4 < padded; sheet += 1) {
    order.push(at(padded - 2 * sheet), at(1 + 2 * sheet));
    order.push(at(2 + 2 * sheet), at(padded - 1 - 2 * sheet));
  }
  return order;
}

// --- n-up grids --------------------------------------------------------

/** Columns × rows for each supported count, turned to suit the sheet. */
const gridFor = (perSheet: NUpCount, landscape: boolean): { cols: number; rows: number } => {
  const portrait: Record<NUpCount, { cols: number; rows: number }> = {
    2: { cols: 1, rows: 2 },
    4: { cols: 2, rows: 2 },
    6: { cols: 2, rows: 3 },
    8: { cols: 2, rows: 4 },
    9: { cols: 3, rows: 3 },
    16: { cols: 4, rows: 4 },
  };
  const grid = portrait[perSheet];
  return landscape ? { cols: grid.rows, rows: grid.cols } : grid;
};

/** Slot `index` (0-based, within one sheet) → its column and row. */
const cellFor = (
  index: number,
  cols: number,
  rows: number,
  order: NUpOrder
): { col: number; row: number } => {
  const downFirst = order === 'column' || order === 'column-rtl';
  const col = downFirst ? Math.floor(index / rows) : index % cols;
  const row = downFirst ? index % rows : Math.floor(index / cols);
  const rtl = order === 'row-rtl' || order === 'column-rtl';
  return { col: rtl ? cols - 1 - col : col, row };
};

// --- shared plumbing ---------------------------------------------------

const resolveSheet = (
  size: SheetSize | undefined,
  orientation: SheetOrientation,
  first: Source | undefined
): { width: number; height: number } | null => {
  let base: { width: number; height: number } | undefined;
  if (size === undefined) base = PAPER.a4;
  else if (size === 'source') {
    base = first ? { width: first.shownWidth, height: first.shownHeight } : undefined;
  } else if (typeof size === 'string') base = PAPER[size];
  else if (Number.isFinite(size?.width) && Number.isFinite(size?.height)) {
    base = { width: size.width, height: size.height };
  }

  if (!base || base.width < MIN_SIDE || base.height < MIN_SIDE) return null;

  if (orientation === 'auto') return base;
  const landscape = base.width > base.height;
  const wantLandscape = orientation === 'landscape';
  return landscape === wantLandscape
    ? { width: base.width, height: base.height }
    : { width: base.height, height: base.width };
};

interface Loaded {
  docs: PDFDocument[];
  sources: Source[];
  bytesIn: number;
}

const loadAll = async (files: InputFile[]): Promise<Loaded | string> => {
  const docs: PDFDocument[] = [];
  const sources: Source[] = [];
  let bytesIn = 0;

  for (const [index, file] of files.entries()) {
    bytesIn += file.bytes.byteLength;
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch {
      return `${file.name} could not be read. If it is password-protected, remove the password first with Unlock.`;
    }
    docs.push(doc);
    doc.getPages().forEach((page, i) => sources.push(measure(page, index, i + 1)));
  }

  return { docs, sources, bytesIn };
};

/**
 * Embed a set of windows, batching by source document.
 *
 * `embedPages` builds ONE object copier for the whole batch, so a font or an
 * image shared by twenty pages is copied across once. Calling `embedPage`
 * twenty times instead builds twenty copiers and twenty copies, which on a
 * 16-up of an illustrated document is the difference between a sheet and a
 * download. Worth the bookkeeping.
 */
type Window = { source: Source; wx: number; wy: number; ww: number; wh: number };

const embedWindows = async (
  out: PDFDocument,
  windows: Window[]
): Promise<(PDFEmbeddedPage | null)[]> => {
  const result: (PDFEmbeddedPage | null)[] = new Array(windows.length).fill(null);

  const byFile = new Map<number, number[]>();
  windows.forEach((window, index) => {
    const list = byFile.get(window.source.file) ?? [];
    list.push(index);
    byFile.set(window.source.file, list);
  });

  for (const [, all] of byFile) {
    // A page with no /Contents is legal and blank, and it must be filtered out
    // HERE rather than caught. `embedPages` does not read the content stream:
    // it builds an embedder and defers, and the read happens inside `save()`
    // when the document flushes. So a try/catch around the embed call never
    // fires — the throw arrives much later, from a call that has nothing to do
    // with this page, and takes the whole document with it. Ask first.
    const indexes = all.filter((i) => windows[i].source.page.node.Contents() !== undefined);
    if (indexes.length === 0) continue;

    const pages = indexes.map((i) => windows[i].source.page);
    const boxes = indexes.map((i) => {
      const w = windows[i];
      return windowToBox(w.source, w.wx, w.wy, w.ww, w.wh);
    });
    const embedded = await out.embedPages(pages, boxes);
    embedded.forEach((page, i) => {
      result[indexes[i]] = page;
    });
  }

  return result;
};

const finish = (
  out: PDFDocument,
  bytes: Uint8Array,
  name: string,
  bytesIn: number,
  started: number,
  summary: string,
  notes: string[]
): OpResult => {
  const files: OutputFile[] = [{ name, bytes }];
  if (bytes.length > bytesIn * 1.1 && bytes.length - bytesIn > 20_000) {
    notes.push(
      `The result is ${Math.round((bytes.length / bytesIn - 1) * 100)}% larger than the original. Each placement adds a wrapper object around content that is otherwise unchanged, and the file is repacked from scratch — nothing was re-encoded to make it bigger.`
    );
  }
  // Last, always, whatever each layout added in between.
  notes.push('Everything happened in this tab. Nothing was uploaded.');
  return {
    ok: true,
    files,
    bytesIn,
    bytesOut: bytes.length,
    pages: out.getPageCount(),
    durationMs: performance.now() - started,
    summary,
    notes,
  };
};

/** The caveats that are true of every layout here, in the same words each time. */
const sharedNotes = (blanks: number, cropped: number, rotated: number): string[] => {
  const notes: string[] = [
    'Pages were placed, not redrawn — the text, vectors and images on each sheet are the bytes from the original, so text is still selectable.',
    'Links, form fields, comments and bookmarks are gone. Imposition copies a page’s content, and those live in separate dictionaries with nowhere meaningful to land on a tiled sheet.',
  ];
  if (cropped > 0) {
    notes.push(
      `${cropped} page${cropped === 1 ? ' was' : 's were'} cropped, so what was placed is the visible area a reader shows — not the full sheet underneath it.`
    );
  }
  if (rotated > 0) {
    notes.push(
      `${rotated} page${rotated === 1 ? ' was' : 's were'} stored rotated; the rotation was applied when placing, so ${rotated === 1 ? 'it reads' : 'they read'} the right way up.`
    );
  }
  if (blanks > 0) {
    notes.push(
      `${blanks} page${blanks === 1 ? ' had' : 's had'} no content stream and came through as blank. That is what the original held, not something dropped here.`
    );
  }
  return notes;
};

const countCropped = (sources: Source[]): number =>
  sources.filter((s) => {
    const media = s.page.getMediaBox();
    return s.box.width < media.width - 0.5 || s.box.height < media.height - 0.5;
  }).length;

// --- the tool ----------------------------------------------------------

export async function impose(files: InputFile[], options: ImposeOptions): Promise<OpResult> {
  if (!files || files.length === 0) return { ok: false, error: 'Choose a PDF.' };
  if (!options || typeof options !== 'object') {
    return { ok: false, error: 'Choose a layout: pages per sheet, booklet, or poster.' };
  }

  const started = performance.now();
  const loaded = await loadAll(files);
  if (typeof loaded === 'string') return { ok: false, error: loaded };
  const { sources, bytesIn } = loaded;

  if (sources.length === 0) {
    return { ok: false, error: 'That PDF has no pages in it.' };
  }

  switch (options.kind) {
    case 'n-up':
      return nUp(sources, files, bytesIn, started, options);
    case 'booklet':
      return booklet(sources, files, bytesIn, started, options);
    case 'poster':
      return poster(sources, files, bytesIn, started, options);
    default:
      return { ok: false, error: 'Choose a layout: pages per sheet, booklet, or poster.' };
  }
}

// --- n-up --------------------------------------------------------------

async function nUp(
  sources: Source[],
  files: InputFile[],
  bytesIn: number,
  started: number,
  options: NUpOptions
): Promise<OpResult> {
  const allowed: NUpCount[] = [2, 4, 6, 8, 9, 16];
  if (!allowed.includes(options.perSheet)) {
    return {
      ok: false,
      error: `${options.perSheet} pages per sheet is not one of the layouts here. Choose 2, 4, 6, 8, 9 or 16.`,
    };
  }

  const margin = Math.max(0, options.margin ?? 18);
  const gutter = Math.max(0, options.gutter ?? 0);
  const order: NUpOrder = options.order ?? 'row';
  const orientation = options.orientation ?? 'auto';

  // "Auto" is decided by measuring, not by a rule of thumb: lay the first page
  // out both ways and keep whichever fits it larger. For a portrait source at
  // 2-up that picks landscape; at 9-up it picks portrait. A rule of thumb gets
  // one of those wrong.
  const candidates: SheetOrientation[] =
    orientation === 'auto' ? ['portrait', 'landscape'] : [orientation];

  let best: { sheet: { width: number; height: number }; grid: { cols: number; rows: number }; scale: number } | null =
    null;

  for (const candidate of candidates) {
    const sheet = resolveSheet(options.sheet, candidate, sources[0]);
    if (!sheet) return { ok: false, error: 'That sheet size is not one this tool knows.' };
    const grid = gridFor(options.perSheet, sheet.width > sheet.height);
    const cellWidth = (sheet.width - 2 * margin - gutter * (grid.cols - 1)) / grid.cols;
    const cellHeight = (sheet.height - 2 * margin - gutter * (grid.rows - 1)) / grid.rows;
    if (cellWidth < MIN_SIDE || cellHeight < MIN_SIDE) continue;
    const scale = Math.min(
      cellWidth / sources[0].shownWidth,
      cellHeight / sources[0].shownHeight
    );
    if (!best || scale > best.scale) best = { sheet, grid, scale };
  }

  if (!best) {
    return {
      ok: false,
      error: `A margin of ${Math.round(margin)} points and a gutter of ${Math.round(gutter)} leaves no room for ${options.perSheet} pages on that sheet. Reduce them, or choose a bigger sheet.`,
    };
  }

  const { sheet, grid } = best;
  const cellWidth = (sheet.width - 2 * margin - gutter * (grid.cols - 1)) / grid.cols;
  const cellHeight = (sheet.height - 2 * margin - gutter * (grid.rows - 1)) / grid.rows;

  const out = await PDFDocument.create();
  const windows: Window[] = sources.map((source) => ({
    source,
    wx: 0,
    wy: 0,
    ww: source.shownWidth,
    wh: source.shownHeight,
  }));
  const embedded = await embedWindows(out, windows);

  let blanks = 0;
  let smallest = Infinity;
  let largest = 0;
  const sheetCount = Math.ceil(sources.length / options.perSheet);

  for (let s = 0; s < sheetCount; s += 1) {
    const target = out.addPage([sheet.width, sheet.height]);

    for (let slot = 0; slot < options.perSheet; slot += 1) {
      const index = s * options.perSheet + slot;
      if (index >= sources.length) break;

      const { col, row } = cellFor(slot, grid.cols, grid.rows, order);
      const cell: Rect = {
        x: margin + col * (cellWidth + gutter),
        // Row 0 is the TOP row: PDF y runs up, reading order runs down.
        y: margin + (grid.rows - 1 - row) * (cellHeight + gutter),
        width: cellWidth,
        height: cellHeight,
      };

      const page = embedded[index];
      if (!page) {
        blanks += 1;
        continue;
      }

      const source = sources[index];
      const box = fitCentred(cell, source.shownWidth, source.shownHeight);
      if (!box) {
        blanks += 1;
        continue;
      }
      const used = box.width / source.shownWidth;
      smallest = Math.min(smallest, used);
      largest = Math.max(largest, used);
      place(target, page, source.rotation, box);
    }

    if (options.separators) {
      for (let c = 1; c < grid.cols; c += 1) {
        const x = margin + c * cellWidth + (c - 0.5) * gutter;
        hairline(target, x, margin, x, sheet.height - margin);
      }
      for (let r = 1; r < grid.rows; r += 1) {
        const y = margin + r * cellHeight + (r - 0.5) * gutter;
        hairline(target, margin, y, sheet.width - margin, y);
      }
    }
  }

  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });

  const rotated = sources.filter((s) => s.rotation !== 0).length;
  const notes = sharedNotes(blanks, countCropped(sources), rotated);

  if (Number.isFinite(smallest)) {
    const range =
      Math.round(largest * 100) === Math.round(smallest * 100)
        ? `${Math.round(smallest * 100)}%`
        : `${Math.round(smallest * 100)}–${Math.round(largest * 100)}%`;
    notes.unshift(
      `Pages are drawn at ${range} of their original size. Body text set at 11pt comes out around ${(11 * smallest).toFixed(1)}pt — print one sheet and read it before committing to the rest.`
    );
  }
  const varied = new Set(sources.map((s) => `${Math.round(s.shownWidth)}x${Math.round(s.shownHeight)}`));
  if (varied.size > 1) {
    notes.push(
      `The source pages are not all the same size (${varied.size} different sizes), so each was fitted to its own cell and they do not all end up at the same scale.`
    );
  }
  if (options.separators) {
    notes.push('The hairlines mark the cell boundaries, not a trim allowance — cut on them and adjacent pages meet exactly.');
  }

  const label = files.length > 1 ? 'pages' : baseName(files[0].name);
  return finish(
    out,
    bytes,
    `${label}-${options.perSheet}-up.pdf`,
    bytesIn,
    started,
    `${sources.length} page${sources.length === 1 ? '' : 's'} · ${options.perSheet} per sheet · ${sheetCount} sheet${sheetCount === 1 ? '' : 's'} · ${Math.round(sheet.width)} × ${Math.round(sheet.height)} pt`,
    notes
  );
}

// --- booklet -----------------------------------------------------------

async function booklet(
  sources: Source[],
  files: InputFile[],
  bytesIn: number,
  started: number,
  options: BookletOptions
): Promise<OpResult> {
  const margin = Math.max(0, options.margin ?? 18);
  const gutter = Math.max(0, options.gutter ?? 0);

  // The fold runs down the middle, so the sheet is used long side across
  // whichever way round the caller named it.
  const chosen = resolveSheet(options.sheet, 'landscape', sources[0]);
  if (!chosen) return { ok: false, error: 'That sheet size is not one this tool knows.' };
  const sheet = chosen;

  const cellWidth = (sheet.width - 2 * margin - gutter) / 2;
  const cellHeight = sheet.height - 2 * margin;
  if (cellWidth < MIN_SIDE || cellHeight < MIN_SIDE) {
    return {
      ok: false,
      error: `A margin of ${Math.round(margin)} points and a gutter of ${Math.round(gutter)} leaves no room for two pages on that sheet. Reduce them, or choose a bigger sheet.`,
    };
  }

  const order = bookletOrder(sources.length);
  const padded = Math.ceil(sources.length / 4) * 4;

  const out = await PDFDocument.create();
  const windows: Window[] = sources.map((source) => ({
    source,
    wx: 0,
    wy: 0,
    ww: source.shownWidth,
    wh: source.shownHeight,
  }));
  const embedded = await embedWindows(out, windows);

  let blanks = 0;
  let smallest = Infinity;

  for (let side = 0; side * 2 < order.length; side += 1) {
    const target = out.addPage([sheet.width, sheet.height]);

    for (const half of [0, 1] as const) {
      const number = order[side * 2 + half];
      if (number === null) continue;

      const source = sources[number - 1];
      const page = embedded[number - 1];
      if (!source || !page) {
        blanks += 1;
        continue;
      }

      const cell: Rect = {
        x: margin + half * (cellWidth + gutter),
        y: margin,
        width: cellWidth,
        height: cellHeight,
      };
      const box = fitCentred(cell, source.shownWidth, source.shownHeight);
      if (!box) {
        blanks += 1;
        continue;
      }
      smallest = Math.min(smallest, box.width / source.shownWidth);
      place(target, page, source.rotation, box);
    }

    if (options.separators) {
      const x = sheet.width / 2;
      hairline(target, x, margin, x, sheet.height - margin);
    }
  }

  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });

  const rotated = sources.filter((s) => s.rotation !== 0).length;
  const notes = sharedNotes(blanks, countCropped(sources), rotated);

  notes.unshift(
    'Print double-sided, flipping on the SHORT edge. These are landscape sheets, so long-edge duplex turns every second side upside down — the pages would be in the right places and the wrong way up.'
  );
  notes.splice(
    1,
    0,
    'The page order in this file is the folding order, not reading order. Opened on screen it looks scrambled; that is correct. Print it, stack the sheets in order, fold the stack in half together and staple through the fold.'
  );

  const pad = padded - sources.length;
  if (pad > 0) {
    notes.push(
      `${sources.length} pages were padded to ${padded} with ${pad} blank${pad === 1 ? '' : 's'}. A saddle-stitched booklet is made of folded sheets and every sheet holds four pages, so the count has to be a multiple of four. The blanks fall at the end of the booklet.`
    );
  }
  if (Number.isFinite(smallest)) {
    const percent = Math.round(smallest * 100);
    notes.push(
      `Pages are drawn at about ${percent}% of their original size to fit two on a ${Math.round(sheet.width)} × ${Math.round(sheet.height)} pt sheet.`
    );
  }
  notes.push(
    'The gutter is even on both halves. Thick booklets creep — the inner pages stick out past the outer ones once folded — and this does not compensate for that; for more than about 40 pages, trim the fore-edge after folding.'
  );

  const sheets = out.getPageCount() / 2;
  const label = files.length > 1 ? 'pages' : baseName(files[0].name);
  return finish(
    out,
    bytes,
    `${label}-booklet.pdf`,
    bytesIn,
    started,
    `${sources.length} page${sources.length === 1 ? '' : 's'} → ${padded} in folding order · ${sheets} sheet${sheets === 1 ? '' : 's'}, printed both sides`,
    notes
  );
}

// --- poster ------------------------------------------------------------

async function poster(
  sources: Source[],
  files: InputFile[],
  bytesIn: number,
  started: number,
  options: PosterOptions
): Promise<OpResult> {
  const number = options.page ?? 1;
  if (!Number.isInteger(number) || number < 1 || number > sources.length) {
    return {
      ok: false,
      error: `Choose a page from 1 to ${sources.length} to blow up.`,
    };
  }
  const source = sources[number - 1];

  const across = options.across;
  const down = options.down;
  if (
    !Number.isInteger(across) ||
    !Number.isInteger(down) ||
    across < 1 ||
    down < 1 ||
    across > 10 ||
    down > 10
  ) {
    return { ok: false, error: 'Choose between 1 and 10 sheets across and down.' };
  }
  if (across === 1 && down === 1) {
    return {
      ok: false,
      error: 'One sheet across and one down is not a poster — it is a copy. Ask for at least two sheets one way.',
    };
  }

  const margin = Math.max(0, options.margin ?? 18);
  const overlap = Math.max(0, options.overlap ?? 18);
  const marks = options.marks ?? true;
  const orientation = options.orientation ?? 'auto';

  const candidates: SheetOrientation[] =
    orientation === 'auto' ? ['portrait', 'landscape'] : [orientation];

  let best: { sheet: { width: number; height: number }; scale: number } | null = null;
  for (const candidate of candidates) {
    const sheet = resolveSheet(options.sheet, candidate, source);
    if (!sheet) return { ok: false, error: 'That sheet size is not one this tool knows.' };
    const printW = sheet.width - 2 * margin;
    const printH = sheet.height - 2 * margin;
    if (printW < MIN_SIDE || printH < MIN_SIDE) continue;
    if (overlap >= printW || overlap >= printH) continue;
    const totalW = across * printW - (across - 1) * overlap;
    const totalH = down * printH - (down - 1) * overlap;
    const scale = Math.min(totalW / source.shownWidth, totalH / source.shownHeight);
    if (!best || scale > best.scale) best = { sheet, scale };
  }

  if (!best) {
    return {
      ok: false,
      error: `A margin of ${Math.round(margin)} points and an overlap of ${Math.round(overlap)} leaves no printable area on that sheet. Reduce them, or choose a bigger sheet.`,
    };
  }

  const { sheet, scale } = best;
  const printW = sheet.width - 2 * margin;
  const printH = sheet.height - 2 * margin;
  const totalW = across * printW - (across - 1) * overlap;
  const totalH = down * printH - (down - 1) * overlap;

  const posterW = source.shownWidth * scale;
  const posterH = source.shownHeight * scale;
  // The enlarged page is centred on the wall of paper, so the surplus is split
  // evenly rather than piling up on the last sheet.
  const posterX = (totalW - posterW) / 2;
  const posterY = (totalH - posterH) / 2;

  const out = await PDFDocument.create();
  const embedded = await embedWindows(out, [
    { source, wx: 0, wy: 0, ww: source.shownWidth, wh: source.shownHeight },
  ]);
  const page = embedded[0];
  if (!page) {
    return {
      ok: false,
      error: `Page ${number} has no content in it, so there is nothing to enlarge. Pick a page with something on it.`,
    };
  }

  for (let row = 0; row < down; row += 1) {
    for (let col = 0; col < across; col += 1) {
      const target = out.addPage([sheet.width, sheet.height]);

      // The tile's window on the wall of paper. Row 0 is the top row.
      const windowX = col * (printW - overlap);
      const windowTop = totalH - row * (printH - overlap);
      const windowY = windowTop - printH;

      const printable: Rect = { x: margin, y: margin, width: printW, height: printH };
      clipTo(target, printable);
      place(target, page, source.rotation, {
        x: margin + (posterX - windowX),
        y: margin + (posterY - windowY),
        width: posterW,
        height: posterH,
      });
      unclip(target);

      if (marks) {
        // The printable border, then the trim lines: each sheet repeats the
        // overlap strip from the neighbour above and to its left, so those are
        // the two edges you cut before butting the sheets together.
        hairline(target, margin, margin, margin + printW, margin);
        hairline(target, margin, margin + printH, margin + printW, margin + printH);
        hairline(target, margin, margin, margin, margin + printH);
        hairline(target, margin + printW, margin, margin + printW, margin + printH);
        if (col > 0) {
          hairline(target, margin + overlap, margin, margin + overlap, margin + printH);
        }
        if (row > 0) {
          hairline(target, margin, margin + printH - overlap, margin + printW, margin + printH - overlap);
        }
      }
    }
  }

  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });

  const notes = sharedNotes(0, countCropped([source]), source.rotation !== 0 ? 1 : 0);

  const enlargement = Math.round(scale * 100);
  const widthCm = (posterW / 72) * 2.54;
  const heightCm = (posterH / 72) * 2.54;
  notes.unshift(
    `Page ${number} is enlarged to ${enlargement}% — about ${widthCm.toFixed(0)} × ${heightCm.toFixed(0)} cm once assembled.`,
    `Text and vector artwork enlarge cleanly at any size. Photographs do not: anything on this page that is a picture is being blown up ${scale.toFixed(1)}× and will look softer on paper than it does on screen.`
  );
  if (overlap > 0) {
    notes.push(
      `Each sheet repeats ${Math.round(overlap)} points (${((overlap / 72) * 25.4).toFixed(0)} mm) of its neighbour above and to the left. Trim on the inner guide line of those two edges, then butt the sheets — do not overlap them again or the picture shrinks.`
    );
  } else {
    notes.push(
      'There is no overlap, so the sheets have to be butted exactly on the printed border. Any printer that scales the page even slightly will show a seam; a few points of overlap is more forgiving.'
    );
  }
  notes.push(
    'Print at 100%. "Fit to page" and "shrink oversized pages" scale each sheet independently, and tiles that were each shrunk by a different amount cannot be made to line up.',
    `The sheets are already ${Math.round(sheet.width)} × ${Math.round(sheet.height)} pt, with ${Math.round(margin)} pt of margin left for the printer's unprintable edge.`
  );
  const waste = 1 - (posterW * posterH) / (totalW * totalH);
  if (waste > 0.15) {
    notes.push(
      `${Math.round(waste * 100)}% of the paper ends up blank because a ${across} × ${down} grid is a different shape from this page. A ${across === down ? 'different' : 'squarer or longer'} grid would waste less.`
    );
  }

  const label = baseName(files[source.file]?.name ?? 'poster');
  return finish(
    out,
    bytes,
    `${label}-poster.pdf`,
    bytesIn,
    started,
    `Page ${number} across ${across} × ${down} sheets · ${enlargement}% · ${widthCm.toFixed(0)} × ${heightCm.toFixed(0)} cm`,
    notes
  );
}
