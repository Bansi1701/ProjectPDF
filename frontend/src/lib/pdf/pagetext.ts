/**
 * The document that a PDF page only implies.
 *
 * pdf.js hands back positioned glyph runs. It does not hand back a document:
 * there are no paragraphs in a PDF, no headings, no table — only text placed at
 * coordinates by whatever produced the file. Everything below is inference from
 * geometry, and it is the whole of the difficult part of PDF → Word and
 * PDF → Excel. Both converters read this module; neither should re-derive any
 * of it, or the two will drift and disagree about the same page.
 *
 * Three stances run through the file:
 *
 *  - **Relative, never absolute.** A document set in 9pt has 12pt headings. A
 *    threshold in points is a threshold that works on the documents it was
 *    written against. Every size test here is a ratio against the document's
 *    own modal body size, and every distance is in ems of the text it measures.
 *
 *  - **Say what is not known.** Bold and italic are read off font names, which
 *    are frequently absent or lying. Tables are found by alignment, which is
 *    circumstantial. Both carry a confidence out to the caller so PDF → Excel
 *    can decline honestly instead of emitting a convincing, wrong spreadsheet.
 *
 *  - **Wrong structure is worse than missing structure.** A heading that is not
 *    there is visible to the reader. Two paragraphs silently glued together, or
 *    two columns interleaved line by line, are not.
 *
 * Nothing here logs, and nothing here leaves the browser.
 */
import { documentOptions, loadPdfjs } from './pdfjs';
import type { PdfjsApi } from './pdfjs';

// ── the pdf.js shapes we accept ─────────────────────────────────────────

/** A loaded pdf.js document, as `loadPdfjs()` produces one. */
export type PdfDocument = Awaited<ReturnType<PdfjsApi['getDocument']>['promise']>;

/** One page of it. `analysePage` takes this; `readDocumentStructure` opens its own. */
export type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

// ── what a page is made of ──────────────────────────────────────────────

/**
 * One glyph run, normalised into top-down page points.
 *
 * pdf.js reports text in PDF user space: y grows upward, the origin is the
 * viewBox corner, and the page's own /Rotate has not been applied. Every
 * coordinate in this file has been through the page viewport instead, so it is
 * top-down, page-relative, and upright — the same space thumbnails and
 * redaction boxes already use.
 */
export interface TextRun {
  text: string;
  /** Left edge, points from the left of the upright page. */
  x: number;
  /** Right edge: x plus the run's advance width. */
  right: number;
  /** Baseline, points from the top of the upright page. */
  baseline: number;
  /** Top of the em box, from the font's own ascent where it is known. */
  top: number;
  bottom: number;
  /** Rendered size in points — the number a word processor calls font size. */
  fontSize: number;
  /** pdf.js's internal id ("g_d0_f3"), stable within a document. */
  fontId: string;
  /** PostScript name with any subset tag stripped, or '' when unresolved. */
  fontName: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  monospace: boolean;
  /**
   * A whitespace-only run. pdf.js synthesises these where a PDF moves the pen
   * instead of drawing a space, and their width is the size of the *gap* rather
   * than of any glyph — which makes them the cheapest column signal on offer.
   */
  spacer: boolean;
}

/** Runs that share a baseline, left to right. */
export interface TextLine {
  runs: TextRun[];
  /** Runs joined, with spaces inserted where the gaps say there were spaces. */
  text: string;
  x: number;
  right: number;
  top: number;
  bottom: number;
  baseline: number;
  /** The size of the run that dominates the line, not the largest run. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** Index into `PageStructure.bands`. */
  band: number;
  /** Index into that band's `columns`. */
  column: number;
  /** Index into `PageStructure.tables`, or -1 when the line is running text. */
  table: number;
  /** Repeats in the same place on most pages: a running head or a folio. */
  running: boolean;
}

/**
 * A picture, and where it sits on the upright page.
 *
 * The placement is the whole point: a converter that knows an image exists but
 * not where it goes can only append it, which is how a report ends up with its
 * chart at the bottom and its caption three pages up.
 */
export interface PlacedImage {
  /** Points from the left and top of the upright page. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Encoded file bytes, ready to drop into a container. */
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  pixelWidth: number;
  pixelHeight: number;
}

/** A vertical text column inside one horizontal band of the page. */
export interface PageColumn {
  x: number;
  right: number;
  top: number;
  bottom: number;
  lines: TextLine[];
}

/**
 * A horizontal slice of the page with a single column structure.
 *
 * A two-column paper with a full-width title is two bands: the title's, which
 * has one column, and the body's, which has two. Reading order is bands down
 * the page, then columns across, then lines down each column.
 */
export interface ColumnBand {
  top: number;
  bottom: number;
  columns: PageColumn[];
}

/** A stroked or filled rule: a table border, an underline, a divider. */
export interface RuleLine {
  x: number;
  y: number;
  width: number;
  height: number;
  orientation: 'horizontal' | 'vertical';
}

export type BlockAlign = 'left' | 'center' | 'right' | 'justify';

/** A run of lines that belong together: a paragraph, a heading, a list item. */
export interface Paragraph {
  kind: 'heading' | 'paragraph' | 'list-item' | 'running';
  /** 1-6 for a heading, 0 otherwise. */
  level: number;
  /** The bullet glyph or the number, with `text` already stripped of it. */
  marker: string | null;
  /** A numbered list item rather than a bulleted one. */
  ordered: boolean;
  text: string;
  lines: TextLine[];
  x: number;
  right: number;
  top: number;
  bottom: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: BlockAlign;
  /** Points from the column's left edge — Word wants this × 20, in twips. */
  indent: number;
  /** First line's extra indent; negative for a hanging indent. */
  firstLineIndent: number;
  /** Blank space above the block, in points. */
  spaceBefore: number;
  band: number;
  column: number;
}

export interface TableCell {
  text: string;
  runs: TextRun[];
  row: number;
  column: number;
  /** Columns covered. >1 where one piece of text straddles a boundary. */
  span: number;
}

export interface TableColumnSpec {
  x: number;
  right: number;
  /** Where the cells line up: numbers usually right-align, labels left. */
  align: 'left' | 'center' | 'right';
}

/** How a table was arrived at, so a caller can second-guess the number. */
export interface TableEvidence {
  rows: number;
  columns: number;
  /** Share of cells present, over rows × columns. A real table is dense. */
  rowSupport: number;
  /** 0-1: how tightly the cells in each column line up. */
  alignment: number;
  /** Share of rows that split into exactly `columns` cells. */
  shape: number;
  /** 0-1: how much of the grid is corroborated by actual drawn rules. */
  ruleScore: number;
  /** Cells forced to share a column because the inferred grid did not separate
   * them. Any number above zero means text was joined that was not adjacent. */
  collisions: number;
}

export interface TableBlock {
  kind: 'table';
  /** Row-major and rectangular: every row has `columns.length` cells. */
  rows: TableCell[][];
  columns: TableColumnSpec[];
  lines: TextLine[];
  x: number;
  right: number;
  top: number;
  bottom: number;
  band: number;
  column: number;
  /** 0-1. See `TABLE_CONFIDENCE_FLOOR` before rendering this as a table. */
  confidence: number;
  /** Drawn rules were found around the grid, not merely aligned whitespace. */
  ruled: boolean;
  evidence: TableEvidence;
}

export type PageBlock = Paragraph | TableBlock;

export interface PageStructure {
  page: number;
  /** Upright page size in points, with the page's own /Rotate applied. */
  width: number;
  height: number;
  rotation: number;
  /** The modal body size used to judge this page's headings. */
  bodyFontSize: number;
  /** Every line, in reading order. */
  lines: TextLine[];
  /** Paragraphs, headings, list items and tables, in reading order. */
  blocks: PageBlock[];
  tables: TableBlock[];
  bands: ColumnBand[];
  /** Most columns found in any one band. 1 means a single-column page. */
  columnCount: number;
  /** 0-1. 1 when the page is plainly single-column and nothing was guessed. */
  columnConfidence: number;
  rules: RuleLine[];
  /** Pictures drawn on this page, with their placement. Empty when unread. */
  images: PlacedImage[];
  /** Whether bold and italic could be read at all on this page. */
  emphasis: 'font-names' | 'unknown';
  /** Runs turned on their side; they are excluded from lines, not lost. */
  sidewaysRuns: number;
  text: string;
  /** No text layer on this page — an image of a page, most likely. */
  empty: boolean;
}

export interface DocumentStructure {
  pages: PageStructure[];
  pageCount: number;
  /** The document's modal body size. Every heading ratio is against this. */
  bodyFontSize: number;
  bulletGlyphs: string[];
  emphasis: 'font-names' | 'unknown';
  /** The text layer reads like the output of a poor OCR pass. */
  ocrNoise: boolean;
  /** Pages that failed to read; they are absent from `pages`. Never the ones
   * left out by `maxPages` — those are counted by `pageCount` minus `pages`. */
  skippedPages: number[];
  /** Captured before pdf.js detached the input buffer. */
  bytesIn: number;
  text: string;
  /** Plain-language caveats worth passing to the user. */
  notes: string[];
}

export type StructureResult =
  | { ok: true; document: DocumentStructure }
  | { ok: false; error: string };

export interface ReadOptions {
  /**
   * Resolving real font names costs one `getOperatorList()` per page, which
   * also decodes that page's images. Turning it off loses bold, italic and
   * drawn rules, and says so through `emphasis`.
   */
  fonts?: 'resolve' | 'skip';
  /** Stop after this many pages. What was read is in `pages`, and a note says so. */
  maxPages?: number;
}

/**
 * Below this, a table is a guess rather than a finding.
 *
 * Both converters share the number so they agree about the same page. It is
 * where the gap fell when this was measured over a mixed corpus: the tables
 * that turned out to be real scored 0.79 and up, and the two that were not —
 * a scan's OCR noise, and a paragraph with a link hanging off its right edge —
 * scored 0.60 and 0.65.
 */
export const TABLE_CONFIDENCE_FLOOR = 0.7;

// ── small numeric helpers ───────────────────────────────────────────────

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function spread(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * The most common line size, weighted by how much text is set in it.
 *
 * Weighting by characters rather than by line count is what stops a page whose
 * only long line is its title from deciding the document is set in 28pt.
 */
export function modalFontSize(lines: TextLine[]): number {
  const buckets = new Map<number, number>();
  for (const line of lines) {
    // Half-point buckets: the same paragraph often reports 9.96 and 10.04.
    const key = Math.round(line.fontSize * 2) / 2;
    buckets.set(key, (buckets.get(key) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = 0;
  for (const [size, weight] of buckets) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best || 12;
}

// ── fonts ───────────────────────────────────────────────────────────────

interface FontFacts {
  name: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  monospace: boolean;
  known: boolean;
}

/**
 * `(?![a-z])` is not decoration.
 *
 * Without it "Blackadder" is bold and "Bookman-Italicised" is italic. With it,
 * the token has to end at a case change or a separator, which is how real
 * PostScript names are built: Arial-BoldMT, TimesNewRomanPS-BoldItalicMT,
 * Georgia,Bold, Helvetica-Oblique.
 */
/**
 * The lookahead above cannot be written as `(?![a-z])` on a case-insensitive
 * regex: under `/i` the class matches uppercase too, so "Bold" followed by the
 * capital of "BoldMT" fails the very test it was meant to pass. That silently
 * cost every Arial and Times New Roman document its bold and italic — a
 * 49-page sample produced zero bold runs across 806 paragraphs — because their
 * PostScript names end the weight token with the Monotype "MT" suffix.
 *
 * Splitting on the case change first expresses the same rule and actually
 * holds: "Arial-BoldMT" tokenises to "arial-bold mt", while "Blackadder" has
 * no case change and stays one token, so it is still not bold.
 */
const tokeniseFontName = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

// Bare "ultra" and "demi" are omitted deliberately: "UltraLight" is a thin
// weight, not a bold one, and would otherwise match.
const BOLD_NAME = /\b(bold|black|heavy|semibold|demibold|extrabold|ultrabold|demi)\b/;
const ITALIC_NAME = /\b(italic|oblique)\b/;

/** Subset tags: six capitals and a plus, prepended by the producer. */
const SUBSET_TAG = /^[A-Z]{6}\+/;

function readFontFacts(raw: unknown, family: string | undefined): FontFacts {
  const font = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  const name = typeof font?.name === 'string' ? font.name.replace(SUBSET_TAG, '') : '';

  // pdf.js fills in .bold/.italic only when it had to substitute a font it
  // could not find. For an embedded subset — which is most real documents —
  // both are undefined and the PostScript name is the only evidence there is.
  const flaggedBold = font?.bold === true || font?.black === true;
  const flaggedItalic = font?.italic === true;

  return {
    name,
    bold: flaggedBold || BOLD_NAME.test(tokeniseFontName(name)),
    italic: flaggedItalic || ITALIC_NAME.test(tokeniseFontName(name)),
    // fallbackName is the only classification pdf.js exposes without the
    // operator list, and it only ever says serif, sans-serif or monospace.
    serif: family === 'serif',
    monospace: family === 'monospace',
    known: name.length > 0,
  };
}

// ── drawn rules ─────────────────────────────────────────────────────────

/** A rule is thinner than this; anything fatter is a filled panel. */
const RULE_THICKNESS = 2.5;
/** And longer than this, so glyph-sized artefacts do not count. */
const RULE_LENGTH = 12;

function matrixMultiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Reads `count` finite numbers out of an array, a Float32Array, or nothing. */
function numbers(value: unknown, count: number): number[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as ArrayLike<unknown>;
  if (typeof source.length !== 'number' || source.length < count) return null;
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = source[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    out.push(entry);
  }
  return out;
}

type OperatorList = Awaited<ReturnType<PdfPage['getOperatorList']>>;
type ViewportPoint = (x: number, y: number) => [number, number];

/**
 * Finds the horizontal and vertical rules drawn on the page.
 *
 * Table borders, header underlines and dividers are vector paths, so they are
 * invisible to `getTextContent()` — which is exactly why a ruled table is so
 * often reconstructed as three ragged paragraphs. They are visible in the
 * operator list, and this page has already paid for that list to read its
 * fonts, so the rules come almost free.
 *
 * pdf.js gives every path a bounding box in the space it was constructed in;
 * this walks the graphics stack to put that box back into page coordinates.
 * A path drawn as one long sequence of subpaths — a whole table grid in one go
 * — has a box the size of the table and is correctly ignored rather than
 * mistaken for a rule. Missing a rule only costs confidence; inventing one
 * would cost correctness.
 */
async function readRules(operators: OperatorList, toPoint: ViewportPoint): Promise<RuleLine[]> {
  const { OPS } = await loadPdfjs();
  const rules: RuleLine[] = [];

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const op = operators.fnArray[index];
    const args: unknown = operators.argsArray[index];

    if (op === OPS.save) {
      stack.push([...ctm]);
    } else if (op === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (op === OPS.transform) {
      const matrix = numbers(args, 6);
      if (matrix) ctm = matrixMultiply(ctm, matrix);
    } else if (op === OPS.paintFormXObjectBegin) {
      stack.push([...ctm]);
      const matrix = Array.isArray(args) ? numbers(args[0], 6) : null;
      if (matrix) ctm = matrixMultiply(ctm, matrix);
    } else if (op === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (op === OPS.constructPath) {
      const box = Array.isArray(args) ? numbers(args[2], 4) : null;
      if (!box) continue;

      const corners: [number, number][] = [
        [box[0], box[1]],
        [box[2], box[1]],
        [box[2], box[3]],
        [box[0], box[3]],
      ].map(([x, y]) => {
        const [ux, uy] = [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
        return toPoint(ux, uy);
      });

      const xs = corners.map((point) => point[0]);
      const ys = corners.map((point) => point[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;

      if (height <= RULE_THICKNESS && width >= RULE_LENGTH) {
        rules.push({ x, y, width, height, orientation: 'horizontal' });
      } else if (width <= RULE_THICKNESS && height >= RULE_LENGTH) {
        rules.push({ x, y, width, height, orientation: 'vertical' });
      }
    }
  }

  return rules;
}

// ── runs ────────────────────────────────────────────────────────────────

/** Beyond this much slope a run is sideways text, not part of a line. */
const HORIZONTAL_SLOPE = 0.27; // ~15°

/** Used when the font declares no ascent or descent of its own. */
const DEFAULT_ASCENT = 0.75;
const DEFAULT_DESCENT = -0.22;

interface PageRuns {
  runs: TextRun[];
  sideways: number;
  fontsResolved: boolean;
  rules: RuleLine[];
  images: PlacedImage[];
}

interface ImageObject {
  width: number;
  height: number;
  data?: Uint8Array | Uint8ClampedArray | null;
  bitmap?: ImageBitmap | null;
}

interface ObjectStore {
  has(id: string): boolean;
  get(id: string): unknown;
  get(id: string, callback: (data: unknown) => void): null;
}

/**
 * How long to wait for one picture's pixels after the operator list arrives.
 *
 * getOperatorList resolves without waiting for images — the render path waits
 * on dependencies and this is not the render path. Checking `has()` alone found
 * every PNG and no JPEG at all, because a JPEG is still in flight at that
 * moment. In practice the pixels land immediately; this is the ceiling so one
 * undecodable image costs a missing picture rather than a hung tab.
 */
const IMAGE_WAIT_MS = 10_000;

const asImage = (value: unknown): ImageObject | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ImageObject>;
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') return null;
  return candidate.width > 0 && candidate.height > 0 ? (candidate as ImageObject) : null;
};

/**
 * Pictures and where they land, from the same operator list the rules come from.
 *
 * A PDF places an image by mapping the unit square through the current
 * transform, so the placement *is* the CTM — which is why this walks the same
 * graphics stack readRules does rather than guessing from the image's own
 * pixel size. The four transformed corners are bounded, so a rotated or
 * flipped placement still yields the box it actually occupies.
 *
 * Encoding goes through a canvas rather than reproducing the source bytes.
 * Extract Images exists for people who want the original file; here the image
 * is going into a Word document that will re-compress it anyway, and a canvas
 * costs about a hundred lines less.
 */
async function readImages(
  page: PdfPage,
  operators: OperatorList,
  toPoint: ViewportPoint
): Promise<PlacedImage[]> {
  if (typeof OffscreenCanvas === 'undefined') return [];
  const { OPS } = await loadPdfjs();

  const local = page.objs as unknown as ObjectStore;
  const shared = page.commonObjs as unknown as ObjectStore;
  const placed: PlacedImage[] = [];

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const op = operators.fnArray[index];
    const args: unknown = operators.argsArray[index];

    if (op === OPS.save) {
      stack.push([...ctm]);
      continue;
    }
    if (op === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (op === OPS.transform) {
      const matrix = numbers(args, 6);
      if (matrix) ctm = matrixMultiply(ctm, matrix);
      continue;
    }
    if (op === OPS.paintFormXObjectBegin) {
      stack.push([...ctm]);
      const matrix = Array.isArray(args) ? numbers(args[0], 6) : null;
      if (matrix) ctm = matrixMultiply(ctm, matrix);
      continue;
    }
    if (op === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (op !== OPS.paintImageXObject && op !== OPS.paintImageXObjectRepeat) continue;

    const id = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : null;
    if (!id) continue;

    // Objects exist only once the operator list has been built, and `get`
    // throws for an id that has not resolved — so `has` is not optional. A
    // globally cached image lands in the document's store, not the page's.
    let object: ImageObject | null = null;
    if (local.has(id)) object = asImage(local.get(id));
    else if (shared.has(id)) object = asImage(shared.get(id));
    else {
      // Not resolved yet. A globally cached image — one repeated across pages —
      // is sent to the document's store, so the id says which one to ask.
      const store = id.startsWith('g_') ? shared : local;
      object = asImage(
        await new Promise<unknown>((resolve) => {
          let settled = false;
          const finish = (data: unknown) => {
            if (settled) return;
            settled = true;
            resolve(data);
          };
          const timer = setTimeout(() => finish(null), IMAGE_WAIT_MS);
          try {
            store.get(id, (data: unknown) => {
              clearTimeout(timer);
              finish(data);
            });
          } catch {
            clearTimeout(timer);
            finish(null);
          }
        })
      );
    }
    if (!object) continue;

    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([x, y]) => toPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    // A hairline placement is a rule drawn as an image, or a spacer.
    if (width < 2 || height < 2) continue;

    try {
      const canvas = new OffscreenCanvas(object.width, object.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      if (object.bitmap) {
        ctx.drawImage(object.bitmap, 0, 0);
      } else if (object.data) {
        const source = object.data;
        const pixels = new Uint8ClampedArray(object.width * object.height * 4);
        // pdf.js hands back RGBA when it has decoded to one; a three-channel
        // buffer is widened rather than guessed at.
        const channels = source.length / (object.width * object.height);
        if (channels >= 4) pixels.set(source.subarray(0, pixels.length));
        else if (channels >= 3) {
          for (let i = 0, at = 0; at < pixels.length; i += 3, at += 4) {
            pixels[at] = source[i];
            pixels[at + 1] = source[i + 1];
            pixels[at + 2] = source[i + 2];
            pixels[at + 3] = 255;
          }
        } else continue;
        ctx.putImageData(new ImageData(pixels, object.width, object.height), 0, 0);
      } else continue;

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      canvas.width = 0;
      canvas.height = 0;
      placed.push({
        x,
        y,
        width,
        height,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime: 'image/png',
        pixelWidth: object.width,
        pixelHeight: object.height,
      });
    } catch {
      // One unreadable picture is a missing picture, not a failed conversion.
    }
  }

  return placed;
}

async function extractRuns(page: PdfPage, wantFonts: boolean): Promise<PageRuns> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const toPoint: ViewportPoint = (x, y) => {
    const point = viewport.convertToViewportPoint(x, y);
    return [point[0], point[1]];
  };

  // getTextContent never resolves a font to the API side — only the operator
  // list does, and it is also where the drawn rules are. One call, two answers.
  let operators: OperatorList | null = null;
  if (wantFonts) {
    try {
      operators = await page.getOperatorList();
    } catch {
      // A page whose content stream will not parse still has usable text; the
      // caller is told through `emphasis` that nothing was styled.
      operators = null;
    }
  }

  const facts = new Map<string, FontFacts>();
  const factsFor = (id: string): FontFacts => {
    const cached = facts.get(id);
    if (cached) return cached;
    const family = content.styles[id]?.fontFamily;
    // commonObjs.get throws on an unresolved id, so has() is not optional.
    // It is document-level, so a font translated on page 1 is still here on
    // page 40 even after every intervening page.cleanup().
    const raw: unknown = operators && page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
    const value = readFontFacts(raw, family);
    facts.set(id, value);
    return value;
  };

  const runs: TextRun[] = [];
  let sideways = 0;

  for (const item of content.items) {
    // Marked-content markers carry no geometry; with the default options they
    // do not appear at all, but narrowing here keeps that an implementation
    // detail rather than a crash waiting for someone to pass a flag.
    if (!('transform' in item)) continue;

    const text = item.str;
    const transform = item.transform;
    if (transform.length < 6) continue;

    // item.height is 0 on the synthetic whitespace items, and the naive
    // |transform[3]| is 0 for anything rotated a quarter turn. hypot of the
    // matrix's second column is what pdf.js itself measures text with.
    const fontSize = item.height || Math.hypot(transform[2], transform[3]) || 12;

    const advance = Math.hypot(transform[0], transform[1]) || 1;
    const width = Number.isFinite(item.width) ? item.width : 0;
    const start = toPoint(transform[4], transform[5]);
    const end = toPoint(
      transform[4] + (width * transform[0]) / advance,
      transform[5] + (width * transform[1]) / advance
    );

    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (Math.abs(dy) > Math.abs(dx) * HORIZONTAL_SLOPE + 0.01) {
      // Sideways text — a rotated table header, a spine label. Reading it into
      // a line would corrupt the line it landed nearest; counted, not merged.
      sideways += 1;
      continue;
    }

    const id = item.fontName;
    const font = factsFor(id);
    const style = content.styles[id];
    const ascent = typeof style?.ascent === 'number' && style.ascent > 0 ? style.ascent : DEFAULT_ASCENT;
    const descent =
      typeof style?.descent === 'number' && style.descent < 0 ? style.descent : DEFAULT_DESCENT;
    const baseline = (start[1] + end[1]) / 2;

    runs.push({
      text,
      x: Math.min(start[0], end[0]),
      right: Math.max(start[0], end[0]),
      baseline,
      top: baseline - ascent * fontSize,
      bottom: baseline - descent * fontSize,
      fontSize,
      fontId: id,
      fontName: font.name,
      bold: font.bold,
      italic: font.italic,
      serif: font.serif,
      monospace: font.monospace,
      spacer: text.trim().length === 0,
    });
  }

  const rules = operators ? await readRules(operators, toPoint) : [];
  const images = operators ? await readImages(page, operators, toPoint) : [];
  const fontsResolved = [...facts.values()].some((font) => font.known);

  return { runs, sideways, fontsResolved, rules, images };
}

// ── lines ───────────────────────────────────────────────────────────────

/**
 * Baselines this close, relative to the larger em, are the same line.
 *
 * It has to be loose enough for a superscript — set around 0.6 em and raised
 * about a third of one — and tight enough that consecutive lines never merge.
 * Solid leading is 1.0 em and typeset leading 1.15-1.2 em, so anything under
 * half an em is safe on both counts; 0.42 leaves room on either side.
 */
const SAME_LINE = 0.42;

/** A floor in points, because 6pt small print still jitters by a fraction. */
const SAME_LINE_FLOOR = 0.6;

/** A gap wider than this fraction of an em was a space, not a kern. */
const SPACE_GAP = 0.18;

function joinRuns(runs: TextRun[]): string {
  let text = '';
  let right = Number.NaN;
  let pending = false;

  for (const run of runs) {
    // A glyph drawn without advancing the pen is a decoration placed on the
    // text rather than part of it: a bullet, a tick, an overstruck accent.
    // Word and every resume builder draw list bullets this way, at the same x
    // as the first word, so the gap test below sees no gap and writes
    // "•Deliver". It is a token of its own and what follows it is another.
    if (!run.spacer && run.right - run.x < 0.5) {
      text += (text.length > 0 && !/\s$/.test(text) ? ' ' : '') + run.text;
      pending = true;
      continue;
    }
    if (run.spacer) {
      // One of these stands for a jump the producer made with the pen, and its
      // width is the width of that jump — it reaches exactly to the next run,
      // so the gap test below would see nothing and glue the words together.
      // It is worth exactly one space: a 40pt tab is not forty of them.
      pending = true;
      right = Number.isNaN(right) ? run.right : Math.max(right, run.right);
      continue;
    }
    const gap = Number.isNaN(right) ? 0 : run.x - right;
    const needsSpace =
      text.length > 0 && (pending || gap > run.fontSize * SPACE_GAP) && !/\s$/.test(text);
    text += (needsSpace ? ' ' : '') + run.text;
    right = run.right;
    pending = false;
  }

  return text;
}

function finishLine(line: TextLine): void {
  line.runs.sort((a, b) => a.x - b.x);

  const inked = line.runs.filter((run) => !run.spacer);
  const carrier = inked.length > 0 ? inked : line.runs;

  line.text = joinRuns(line.runs);
  line.x = Math.min(...carrier.map((run) => run.x));
  line.right = Math.max(...carrier.map((run) => run.right));
  line.top = Math.min(...carrier.map((run) => run.top));
  line.bottom = Math.max(...carrier.map((run) => run.bottom));

  // The dominant size and style, weighted by characters: one superscript digit
  // must not make the line 6pt, and one bold word must not make it a heading.
  const weights = new Map<number, number>();
  let boldWeight = 0;
  let italicWeight = 0;
  let total = 0;
  for (const run of inked) {
    const weight = run.text.length;
    total += weight;
    weights.set(run.fontSize, (weights.get(run.fontSize) ?? 0) + weight);
    if (run.bold) boldWeight += weight;
    if (run.italic) italicWeight += weight;
  }
  let bestWeight = 0;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      line.fontSize = size;
      bestWeight = weight;
    }
  }
  line.bold = total > 0 && boldWeight / total >= 0.6;
  line.italic = total > 0 && italicWeight / total >= 0.6;
}

export function toLines(runs: TextRun[]): TextLine[] {
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines: TextLine[] = [];
  // The baseline a line is measured from belongs to its widest run, so a
  // superscript joining the line cannot drag the line's own baseline upward.
  let anchor = 0;

  for (const run of sorted) {
    const last = lines[lines.length - 1];
    const tolerance = Math.max(
      SAME_LINE * Math.max(run.fontSize, last?.fontSize ?? 0),
      SAME_LINE_FLOOR
    );

    if (last && Math.abs(run.baseline - last.baseline) <= tolerance) {
      last.runs.push(run);
      last.fontSize = Math.max(last.fontSize, run.fontSize);
      const width = run.right - run.x;
      if (width > anchor) {
        anchor = width;
        last.baseline = run.baseline;
      }
      continue;
    }

    anchor = run.right - run.x;
    lines.push({
      runs: [run],
      text: '',
      x: run.x,
      right: run.right,
      top: run.top,
      bottom: run.bottom,
      baseline: run.baseline,
      fontSize: run.fontSize,
      bold: run.bold,
      italic: run.italic,
      band: 0,
      column: 0,
      table: -1,
      running: false,
    });
  }

  for (const line of lines) finishLine(line);
  return lines.filter((line) => line.text.trim().length > 0);
}

// ── columns ─────────────────────────────────────────────────────────────

/** Fewer lines than this and a page has no column structure worth finding. */
const MIN_COLUMN_LINES = 10;
/** Each column has to hold at least this many lines to be believed. */
const MIN_LINES_PER_COLUMN = 6;
/** And at least this share of the band's lines, so a margin note is not a column. */
const MIN_COLUMN_SHARE = 0.2;
/**
 * Text in a column wraps, so its lines fill most of its width. A caption or a
 * stub column of one-word entries does not.
 */
const MIN_FILL = 0.45;

interface Cut {
  columns: TextLine[][];
  confidence: number;
}

function verticalExtent(lines: TextLine[]): [number, number] {
  return [Math.min(...lines.map((l) => l.top)), Math.max(...lines.map((l) => l.bottom))];
}

function toColumn(lines: TextLine[]): PageColumn {
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const [top, bottom] = verticalExtent(sorted);
  return {
    x: Math.min(...sorted.map((line) => line.x)),
    right: Math.max(...sorted.map((line) => line.right)),
    top,
    bottom,
    lines: sorted,
  };
}

/**
 * Is this group of lines a grid rather than a pair of columns?
 *
 * The two look identical from a distance: both are text in two stacks with a
 * clear channel between them. The difference is that a table's rows are one
 * thing read across, and a column's lines are one thing read down, and cutting
 * the wrong way destroys the document either way.
 *
 * Asking the table detector is the honest test. It works on the ungrouped
 * lines — where a row's cells still share a line, which is exactly the shape
 * it wants — so a confident table here means the channel is a column boundary
 * inside a grid, not a gutter between columns.
 */
function looksTabular(lines: TextLine[], body: number): boolean {
  const tables = findTables(toColumn(lines), body, [], 0, 0).filter(
    (table) => table.confidence >= TABLE_CONFIDENCE_FLOOR
  );
  const covered = tables.reduce((sum, table) => sum + table.lines.length, 0);
  if (covered / lines.length < 0.5) return false;

  // The tie-break, where both readings fit: a cell is terse — a label, a date,
  // a number, a couple of words — and a line of a column is running prose that
  // fills the measure. Reading prose across the gutter instead of down it is
  // the single mistake that makes a two-column paper unreadable.
  const words = tables
    .flatMap((table) => table.rows.flat())
    .filter((cell) => cell.text.length > 0)
    .map((cell) => cell.text.split(/\s+/).length);
  return median(words) <= 4;
}

/**
 * Splits at the widest believable gutter, then recurses on each side.
 *
 * This works on runs, not on lines, and that is the whole point. Two columns
 * set on the same grid — which is most of them — put a line of the left column
 * and a line of the right column on the same baseline, and any line grouping
 * done before the columns are known glues the two together with a space. By
 * the time you have lines, the evidence is gone. So: find the gutter in the
 * runs, split the runs, and only then group each side into lines.
 *
 * A vertical strip that no run crosses is common on its own — an indented
 * block leaves one, so does a short heading — so a candidate has to survive
 * five more tests: enough lines each side, a fair share each side, the two
 * sides running down the page together rather than one sitting above the
 * other, lines that fill the width they were given, and not being a table.
 */
function cutColumns(runs: TextRun[], body: number, pageWidth: number, depth: number): Cut {
  const lines = toLines(runs);
  const single: Cut = { columns: [lines], confidence: 1 };
  if (depth > 2 || lines.length < MIN_COLUMN_LINES) return single;

  // Spacer runs are excluded: pdf.js emits one for the jump from the end of a
  // left-hand line to the start of the right-hand one, and it spans the gutter
  // exactly. Including them means never finding a gutter at all.
  const inked = runs.filter((run) => !run.spacer);
  const intervals = inked
    .map((run): [number, number] => [run.x, run.right])
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }

  // A gutter narrower than about an em and a half is a wide word space; one
  // narrower than 2.8% of the page is too tight to be a designed column gap.
  const minGutter = Math.max(1.6 * body, 0.028 * pageWidth);

  let best: Cut | null = null;
  let bestWidth = 0;

  for (let index = 0; index + 1 < merged.length; index += 1) {
    const gapStart = merged[index][1];
    const gapEnd = merged[index + 1][0];
    const gap = gapEnd - gapStart;
    if (gap < minGutter || gap <= bestWidth) continue;

    const middle = (gapStart + gapEnd) / 2;
    const leftRuns = runs.filter((run) => (run.x + run.right) / 2 < middle);
    const rightRuns = runs.filter((run) => (run.x + run.right) / 2 >= middle);
    const left = toLines(leftRuns);
    const right = toLines(rightRuns);

    if (left.length < MIN_LINES_PER_COLUMN || right.length < MIN_LINES_PER_COLUMN) continue;
    if (Math.min(left.length, right.length) / (left.length + right.length) < MIN_COLUMN_SHARE) {
      continue;
    }

    const [leftTop, leftBottom] = verticalExtent(left);
    const [rightTop, rightBottom] = verticalExtent(right);
    const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
    const shorter = Math.min(leftBottom - leftTop, rightBottom - rightTop);
    // Side by side down the page, not one stacked above the other.
    if (shorter <= 0 || overlap / shorter < 0.5) continue;

    const fill = (group: TextLine[]): number => {
      const x = Math.min(...group.map((l) => l.x));
      const width = Math.max(...group.map((l) => l.right)) - x;
      if (width <= 0) return 0;
      return median(group.map((l) => (l.right - l.x) / width));
    };
    const leftFill = fill(left);
    const rightFill = fill(right);
    if (leftFill < MIN_FILL || rightFill < MIN_FILL) continue;

    if (looksTabular(lines, body)) return single;

    // Wider gutters and fuller columns are more convincing; both saturate.
    const confidence = clamp01(
      0.5 * Math.min(1, gap / (3 * body)) + 0.5 * Math.min(1, (leftFill + rightFill) / 1.6)
    );
    best = { columns: [left, right], confidence };
    bestWidth = gap;
  }

  if (!best) return single;

  const columns: TextLine[][] = [];
  let confidence = best.confidence;
  for (const group of best.columns) {
    const deeper = cutColumns(
      group.flatMap((line) => line.runs),
      body,
      pageWidth,
      depth + 1
    );
    columns.push(...deeper.columns);
    if (deeper.columns.length > 1) confidence = Math.min(confidence, deeper.confidence);
  }
  return { columns, confidence };
}

/**
 * Bands first, columns inside them.
 *
 * A two-column paper almost always has a full-width title, and often a
 * full-width figure halfway down and a folio underneath. Looking for a gutter
 * across the whole page finds nothing, because the title crosses it — and
 * finding one anyway would file the footer at the bottom of the left column,
 * halfway through the document. Cutting the page into horizontal bands at its
 * larger vertical gaps and looking inside each one puts every part where it
 * belongs. This is the cheap half of the classic XY cut, and it is enough.
 */
function findBands(
  runs: TextRun[],
  body: number,
  pageWidth: number
): { bands: ColumnBand[]; confidence: number } {
  // Bands are found from lines grouped across the whole page width. That
  // grouping is wrong wherever there are columns, but it is exactly right for
  // this question: a horizontal strip of blank space that no column crosses.
  const ordered = toLines(runs);
  if (ordered.length === 0) return { bands: [], confidence: 1 };

  const gaps: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    gaps.push(ordered[index].baseline - ordered[index - 1].baseline);
  }
  const typical = median(gaps.filter((gap) => gap > 0)) || body * 1.2;

  const groups: TextLine[][] = [[ordered[0]]];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index].top - ordered[index - 1].bottom;
    // Twice the usual leading of blank space is a break in the layout, not a
    // paragraph break — a new band is allowed to have its own column count.
    if (gap > typical * 2) groups.push([]);
    groups[groups.length - 1].push(ordered[index]);
  }

  const bands: ColumnBand[] = [];
  let confidence = 1;
  let split = false;

  for (const group of groups) {
    const cut = cutColumns(
      group.flatMap((line) => line.runs),
      body,
      pageWidth,
      0
    );
    if (cut.columns.length > 1) {
      split = true;
      confidence = Math.min(confidence, cut.confidence);
    }
    const [top, bottom] = verticalExtent(group);
    bands.push({ top, bottom, columns: cut.columns.map(toColumn) });
  }

  if (!split) {
    // Nothing was divided, so nothing was guessed: merge the bands back into
    // one and report the page as plainly single-column.
    const [top, bottom] = verticalExtent(ordered);
    return { bands: [{ top, bottom, columns: [toColumn(ordered)] }], confidence: 1 };
  }

  return { bands, confidence };
}

// ── tables ──────────────────────────────────────────────────────────────

/** A gap this many ems wide inside a line is a cell boundary, not a space. */
const CELL_GAP = 1.4;
/** Fewer rows than this is a colon-separated label, not a table. */
const MIN_TABLE_ROWS = 3;
/** Cell edges within this fraction of an em belong to the same column. */
const COLUMN_SNAP = 0.9;

interface RawCell {
  runs: TextRun[];
  x: number;
  right: number;
  text: string;
}

/** Splits a line where its internal gaps are too wide to be word spaces. */
function splitCells(line: TextLine): RawCell[] {
  const cells: RawCell[] = [];
  let current: TextRun[] = [];
  let right = Number.NaN;

  const flush = (): void => {
    const inked = current.filter((run) => !run.spacer);
    if (inked.length > 0) {
      cells.push({
        runs: [...current],
        x: Math.min(...inked.map((run) => run.x)),
        right: Math.max(...inked.map((run) => run.right)),
        text: joinRuns(current).trim(),
      });
    }
    current = [];
  };

  for (const run of line.runs) {
    const threshold = CELL_GAP * (run.fontSize || line.fontSize);
    const gap = Number.isNaN(right) ? 0 : run.x - right;
    // A whitespace run that is itself this wide is pdf.js reporting a jump the
    // producer made with the pen: the strongest cell boundary available.
    if (current.length > 0 && (gap > threshold || (run.spacer && run.right - run.x > threshold))) {
      flush();
    }
    if (run.spacer && current.length === 0) {
      right = run.right;
      continue;
    }
    current.push(run);
    right = Number.isNaN(right) ? run.right : Math.max(right, run.right);
  }
  flush();

  return cells.filter((cell) => cell.text.length > 0);
}

interface Candidate {
  line: TextLine;
  cells: RawCell[];
  /** Lines that wrapped inside a cell of this row rather than starting one. */
  continuation: TextLine[];
}

function clusterColumns(rows: Candidate[], body: number): TableColumnSpec[] {
  const edges = rows.flatMap((row) => row.cells.map((cell) => cell.x)).sort((a, b) => a - b);
  const snap = COLUMN_SNAP * body;

  const clusters: number[][] = [];
  for (const edge of edges) {
    const last = clusters[clusters.length - 1];
    if (last && edge - last[last.length - 1] <= snap) last.push(edge);
    else clusters.push([edge]);
  }

  return clusters
    .filter((cluster) => cluster.length >= Math.max(2, Math.ceil(rows.length * 0.5)))
    .map((cluster) => ({
      x: median(cluster),
      right: median(cluster),
      align: 'left' as const,
    }));
}

/**
 * Column boundaries taken from the drawn grid rather than inferred from where
 * text happens to line up.
 *
 * Alignment clustering only sees a boundary where at least two rows start a
 * cell at the same x, and that quietly fails on the most ordinary table there
 * is: left-aligned headings over right-aligned numbers. Each heading sits at an
 * x no other row shares, so the heading edges are discarded as noise and the
 * headings are then snapped to the number columns — on a four-column table two
 * of them land in one cell and everything after shifts left.
 *
 * A ruled table states its boundaries outright. When the producer drew them,
 * they are the answer, and no amount of inference improves on them.
 */
function columnsFromRules(rows: Candidate[], rules: RuleLine[]): TableColumnSpec[] {
  const top = Math.min(...rows.map((row) => row.line.top));
  const bottom = Math.max(...rows.map((row) => row.line.bottom));
  const height = bottom - top;
  if (!Number.isFinite(height) || height <= 0) return [];

  // A boundary runs most of the grid's height. A short tick inside one cell,
  // or an underline under a single heading, is not a column edge.
  const verticals = rules
    .filter(
      (rule) =>
        rule.orientation === 'vertical' &&
        rule.height >= height * 0.6 &&
        rule.y <= top + height * 0.25 &&
        rule.y + rule.height >= bottom - height * 0.25
    )
    .map((rule) => rule.x)
    .sort((a, b) => a - b);

  // A rule drawn twice, or drawn as a very thin filled rectangle, arrives as
  // two edges a fraction of a point apart.
  const edges: number[] = [];
  for (const edge of verticals) {
    if (edges.length === 0 || edge - edges[edges.length - 1] > 1.5) edges.push(edge);
  }

  // Two edges bound one column, which is not a grid worth claiming.
  if (edges.length < 3) return [];

  const specs: TableColumnSpec[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    specs.push({ x: edges[index], right: edges[index + 1], align: 'left' });
  }
  return specs;
}

/**
 * Reads a run of consecutive lines as a grid, and says how sure it is.
 *
 * Confidence is the point of this function. Alignment is circumstantial
 * evidence: a form, a table of contents and a two-column list of figures all
 * align, and so does a paragraph that happens to break twice in the same place.
 * PDF → Excel would rather emit nothing than a spreadsheet whose columns are an
 * accident, so the number goes out with the table and the caller decides.
 */
function buildTable(
  rows: Candidate[],
  body: number,
  rules: RuleLine[],
  band: number,
  column: number
): TableBlock | null {
  // Drawn boundaries beat inferred ones whenever the producer supplied them.
  const drawn = columnsFromRules(rows, rules);
  const ruledColumns = drawn.length >= 2;
  const specs = ruledColumns ? drawn : clusterColumns(rows, body);
  if (specs.length < 2) return null;

  const grid: TableCell[][] = [];
  let filled = 0;
  /** Cells that had to share a column because the grid did not separate them. */
  let collisions = 0;
  const perColumn: { lefts: number[]; rights: number[]; centres: number[] }[] = specs.map(() => ({
    lefts: [],
    rights: [],
    centres: [],
  }));

  for (const [rowIndex, row] of rows.entries()) {
    const cells: TableCell[] = specs.map((_, columnIndex) => ({
      text: '',
      runs: [],
      row: rowIndex,
      column: columnIndex,
      span: 1,
    }));

    for (const cell of row.cells) {
      // A column with a real right edge came from a drawn rule, so the cell
      // belongs to whichever band contains it — which is what puts a
      // left-aligned heading and a right-aligned number in the same column.
      // Inferred columns have no width, and fall back to nearest left edge; a
      // cell starting before the first column — a row label hanging into the
      // margin — lands in column 0.
      let target = -1;
      for (const [index, spec] of specs.entries()) {
        if (spec.right > spec.x && cell.x >= spec.x - 0.5 && cell.x < spec.right) {
          target = index;
          break;
        }
      }

      if (target < 0) {
        target = 0;
        let bestDistance = Infinity;
        for (const [index, spec] of specs.entries()) {
          const distance = Math.abs(cell.x - spec.x);
          if (distance < bestDistance) {
            bestDistance = distance;
            target = index;
          }
        }
      }
      const existing = cells[target];
      // Two cells claiming one column means the grid is not what we think it
      // is. Joining them keeps the text, and the alignment score pays for it —
      // but the reader is entitled to know it happened, so it is counted. A
      // spreadsheet where two headings share a cell looks correct and is not.
      if (existing.text) collisions += 1;
      existing.text = existing.text ? `${existing.text} ${cell.text}` : cell.text;
      existing.runs.push(...cell.runs);
      perColumn[target].lefts.push(cell.x);
      perColumn[target].rights.push(cell.right);
      perColumn[target].centres.push((cell.x + cell.right) / 2);
    }

    for (const cell of cells) if (cell.text) filled += 1;
    grid.push(cells);
  }

  const owned = rows.flatMap((row) => [row.line, ...row.continuation]);
  const x = Math.min(...owned.map((line) => line.x));
  const right = Math.max(...owned.map((line) => line.right));
  const top = Math.min(...owned.map((line) => line.top));
  const bottom = Math.max(...owned.map((line) => line.bottom));

  // Numbers right-align and headings centre, so a column is as tight as its
  // tightest edge — judging every column by its left edge alone under-rates
  // exactly the money columns a spreadsheet cares most about.
  let alignmentTotal = 0;
  for (const [index, spec] of specs.entries()) {
    const edges = perColumn[index];
    const options: [number, TableColumnSpec['align']][] = [
      [spread(edges.lefts), 'left'],
      [spread(edges.rights), 'right'],
      [spread(edges.centres), 'center'],
    ];
    options.sort((a, b) => a[0] - b[0]);
    spec.align = options[0][1];
    spec.x = edges.lefts.length > 0 ? Math.min(...edges.lefts) : spec.x;
    spec.right = edges.rights.length > 0 ? Math.max(...edges.rights) : spec.right;
    // Half an em of scatter is still a column; a whole em is not.
    alignmentTotal += clamp01(1 - options[0][0] / (0.8 * body));
  }

  const alignment = alignmentTotal / specs.length;
  // Columns that do not line up are not columns — but only while the columns
  // are a guess. Scatter is the whole of the evidence when the boundaries were
  // inferred from where text happens to sit, and none of it when the producer
  // drew them.
  //
  // The distinction is not academic: a perfectly ordinary ruled table puts a
  // left-aligned heading above a column of right-aligned numbers, so the one
  // column scores badly on every measure of scatter while being exactly right.
  // Judging a drawn grid by that test threw away the table this tool exists to
  // find.
  if (!ruledColumns && alignment < 0.35) return null;

  // Monospaced text aligns because of the font, not because of a table. Every
  // ASCII diagram and code block in a document lands here otherwise, and comes
  // out as a spreadsheet of box-drawing characters.
  const cellRuns = grid.flat().flatMap((cell) => cell.runs);
  const monospace = cellRuns.filter((run) => run.monospace).length;
  if (cellRuns.length > 0 && monospace / cellRuns.length >= 0.6) return null;

  const rowSupport = filled / (rows.length * specs.length);
  // Rows that split into exactly as many pieces as there are columns. A real
  // table is regular; a paragraph that happens to have a link hanging off its
  // right-hand end is not, and this is what tells them apart.
  const shape = rows.filter((row) => row.cells.length === specs.length).length / rows.length;
  // Three rows is the minimum and proves little. Evidence accumulates with
  // every further row that keeps to the same grid.
  const sizeScore = clamp01((rows.length - MIN_TABLE_ROWS + 1) / 4);

  // Rules are the only direct evidence a table exists. Horizontal ones spanning
  // the grid are header and total rules; vertical ones landing on a boundary we
  // inferred are the boundary itself, drawn by the producer.
  // Within the grid itself, not merely near it: a section divider sitting an
  // em above the first row is not evidence that the rows below it are a table.
  const inside = rules.filter(
    (rule) => rule.y >= top - 2 && rule.y <= bottom + 2 && rule.x < right && rule.x + rule.width > x
  );
  const spanning = inside.filter(
    (rule) => rule.orientation === 'horizontal' && rule.width >= (right - x) * 0.6
  ).length;
  const boundaries = specs.slice(1).map((spec) => spec.x);
  const matched = boundaries.filter((boundary) =>
    inside.some((rule) => rule.orientation === 'vertical' && Math.abs(rule.x - boundary) < body)
  ).length;
  const ruleScore = clamp01(
    Math.min(1, spanning / 2) * 0.5 + (boundaries.length > 0 ? matched / boundaries.length : 0) * 0.5
  );

  // Where the grid is drawn, scatter within a column is not held against it;
  // the rules already said where the columns are.
  const alignmentEvidence = ruledColumns ? Math.max(alignment, 0.85) : alignment;
  const inferred = clamp01(
    0.28 * rowSupport + 0.28 * alignmentEvidence + 0.16 * shape + 0.28 * sizeScore
  );
  // Whitespace alignment alone cannot get you certainty, so the ceiling starts
  // at 0.85 and rises only as far as the drawn rules corroborate the grid. It
  // is the honest way to say that this table was inferred, not read.
  const confidence = Math.min(inferred + 0.25 * ruleScore, 0.85 + 0.15 * ruleScore);

  return {
    kind: 'table',
    rows: grid,
    columns: specs,
    lines: owned,
    x,
    right,
    top,
    bottom,
    band,
    column,
    confidence,
    // One rule near a grid is a section divider. Two, or half the column
    // boundaries drawn, is a table someone actually ruled.
    ruled: ruleScore >= 0.5,
    evidence: {
      rows: rows.length,
      columns: specs.length,
      rowSupport,
      alignment,
      shape,
      ruleScore,
      collisions,
    },
  };
}

function findTables(
  column: PageColumn,
  body: number,
  rules: RuleLine[],
  band: number,
  columnIndex: number
): TableBlock[] {
  const tables: TableBlock[] = [];
  let group: Candidate[] = [];

  /**
   * What separates two tables is a gap out of keeping with the rest of the
   * column, not a gap past a fixed number of ems.
   *
   * The old test was `line.top - previous.bottom > body * 1.6`. A grid set on a
   * 30pt pitch in 11pt text leaves 19.8pt of white between every pair of rows
   * against a 17.6pt threshold, so every row was called detached, flushed on
   * its own, and no group ever reached MIN_TABLE_ROWS — a fully ruled seven-row
   * table came back as "no tables in this PDF". Airy tables are common; a fixed
   * em multiple cannot tell "airy" from "different table".
   *
   * So the threshold comes from the column's own median row pitch, which is the
   * same relative-not-absolute approach buildBlocks already takes for leading.
   */
  const gaps: number[] = [];
  for (let index = 1; index < column.lines.length; index += 1) {
    const gap = column.lines[index].top - column.lines[index - 1].bottom;
    if (gap > 0) gaps.push(gap);
  }
  const typicalGap = gaps.length
    ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    : 0;
  // Half again the usual gap reads as a break. The em floor keeps a column of
  // tightly-set lines from calling a one-point wobble a new table.
  const breakGap = Math.max(body * 1.6, typicalGap * 1.75);

  const flush = (): void => {
    if (group.length >= MIN_TABLE_ROWS) {
      const table = buildTable(group, body, rules, band, columnIndex);
      if (table) tables.push(table);
    }
    group = [];
  };

  for (const [index, line] of column.lines.entries()) {
    const cells = splitCells(line);
    const previous = column.lines[index - 1];
    // A row far below the last one belongs to a different table, even if it
    // splits into the same number of cells.
    const detached = previous ? line.top - previous.bottom > breakGap : false;

    if (cells.length >= 2) {
      if (detached) flush();
      group.push({ line, cells, continuation: [] });
      continue;
    }

    // Cell text wraps. "(ADULT)" under a traveller's name is the rest of that
    // cell, not a new row and not the end of the table — treating it as either
    // is what leaves a ruled table looking like three ragged paragraphs.
    const last = group[group.length - 1];
    if (last && !detached && cells.length === 1) {
      // Tight: a wrapped cell restarts at its column's own left edge, to the
      // point. Anything looser swallows the indented lines that follow a table
      // — a bullet list under a two-column heading absorbs into the heading's
      // first cell and the "table" grows down the whole page.
      const target = last.cells.find((cell) => Math.abs(cell.x - cells[0].x) <= 0.3 * body);
      if (target) {
        target.text = `${target.text} ${cells[0].text}`.trim();
        target.runs.push(...cells[0].runs);
        target.right = Math.max(target.right, cells[0].right);
        last.continuation.push(line);
        continue;
      }
    }

    flush();
  }
  flush();

  return tables;
}

// ── paragraphs ──────────────────────────────────────────────────────────

const NUMBERED = /^\s*(\d{1,3}|[a-z]|[ivxlcdm]{1,5})[.)]\s+/i;

/**
 * Bullets are found by repetition, not by a list of characters.
 *
 * Word and InDesign draw bullets from a symbol font, so the glyph that arrives
 * is usually a private-use codepoint rather than "•". Any short, wordless token
 * that starts three or more lines in the document is a bullet, whatever it
 * looks like. Counting across the whole document rather than per page is what
 * catches the two-item list that happens to sit alone on a page.
 */
export function bulletGlyphs(lines: TextLine[]): Set<string> {
  const starts = new Map<string, number>();
  for (const line of lines) {
    // Monospaced text is a code block or an ASCII diagram, where "│", "└" and
    // "→" begin line after line and none of them is a list.
    if (line.runs.find((run) => !run.spacer)?.monospace) continue;
    const match = /^(\S{1,2})\s+\S/.exec(line.text.trim());
    if (!match) continue;
    const token = match[1];
    if (/[A-Za-z0-9]/.test(token)) continue;
    starts.set(token, (starts.get(token) ?? 0) + 1);
  }

  const bullets = new Set<string>();
  for (const [glyph, count] of starts) {
    if (count < 3) continue;
    // And it lives *only* there. Without this, a document containing ASCII
    // diagrams turns "=", "[" and "│" into bullets, because they too begin
    // three lines — the difference is that they also litter the middle of
    // them, which no real bullet ever does.
    const elsewhere = lines.filter((line) => line.text.trim().indexOf(glyph, 1) > 0).length;
    if (elsewhere < count) bullets.add(glyph);
  }
  return bullets;
}

/**
 * Heading by proportion, because 12pt is a heading in a 9pt document.
 *
 * The word cap matters as much as the ratio: a whole paragraph set large is a
 * pull quote, not a heading, and turning it into one destroys it. Bold gets a
 * level of its own but only for a short standalone line — plenty of documents
 * bold an entire paragraph for emphasis.
 */
function headingLevel(block: Paragraph, body: number): number {
  const ratio = block.fontSize / body;
  const words = block.text.trim().split(/\s+/).length;
  if (words > 14) return 0;
  if (ratio >= 1.6) return 1;
  if (ratio >= 1.32) return 2;
  if (ratio >= 1.15) return 3;
  // A tenth larger is a heading only if it is also short. Word and the
  // markdown renderers set an h3 at 1.125 of the body, which the 1.15 step
  // above walks straight past; a paragraph set a shade bigger is still a
  // paragraph, and the word cap is what tells the two apart.
  if (ratio >= 1.09 && words <= 8) return 3;
  if (block.bold && ratio >= 1.02 && words <= 8) return 4;
  // Short, ALL CAPS, standing alone: a section label in the body face, which
  // is how a great many reports and contracts set their headings.
  if (words <= 8 && /^[^a-z]+$/.test(block.text) && /[A-Z]{3}/.test(block.text)) return 4;
  return 0;
}

function alignOf(block: Paragraph, column: PageColumn, body: number): BlockAlign {
  const width = column.right - column.x;
  if (width <= 0) return 'left';
  const leftGap = block.x - column.x;
  const rightGap = column.right - block.right;
  const slack = Math.max(2, 0.015 * width);

  // Centred text has a real margin on both sides and near-equal ones. Without
  // the first clause, an indented bullet that happens to wrap a word early
  // reads as centred, which is how a list turns into a poem.
  if (leftGap > Math.max(body, 0.05 * width) && Math.abs(leftGap - rightGap) <= slack) {
    return 'center';
  }
  if (leftGap > Math.max(body * 1.5, 0.05 * width) && rightGap <= slack) return 'right';
  if (block.lines.length > 1) {
    // Justified text is recognised by every line but the last reaching the
    // right edge — which is also the signal the paragraph breaker uses below.
    const flush = block.lines.slice(0, -1).every((line) => column.right - line.right <= slack);
    if (flush) return 'justify';
  }
  return 'left';
}

/** Blocks for one column, in order, with any tables slotted into place. */
function buildBlocks(
  column: PageColumn,
  body: number,
  bullets: Set<string>,
  tables: TableBlock[],
  band: number,
  columnIndex: number
): PageBlock[] {
  const blocks: PageBlock[] = [];
  const lines = column.lines;

  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const gap = lines[index].baseline - lines[index - 1].baseline;
    if (gap > 0 && gap < body * 3) gaps.push(gap);
  }
  const leading = median(gaps) || body * 1.2;

  const slack = Math.max(2, 0.02 * (column.right - column.x));
  const rightEdges = lines.filter((line) => column.right - line.right <= slack).length;
  // Only in justified text does a short line mean anything: in ragged-right
  // setting most lines end short and the signal is noise.
  const justified = lines.length >= 4 && rightEdges / lines.length >= 0.6;

  let current: TextLine[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    blocks.push(finishParagraph(current, column, body, bullets, band, columnIndex));
    current = [];
  };

  for (const [index, line] of lines.entries()) {
    if (line.table >= 0) {
      flush();
      const table = tables[line.table];
      if (table && !blocks.includes(table)) blocks.push(table);
      continue;
    }

    const previous = lines[index - 1];
    if (previous && previous.table < 0 && current.length > 0) {
      let breaks = false;

      // 1. Vertical space beyond the running leading. 1.35 clears the ordinary
      //    variation in a single paragraph without needing a full blank line.
      if (line.baseline - previous.baseline > leading * 1.35) breaks = true;

      // 2. A first-line indent: the previous line sat at the column edge and
      //    this one steps in. Suppressed after a list marker, where the step is
      //    a hanging indent continuing the same item.
      const stepsIn = line.x - previous.x > body * 0.5;
      const previousAtEdge = previous.x - column.x <= body * 0.5;
      const previousIsMarker = startsList(previous.text, bullets) !== null;
      if (stepsIn && previousAtEdge && !previousIsMarker) breaks = true;

      // 3. The previous line stopped short of the edge. In justified text any
      //    shortfall is the end of a paragraph. In ragged text it takes a big
      //    shortfall *and* a closing punctuation mark to mean anything.
      const shortfall = column.right - previous.right;
      if (justified && shortfall > body * 1.5) breaks = true;
      // A closing bracket is deliberately not in that set: "…syndrome (ACS)"
      // ends a line, not a sentence. And a line starting lower case is the
      // continuation of the one above it whatever the line above ended with.
      if (
        !justified &&
        shortfall > (column.right - column.x) * 0.25 &&
        /[.!?:;”"'’]$/.test(previous.text.trim()) &&
        !/^[a-z]/.test(line.text.trim())
      ) {
        breaks = true;
      }

      // 4. A change of size or weight is a change of role.
      // 6%: line sizes inside one paragraph are equal to the digit, so this
      // only has to clear rounding — and a 13pt heading above 12pt body, which
      // a laxer threshold silently swallowed into the paragraph beneath it.
      if (Math.abs(line.fontSize - previous.fontSize) > previous.fontSize * 0.06) breaks = true;
      if (line.bold !== previous.bold) breaks = true;

      // 5. A new list item is always its own block.
      if (startsList(line.text, bullets) !== null) breaks = true;

      if (breaks) flush();
    }

    current.push(line);
  }

  flush();
  return blocks;
}

interface ListStart {
  marker: string;
  rest: string;
  ordered: boolean;
}

function startsList(text: string, bullets: Set<string>): ListStart | null {
  const trimmed = text.trim();
  const leading = /^(\S{1,2})\s+/.exec(trimmed);
  if (leading && bullets.has(leading[1])) {
    return { marker: leading[1], rest: trimmed.slice(leading[0].length), ordered: false };
  }
  const numbered = NUMBERED.exec(trimmed);
  if (numbered) {
    return { marker: numbered[1], rest: trimmed.slice(numbered[0].length), ordered: true };
  }
  return null;
}

function finishParagraph(
  lines: TextLine[],
  column: PageColumn,
  body: number,
  bullets: Set<string>,
  band: number,
  columnIndex: number
): Paragraph {
  const text = lines
    .map((line) => line.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const weights = new Map<number, number>();
  let boldWeight = 0;
  let italicWeight = 0;
  let total = 0;
  for (const line of lines) {
    const weight = Math.max(1, line.text.length);
    total += weight;
    weights.set(line.fontSize, (weights.get(line.fontSize) ?? 0) + weight);
    if (line.bold) boldWeight += weight;
    if (line.italic) italicWeight += weight;
  }
  let fontSize = lines[0].fontSize;
  let bestWeight = 0;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      fontSize = size;
      bestWeight = weight;
    }
  }

  const x = Math.min(...lines.map((line) => line.x));
  const bodyLines = lines.slice(1);
  const block: Paragraph = {
    kind: 'paragraph',
    level: 0,
    marker: null,
    ordered: false,
    text,
    lines,
    x,
    right: Math.max(...lines.map((line) => line.right)),
    top: Math.min(...lines.map((line) => line.top)),
    bottom: Math.max(...lines.map((line) => line.bottom)),
    fontSize,
    bold: total > 0 && boldWeight / total >= 0.6,
    italic: total > 0 && italicWeight / total >= 0.6,
    align: 'left',
    indent: x - column.x,
    firstLineIndent:
      bodyLines.length > 0 ? lines[0].x - Math.min(...bodyLines.map((line) => line.x)) : 0,
    spaceBefore: 0,
    band,
    column: columnIndex,
  };

  block.align = alignOf(block, column, body);

  const level = headingLevel(block, body);

  // "3. Market size" set two sizes up is a numbered heading, not a list item,
  // and every report in the world numbers its headings. A bullet glyph is
  // never a heading, however large it is set.
  const list = startsList(lines[0].text, bullets);
  if (list && !(level > 0 && list.ordered)) {
    block.kind = 'list-item';
    block.marker = list.marker;
    block.ordered = list.ordered;
    block.text = [list.rest, ...lines.slice(1).map((line) => line.text.trim())]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return block;
  }

  if (lines.every((line) => line.running)) {
    block.kind = 'running';
    return block;
  }

  if (level > 0) {
    block.kind = 'heading';
    block.level = level;
  }
  return block;
}

// ── OCR noise ───────────────────────────────────────────────────────────

/**
 * Does this text layer look like the output of a poor OCR pass?
 *
 * Scanned documents often arrive with a text layer already baked in by whatever
 * scanned them. It extracts cleanly and reads like noise. A Word file full of
 * that looks more authoritative than a plain text file full of it, so both
 * converters should say so rather than hand it over.
 */
export function looksLikeOcrNoise(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => word.length > 1);
  if (words.length < 60) return false;

  // Punctuation buried inside a word, or letters interleaved with digits.
  const garbled = words.filter(
    (word) => /[A-Za-z][^A-Za-z0-9\s'’-][A-Za-z]/.test(word) || /[A-Za-z]\d|\d[A-Za-z]/.test(word)
  ).length;
  // Bad OCR also shatters words into one- and two-letter fragments.
  const fragments = words.filter((word) => /^[A-Za-z]{1,2}$/.test(word)).length;

  // Measured across real documents: a scanned page with a poor baked-in text
  // layer scores about 14% on both, while clean exports sit under 6%.
  return garbled / words.length >= 0.08 && fragments / words.length >= 0.08;
}

// ── the page ────────────────────────────────────────────────────────────

export interface PageContext {
  /** The document's modal body size. Defaults to this page's own. */
  bodyFontSize?: number;
  /** Document-wide bullet glyphs. Defaults to this page's own. */
  bulletGlyphs?: Set<string>;
  /** Signatures of lines that repeat across pages — see `runningSignature`. */
  running?: Set<string>;
  fonts?: 'resolve' | 'skip';
}

/**
 * What a line has to match to count as the same running head on another page.
 *
 * Digits are folded because the folio changes on every page and the rest of the
 * footer does not; the vertical third is included because a phrase can appear
 * in the body of one page and in the footer of the next.
 */
export function runningSignature(line: TextLine, pageHeight: number): string {
  const zone = line.baseline < pageHeight * 0.12 ? 'top' : line.bottom > pageHeight * 0.88 ? 'bottom' : '';
  if (!zone) return '';
  const normalised = line.text.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  return normalised.length > 0 ? `${zone}:${normalised}` : '';
}

/** Everything read off one page before the document's own statistics exist. */
export interface PageScan {
  page: number;
  width: number;
  height: number;
  rotation: number;
  /** Every run on the page. Lines are grouped later, once columns are known. */
  runs: TextRun[];
  /**
   * Those runs grouped into lines across the whole page width, for the
   * document-wide statistics only. On a multi-column page these are wrong by
   * construction — two columns share a baseline — which is harmless for a
   * character-weighted modal size and is why `structurePage` regroups.
   */
  lines: TextLine[];
  rules: RuleLine[];
  /** Pictures with their placement. Empty when fonts were not resolved. */
  images: PlacedImage[];
  sideways: number;
  fontsResolved: boolean;
}

/** First pass: geometry and lines only. Cheap enough to run over a whole book. */
export async function scanPage(
  page: PdfPage,
  pageNumber: number,
  fonts: 'resolve' | 'skip' = 'resolve'
): Promise<PageScan> {
  const viewport = page.getViewport({ scale: 1 });
  const { runs, sideways, fontsResolved, rules, images } = await extractRuns(page, fonts === 'resolve');
  return {
    page: pageNumber,
    width: viewport.width,
    height: viewport.height,
    rotation: page.rotate,
    runs,
    lines: toLines(runs),
    rules,
    images,
    sideways,
    fontsResolved,
  };
}

/** Second pass: columns, tables and blocks, given what the document looks like. */
export function structurePage(scan: PageScan, context: PageContext = {}): PageStructure {
  const body = context.bodyFontSize ?? modalFontSize(scan.lines);
  const bullets = context.bulletGlyphs ?? bulletGlyphs(scan.lines);
  const running = context.running;

  const { bands, confidence } = findBands(scan.runs, body, scan.width);

  const tables: TableBlock[] = [];
  const blocks: PageBlock[] = [];
  const ordered: TextLine[] = [];

  for (const [bandIndex, band] of bands.entries()) {
    band.columns.sort((a, b) => a.x - b.x);
    for (const [columnIndex, column] of band.columns.entries()) {
      for (const line of column.lines) {
        line.band = bandIndex;
        line.column = columnIndex;
        if (running) line.running = running.has(runningSignature(line, scan.height));
      }

      const found = findTables(column, body, scan.rules, bandIndex, columnIndex);
      for (const table of found) {
        const index = tables.length;
        tables.push(table);
        for (const line of table.lines) line.table = index;
      }

      blocks.push(...buildBlocks(column, body, bullets, tables, bandIndex, columnIndex));
      ordered.push(...column.lines);
    }
  }

  // Space above each block, measured within its own column so a column break
  // does not read as a page's worth of blank space.
  let previousBottom: number | null = null;
  let previousKey = '';
  for (const block of blocks) {
    const key = `${block.band}:${block.column}`;
    if (block.kind !== 'table') {
      // Clamped: descenders overlap the line below, so the raw figure goes
      // slightly negative between tightly set paragraphs and means nothing.
      block.spaceBefore =
        previousBottom !== null && key === previousKey
          ? Math.max(0, block.top - previousBottom)
          : 0;
    }
    previousBottom = block.bottom;
    previousKey = key;
  }

  const text = blocks
    .map((block) => (block.kind === 'table' ? tableText(block) : block.text))
    .filter((value) => value.length > 0)
    .join('\n');

  return {
    page: scan.page,
    width: scan.width,
    height: scan.height,
    rotation: scan.rotation,
    bodyFontSize: body,
    lines: ordered,
    blocks,
    tables,
    bands,
    columnCount: Math.max(1, ...bands.map((band) => band.columns.length)),
    columnConfidence: confidence,
    rules: scan.rules,
    images: scan.images ?? [],
    emphasis: scan.fontsResolved ? 'font-names' : 'unknown',
    sidewaysRuns: scan.sideways,
    text,
    empty: scan.lines.length === 0,
  };
}

/** A table as plain text, tab-separated: for word counts and OCR sniffing. */
export function tableText(table: TableBlock): string {
  return table.rows.map((row) => row.map((cell) => cell.text).join('\t')).join('\n');
}

/** Both passes over one page, for a caller that already has a document open. */
export async function analysePage(
  page: PdfPage,
  pageNumber: number,
  context: PageContext = {}
): Promise<PageStructure> {
  const scan = await scanPage(page, pageNumber, context.fonts ?? 'resolve');
  return structurePage(scan, context);
}

// ── the document ────────────────────────────────────────────────────────

/**
 * Opens a PDF and reads its structure, page by page.
 *
 * Two passes, and the reason is the heading rule: a heading is a heading
 * because it is larger than *this document's* body text, which is not knowable
 * from page one. The first pass reads lines and geometry, the second decides
 * what they mean.
 *
 * The buffer is detached, as it always is when pdf.js takes it — pass
 * `bytes.slice(0)` if the caller still needs it afterwards. `bytesIn` is
 * captured here so the caller does not have to remember to.
 */
export async function readDocumentStructure(
  bytes: ArrayBuffer,
  options: ReadOptions = {}
): Promise<StructureResult> {
  const bytesIn = bytes.byteLength;
  const fonts = options.fonts ?? 'resolve';
  const api = await loadPdfjs();

  let doc: PdfDocument;
  try {
    doc = await api.getDocument({ data: new Uint8Array(bytes), ...documentOptions() }).promise;
  } catch (error) {
    return { ok: false, error: `This PDF could not be opened: ${(error as Error).message}` };
  }

  const pageCount = doc.numPages;
  const limit = Math.min(pageCount, options.maxPages ?? pageCount);
  const scans: PageScan[] = [];
  const skippedPages: number[] = [];

  try {
    for (let number = 1; number <= limit; number += 1) {
      try {
        const page = await doc.getPage(number);
        scans.push(await scanPage(page, number, fonts));
        // The operator list leaves this page's decoded images behind; the
        // fonts it resolved live on the document and survive.
        page.cleanup();
      } catch {
        // One unreadable page should not cost the other forty-eight.
        skippedPages.push(number);
      }
    }
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }

  const allLines = scans.flatMap((scan) => scan.lines);
  if (allLines.length === 0) {
    return {
      ok: false,
      error:
        'This PDF has no text layer — it is images of pages, most likely a scan. Converting it needs OCR, which is a different tool.',
    };
  }

  const bodyFontSize = modalFontSize(allLines);
  const bullets = bulletGlyphs(allLines);

  // A line is a running head or a folio when the same line, with its numbers
  // folded away, sits in the same margin on most of the document's pages.
  const running = new Set<string>();
  if (scans.length >= 3) {
    const counts = new Map<string, number>();
    for (const scan of scans) {
      const seen = new Set<string>();
      for (const line of scan.lines) {
        const signature = runningSignature(line, scan.height);
        if (signature) seen.add(signature);
      }
      for (const signature of seen) counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    const threshold = Math.max(3, Math.ceil(scans.length * 0.6));
    for (const [signature, count] of counts) if (count >= threshold) running.add(signature);
  }

  const pages = scans.map((scan) =>
    structurePage(scan, { bodyFontSize, bulletGlyphs: bullets, running, fonts })
  );

  const text = pages.map((page) => page.text).join('\n\n');
  const emphasis = pages.some((page) => page.emphasis === 'font-names') ? 'font-names' : 'unknown';
  const ocrNoise = looksLikeOcrNoise(text);

  const notes: string[] = [];
  if (emphasis === 'unknown') {
    notes.push(
      fonts === 'skip'
        ? 'Bold and italic were not read — this run was asked to skip the font pass. Sizes and spacing are unaffected.'
        : 'Bold and italic could not be read from this PDF — it does not name its fonts. Everything comes across in one weight; sizes and spacing are unaffected.'
    );
  }
  if (skippedPages.length > 0) {
    notes.push(
      `${skippedPages.length} page${skippedPages.length === 1 ? '' : 's'} could not be read and ${skippedPages.length === 1 ? 'was' : 'were'} left out.`
    );
  }
  if (limit < pageCount) {
    notes.push(`Only the first ${limit} of ${pageCount} pages were read.`);
  }
  const multiColumn = pages.filter((page) => page.columnCount > 1).length;
  if (multiColumn > 0) {
    notes.push(
      `${multiColumn} page${multiColumn === 1 ? '' : 's'} read as multiple columns. If the original was a single column, the order of the text will be wrong.`
    );
  }
  const sideways = pages.reduce((sum, page) => sum + page.sidewaysRuns, 0);
  if (sideways > 0) {
    notes.push('Text printed sideways was left out — it has no place in a line of running text.');
  }
  if (ocrNoise) {
    notes.push(
      'This document already carried a text layer, and it reads like poor OCR — misspellings, stray punctuation, run-together words. That is what was in the file; nothing here re-recognised the page.'
    );
  }

  return {
    ok: true,
    document: {
      pages,
      pageCount,
      bodyFontSize,
      bulletGlyphs: [...bullets],
      emphasis,
      ocrNoise,
      skippedPages,
      bytesIn,
      text,
      notes,
    },
  };
}
