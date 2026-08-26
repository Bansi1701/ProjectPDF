/**
 * PDF → Excel.
 *
 * A PDF has no tables in it. It has glyphs at coordinates, and a table is
 * something a reader infers from the fact that they line up. pagetext.ts does
 * that inference and — the part that matters here — reports how sure it is.
 * This file's job is to turn the sure ones into a workbook and to be plain
 * about the rest, because a spreadsheet is a document people do arithmetic on.
 * A wrong number in a cell does not look wrong; it looks like a number. That
 * asymmetry is why the default here is to leave a doubtful grid out and say so
 * rather than ship it and hope.
 *
 * **One sheet per table, not per page and not per document.** A sheet's whole
 * value is that column B means one thing all the way down — that is what lets
 * you sort, filter and sum it. Two tables that happen to share a page almost
 * never share a column structure, so stacking them makes a sheet where B is a
 * date in the top half and a price in the bottom, which is worse than useless.
 * The one exception is the case that is genuinely one table: a long grid
 * continued over a page break, with the same columns in the same places. Those
 * are stitched back together, since splitting them would be the same mistake
 * in the other direction.
 *
 * Numbers are written as numbers. A spreadsheet whose money column is text is
 * not a spreadsheet, it is a screenshot — so `$18,430.50`, `(2,100)` and `12%`
 * are parsed into values Excel can add. Everything that does not parse cleanly
 * stays text, which is the safe direction: text that should have been a number
 * is visibly wrong, and a number that should have been text is not.
 */
import {
  buildXlsx,
  dateToSerial,
  type XlsxCell,
  type XlsxNumberFormat,
  type XlsxSheet,
} from './ooxmlwrite';
import {
  readDocumentStructure,
  TABLE_CONFIDENCE_FLOOR,
  type TableBlock,
  type TableCell,
} from './pagetext';
import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── reading a cell's value ──────────────────────────────────────────────

/**
 * What one cell of text turned out to be.
 *
 * `format` is only ever set alongside a number; Excel ignores a number format
 * on text, and saying so here keeps the two from drifting apart.
 */
export interface TypedValue {
  value: string | number | null;
  format?: XlsxNumberFormat;
  /** Why it is what it is — the caller counts these to write its notes. */
  kind: 'empty' | 'text' | 'number' | 'percent' | 'date' | 'ambiguous-date';
}

/**
 * Currency symbols that may sit against a number.
 *
 * Three-letter codes (`12.50 USD`) are deliberately not in here. They are
 * indistinguishable from a unit — `12.50 EUR` and `12.50 KWH` are the same
 * shape — and a unit is part of the value, not decoration around it.
 */
const CURRENCY = '$€£¥₹₩₪₫₽₴₺₦₱฿';
const LEADING_CURRENCY = new RegExp(`^[A-Za-z]{0,3}[${CURRENCY}]\\s*`);
const TRAILING_CURRENCY = new RegExp(`\\s*[${CURRENCY}]$`);

/** ISO dates only. See `readCellValue` for why nothing with slashes qualifies. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `3/4/2026` — recognised so it can be reported, never so it can be converted. */
const SLASH_DATE = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;

/**
 * Beyond this many significant digits a double stops being able to hold the
 * number exactly, and a 16-digit card or account number would come back with
 * its last digits changed. Silently altering digits is the one failure mode
 * worth refusing outright, so those stay text.
 */
const MAX_SIGNIFICANT_DIGITS = 15;

/**
 * A run of bare digits this long is an identifier, not a quantity. Nobody
 * writes a number they intend to add up without separators past a billion.
 */
const IDENTIFIER_DIGITS = 12;

/** Splits the digits from the separators, or returns null if it is not a number. */
function parseNumeric(body: string): { value: number; decimals: number; grouped: boolean } | null {
  if (!/^\d[\d., ]*\d$|^\d$/.test(body)) return null;

  const dots = (body.match(/\./g) ?? []).length;
  const commas = (body.match(/,/g) ?? []).length;
  const spaces = (body.match(/ /g) ?? []).length;

  // A space is only ever a group separator, so it has to group in threes.
  // `1 555 123 4567` fails here, which is the point: it is a phone number.
  if (spaces > 0 && !/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(body)) return null;
  const spaceless = body.replace(/ /g, '');

  let decimalSeparator: '.' | ',' | null = null;
  let groupSeparator: '.' | ',' | null = null;

  if (dots > 0 && commas > 0) {
    // Both present: whichever comes last is the decimal point, and the other
    // has to be grouping in threes or this is not a number at all.
    decimalSeparator = spaceless.lastIndexOf('.') > spaceless.lastIndexOf(',') ? '.' : ',';
    groupSeparator = decimalSeparator === '.' ? ',' : '.';
  } else if (commas > 1) {
    groupSeparator = ',';
  } else if (dots > 1) {
    // `1.234.567` can only be grouping — no number has two decimal points.
    groupSeparator = '.';
  } else if (commas === 1) {
    // `1,234` groups; `12,5` is the continental decimal comma. The second is
    // genuinely ambiguous against an English reading, so it is left as text
    // rather than guessed at.
    if (/^\d{1,3},\d{3}$/.test(spaceless)) groupSeparator = ',';
    else return null;
  } else if (dots === 1) {
    // One dot is a decimal point. `1.234` meaning 1234 exists in continental
    // documents, but the same string is a perfectly ordinary English decimal,
    // and there is nothing on the page to break the tie.
    decimalSeparator = '.';
  }

  if (groupSeparator) {
    const escaped = groupSeparator === '.' ? '\\.' : ',';
    const decimal = decimalSeparator === groupSeparator ? null : decimalSeparator;
    const tail = decimal ? `(${decimal === '.' ? '\\.' : ','}\\d+)?` : '';
    if (!new RegExp(`^\\d{1,3}(${escaped}\\d{3})+${tail}$`).test(spaceless)) return null;
  }

  const stripped = groupSeparator ? spaceless.split(groupSeparator).join('') : spaceless;
  const normalised = decimalSeparator === ',' ? stripped.replace(',', '.') : stripped;

  const [whole, fraction = ''] = normalised.split('.');

  // `007` and `0123` are identifiers whose leading zeros carry meaning, and a
  // numeric cell throws them away.
  if (whole.length > 1 && whole.startsWith('0')) return null;

  const significant = whole.replace(/^0+/, '').length + fraction.length;
  if (significant > MAX_SIGNIFICANT_DIGITS) return null;
  if (!groupSeparator && !fraction && whole.length >= IDENTIFIER_DIGITS) return null;

  const value = Number(normalised);
  if (!Number.isFinite(value)) return null;

  return { value, decimals: fraction.length, grouped: Boolean(groupSeparator) || spaces > 0 };
}

/**
 * Reads one cell of extracted text as a value.
 *
 * The bias throughout is towards leaving things alone. Slash dates are the
 * clearest case: `03/04/2026` is the 3rd of April in most of the world and the
 * 4th of March in the United States, the page carries nothing that says which,
 * and a date that is silently three weeks out is not something anyone catches
 * by looking. So those stay text, and the caller says so.
 */
export function readCellValue(raw: string): TypedValue {
  const text = raw.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { value: null, kind: 'empty' };

  const iso = ISO_DATE.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Rejects 2026-02-31, which rolls over into March rather than failing.
    if (
      month >= 1 &&
      month <= 12 &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return { value: dateToSerial(new Date(year, month - 1, day)), format: 'date', kind: 'date' };
    }
  }

  if (SLASH_DATE.test(text)) return { value: text, kind: 'ambiguous-date' };

  let body = text;
  let negative = false;

  // Accounting negatives: `(1,234)`, and `($1,234)` with the symbol inside.
  const parenthesised = /^\((.+)\)$/.exec(body);
  if (parenthesised) {
    negative = true;
    body = parenthesised[1].trim();
  }

  // A sign and a currency symbol can come in either order — `-$5` and `$-5`
  // are both written — so each is stripped once, whichever is outermost.
  for (let pass = 0; pass < 2; pass += 1) {
    const sign = /^[-+−]\s*/.exec(body);
    if (sign) {
      if (!sign[0].startsWith('+')) negative = !negative;
      body = body.slice(sign[0].length);
      continue;
    }
    const currency = LEADING_CURRENCY.exec(body);
    if (currency) body = body.slice(currency[0].length);
    else break;
  }

  let percent = false;
  if (body.endsWith('%')) {
    percent = true;
    body = body.slice(0, -1).trim();
  }

  body = body.replace(TRAILING_CURRENCY, '').trim();

  const parsed = parseNumeric(body);
  if (!parsed) return { value: text, kind: 'text' };

  const signed = negative ? -parsed.value : parsed.value;

  if (percent) {
    // Excel stores a percentage as its fraction, which is what makes `=A1*B1`
    // mean what you expect. The built-in percent format shows whole percents
    // only, so a percentage with decimals is left unformatted rather than
    // displayed rounded to a different number than the page showed.
    const fraction = signed / 100;
    return {
      value: fraction,
      format: Number.isInteger(signed) ? 'percent' : 'general',
      kind: 'percent',
    };
  }

  // The format reproduces what the page showed as closely as the six built-in
  // codes allow. Grouping may be added or dropped — that is cosmetic — but the
  // number of digits shown never changes, because that would show a different
  // number from the one in the cell.
  const format: XlsxNumberFormat =
    parsed.decimals === 2 ? 'decimal' : parsed.decimals === 0 && parsed.grouped ? 'thousands' : 'general';

  return { value: signed, format, kind: 'number' };
}

// ── grouping tables into sheets ─────────────────────────────────────────

/** A table together with the page it sits on, which is what says where it sits. */
interface Placed {
  page: number;
  /** The page's height in points, so `top` and `bottom` can be read as fractions. */
  height: number;
  table: TableBlock;
}

/** One or more table blocks that are really one table, and where they came from. */
interface Grid {
  pages: number[];
  tables: TableBlock[];
}

const cellText = (cell: TableCell): string => cell.text.replace(/\s+/g, ' ').trim();

const rowText = (row: TableCell[]): string => row.map(cellText).join(' ');

/**
 * Whether `next` is the same table as `previous`, continued on the next page.
 *
 * Matching columns are not enough on their own. A document that prints the same
 * grid several times — an e-ticket with a passenger block per segment, an
 * invoice with a copy per recipient — has tables whose columns match perfectly
 * and which are nothing to do with each other; stitching two of those together
 * yields a sheet with every row in it twice. So the geometry has to agree as
 * well: a table only continues if it was cut off at the foot of one page and
 * picked up at the head of the next. Anything else is left as two sheets, which
 * is the recoverable mistake of the two.
 */
function continues(previous: Placed, next: Placed, tolerance: number): boolean {
  if (previous.table.columns.length !== next.table.columns.length) return false;

  const aligned = previous.table.columns.every(
    (column, index) => Math.abs(column.x - next.table.columns[index].x) <= tolerance
  );
  if (!aligned) return false;

  // Ran out of page, and resumed near the top of the next one.
  const broken =
    previous.table.bottom >= previous.height * 0.75 && next.table.top <= next.height * 0.35;
  if (!broken) return false;

  // A table does not continue by starting over. Where the candidate's first
  // row is the row that opened the table above it, this is a second copy of
  // the same grid rather than the rest of it, and joining them would put every
  // row in the sheet twice. Position cannot tell those apart — a repeated
  // block can fall at the foot of one page and the head of the next exactly as
  // a real break does — so the content has to.
  const above = previous.table.rows.map(rowText);
  const below = next.table.rows.map(rowText);
  const start = below[0] !== undefined && below[0] === above[0] ? 1 : 0;
  return below[start] === undefined || below[start] !== above[start];
}

// ── header rows ─────────────────────────────────────────────────────────

/**
 * Whether row 0 is a header rather than data.
 *
 * Two signals, either of which is enough: the row is set bold over rows that
 * are not, or it is text sitting above columns that hold numbers. The second
 * carries most of the weight, because plenty of PDFs never name their fonts
 * and pagetext.ts then has no bold to report.
 */
function looksLikeHeader(rows: TableCell[][], typed: TypedValue[][]): boolean {
  if (rows.length < 3) return false;

  const first = rows[0];
  const labelled = first.filter((cell) => cellText(cell));
  if (labelled.length < 2) return false;

  // A row of numbers is data, whatever it is sitting on top of.
  if (typed[0].some((value) => typeof value.value === 'number')) return false;

  const boldHead =
    first.every((cell) => cell.runs.length === 0 || cell.runs.every((run) => run.bold)) &&
    first.some((cell) => cell.runs.some((run) => run.bold)) &&
    rows.slice(1).some((row) => row.some((cell) => cell.runs.some((run) => !run.bold)));
  if (boldHead) return true;

  return typed.slice(1).some((row) => row.some((value) => typeof value.value === 'number'));
}

/**
 * Column headings that mean "this column holds identifiers, not quantities".
 *
 * An e-ticket number, an invoice number and an account number are all runs of
 * digits that parse perfectly well as numbers and are never added up. Storing
 * one as a number costs its leading zeros, right-aligns it against every other
 * reference on the sheet, and invites a spreadsheet to reformat it — so where
 * the table names its own column, that name is taken at its word.
 *
 * Anchored at the end so "Number of units" is still a count. The heading is the
 * only evidence available: `2416986754` on its own is indistinguishable from a
 * quantity, and this file does not guess without something to go on.
 */
const IDENTIFIER_HEADING =
  /(^|[\s(-])(no\.?|num(ber)?|nr\.?|#|id|ref(\.|erence)?|code|acc(t|ount)?|phone|tel|fax|zip|postcode|isbn|sku|serial|barcode|imei|vin)\)?$/i;

// ── counting, for the notes ─────────────────────────────────────────────

interface Tally {
  numbers: number;
  percents: number;
  dates: number;
  ambiguousDates: number;
  negatives: number;
  spans: number;
  headers: number;
  identifiers: number;
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** "4", "4 and 9", "4, 9 and 12" — a list a person would read aloud. */
function listPages(pages: number[]): string {
  if (pages.length === 1) return String(pages[0]);
  return `${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`;
}

// ── the operation ───────────────────────────────────────────────────────

export async function pdfToExcel(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  const started = performance.now();

  // Rules are what separate a table someone drew from a coincidence of
  // spacing, and they only come out of the operator list — so the font pass
  // stays on even though it costs a little.
  const read = await readDocumentStructure(file.bytes, { fonts: 'resolve' });
  if (!read.ok) return read;

  const document = read.document;

  // ── which grids are solid enough to be called tables ──────────────────
  const accepted: Placed[] = [];
  const rejected: number[] = [];

  for (const page of document.pages) {
    for (const table of page.tables) {
      if (table.confidence >= TABLE_CONFIDENCE_FLOOR) {
        accepted.push({ page: page.page, height: page.height, table });
      } else if (!rejected.includes(page.page)) {
        rejected.push(page.page);
      }
    }
  }

  if (accepted.length === 0) {
    const bare = document.pages.length;
    return {
      ok: false,
      error:
        rejected.length > 0
          ? `Nothing in this PDF was solid enough to call a table. There ${rejected.length === 1 ? 'is a grid' : 'are grids'} on page ${listPages(rejected)} that came close, but ${rejected.length === 1 ? 'its columns are' : 'their columns are'} inferred from where the text happens to line up, and ${rejected.length === 1 ? 'it did' : 'they did'} not line up well enough to be sure. A spreadsheet that looks right and is wrong is worse than one you never got. PDF → Word keeps the text where it sits on the page, so you can lay it out yourself.`
          : `No tables in this PDF. There ${bare === 1 ? 'is' : 'are'} ${plural(bare, 'page')} of text, but nothing that falls into rows and columns — and inventing a grid where there is not one would only give you a spreadsheet to un-pick. Try PDF → Word or PDF → Markdown for the text itself.`,
    };
  }

  // ── stitch tables continued across a page break ───────────────────────
  const tolerance = Math.max(4, document.bodyFontSize * 0.5);
  const grids: Grid[] = [];

  let last: Placed | null = null;

  for (const placed of accepted) {
    const open = grids[grids.length - 1];
    const adjacent = last !== null && last.page === placed.page - 1;

    if (open && last && adjacent && continues(last, placed, tolerance)) {
      open.tables.push(placed.table);
      open.pages.push(placed.page);
    } else {
      grids.push({ pages: [placed.page], tables: [placed.table] });
    }
    last = placed;
  }

  // Where a page holds several tables, "Page 4" is not a name that tells them
  // apart, so the sheet says which one it is.
  const perPage = new Map<number, number>();
  for (const grid of grids) {
    const first = grid.pages[0];
    perPage.set(first, (perPage.get(first) ?? 0) + 1);
  }
  const numbered = new Map<number, number>();

  // ── build the sheets ──────────────────────────────────────────────────
  const tally: Tally = {
    numbers: 0,
    percents: 0,
    dates: 0,
    ambiguousDates: 0,
    negatives: 0,
    spans: 0,
    headers: 0,
    identifiers: 0,
  };

  const sheets: XlsxSheet[] = [];
  let dataRows = 0;

  for (const grid of grids) {
    // A repeated header at the top of a continuation page is the same header,
    // not a row of data.
    const merged: TableCell[][] = [];
    const headSignature = rowText(grid.tables[0].rows[0] ?? []);

    grid.tables.forEach((table, index) => {
      for (const [position, row] of table.rows.entries()) {
        if (index > 0 && position === 0 && rowText(row) === headSignature) continue;
        if (row.some((cell) => cellText(cell))) merged.push(row);
      }
      // The grid reader counts cells it had to join because the inferred
      // columns did not separate them; that is the loss worth disclosing.
      tally.spans += table.evidence.collisions;

      for (const row of table.rows) {
        for (const cell of row) if (cell.span > 1) tally.spans += 1;
      }
    });

    if (merged.length === 0) continue;

    const typed = merged.map((row) => row.map((cell) => readCellValue(cellText(cell))));
    const header = looksLikeHeader(merged, typed);
    if (header) tally.headers += 1;

    // Columns the table itself declares to be references rather than figures.
    const identifiers = new Set<number>();
    if (header) {
      merged[0].forEach((cell, index) => {
        if (IDENTIFIER_HEADING.test(cellText(cell))) identifiers.add(index);
      });
    }

    const rows: XlsxCell[][] = typed.map((row, rowIndex) =>
      row.map((value, columnIndex): XlsxCell => {
        // A header cell is a label even when it reads as a number — a column
        // headed "2024" is headed with the word, not with the year.
        if (header && rowIndex === 0) {
          return { value: cellText(merged[rowIndex][columnIndex]) || null, header: true };
        }

        if (identifiers.has(columnIndex) && value.kind !== 'empty') {
          tally.identifiers += 1;
          return { value: cellText(merged[rowIndex][columnIndex]) };
        }

        if (value.kind === 'number' || value.kind === 'percent' || value.kind === 'date') {
          tally.numbers += 1;
          if (value.kind === 'percent') tally.percents += 1;
          if (value.kind === 'date') tally.dates += 1;
          if (typeof value.value === 'number' && value.value < 0) tally.negatives += 1;
        }
        if (value.kind === 'ambiguous-date') tally.ambiguousDates += 1;

        return { value: value.value, format: value.format };
      })
    );

    dataRows += header ? rows.length - 1 : rows.length;

    const columns = merged[0]?.length ?? 0;
    const widths: number[] = [];
    for (let column = 0; column < columns; column += 1) {
      let longest = 0;
      for (const row of merged) {
        const cell = row[column];
        if (cell) longest = Math.max(longest, cellText(cell).length);
      }
      widths.push(Math.min(Math.max(longest + 2, 9), 48));
    }

    const first = grid.pages[0];
    const span =
      grid.pages.length === 1 ? `Page ${first}` : `Pages ${first}–${grid.pages[grid.pages.length - 1]}`;
    const index = (numbered.get(first) ?? 0) + 1;
    numbered.set(first, index);
    const label = (perPage.get(first) ?? 1) > 1 ? `${span} table ${index}` : span;

    sheets.push({
      name: label,
      rows,
      columnWidths: widths,
      freezeHeader: header,
      // A grid this wide is unreadable down a portrait page, and the sheet
      // carries its own print setup.
      landscape: columns >= 6,
    });
  }

  if (sheets.length === 0) {
    return {
      ok: false,
      error:
        'The tables in this PDF turned out to be empty — the grid is there but the cells have no text in them. There is nothing to put in a spreadsheet.',
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = buildXlsx({ sheets });
  } catch (error) {
    // buildXlsx throws only past Excel's own grid limits, and writes its
    // message for a person to read.
    return { ok: false, error: (error as Error).message };
  }

  // ── what to tell the user ─────────────────────────────────────────────
  const tables = accepted.length;
  const pagesWithTables = new Set(accepted.map((entry) => entry.page)).size;
  const ruled = accepted.filter((entry) => entry.table.ruled).length;

  const notes: string[] = [
    `${plural(sheets.length, 'sheet')} from ${plural(tables, 'table')} across ${plural(pagesWithTables, 'page')} of the PDF, one sheet per table. Nothing was uploaded — the file was read here, in this tab.`,
  ];

  // The honesty note. This is the one that matters, and it is never omitted:
  // the site does not claim to extract tables from unruled layouts, and an
  // unruled table is what nearly every PDF actually contains.
  if (ruled === 0) {
    notes.push(
      'None of these tables are ruled — the PDF draws no lines around them — so the columns were worked out from where the text lines up on the page. That is a reading, not a fact: a column can be split in two or two run together where the spacing is unusual, and a wrapped line can land in the wrong row. Check the sheet against the page before you rely on it.'
    );
  } else if (ruled === tables) {
    notes.push(
      `${tables === 1 ? 'This table is' : 'All of these tables are'} drawn with ruling lines in the PDF, which is direct evidence of a grid rather than an inference from spacing. That is the case this tool is most confident about, but it is still worth a look before you rely on it.`
    );
  } else {
    notes.push(
      `${ruled} of the ${tables} tables are drawn with ruling lines, which is direct evidence of a grid. The other ${tables - ruled} were worked out from where the text lines up — a column there can be split in two or two run together. Check those against the page before you rely on them.`
    );
  }

  if (rejected.length > 0) {
    notes.push(
      `${rejected.length === 1 ? 'A grid' : 'Grids'} on page ${listPages(rejected)} ${rejected.length === 1 ? 'was' : 'were'} left out. The columns did not line up well enough to be sure ${rejected.length === 1 ? 'it is a table' : 'they are tables'} at all, and a spreadsheet that looks right and is wrong is worse than one that is missing something.`
    );
  }

  const stitched = grids.filter((grid) => grid.pages.length > 1);
  if (stitched.length > 0) {
    notes.push(
      `${stitched.length === 1 ? 'One table ran' : `${stitched.length} tables ran`} across a page break with the same columns in the same places, so ${stitched.length === 1 ? 'it was' : 'they were'} put back together into ${stitched.length === 1 ? 'a single sheet' : 'single sheets'} — ${stitched.map((grid) => `pages ${listPages(grid.pages)}`).join('; ')}. Repeated header rows were dropped.`
    );
  }

  if (tally.numbers > 0) {
    const detail: string[] = ['thousands separators removed'];
    if (tally.negatives > 0) detail.push('(1,234) read as a negative');
    if (tally.percents > 0) detail.push('12% stored as 0.12, the way Excel stores a percentage');
    if (tally.dates > 0) detail.push('dates written as 2026-03-14 turned into real dates');
    notes.push(
      `${plural(tally.numbers, 'cell')} came across as ${tally.numbers === 1 ? 'a number' : 'numbers'} rather than text, so ${tally.numbers === 1 ? 'it adds' : 'they add'} up: ${detail.join(', ')}. Anything that did not parse cleanly was left as text rather than guessed at.`
    );
  } else {
    notes.push(
      'Nothing in these tables parsed as a number, so every cell is text. If you expected figures, the page is probably using a separator or a currency this does not recognise.'
    );
  }

  if (tally.numbers > 0) {
    notes.push(
      'Currency symbols are gone from the cells that held them: the value is the number, and none of the built-in formats used here carry a symbol. Set a currency format on the column if you want it back.'
    );
  }

  if (tally.identifiers > 0) {
    notes.push(
      `${plural(tally.identifiers, 'cell')} stayed text because the column is headed as a reference — an account or ticket number, an ID, a phone number. Those parse as numbers perfectly well and are never added up, and storing one as a number loses its leading zeros.`
    );
  }

  if (tally.ambiguousDates > 0) {
    notes.push(
      `${plural(tally.ambiguousDates, 'cell')} like 03/04/2026 stayed text on purpose. That is the 3rd of April in most of the world and the 4th of March in the United States, nothing on the page says which, and a date silently three weeks out is not something you would catch by looking.`
    );
  }

  if (tally.headers > 0) {
    notes.push(
      `The top row of ${plural(tally.headers, 'sheet')} was read as a header — bold, shaded and frozen — because it is text sitting over columns of numbers. If that is wrong it is a formatting change, not a data one.`
    );
  }

  // `span` is never written above 1 anywhere in the repo, so the note this
  // replaced could not fire. The loss it was written to disclose is real, it
  // just happens elsewhere: two cells landing in one column are joined by the
  // table reader, which now counts them.
  const joined = tally.spans;
  if (joined > 0) {
    notes.push(
      `${plural(joined, 'cell')} had to share a column with the one beside it because the grid did not separate them cleanly, so that text is joined rather than in its own cell. Check those rows.`
    );
  }

  // Everything that is not a table is gone, and only the failure paths said so
  // before. A twenty-page report with two tables becomes a two-sheet workbook
  // and eighteen pages of prose vanish; the tool that drops the most content
  // should be the loudest about it.
  notes.push(
    'Only the tables came across. Paragraphs, headings, footnotes and images are not in this workbook — PDF to Word keeps those.'
  );

  // Forward the caveats from the read that bear on a table specifically.
  // Multi-column pages are the sharpest of them: a page cut into columns puts
  // a table's own rows in the wrong order. Sideways text matters just as much
  // here and was being filtered out: vertically-set column headers are
  // commonplace in exactly the financial tables this tool targets, and losing
  // them leaves an unlabelled header row with nothing to explain it.
  for (const note of document.notes) {
    if (/multiple columns|could not be read|poor OCR|first \d+ of|sideways/i.test(note)) {
      notes.push(note);
    }
  }

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}.xlsx`, bytes, type: XLSX_TYPE }],
    bytesIn: document.bytesIn,
    bytesOut: bytes.length,
    pages: document.pageCount,
    durationMs: performance.now() - started,
    summary: `${plural(tables, 'table')}, ${plural(dataRows, 'row')}, in ${plural(sheets.length, 'sheet')}`,
    notes,
  };
}
