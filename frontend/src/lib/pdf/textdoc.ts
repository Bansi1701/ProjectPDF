/**
 * Plain text, CSV and Markdown → PDF, in the browser.
 *
 * Three file types, one typesetter. They look like three tools from the
 * outside — and they are, on three pages, because that is how people search
 * for them — but underneath they are the same problem: text that has never
 * been laid out, arriving with a little structure that has to be honoured.
 * A .txt has line breaks and indentation. A .csv has a grid. A .md has
 * headings and lists. Everything else about the page is this file's decision.
 *
 * The three parts that are easy to get wrong, and are done properly here:
 *
 * Encoding. A file dropped on a web page is bytes, not characters. Reading
 * UTF-16 as UTF-8 produces text separated by NULs, which is the classic
 * "why is my Windows file full of squares" bug. BOMs are honoured, BOM-less
 * UTF-16 is detected from its NUL pattern, and bytes that are not valid UTF-8
 * fall back to Windows-1252 rather than turning into replacement characters.
 *
 * CSV quoting. Splitting on commas is wrong for any export that contains a
 * comma, a quote or a newline inside a field — which is most of them, because
 * addresses and notes columns exist. This parses RFC 4180 properly, and sniffs
 * the delimiter, because a spreadsheet exported anywhere in Europe uses
 * semicolons and looks like a single column to a naive reader.
 *
 * Markdown. No library: a focused subset, and `notes` says plainly what is not
 * in it. Rendering `**bold**` as literal asterisks would be worse than useless,
 * but so would claiming full CommonMark and quietly dropping footnotes.
 *
 * All drawing goes through TextPainter, which is not optional: the standard
 * PDF fonts cannot spell anything outside WinAnsi, and a CSV of Chinese
 * product names must not come out as a grid of question marks.
 */
import { PDFDocument, PDFFont, PDFPage, PDFString, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { RGB } from '@cantoo/pdf-lib';

import { TextPainter } from './text';
import type { InputFile, OpResult } from './types';

/** Which reading of the file is used. Chosen from the extension unless forced. */
export type TextDocKind = 'text' | 'csv' | 'markdown';

export interface TextDocOptions {
  /** Override the reading inferred from the file's extension. */
  kind?: TextDocKind;
  /** Columns a tab advances to. Default 4. */
  tabWidth?: number;
  /** Paper. Default A4. */
  paper?: 'a4' | 'letter';
  /** Body text size in points. Default 10.5. */
  fontSize?: number;
}

// ── page and palette ────────────────────────────────────────────────────

const PAPER = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

const MARGIN = 56;
const LEADING = 1.45;
/** Code sets tighter than prose: monospace lines are already airy. */
const CODE_LEADING = 1.32;
const PAD = 4;

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.45);
const LINK_INK = rgb(0.06, 0.3, 0.62);
const RULE = rgb(0.82, 0.82, 0.85);
const SOFT_RULE = rgb(0.9, 0.9, 0.92);
const CODE_BG = rgb(0.965, 0.965, 0.975);
const HEADER_BG = rgb(0.93, 0.93, 0.95);

/**
 * A runaway file — a 200 MB log, a CSV with a million rows — would lay out
 * until the tab dies. Stopping at a stated point beats freezing, and the note
 * says exactly how much was left out.
 */
const MAX_PAGES = 1200;

const baseName = (name: string): string =>
  name.replace(/\.(txt|text|log|csv|tsv|md|markdown|mdown|mkd|mkdn)$/i, '');

// ── decoding ────────────────────────────────────────────────────────────

interface Decoded {
  text: string;
  /** Human-readable, for the note. */
  encoding: string;
}

/**
 * Bytes → characters.
 *
 * A BOM is a definite answer and is trusted first. Without one, a file that is
 * a quarter NUL bytes is UTF-16 that lost its BOM — real, and common out of
 * older Windows tooling — and which half of each pair is NUL says whether it
 * is little- or big-endian. Only then is UTF-8 assumed, strictly, so that a
 * legacy Latin-1 export is recognised as such rather than being peppered with
 * replacement characters.
 */
function decodeText(bytes: ArrayBuffer): Decoded {
  const view = new Uint8Array(bytes);

  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(view.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(view.subarray(2)),
      encoding: 'UTF-16 little-endian (BOM)',
    };
  }
  if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be').decode(view.subarray(2)),
      encoding: 'UTF-16 big-endian (BOM)',
    };
  }

  const sample = view.subarray(0, Math.min(view.length, 2048));
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenNuls += 1;
    else oddNuls += 1;
  }
  const nuls = evenNuls + oddNuls;

  if (sample.length >= 8 && nuls > sample.length * 0.2) {
    // Latin text as UTF-16LE is "a\0b\0": the NULs land on odd indexes.
    const little = oddNuls >= evenNuls;
    return {
      text: new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(view),
      encoding: `UTF-16 ${little ? 'little' : 'big'}-endian (no BOM — detected)`,
    };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), encoding: 'UTF-8' };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(view),
      encoding: 'Windows-1252 (the bytes are not valid UTF-8)',
    };
  }
}

/** One newline convention, and no stray BOM left in the middle of the text. */
const normalise = (text: string): string =>
  text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/﻿/g, '');

/**
 * Tabs advance to the next tab stop; they are not a fixed number of spaces.
 * Replacing each with four spaces shifts every column in a hand-aligned table
 * by however long the preceding word was, which is exactly the alignment the
 * author was using tabs to get.
 */
function expandTabs(line: string, width: number): string {
  if (!line.includes('\t')) return line;
  let out = '';
  let column = 0;
  for (const character of line) {
    if (character === '\t') {
      const stop = width - (column % width);
      out += ' '.repeat(stop);
      column += stop;
    } else {
      out += character;
      column += 1;
    }
  }
  return out;
}

// ── runs, fonts, wrapping ───────────────────────────────────────────────

/** A stretch of text with one appearance. `link` carries a URL, not a style. */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  /** Inline code: a tinted box behind the text. Not every monospace run. */
  tint?: boolean;
  strike?: boolean;
  color?: RGB;
  link?: string;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
  monoItalic: PDFFont;
}

function fontFor(fonts: Fonts, run: Run): PDFFont {
  if (run.mono) return run.bold ? fonts.monoBold : run.italic ? fonts.monoItalic : fonts.mono;
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

interface Piece {
  text: string;
  run: Run;
  font: PDFFont;
  width: number;
}

/**
 * Text measurement, with the answers remembered.
 *
 * Wrapping asks for the width of every word, and the same words recur
 * constantly in a long document, so the answers are kept. This is a modest
 * saving rather than a dramatic one — profiling a 400-page conversion puts
 * almost all of the time inside pdf-lib, assembling and compressing the page
 * contents, and almost none in measurement — but it is free, and it gives the
 * call sites a measure that takes a Run, which is what they are holding.
 *
 * The cache is dropped whole if it outgrows a large document's vocabulary, so
 * a file of nothing but unique tokens cannot quietly eat the tab's memory.
 */
class Ruler {
  private readonly cache = new Map<string, number>();

  constructor(readonly painter: TextPainter) {}

  width(text: string, font: PDFFont, run: Run, size: number): number {
    const key = `${size}|${run.bold ? 1 : 0}${run.italic ? 1 : 0}${run.mono ? 1 : 0}|${text}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const measured = this.painter.width(text, font, {
      size,
      bold: run.bold ?? false,
      italic: run.italic ?? false,
    });
    if (this.cache.size > 200_000) this.cache.clear();
    this.cache.set(key, measured);
    return measured;
  }
}

/**
 * Greedy word wrap that keeps each run's own appearance, following the engine
 * in docx.ts — including the two things that engine learned the hard way.
 *
 * It is copied rather than imported because docx.ts exports only its converter;
 * the two should be pulled into one module the next time either changes.
 *
 * The chunk loop compares by INDEX, not by value: a paragraph whose second
 * line repeats its first silently failed to break. And a word wider than the
 * column is split by code point, or it loops forever and cuts surrogate pairs
 * in half on the way.
 */
function wrap(
  runs: Run[],
  fonts: Fonts,
  ruler: Ruler,
  size: number,
  maxWidth: number
): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let used = 0;

  const endLine = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const run of runs) {
    const font = fontFor(fonts, run);
    const measure = (value: string): number => ruler.width(value, font, run, size);

    for (const chunk of run.text.split(/(\n)/)) {
      if (chunk === '\n') {
        endLine();
        continue;
      }
      if (!chunk) continue;

      for (const word of chunk.split(/(\s+)/)) {
        if (!word) continue;
        const width = measure(word);

        if (used + width > maxWidth && line.length > 0) {
          endLine();
          // A space that caused the break must not open the next line.
          if (/^\s+$/.test(word)) continue;
        }

        if (width > maxWidth && line.length === 0) {
          let piece = '';
          for (const character of word) {
            const next = piece + character;
            if (measure(next) > maxWidth && piece) {
              lines.push([{ text: piece, run, font, width: measure(piece) }]);
              piece = character;
            } else {
              piece = next;
            }
          }
          if (piece) {
            line.push({ text: piece, run, font, width: measure(piece) });
            used = measure(piece);
          }
          continue;
        }

        line.push({ text: word, run, font, width });
        used += width;
      }
    }
  }

  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [[]];
}

const lineWidth = (pieces: Piece[]): number =>
  pieces.reduce((total, piece) => total + piece.width, 0);

// ── links ───────────────────────────────────────────────────────────────

/**
 * A URL goes into the file as a PDF literal string, which is parenthesis-
 * delimited: an unbalanced `(` in a link target would run the string past its
 * own end and corrupt everything after it. pdf-lib stores the value verbatim,
 * so the escaping is this file's job. Non-ASCII targets are percent-encoded,
 * because a literal string is bytes and a reader would not know which encoding.
 */
function pdfUrl(url: string): PDFString {
  const ascii = /^[\x20-\x7e]*$/.test(url) ? url : encodeURI(url);
  return PDFString.of(ascii.replace(/([\\()])/g, '\\$1'));
}

interface LinkRect {
  page: PDFPage;
  url: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ── page flow ───────────────────────────────────────────────────────────

/**
 * The cursor down the document: which page is being written, how far down it
 * is, and what to do when the next thing does not fit. `y` is the TOP of the
 * next line, so a baseline is `y - size` — the same convention as docx.ts.
 */
class Flow {
  page: PDFPage;
  y: number;
  /** Set once the page cap is hit; every renderer stops when it sees this. */
  full = false;
  readonly links: LinkRect[] = [];

  constructor(
    private readonly doc: PDFDocument,
    readonly width: number,
    readonly height: number,
    readonly painter: TextPainter
  ) {
    this.page = doc.addPage([width, height]);
    this.y = height - MARGIN;
  }

  get left(): number {
    return MARGIN;
  }

  get usable(): number {
    return this.width - MARGIN * 2;
  }

  get floor(): number {
    return MARGIN;
  }

  atTop(): boolean {
    return this.y === this.height - MARGIN;
  }

  newPage(): void {
    if (this.doc.getPageCount() >= MAX_PAGES) {
      this.full = true;
      return;
    }
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - MARGIN;
  }

  /** Moves to a new page unless what is coming fits where we are. */
  fit(height: number): void {
    if (this.atTop()) return;
    if (this.y - height < this.floor) this.newPage();
  }

  /**
   * Draws one wrapped line with its top edge at `top`. The vertical advance is
   * the caller's to make: table cells and code blocks step differently from
   * prose, and only the caller knows which it is placing.
   */
  async drawLine(pieces: Piece[], x: number, size: number, top: number): Promise<void> {
    const baseline = top - size;
    let cursor = x;

    // One annotation per link, not per word: the spaces inside "see the docs"
    // have to be clickable too, or the link only works on part of itself.
    let pending: LinkRect | null = null;
    const closeLink = (): void => {
      if (pending) this.links.push(pending);
      pending = null;
    };

    for (const piece of pieces) {
      const { run } = piece;

      if (run.link) {
        this.page.drawLine({
          start: { x: cursor, y: baseline - size * 0.11 },
          end: { x: cursor + piece.width, y: baseline - size * 0.11 },
          thickness: 0.5,
          color: LINK_INK,
        });
        if (pending && pending.url === run.link) pending.x2 = cursor + piece.width;
        else {
          closeLink();
          pending = {
            page: this.page,
            url: run.link,
            x1: cursor,
            y1: baseline - size * 0.25,
            x2: cursor + piece.width,
            y2: baseline + size * 0.85,
          };
        }
      } else {
        closeLink();
      }

      // Inline code gets its own tint. Drawn immediately before its text, so
      // the tint is behind the glyphs rather than over them. Plain text is set
      // in a monospace face from end to end and must NOT be tinted word by
      // word, which is why this asks about the tint and not about the font.
      if (run.tint && piece.text.trim().length > 0) {
        this.page.drawRectangle({
          x: cursor - 1,
          y: baseline - size * 0.22,
          width: piece.width + 2,
          height: size * 1.18,
          color: CODE_BG,
        });
      }

      if (piece.text.trim().length > 0) {
        await this.painter.draw(this.page, piece.text, cursor, baseline, piece.font, {
          size,
          bold: run.bold ?? false,
          italic: run.italic ?? false,
          color: run.link ? LINK_INK : (run.color ?? INK),
        });

        if (run.strike) {
          this.page.drawLine({
            start: { x: cursor, y: baseline + size * 0.28 },
            end: { x: cursor + piece.width, y: baseline + size * 0.28 },
            thickness: 0.6,
            color: run.color ?? INK,
          });
        }
      }

      cursor += piece.width;
    }

    closeLink();
  }
}

// ── tables, shared by CSV and Markdown ──────────────────────────────────

type Align = 'l' | 'c' | 'r';

interface Cell {
  runs: Run[];
  align: Align;
}

interface Table {
  header: Cell[] | null;
  rows: Cell[][];
  columns: number;
  /** Per-column alignment when the source states one (Markdown does). */
  align?: Align[];
}

const MIN_COL = 38;

/**
 * Column widths from the content.
 *
 * Every column asks for the width of its longest cell. When that fits, it is
 * granted — a table that fits should look like the table, not like a grid of
 * equal columns. When it does not, the columns already narrower than an equal
 * share keep what they asked for and the greedy ones divide the rest between
 * them in proportion, which is what stops one long notes column from crushing
 * six short ones to nothing.
 */
function columnWidths(table: Table, fonts: Fonts, ruler: Ruler, size: number, usable: number): number[] {
  const natural = new Array<number>(table.columns).fill(MIN_COL);
  const cap = Math.max(usable * 0.55, MIN_COL);

  const consider = (cells: Cell[] | null, bold: boolean): void => {
    if (!cells) return;
    for (const [index, cell] of cells.entries()) {
      if (index >= table.columns) continue;
      let widest = 0;
      for (const part of cell.runs.map((run) => run.text).join('').split('\n')) {
        const shape: Run = { text: part, bold, mono: cell.runs[0]?.mono };
        widest = Math.max(widest, ruler.width(part, fontFor(fonts, shape), shape, size));
      }
      natural[index] = Math.max(natural[index], Math.min(widest + PAD * 2, cap));
    }
  };

  consider(table.header, true);
  for (const row of table.rows) consider(row, false);

  const total = natural.reduce((sum, width) => sum + width, 0);
  if (total <= usable) return natural;

  const fair = usable / table.columns;
  const modest = natural.filter((width) => width <= fair);
  const modestTotal = modest.reduce((sum, width) => sum + width, 0);
  const greedyTotal = total - modestTotal;
  const remaining = usable - modestTotal;

  if (greedyTotal <= 0 || remaining <= 0) return natural.map(() => Math.max(fair, MIN_COL));

  return natural.map((width) =>
    width <= fair ? width : Math.max(MIN_COL, (width / greedyTotal) * remaining)
  );
}

interface TableReport {
  /** Column groups the table had to be split into to fit the page. */
  bands: number;
}

/**
 * Draws a table, continuing across pages with its header repeated, and across
 * column bands when it is wider than the paper — the approach spreadsheet.ts
 * uses for wide sheets, for the same reason: cropping columns away loses data
 * silently, and shrinking them to fit makes every column unreadable at once.
 */
async function drawTable(
  flow: Flow,
  table: Table,
  size: number,
  fonts: Fonts,
  ruler: Ruler
): Promise<TableReport> {
  const widths = columnWidths(table, fonts, ruler, size, flow.usable);
  const lineHeight = size * LEADING;

  // Wrapped once: the width of a column does not depend on which band it is in.
  const wrapCell = (cell: Cell | undefined, column: number, bold: boolean): Piece[][] => {
    if (!cell) return [[]];
    const runs = bold ? cell.runs.map((run) => ({ ...run, bold: true })) : cell.runs;
    return wrap(runs, fonts, ruler, size, Math.max(widths[column] - PAD * 2, 8));
  };

  const headerLines = table.header
    ? table.header.map((cell, column) => wrapCell(cell, column, true))
    : null;
  const bodyLines = table.rows.map((row) =>
    row.map((cell, column) => wrapCell(cell, column, false))
  );

  const bands: Array<{ from: number; to: number }> = [];
  let from = 0;
  let used = 0;
  for (let column = 0; column < table.columns; column += 1) {
    if (used + widths[column] > flow.usable && column > from) {
      bands.push({ from, to: column - 1 });
      from = column;
      used = 0;
    }
    used += widths[column];
  }
  bands.push({ from, to: table.columns - 1 });

  for (const band of bands) {
    const offsets: number[] = [];
    let cursor = flow.left;
    for (let column = band.from; column <= band.to; column += 1) {
      offsets[column] = cursor;
      cursor += widths[column];
    }
    const bandWidth = cursor - flow.left;

    const heightOf = (lines: Piece[][][]): number => {
      let tallest = 1;
      for (let column = band.from; column <= band.to; column += 1) {
        tallest = Math.max(tallest, lines[column]?.length ?? 1);
      }
      return tallest * lineHeight + PAD;
    };

    /**
     * Draws one row, splitting it across pages when it is taller than one.
     *
     * A single cell holding a paragraph — a notes column, a description — can
     * easily be taller than the paper. Drawing it in one go puts most of it
     * below the bottom edge, where it is still in the file and invisible on
     * the page, which is the worst of both. So the row is drawn a page's worth
     * of lines at a time, and the rule that closes it is only drawn once the
     * row is genuinely finished.
     */
    const drawRow = async (
      lines: Piece[][][],
      cells: Cell[] | null,
      bold: boolean,
      onBreak?: () => Promise<void>
    ): Promise<void> => {
      let tallest = 1;
      for (let column = band.from; column <= band.to; column += 1) {
        tallest = Math.max(tallest, lines[column]?.length ?? 1);
      }

      let first = 0;
      while (first < tallest && !flow.full) {
        const room = Math.max(1, Math.floor((flow.y - flow.floor - PAD) / lineHeight));
        const take = Math.min(room, tallest - first);
        const last = first + take >= tallest;
        const height = take * lineHeight + (last ? PAD : 0);
        const top = flow.y;

        if (bold) {
          flow.page.drawRectangle({
            x: flow.left,
            y: top - height,
            width: bandWidth,
            height,
            color: HEADER_BG,
          });
        }

        for (let column = band.from; column <= band.to; column += 1) {
          const cellLines = lines[column];
          if (!cellLines) continue;
          const align = table.align?.[column] ?? cells?.[column]?.align ?? 'l';
          const inner = Math.max(widths[column] - PAD * 2, 8);

          for (let index = first; index < first + take; index += 1) {
            const pieces = cellLines[index];
            if (!pieces) continue;
            const drawn = lineWidth(pieces);
            let x = offsets[column] + PAD;
            if (align === 'r') x += Math.max(inner - drawn, 0);
            else if (align === 'c') x += Math.max((inner - drawn) / 2, 0);
            await flow.drawLine(pieces, x, size, top - PAD / 2 - (index - first) * lineHeight);
          }
        }

        if (last) {
          flow.page.drawLine({
            start: { x: flow.left, y: top - height },
            end: { x: flow.left + bandWidth, y: top - height },
            thickness: bold ? 0.9 : 0.4,
            color: bold ? RULE : SOFT_RULE,
          });
        }

        flow.y = top - height;
        first += take;

        if (!last) {
          flow.newPage();
          if (!flow.full && onBreak) await onBreak();
        }
      }
    };

    const headerHeight = headerLines ? heightOf(headerLines) : 0;

    const drawHeader = async (): Promise<void> => {
      if (bands.length > 1) {
        const label = `columns ${band.from + 1}–${band.to + 1} of ${table.columns}`;
        await flow.drawLine(
          wrap([{ text: label, italic: true, color: MUTED }], fonts, ruler, size - 1, flow.usable)[0],
          flow.left,
          size - 1,
          flow.y
        );
        flow.y -= (size - 1) * LEADING;
      }
      if (headerLines && table.header) await drawRow(headerLines, table.header, true);
    };

    flow.fit(headerHeight + lineHeight * 2);
    await drawHeader();

    // What one page can hold once the repeated header has taken its share.
    const budget = flow.height - MARGIN * 2 - headerHeight;

    for (const [index, lines] of bodyLines.entries()) {
      if (flow.full) break;
      // A row taller than a whole page is split where it stands: moving it to
      // a fresh page would waste the page and still not make it fit.
      const height = heightOf(lines);
      if (height <= budget && flow.y - height < flow.floor) {
        flow.newPage();
        if (flow.full) break;
        await drawHeader();
      }
      await drawRow(lines, table.rows[index], false, drawHeader);
    }

    if (flow.full) break;
    flow.y -= lineHeight * 0.5;
  }

  return { bands: bands.length };
}

// ── plain text ──────────────────────────────────────────────────────────

interface PlainReport {
  lines: number;
  wrapped: number;
  breaks: number;
}

/**
 * Plain text is set in a monospace face, deliberately.
 *
 * Text files carry alignment in their spaces: log columns, ASCII tables, an
 * indented block of code pasted into a note. Proportional type destroys all of
 * it while looking perfectly fine, which is the worst way to lose something.
 * Wrapped continuations keep the original line's indentation so an indented
 * block stays visibly one block.
 */
async function renderPlain(
  flow: Flow,
  text: string,
  size: number,
  tabWidth: number,
  fonts: Fonts,
  ruler: Ruler
): Promise<PlainReport> {
  const report: PlainReport = { lines: 0, wrapped: 0, breaks: 0 };
  const lineHeight = size * CODE_LEADING;
  const space = ruler.width(' ', fonts.mono, { text: ' ', mono: true }, size);

  for (const raw of text.split('\n')) {
    if (flow.full) break;
    report.lines += 1;

    // A form feed is a page break in a text file — that is what it is for, and
    // has been since line printers. Honouring it costs nothing and surprises
    // nobody who put one there.
    const segments = raw.split('\f');

    for (const [index, segment] of segments.entries()) {
      if (index > 0 && !flow.atTop()) {
        flow.newPage();
        report.breaks += 1;
        if (flow.full) break;
      }

      const expanded = expandTabs(segment, tabWidth);
      const indent = Math.min(
        (expanded.length - expanded.trimStart().length) * space,
        flow.usable * 0.6
      );
      const body = expanded.trimStart();

      if (!body) {
        flow.fit(lineHeight);
        flow.y -= lineHeight;
        continue;
      }

      const lines = wrap([{ text: body, mono: true }], fonts, ruler, size, flow.usable - indent);
      if (lines.length > 1) report.wrapped += 1;

      for (const pieces of lines) {
        if (flow.y - lineHeight < flow.floor) {
          flow.newPage();
          if (flow.full) break;
        }
        await flow.drawLine(pieces, flow.left + indent, size, flow.y);
        flow.y -= lineHeight;
      }
    }
  }

  return report;
}

// ── CSV ─────────────────────────────────────────────────────────────────

/**
 * RFC 4180, as it is actually written in the wild.
 *
 * Quoted fields may contain the delimiter, newlines and doubled quotes. A
 * quote that turns up in the middle of an unquoted field is a literal quote,
 * not the start of quoting — that is what spreadsheets do, and a stricter
 * reading throws away the rest of the file over one stray inch mark.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field === '') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

const isBlankRow = (row: string[]): boolean => row.every((field) => field.trim() === '');

/**
 * Which character separates the fields.
 *
 * Counting occurrences is not enough: a comma-separated file of prose has more
 * commas inside its quoted fields than between them. So each candidate is
 * actually parsed, and the winner is the one that yields the most consistent
 * number of columns across the sample — a wrong guess produces ragged rows,
 * and that is measurable.
 */
function sniffDelimiter(text: string): { delimiter: string; columns: number } {
  const sample = text.slice(0, 64 * 1024);
  let best = { delimiter: ',', columns: 1, score: -1 };

  for (const delimiter of [',', ';', '\t']) {
    const rows = parseDelimited(sample, delimiter)
      .filter((row) => !isBlankRow(row))
      .slice(0, 60);
    if (rows.length === 0) continue;

    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);

    let modal = 1;
    let hits = 0;
    for (const [length, count] of counts) {
      if (count > hits || (count === hits && length > modal)) {
        modal = length;
        hits = count;
      }
    }
    if (modal < 2) continue;

    // Consistency matters more than column count, but a tie between a clean
    // 2-column reading and a clean 8-column one should go to the wider table.
    const score = (hits / rows.length) * Math.min(modal, 24);
    if (score > best.score) best = { delimiter, columns: modal, score };
  }

  return { delimiter: best.delimiter, columns: best.columns };
}

/** Currency, thousands separators and accounting parentheses still count. */
function looksNumeric(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 32) return false;
  const bare = trimmed
    .replace(/^\((.*)\)$/, '-$1')
    .replace(/[$€£¥₹\s]/g, '')
    .replace(/%$/, '')
    .replace(/,/g, '');
  return bare !== '' && bare !== '-' && Number.isFinite(Number(bare));
}

const delimiterName = (delimiter: string): string =>
  delimiter === ',' ? 'commas' : delimiter === ';' ? 'semicolons' : 'tabs';

// ── Markdown ────────────────────────────────────────────────────────────

type Block =
  | { kind: 'heading'; level: number; runs: Run[]; quote: number }
  | { kind: 'para'; runs: Run[]; quote: number }
  | { kind: 'item'; ordered: boolean; start: number; level: number; runs: Run[]; quote: number }
  | { kind: 'code'; lines: string[]; quote: number }
  | { kind: 'rule'; quote: number }
  | { kind: 'table'; table: Table; quote: number };

interface MarkdownReport {
  headings: number;
  tables: number;
  code: number;
  links: number;
  images: number;
  html: boolean;
  frontMatter: boolean;
  title: string | null;
}

const INLINE_MARKS = /[*_`~[\]!\\<]/;

/**
 * `[label](destination "title")`, scanned rather than matched.
 *
 * A regular expression has to stop the destination at the first `)`, which
 * cuts `https://en.wikipedia.org/wiki/Ampersand_(typography)` in half and
 * leaves a stray bracket in the text. Parentheses inside a URL are legal and
 * common enough — Wikipedia alone guarantees it — that the depth has to be
 * counted. Returns null when this is not a link, and the caller prints the
 * bracket literally.
 */
function matchLink(text: string, start: number): { label: string; url: string; length: number } | null {
  if (text[start] !== '[') return null;

  let depth = 0;
  let close = -1;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0 || text[close + 1] !== '(') return null;

  let parens = 1;
  let index = close + 2;
  let destination = '';
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      destination += text[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (character === '\n') return null;
    if (character === '(') parens += 1;
    if (character === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
    destination += character;
  }
  if (parens !== 0) return null;

  // A URL cannot contain a space, so anything past the first one is the
  // optional title, which belongs to the tooltip and not to the target.
  const url = destination.trim().split(/\s+/)[0].replace(/^</, '').replace(/>$/, '');
  return { label: text.slice(start + 1, close), url, length: index + 1 - start };
}

/**
 * Inline emphasis, code, links and images.
 *
 * Scanned rather than regex-replaced, because emphasis nests and code spans
 * suspend everything inside them: in `` `a *b* c` `` the asterisks are code,
 * not italics, and only a scanner that knows where the span ends can tell.
 */
function inline(text: string, base: Run, report: MarkdownReport): Run[] {
  const runs: Run[] = [];
  const push = (value: string, extra: Partial<Run> = {}): void => {
    if (!value) return;
    const last = runs[runs.length - 1];
    const merged: Run = { ...base, ...extra, text: value };
    if (
      last &&
      last.bold === merged.bold &&
      last.italic === merged.italic &&
      last.mono === merged.mono &&
      last.tint === merged.tint &&
      last.strike === merged.strike &&
      last.link === merged.link &&
      last.color === merged.color
    ) {
      last.text += value;
    } else {
      runs.push(merged);
    }
  };

  let index = 0;
  let literal = '';

  const flush = (): void => {
    push(literal);
    literal = '';
  };

  while (index < text.length) {
    const character = text[index];

    if (!INLINE_MARKS.test(character)) {
      literal += character;
      index += 1;
      continue;
    }

    // A backslash escapes the punctuation that follows it.
    if (character === '\\' && index + 1 < text.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(text[index + 1])) {
      literal += text[index + 1];
      index += 2;
      continue;
    }

    if (character === '`') {
      const fence = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(fence, index + fence.length);
      if (close > 0 && !text.slice(index + fence.length, close).includes('\n\n')) {
        flush();
        // CommonMark strips one space either side, so `` ` `` can hold a backtick.
        const code = text.slice(index + fence.length, close).replace(/^ (.*) $/, '$1');
        push(code, { mono: true, tint: true, bold: false, italic: false });
        index = close + fence.length;
        continue;
      }
      literal += character;
      index += 1;
      continue;
    }

    // <https://…> autolink. Anything else in angle brackets is inline HTML,
    // which this converter does not interpret — it is shown as it was written.
    if (character === '<') {
      const auto = /^<((?:https?|mailto):[^\s>]+)>/.exec(text.slice(index));
      if (auto) {
        flush();
        report.links += 1;
        push(auto[1], { link: auto[1] });
        index += auto[0].length;
        continue;
      }
      if (/^<\/?[a-zA-Z][^>]*>/.test(text.slice(index))) report.html = true;
      literal += character;
      index += 1;
      continue;
    }

    if (character === '!' && text[index + 1] === '[') {
      const image = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(index));
      if (image) {
        flush();
        report.images += 1;
        // The picture is not fetched: that would be a network request for the
        // contents of the user's document, which this product does not make.
        push(`[${image[1] || 'image'}]`, { italic: true, color: MUTED });
        index += image[0].length;
        continue;
      }
    }

    if (character === '[') {
      const link = matchLink(text, index);
      if (link) {
        flush();
        report.links += 1;
        for (const run of inline(link.label, { ...base, link: link.url }, report)) runs.push(run);
        index += link.length;
        continue;
      }
    }

    if (character === '~' && text[index + 1] === '~') {
      const close = text.indexOf('~~', index + 2);
      if (close > 0) {
        flush();
        for (const run of inline(text.slice(index + 2, close), { ...base, strike: true }, report)) {
          runs.push(run);
        }
        index = close + 2;
        continue;
      }
    }

    if (character === '*' || character === '_') {
      const marks = /^(\*+|_+)/.exec(text.slice(index))![1];
      const length = Math.min(marks.length, 3);
      const delimiter = character.repeat(length);

      // `snake_case_names` are not three italic words. Underscore emphasis has
      // to start at a word boundary; asterisks may sit anywhere.
      const boundary = character === '*' || index === 0 || /[\s([{"']/.test(text[index - 1]);
      const close = boundary ? text.indexOf(delimiter, index + length) : -1;

      if (close > index + length) {
        flush();
        const inner = text.slice(index + length, close);
        const style: Partial<Run> =
          length >= 3
            ? { bold: true, italic: true }
            : length === 2
              ? { bold: true }
              : { italic: true };
        for (const run of inline(inner, { ...base, ...style }, report)) runs.push(run);
        index = close + length;
        continue;
      }
    }

    literal += character;
    index += 1;
  }

  flush();
  return runs;
}

const isBlank = (line: string): boolean => line.trim() === '';
const isFence = (line: string): RegExpExecArray | null => /^ {0,3}(`{3,}|~{3,})/.exec(line);
const isRule = (line: string): boolean => /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
const isItem = (line: string): RegExpExecArray | null =>
  /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
const isHeading = (line: string): RegExpExecArray | null =>
  /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
const isQuote = (line: string): boolean => /^ {0,3}>/.test(line);
const isTableDelimiter = (line: string): boolean =>
  /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

/** Splits a table row on unescaped pipes, dropping the optional outer ones. */
function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Blocks, in document order. Recurses once per level of block quote. */
function parseMarkdown(lines: string[], report: MarkdownReport, quote = 0): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = isFence(line);
    if (fence) {
      const marker = fence[1][0];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}\\${marker}{${fence[1].length},}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // the closing fence, or the end of the document
      report.code += 1;
      blocks.push({ kind: 'code', lines: body, quote });
      continue;
    }

    if (isQuote(line)) {
      const inner: string[] = [];
      while (index < lines.length && (isQuote(lines[index]) || !isBlank(lines[index]))) {
        // Lazy continuation: a quoted paragraph may drop the marker on later
        // lines, and stopping at the first bare line would split the quote.
        if (!isQuote(lines[index]) && inner.length === 0) break;
        inner.push(lines[index].replace(/^ {0,3}>( ?)/, ''));
        index += 1;
      }
      for (const block of parseMarkdown(inner, report, quote + 1)) blocks.push(block);
      continue;
    }

    // `- - -` is a thematic break, not a list item holding "- -": the rule
    // pattern only matches a line of nothing but its own marker, so it can be
    // asked first without swallowing real bullets.
    if (isRule(line)) {
      blocks.push({ kind: 'rule', quote });
      index += 1;
      continue;
    }

    const heading = isHeading(line);
    if (heading) {
      report.headings += 1;
      const runs = inline(heading[2], { text: '', bold: true }, report);
      if (!report.title && heading[1].length === 1) {
        report.title = runs.map((run) => run.text).join('').trim() || null;
      }
      blocks.push({ kind: 'heading', level: heading[1].length, runs, quote });
      index += 1;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const headerCells = tableCells(line);
      const align: Align[] = tableCells(lines[index + 1]).map((spec) =>
        spec.startsWith(':') && spec.endsWith(':') ? 'c' : spec.endsWith(':') ? 'r' : 'l'
      );
      index += 2;

      const rows: Cell[][] = [];
      let columns = headerCells.length;
      while (index < lines.length && lines[index].includes('|') && !isBlank(lines[index])) {
        const cells = tableCells(lines[index]);
        columns = Math.max(columns, cells.length);
        rows.push(cells.map((cell) => ({ runs: inline(cell, { text: '' }, report), align: 'l' })));
        index += 1;
      }

      report.tables += 1;
      blocks.push({
        kind: 'table',
        quote,
        table: {
          header: headerCells.map((cell) => ({
            runs: inline(cell, { text: '', bold: true }, report),
            align: 'l',
          })),
          rows,
          columns,
          align,
        },
      });
      continue;
    }

    const item = isItem(line);
    if (item) {
      const indent = expandTabs(item[1], 4).length;
      const ordered = /\d/.test(item[2]);
      const body = [item[3]];
      index += 1;

      // Continuation lines belong to the item until a blank line, a new item,
      // or something that starts a block of its own.
      while (
        index < lines.length &&
        !isBlank(lines[index]) &&
        !isItem(lines[index]) &&
        !isHeading(lines[index]) &&
        !isFence(lines[index]) &&
        !isQuote(lines[index]) &&
        !isRule(lines[index])
      ) {
        body.push(lines[index].trim());
        index += 1;
      }

      blocks.push({
        kind: 'item',
        ordered,
        start: ordered ? Number(item[2].replace(/[.)]/, '')) : 0,
        level: Math.min(Math.floor(indent / 2), 5),
        runs: inline(body.join(' '), { text: '' }, report),
        quote,
      });
      continue;
    }

    // A paragraph — unless the line under it turns it into a setext heading,
    // in which case those lines have been spent and must not be set twice.
    const body: string[] = [];
    let becameHeading = false;

    while (
      index < lines.length &&
      !isBlank(lines[index]) &&
      !isItem(lines[index]) &&
      !isHeading(lines[index]) &&
      !isFence(lines[index]) &&
      !isQuote(lines[index])
    ) {
      const next = lines[index + 1];
      if (next !== undefined && /^ {0,3}(=+|-+)\s*$/.test(next)) {
        body.push(lines[index]);
        const level = next.trim().startsWith('=') ? 1 : 2;
        report.headings += 1;
        const runs = inline(body.join(' ').trim(), { text: '', bold: true }, report);
        if (!report.title && level === 1) {
          report.title = runs.map((run) => run.text).join('').trim() || null;
        }
        blocks.push({ kind: 'heading', level, runs, quote });
        index += 2;
        becameHeading = true;
        break;
      }
      if (isRule(lines[index]) && body.length > 0) break;
      // Two trailing spaces, or a trailing backslash, is a hard line break.
      body.push(/(\s{2,}|\\)$/.test(lines[index]) ? `${lines[index].trimEnd()}\n` : lines[index]);
      index += 1;
    }

    if (!becameHeading && body.length > 0) {
      blocks.push({ kind: 'para', runs: inline(body.join(' ').trim(), { text: '' }, report), quote });
    }
  }

  return blocks;
}

const HEADING_SIZE: Record<number, number> = { 1: 20, 2: 16, 3: 13.5, 4: 12, 5: 11, 6: 10.5 };
/** Cycled by nesting level, so a sub-list is visibly a sub-list. */
const BULLETS = ['•', '–', '·'];

async function renderMarkdown(
  flow: Flow,
  blocks: Block[],
  size: number,
  fonts: Fonts,
  ruler: Ruler
): Promise<{ bands: number; codeWrapped: number }> {
  const lineHeight = size * LEADING;
  let bands = 1;
  let codeWrapped = 0;

  /** Ordered-list position per nesting level; cleared when the list ends. */
  let counters: Array<{ ordered: boolean; value: number }> = [];

  const quoteBar = (depth: number, top: number, height: number): void => {
    for (let level = 0; level < depth; level += 1) {
      flow.page.drawRectangle({
        x: flow.left + level * 16,
        y: top - height,
        width: 2,
        height,
        color: RULE,
      });
    }
  };

  for (const block of blocks) {
    if (flow.full) break;
    // Each level of quote steps in by a bar's width; the text clears the bar.
    const quoteIndent = block.quote * 16;
    const quoted = block.quote > 0 ? quoteIndent + PAD * 2 : 0;
    if (block.kind !== 'item') counters = [];

    if (block.kind === 'rule') {
      flow.fit(lineHeight);
      flow.y -= lineHeight * 0.5;
      flow.page.drawLine({
        start: { x: flow.left + quoteIndent, y: flow.y },
        end: { x: flow.width - MARGIN, y: flow.y },
        thickness: 0.8,
        color: RULE,
      });
      flow.y -= lineHeight * 0.5;
      continue;
    }

    if (block.kind === 'code') {
      const codeSize = size - 1;
      const codeLine = codeSize * CODE_LEADING;
      const inner = flow.usable - quoteIndent - PAD * 2;

      // Long code lines are wrapped, not cropped: a truncated command is worse
      // than a wrapped one, and code is exactly where a missing tail bites.
      const rendered: Piece[][] = [];
      for (const raw of block.lines) {
        const expanded = expandTabs(raw, 4);
        const wrapped = wrap([{ text: expanded || ' ', mono: true }], fonts, ruler, codeSize, inner);
        if (wrapped.length > 1) codeWrapped += 1;
        for (const pieces of wrapped) rendered.push(pieces);
      }

      let cursor = 0;
      while (cursor < rendered.length && !flow.full) {
        const room = Math.floor((flow.y - flow.floor - PAD * 2) / codeLine);
        if (room < 1) {
          flow.newPage();
          continue;
        }
        const take = Math.min(room, rendered.length - cursor);
        const height = take * codeLine + PAD * 2;
        const top = flow.y;

        flow.page.drawRectangle({
          x: flow.left + quoteIndent,
          y: top - height,
          width: flow.usable - quoteIndent,
          height,
          color: CODE_BG,
        });
        quoteBar(block.quote, top, height);

        for (let index = 0; index < take; index += 1) {
          await flow.drawLine(
            rendered[cursor + index].map((piece) => ({
              ...piece,
              run: { ...piece.run, color: rgb(0.15, 0.15, 0.2) },
            })),
            flow.left + quoteIndent + PAD,
            codeSize,
            top - PAD - index * codeLine
          );
        }

        flow.y = top - height;
        cursor += take;
        if (cursor < rendered.length) flow.newPage();
      }

      flow.y -= lineHeight * 0.4;
      continue;
    }

    if (block.kind === 'table') {
      flow.y -= lineHeight * 0.3;
      const result = await drawTable(flow, block.table, size - 0.5, fonts, ruler);
      bands = Math.max(bands, result.bands);
      continue;
    }

    if (block.kind === 'heading') {
      const headingSize = HEADING_SIZE[block.level] ?? size;
      const above = headingSize * 0.7;
      const lines = wrap(block.runs, fonts, ruler, headingSize, flow.usable - quoted);
      const height = headingSize * LEADING;

      // A heading is kept with the line that follows it: a heading alone at the
      // foot of a page is the clearest sign of a layout that has gone wrong.
      flow.fit(above + height * (lines.length + 1));
      flow.y -= above;

      for (const pieces of lines) {
        if (flow.y - height < flow.floor) flow.newPage();
        if (flow.full) break;
        const top = flow.y;
        quoteBar(block.quote, top, height);
        await flow.drawLine(pieces, flow.left + quoted, headingSize, top);
        flow.y -= height;
      }

      if (block.level <= 2 && !flow.full) {
        flow.page.drawLine({
          start: { x: flow.left + quoteIndent, y: flow.y + headingSize * 0.25 },
          end: { x: flow.width - MARGIN, y: flow.y + headingSize * 0.25 },
          thickness: 0.6,
          color: SOFT_RULE,
        });
      }
      flow.y -= headingSize * 0.35;
      continue;
    }

    if (block.kind === 'item') {
      const level = block.level;
      counters.length = Math.min(counters.length, level + 1);
      const slot = counters[level];
      if (block.ordered) {
        counters[level] =
          slot && slot.ordered ? { ordered: true, value: slot.value + 1 } : { ordered: true, value: block.start };
      } else {
        counters[level] = { ordered: false, value: 0 };
      }

      const marker = block.ordered
        ? `${counters[level].value}.`
        : BULLETS[level % BULLETS.length];
      const indent = quoted + level * 18;
      const markerWidth = 16;
      const lines = wrap(block.runs, fonts, ruler, size, flow.usable - indent - markerWidth);

      for (const [index, pieces] of lines.entries()) {
        if (flow.y - lineHeight < flow.floor) flow.newPage();
        if (flow.full) break;
        const top = flow.y;
        quoteBar(block.quote, top, lineHeight);
        if (index === 0) {
          await flow.drawLine(
            [
              {
                text: marker,
                run: { text: marker, color: MUTED },
                font: fonts.regular,
                width: ruler.width(marker, fonts.regular, { text: marker }, size),
              },
            ],
            flow.left + indent,
            size,
            top
          );
        }
        await flow.drawLine(pieces, flow.left + indent + markerWidth, size, top);
        flow.y -= lineHeight;
      }
      flow.y -= lineHeight * 0.12;
      continue;
    }

    const lines = wrap(block.runs, fonts, ruler, size, flow.usable - quoted);
    for (const pieces of lines) {
      if (flow.y - lineHeight < flow.floor) flow.newPage();
      if (flow.full) break;
      const top = flow.y;
      quoteBar(block.quote, top, lineHeight);
      await flow.drawLine(pieces, flow.left + quoted, size, top);
      flow.y -= lineHeight;
    }
    flow.y -= lineHeight * 0.45;
  }

  return { bands, codeWrapped };
}

// ── the tool ────────────────────────────────────────────────────────────

function kindFor(name: string, forced: TextDocKind | undefined): TextDocKind | null {
  if (forced) return forced;
  if (/\.(md|markdown|mdown|mkd|mkdn)$/i.test(name)) return 'markdown';
  if (/\.(csv|tsv)$/i.test(name)) return 'csv';
  if (/\.(txt|text|log)$/i.test(name)) return 'text';
  return null;
}

/**
 * Converts one .txt, .csv or .md file to a PDF.
 *
 * `kind` overrides the reading taken from the extension, for the case where a
 * tool page knows better than the file name does.
 */
export async function textDocToPdf(
  files: InputFile[],
  options: TextDocOptions = {}
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a text, CSV or Markdown file.' };

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  const inferred = kindFor(file.name, options.kind);
  const kind: TextDocKind = inferred ?? 'text';

  const decoded = decodeText(file.bytes);
  const text = normalise(decoded.text);

  if (text.trim() === '') {
    return {
      ok: false,
      error: 'This file has no text in it — there would be nothing on the page.',
    };
  }

  const tabWidth = Math.min(Math.max(Math.round(options.tabWidth ?? 4), 1), 16);
  const paper = PAPER[options.paper ?? 'a4'];
  const size = Math.min(Math.max(options.fontSize ?? 10.5, 6), 24);

  const doc = await PDFDocument.create();
  const painter = new TextPainter(doc);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
    monoItalic: await doc.embedFont(StandardFonts.CourierOblique),
  };

  const ruler = new Ruler(painter);
  const flow = new Flow(doc, paper.width, paper.height, painter);
  const notes: string[] = [
    'Converted here, in this tab. The file was never uploaded.',
    `Read as ${decoded.encoding}.`,
  ];
  let summary = '';

  if (kind === 'text') {
    const report = await renderPlain(flow, text, size, tabWidth, fonts, ruler);
    summary = `${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'} from ${report.lines} line${report.lines === 1 ? '' : 's'}`;
    notes.push(
      `Set in Courier, a monospace face, on purpose: text files carry meaning in their spacing — aligned columns, indented blocks — and a proportional font destroys that while still looking tidy. Tabs advance to every ${tabWidth}${tabWidth === 4 ? 'th' : ''} column.`
    );
    if (report.wrapped > 0) {
      notes.push(
        `${report.wrapped} line${report.wrapped === 1 ? ' was' : 's were'} wider than the page and ${report.wrapped === 1 ? 'was' : 'were'} wrapped, indented to match the line ${report.wrapped === 1 ? 'it' : 'they'} continue${report.wrapped === 1 ? 's' : ''}. Nothing was cut off.`
      );
    }
    if (report.breaks > 0) {
      notes.push(
        `${report.breaks} form feed${report.breaks === 1 ? '' : 's'} in the file ${report.breaks === 1 ? 'was' : 'were'} treated as ${report.breaks === 1 ? 'a page break' : 'page breaks'}.`
      );
    }
  } else if (kind === 'csv') {
    const forcedTab = /\.tsv$/i.test(file.name);
    const sniffed = forcedTab ? { delimiter: '\t', columns: 0 } : sniffDelimiter(text);
    const rows = parseDelimited(text, sniffed.delimiter).filter((row) => !isBlankRow(row));

    if (rows.length === 0) {
      return { ok: false, error: 'This file has no rows with anything in them.' };
    }

    const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    const numericLater = rows.slice(1).some((row) => row.some(looksNumeric));
    const hasHeader = rows.length > 1 && !rows[0].some(looksNumeric) && numericLater;
    const body = hasHeader ? rows.slice(1) : rows;
    const ragged = rows.filter((row) => row.length !== columns).length;

    const table: Table = {
      header: hasHeader
        ? rows[0].map((value) => ({ runs: [{ text: value, bold: true }], align: 'l' as Align }))
        : null,
      rows: body.map((row) =>
        Array.from({ length: columns }, (_, column) => {
          const value = row[column] ?? '';
          return { runs: [{ text: value }], align: looksNumeric(value) ? 'r' : ('l' as Align) };
        })
      ),
      columns,
    };

    const result = await drawTable(flow, table, size - 1, fonts, ruler);
    summary = `${body.length} row${body.length === 1 ? '' : 's'} × ${columns} column${columns === 1 ? '' : 's'} across ${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'}`;

    notes.push(
      columns === 1
        ? 'No delimiter was found in this file — no line splits into more than one field — so each line is set as a single cell. If it should be a table, check what separates its columns.'
        : `Fields are separated by ${delimiterName(sniffed.delimiter)}${forcedTab ? ' (a .tsv file)' : ', worked out by parsing the file each way and keeping the reading with the most consistent column count'}. Quoted fields are read to RFC 4180, so commas, quotes and line breaks inside a value stay inside it.`
    );
    notes.push(
      hasHeader
        ? 'The first row looked like a header — no numbers in it, numbers below it — so it is set in bold and repeated at the top of every page.'
        : 'No header row was detected, so every row is set the same way. Nothing is repeated across pages.'
    );
    if (result.bands > 1) {
      notes.push(
        `The table is wider than the page, so it continues across ${result.bands} column groups rather than being cropped. Every column is there; look for the "columns n–m" line above each group.`
      );
    }
    if (ragged > 0) {
      notes.push(
        `${ragged} row${ragged === 1 ? ' has' : 's have'} a different number of fields from the widest row. ${ragged === 1 ? 'It was' : 'They were'} padded rather than dropped, so nothing is lost — but it usually means the file is not quite valid.`
      );
    }
    notes.push(
      'Values are printed as they appear in the file. Nothing was parsed as a date or a number and reformatted, because that is how a leading zero or a European decimal comma gets quietly destroyed.'
    );
  } else {
    const report: MarkdownReport = {
      headings: 0,
      tables: 0,
      code: 0,
      links: 0,
      images: 0,
      html: false,
      frontMatter: false,
      title: null,
    };

    let source = text;
    const front = /^---\n([\s\S]*?)\n---\n?/.exec(source);
    if (front) {
      report.frontMatter = true;
      const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(front[1]);
      if (title) report.title = title[1];
      source = source.slice(front[0].length);
    }

    const blocks = parseMarkdown(source.split('\n'), report);
    if (blocks.length === 0) {
      return { ok: false, error: 'This file has no text in it — there would be nothing on the page.' };
    }

    const result = await renderMarkdown(flow, blocks, size, fonts, ruler);
    if (report.title) doc.setTitle(report.title);

    summary = `${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'} from ${blocks.length} Markdown block${blocks.length === 1 ? '' : 's'}`;

    const carried: string[] = [];
    if (report.headings > 0) carried.push(`${report.headings} heading${report.headings === 1 ? '' : 's'}`);
    if (report.tables > 0) carried.push(`${report.tables} table${report.tables === 1 ? '' : 's'}`);
    if (report.code > 0) carried.push(`${report.code} code block${report.code === 1 ? '' : 's'}`);
    if (report.links > 0) carried.push(`${report.links} link${report.links === 1 ? '' : 's'}`);

    notes.push(
      carried.length > 0
        ? `Laid out ${carried.join(', ')}, plus bold, italic, inline code, nested bullet and numbered lists, block quotes and horizontal rules.`
        : 'Laid out headings, bold, italic, inline code, nested bullet and numbered lists, block quotes, rules and tables.'
    );
    if (report.links > 0) {
      notes.push('Links are clickable in the PDF: the target is stored as a link annotation, and the text is underlined so it is visible in print too.');
    }
    if (report.images > 0) {
      notes.push(
        `${report.images} image${report.images === 1 ? '' : 's'} in the Markdown ${report.images === 1 ? 'was' : 'were'} left as ${report.images === 1 ? 'its' : 'their'} alt text. Fetching ${report.images === 1 ? 'it' : 'them'} would mean sending part of your document to a server, which this tool does not do — even for a picture.`
      );
    }
    if (report.frontMatter) {
      notes.push('YAML front matter at the top of the file was skipped rather than printed.');
    }
    if (report.html) {
      notes.push('Inline HTML is shown exactly as it was written; it is not interpreted.');
    }
    if (result.bands > 1) {
      notes.push('A table was wider than the page and continues across column groups rather than being cropped.');
    }
    if (result.codeWrapped > 0) {
      notes.push(
        `${result.codeWrapped} line${result.codeWrapped === 1 ? '' : 's'} of code ${result.codeWrapped === 1 ? 'was' : 'were'} too wide for the page and ${result.codeWrapped === 1 ? 'was' : 'were'} wrapped. Nothing was truncated, but a wrapped command is not always a runnable one.`
      );
    }
    notes.push(
      'This is a focused subset of Markdown, not CommonMark. Not supported: reference-style links and footnotes, definition lists, task-list checkboxes (they print as written), nested tables, and lists interrupted by indented code blocks.'
    );
  }

  // Links are registered after layout because a link's rectangle is only known
  // once the line it sits on has been placed.
  for (const link of flow.links) {
    const annotation = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [link.x1, link.y1, link.x2, link.y2],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: pdfUrl(link.url) },
    });
    link.page.node.addAnnot(doc.context.register(annotation));
  }

  if (flow.full) {
    notes.push(
      `This file is long enough to fill more than ${MAX_PAGES} pages, so it was stopped there. The rest is not in the PDF — split the source file if you need all of it.`
    );
  }

  if (!inferred) {
    notes.push(
      `The extension on "${file.name}" is not one this tool recognises, so the file was read as plain text.`
    );
  }

  const fallback = painter.note();
  if (fallback) notes.push(fallback);

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: doc.getPageCount(),
    durationMs: performance.now() - started,
    summary,
    notes,
  };
}
