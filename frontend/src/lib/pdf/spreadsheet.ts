/**
 * Excel → PDF, in the browser.
 *
 * A spreadsheet is the one document type that has already been laid out.
 * Column widths and row heights are stored explicitly, cells sit in a grid,
 * and nothing flows — so there is no line-breaking problem to solve. And `<v>`
 * holds the cached value of every formula: Excel evaluated `=SUM(A1:A9)` and
 * wrote the answer into the file, so a converter never needs a formula engine,
 * only the ability to read what is there.
 *
 * What a first pass gets wrong is everything between the value and what the
 * sheet actually shows. A cell holding `1234.5` displays as `$1,234.50`. A
 * date is a day count whose epoch depends on which platform first saved the
 * workbook. A label wider than its column spills into the empty cell beside it
 * rather than being cut off. Hidden sheets do not print at all. Those are the
 * difference between a PDF someone recognises and a grid of raw numbers.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { RGB } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';

import {
  attr,
  children,
  decode,
  find,
  findAll,
  numAttr,
  relationships,
  unescapeXml,
} from './ooxml';
import { BUILTIN_DATE, builtinCode, formatNumber, isDateCode, serialToDate } from './numfmt';
import { TextPainter } from './text';
import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.xlsx?$/i, '');

// ── cell references ─────────────────────────────────────────────────────

/** "BC12" → column 54 (zero-based), row 11. */
function parseRef(ref: string): { col: number; row: number } {
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  if (!match) return { col: 0, row: 0 };

  let col = 0;
  for (const character of match[1]) col = col * 26 + (character.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(match[2]) - 1 };
}

const columnName = (index: number): string => {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

// ── styles ──────────────────────────────────────────────────────────────

interface Style {
  format: string;
  date: boolean;
  bold: boolean;
  italic: boolean;
  align: 'l' | 'c' | 'r' | null;
  fill: RGB | null;
  color: RGB | null;
}

const PLAIN: Style = {
  format: '',
  date: false,
  bold: false,
  italic: false,
  align: null,
  fill: null,
  color: null,
};

const argbToRgb = (value: string): RGB | null => {
  const hex = value.length === 8 ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return rgb(
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255
  );
};

/**
 * Workbook themes list their colours light-first, so index 0 is the light
 * background and index 1 the dark text — the reverse of the element order in
 * the theme part. Swapping the first two pairs is the documented mapping.
 */
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

function readThemeColors(xml: string): string[] {
  const scheme = find(xml, 'a:clrScheme');
  if (!scheme) return [];

  const byName = new Map<string, string>();
  for (const slot of children(scheme.inner)) {
    const srgb = find(slot.inner, 'a:srgbClr');
    const sys = find(slot.inner, 'a:sysClr');
    const value = srgb ? attr(srgb.attrs, 'val') : sys ? attr(sys.attrs, 'lastClr') : null;
    if (value) byName.set(slot.name.replace(/^a:/, ''), value);
  }

  return THEME_ORDER.map((name) => byName.get(name) ?? '');
}

/** Reads a `<color>` element, whichever way it names its colour. */
function readColor(body: string, theme: string[]): RGB | null {
  const color = find(body, 'color') ?? find(body, 'fgColor');
  if (!color) return null;

  const raw = attr(color.attrs, 'rgb');
  if (raw) return argbToRgb(raw);

  const themed = attr(color.attrs, 'theme');
  if (themed !== null) {
    const hex = theme[Number(themed)];
    if (hex) return argbToRgb(hex);
  }

  return null;
}

function readStyles(xml: string, theme: string[]): Style[] {
  if (!xml) return [];

  const custom = new Map<number, string>();
  for (const fmt of findAll(xml, 'numFmt')) {
    const id = numAttr(fmt.attrs, 'numFmtId', -1);
    const code = attr(fmt.attrs, 'formatCode');
    if (id >= 0 && code) custom.set(id, unescapeXml(code));
  }

  const fontsBlock = find(xml, 'fonts');
  const fonts = fontsBlock
    ? children(fontsBlock.inner)
        .filter((child) => child.name === 'font')
        .map((font) => ({
          bold: Boolean(find(font.inner, 'b')),
          italic: Boolean(find(font.inner, 'i')),
          color: readColor(font.inner, theme),
        }))
    : [];

  const fillsBlock = find(xml, 'fills');
  const fills = fillsBlock
    ? children(fillsBlock.inner)
        .filter((child) => child.name === 'fill')
        .map((fill) => {
          const pattern = find(fill.inner, 'patternFill');
          if (!pattern) return null;
          // `none` and `gray125` are Excel's two default entries, not a colour.
          const type = attr(pattern.attrs, 'patternType');
          if (!type || type === 'none' || type === 'gray125') return null;
          return readColor(pattern.inner, theme);
        })
    : [];

  const cellXfs = find(xml, 'cellXfs');
  if (!cellXfs) return [];

  return children(cellXfs.inner)
    .filter((child) => child.name === 'xf')
    .map((xf) => {
      const numFmtId = numAttr(xf.attrs, 'numFmtId', 0);
      const format = custom.get(numFmtId) ?? builtinCode(numFmtId);
      const font = fonts[numAttr(xf.attrs, 'fontId', -1)];
      const fill = fills[numAttr(xf.attrs, 'fillId', -1)] ?? null;

      const alignment = find(xf.inner, 'alignment');
      const horizontal = alignment ? attr(alignment.attrs, 'horizontal') : null;

      return {
        format,
        date: BUILTIN_DATE.has(numFmtId) || (Boolean(format) && isDateCode(format)),
        bold: font?.bold ?? false,
        italic: font?.italic ?? false,
        align:
          horizontal === 'center'
            ? 'c'
            : horizontal === 'right'
              ? 'r'
              : horizontal === 'left'
                ? 'l'
                : null,
        fill,
        color: font?.color ?? null,
      } satisfies Style;
    });
}

// ── the sheet ───────────────────────────────────────────────────────────

interface Cell {
  col: number;
  row: number;
  value: string;
  numeric: boolean;
  style: Style;
  /** Extra columns this cell spans, from a merge. */
  span: number;
}

interface Sheet {
  name: string;
  cells: Cell[];
  widths: Map<number, number>;
  heights: Map<number, number>;
  maxCol: number;
  maxRow: number;
  /** Rows frozen at the top, repeated as a header on every page. */
  frozenRows: number;
  landscape: boolean;
}

/** Excel's width unit is character widths; this is the documented conversion. */
const widthToPoints = (width: number): number => Math.round((width * 7 + 5) * 0.75);
const DEFAULT_COL_WIDTH = widthToPoints(8.43);
const ROW_HEIGHT = 16;

function readSheet(
  name: string,
  xml: string,
  shared: string[],
  styles: Style[],
  date1904: boolean
): Sheet {
  const widths = new Map<number, number>();
  const heights = new Map<number, number>();

  const columnsBlock = find(xml, 'cols');
  if (columnsBlock) {
    for (const col of findAll(columnsBlock.inner, 'col')) {
      const min = numAttr(col.attrs, 'min', 0);
      const max = numAttr(col.attrs, 'max', 0);
      const width = numAttr(col.attrs, 'width', 0);
      if (!min || !width) continue;
      if (attr(col.attrs, 'hidden') === '1') {
        for (let i = min; i <= Math.min(max, min + 200); i += 1) widths.set(i - 1, 0);
        continue;
      }
      // A `max` of 16384 means "every column from here"; do not materialise it.
      for (let i = min; i <= Math.min(max, min + 200); i += 1) widths.set(i - 1, widthToPoints(width));
    }
  }

  // Merges: the top-left cell carries the content, the rest are placeholders.
  const covered = new Set<string>();
  const spans = new Map<string, number>();
  const mergeBlock = find(xml, 'mergeCells');
  if (mergeBlock) {
    for (const merge of findAll(mergeBlock.inner, 'mergeCell')) {
      const ref = attr(merge.attrs, 'ref');
      if (!ref || !ref.includes(':')) continue;
      const [first, last] = ref.split(':').map(parseRef);
      spans.set(`${first.row}:${first.col}`, last.col - first.col);
      for (let row = first.row; row <= last.row; row += 1) {
        for (let col = first.col; col <= last.col; col += 1) {
          if (row !== first.row || col !== first.col) covered.add(`${row}:${col}`);
        }
      }
    }
  }

  const cells: Cell[] = [];
  let maxCol = 0;
  let maxRow = 0;

  const sheetData = find(xml, 'sheetData');
  for (const rowElement of sheetData ? findAll(sheetData.inner, 'row') : []) {
    const rowIndex = numAttr(rowElement.attrs, 'r', 0) - 1;
    if (attr(rowElement.attrs, 'hidden') === '1') continue;

    const height = numAttr(rowElement.attrs, 'ht', 0);
    if (height > 0) heights.set(rowIndex, Math.min(Math.max(height, 8), 120));

    for (const cellElement of children(rowElement.inner)) {
      if (cellElement.name !== 'c') continue;

      const ref = attr(cellElement.attrs, 'r');
      const { col, row } = ref ? parseRef(ref) : { col: 0, row: rowIndex };
      if (covered.has(`${row}:${col}`)) continue;

      const type = attr(cellElement.attrs, 't') ?? 'n';
      const styleIndex = numAttr(cellElement.attrs, 's', -1);
      const style = styles[styleIndex] ?? PLAIN;

      // `<v>` is the cached value; `<f>` is the formula that produced it and is
      // deliberately ignored — Excel already did that work.
      const valueElement = find(cellElement.inner, 'v');
      const raw = valueElement ? valueElement.inner : '';

      let value = '';
      let numeric = false;

      if (type === 's') {
        value = shared[Number(raw)] ?? '';
      } else if (type === 'inlineStr') {
        value = findAll(cellElement.inner, 't')
          .map((t) => unescapeXml(t.inner))
          .join('');
      } else if (type === 'b') {
        value = raw === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        value = raw; // #DIV/0! and friends
      } else if (type === 'str') {
        value = unescapeXml(raw);
      } else if (raw !== '') {
        const number = Number(raw);
        if (!Number.isFinite(number)) {
          value = unescapeXml(raw);
        } else if (style.date) {
          value = serialToDate(number, date1904);
        } else {
          numeric = true;
          value =
            formatNumber(number, style.format) ??
            // Trim the float noise Excel stores without inventing precision.
            String(Math.round(number * 1e10) / 1e10);
        }
      }

      if (value === '') continue;

      cells.push({
        col,
        row,
        value: type === 's' || type === 'inlineStr' ? value : unescapeXml(value),
        numeric,
        style,
        span: spans.get(`${row}:${col}`) ?? 0,
      });

      if (col + (spans.get(`${row}:${col}`) ?? 0) > maxCol) {
        maxCol = col + (spans.get(`${row}:${col}`) ?? 0);
      }
      if (row > maxRow) maxRow = row;
    }
  }

  const pane = find(xml, 'pane');
  const frozenRows =
    pane && attr(pane.attrs, 'state') !== 'split' ? numAttr(pane.attrs, 'ySplit', 0) : 0;

  const pageSetup = find(xml, 'pageSetup');
  const landscape = pageSetup ? attr(pageSetup.attrs, 'orientation') !== 'portrait' : true;

  return { name, cells, widths, heights, maxCol, maxRow, frozenRows, landscape };
}

// ── drawing ─────────────────────────────────────────────────────────────

const A4 = { long: 841.89, short: 595.28 };
const MARGIN = 32;
const FONT_SIZE = 8.5;
const PAD = 4;
/** A run of empty rows collapses to one gap this tall, not to nothing. */
const GAP_HEIGHT = 8;

export async function xlsxToPdf(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a spreadsheet.' };

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(file.bytes));
  } catch {
    return {
      ok: false,
      error:
        'That does not look like a .xlsx. The older binary .xls format is a different thing entirely — re-save it as .xlsx first.',
    };
  }

  const workbookXml = decode(entries['xl/workbook.xml']);
  if (!workbookXml) {
    return { ok: false, error: 'That file has no workbook inside it, so it is not a .xlsx.' };
  }

  const workbookPr = find(workbookXml, 'workbookPr');
  const date1904 =
    workbookPr !== null &&
    (attr(workbookPr.attrs, 'date1904') === '1' || attr(workbookPr.attrs, 'date1904') === 'true');

  // The shared string table: cells hold indexes into this, not text.
  const shared: string[] = [];
  for (const si of findAll(decode(entries['xl/sharedStrings.xml']), 'si')) {
    // A string can be split across runs; join them.
    shared.push(
      findAll(si.inner, 't')
        .map((t) => unescapeXml(t.inner))
        .join('')
    );
  }

  const themePath = Object.keys(entries).find((key) => /^xl\/theme\/theme\d*\.xml$/.test(key));
  const theme = readThemeColors(themePath ? decode(entries[themePath]) : '');
  const styles = readStyles(decode(entries['xl/styles.xml']), theme);

  const rels = relationships(decode(entries['xl/_rels/workbook.xml.rels']), 'xl');

  const sheets: Sheet[] = [];
  let hidden = 0;

  for (const entry of findAll(workbookXml, 'sheet')) {
    const name = unescapeXml(attr(entry.attrs, 'name') ?? 'Sheet');

    // A sheet hidden in Excel does not print, and should not convert — it is
    // content the author chose not to show, and often working notes.
    const state = attr(entry.attrs, 'state');
    if (state === 'hidden' || state === 'veryHidden') {
      hidden += 1;
      continue;
    }

    const target = rels.get(attr(entry.attrs, 'r:id') ?? '');
    const xml = target ? decode(entries[target]) : '';
    if (xml) sheets.push(readSheet(name, xml, shared, styles, date1904));
  }

  const withContent = sheets.filter((sheet) => sheet.cells.length > 0);
  if (withContent.length === 0) {
    return {
      ok: false,
      error:
        hidden > 0
          ? 'Every sheet with anything in it is hidden, so there was nothing to convert.'
          : 'This workbook has no cells with anything in them.',
    };
  }

  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await doc.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const painter = new TextPainter(doc);

  const fontFor = (style: Style): PDFFont =>
    style.bold && style.italic
      ? boldItalic
      : style.bold
        ? boldFont
        : style.italic
          ? italicFont
          : regular;

  let overflowed = 0;

  for (const sheet of withContent) {
    const page = { width: sheet.landscape ? A4.long : A4.short, height: sheet.landscape ? A4.short : A4.long };
    const usable = page.width - MARGIN * 2;
    const widthOf = (col: number) => sheet.widths.get(col) ?? DEFAULT_COL_WIDTH;

    // Split the columns into bands that each fit a page, so a wide sheet
    // continues on the next page rather than being cropped away.
    const bands: Array<{ from: number; to: number }> = [];
    let from = 0;
    let used = 0;
    for (let col = 0; col <= sheet.maxCol; col += 1) {
      const width = Math.min(widthOf(col), usable);
      if (used + width > usable && col > from) {
        bands.push({ from, to: col - 1 });
        from = col;
        used = 0;
      }
      used += width;
    }
    bands.push({ from, to: sheet.maxCol });

    const byRow = new Map<number, Cell[]>();
    for (const cell of sheet.cells) {
      const list = byRow.get(cell.row);
      if (list) list.push(cell);
      else byRow.set(cell.row, [cell]);
    }

    const rowsPresent = [...byRow.keys()].sort((a, b) => a - b);

    for (const band of bands) {
      // Where each column in this band starts, measured from the left margin.
      const offsets = new Map<number, number>();
      let cursor = MARGIN;
      for (let col = band.from; col <= band.to; col += 1) {
        offsets.set(col, cursor);
        cursor += widthOf(col);
      }

      let sheetPage: PDFPage = doc.addPage([page.width, page.height]);
      let y = page.height - MARGIN;

      const drawRow = async (cells: Cell[], height: number): Promise<void> => {
        const inBand = cells.filter((cell) => cell.col >= band.from && cell.col <= band.to);
        if (inBand.length === 0) return;

        const occupied = new Set(cells.map((cell) => cell.col));

        for (const cell of inBand) {
          const x = offsets.get(cell.col) ?? MARGIN;

          // The cell's own width, plus any columns a merge takes with it.
          let boxWidth = widthOf(cell.col);
          for (let extra = 1; extra <= cell.span; extra += 1) {
            if (cell.col + extra <= band.to) boxWidth += widthOf(cell.col + extra);
          }

          if (cell.style.fill) {
            sheetPage.drawRectangle({
              x,
              y: y - height,
              width: boxWidth,
              height,
              color: cell.style.fill,
            });
          }

          const font = fontFor(cell.style);
          const style = {
            size: FONT_SIZE,
            bold: cell.style.bold,
            italic: cell.style.italic,
            color: cell.style.color ?? rgb(0.12, 0.12, 0.14),
          };

          let available = boxWidth - PAD * 2;

          // Excel lets a label run over its neighbour when that neighbour is
          // empty. Truncating instead is the most visible way a converted
          // sheet stops looking like the original.
          if (!cell.numeric) {
            const natural = painter.width(cell.value, font, style);
            if (natural > available) {
              let reach = cell.col + cell.span;
              while (reach + 1 <= band.to && !occupied.has(reach + 1) && available < natural) {
                reach += 1;
                available += widthOf(reach);
              }
              if (reach > cell.col + cell.span) overflowed += 1;
            }
          }

          if (available <= 0) continue;

          const shown = painter.fit(cell.value, font, style, available);
          if (!shown) continue;

          const drawnWidth = painter.width(shown, font, style);
          const align = cell.style.align ?? (cell.numeric ? 'r' : 'l');
          let offset = 0;
          if (align === 'r') offset = Math.max(available - drawnWidth, 0);
          else if (align === 'c') offset = Math.max((available - drawnWidth) / 2, 0);

          await painter.draw(sheetPage, shown, x + PAD + offset, y - height + 5, font, style);
        }
      };

      const header = async (): Promise<void> => {
        const label =
          bands.length > 1
            ? `${sheet.name}  ·  columns ${columnName(band.from)}–${columnName(band.to)}`
            : sheet.name;

        await painter.draw(
          sheetPage,
          painter.fit(label, boldFont, { size: 10, bold: true }, usable),
          MARGIN,
          y - 10,
          boldFont,
          { size: 10, bold: true, color: rgb(0.1, 0.1, 0.12) }
        );
        y -= 22;

        // Repeat whatever Excel froze at the top, the way its own print
        // titles do — a long table stays readable past page one.
        for (let row = 0; row < sheet.frozenRows; row += 1) {
          const cells = byRow.get(row);
          if (!cells) continue;
          const height = sheet.heights.get(row) ?? ROW_HEIGHT;
          await drawRow(cells, height);
          y -= height;
        }

        if (sheet.frozenRows > 0) {
          sheetPage.drawLine({
            start: { x: MARGIN, y: y + 2 },
            end: { x: page.width - MARGIN, y: y + 2 },
            thickness: 0.8,
            color: rgb(0.6, 0.6, 0.64),
          });
          y -= 3;
        }
      };

      await header();

      let previous = -1;
      for (const row of rowsPresent) {
        if (row < sheet.frozenRows) {
          previous = row;
          continue;
        }

        // A run of blank rows collapses to one gap: keeping all of them wastes
        // pages, and dropping them entirely merges blocks the author separated.
        if (previous >= 0 && row - previous > 1) {
          if (y - GAP_HEIGHT > MARGIN) y -= GAP_HEIGHT;
        }
        previous = row;

        const cells = byRow.get(row);
        if (!cells) continue;
        const height = sheet.heights.get(row) ?? ROW_HEIGHT;

        if (y - height < MARGIN) {
          sheetPage = doc.addPage([page.width, page.height]);
          y = page.height - MARGIN;
          await header();
        }

        // A faint rule under every row: a grid without lines is unreadable.
        sheetPage.drawLine({
          start: { x: MARGIN, y: y - height + 1 },
          end: { x: page.width - MARGIN, y: y - height + 1 },
          thickness: 0.4,
          color: rgb(0.85, 0.85, 0.87),
        });

        await drawRow(cells, height);
        y -= height;
      }
    }
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  const charts = Object.keys(entries).filter((key) => /^xl\/charts\//.test(key)).length;
  const images = Object.keys(entries).filter((key) => /^xl\/media\//.test(key)).length;

  const dropped: string[] = [];
  if (charts > 0) dropped.push(`${charts} chart${charts === 1 ? '' : 's'}`);
  if (images > 0) dropped.push(`${images} image${images === 1 ? '' : 's'}`);

  const notes = [
    `${withContent.length} sheet${withContent.length === 1 ? '' : 's'} laid out as tables, in this tab. The workbook was never uploaded.`,
    'Formula results are the values Excel itself calculated and stored — nothing here re-computed them, so they match what you last saw. Number formats, dates and currency symbols are reproduced as the sheet displays them.',
  ];

  if (hidden > 0) {
    notes.push(
      `${hidden} hidden sheet${hidden === 1 ? ' was' : 's were'} left out, the same as Excel does when printing.`
    );
  }

  if (dropped.length > 0) {
    notes.push(`Not carried over: ${dropped.join(' and ')}. Those are drawings, not cells.`);
  }

  if (overflowed > 0) {
    notes.push(
      `${overflowed} label${overflowed === 1 ? '' : 's'} ran past ${overflowed === 1 ? 'its' : 'their'} column into the empty space beside it, exactly as Excel shows them.`
    );
  }

  const fallback = painter.note();
  if (fallback) notes.push(fallback);

  notes.push('Wide sheets continue across pages by column band rather than being cropped.');

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: doc.getPageCount(),
    durationMs: performance.now() - started,
    summary: `${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'} from ${withContent.length} sheet${withContent.length === 1 ? '' : 's'}`,
    notes,
  };
}
