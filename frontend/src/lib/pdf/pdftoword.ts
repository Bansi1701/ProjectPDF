/**
 * PDF → Word (.docx), in the browser.
 *
 * This is the conversion everybody wants and nobody can do honestly, because
 * the two formats disagree about what a document is. A .docx is a stream of
 * paragraphs that Word re-flows onto whatever page it is given. A PDF is the
 * finished picture: glyphs at coordinates, with the paragraphs already
 * dissolved into it. Going the other way is not parsing, it is reconstruction
 * — and reconstruction is guesswork wearing a suit.
 *
 * The usual answer is pdf2docx, which reads as MIT and pins AGPL PyMuPDF, so
 * it is not an answer here. What is left is to do the inference deliberately,
 * keep the parts that are actually recoverable, and say out loud which is
 * which. pagetext.ts does the reading and the geometry; ooxmlwrite.ts does the
 * OOXML; this file is the judgement in between, plus the notes that admit to
 * it.
 *
 * The line that matters: font size, emphasis, page size and the words are READ
 * from the file. Paragraph boundaries, headings, lists, tables, alignment and
 * margins are INFERRED from where things sit. Everything in `notes` exists to
 * keep a user from mistaking the second list for the first.
 */
import {
  TABLE_CONFIDENCE_FLOOR,
  readDocumentStructure,
  toLines,
  type DocumentStructure,
  type PageStructure,
  type Paragraph,
  type TableBlock,
  type TextLine,
  type TextRun,
} from './pagetext';
import {
  buildDocx,
  type DocxBlock,
  type DocxPage,
  type DocxRun,
  type DocxTable,
  type DocxTableCell,
} from './ooxmlwrite';
import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ── fonts ───────────────────────────────────────────────────────────────

/**
 * PostScript names to families Word can actually resolve.
 *
 * A PDF names its fonts the way the typesetter embedded them — `ArialMT`,
 * `TimesNewRomanPSMT`, `LiberationSerif-Regular` — and none of those are
 * installed on a Windows machine. Handing one straight to `w:rFonts` gets
 * silent substitution with whatever Word picks, which is usually not the
 * nearest thing. Naming the family it was cloned from is closer, and the
 * open-source metric clones (Liberation, Nimbus, Carlito, Caladea, Arimo,
 * Tinos, Cousine) exist precisely to stand in for a specific commercial face,
 * so mapping them back is a fact rather than a guess.
 */
const FONT_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(arial|helvetica|liberationsans|nimbussans|arimo|freesans)/, 'Arial'],
  [/^(times|liberationserif|nimbusroman|tinos|freeserif)/, 'Times New Roman'],
  [/^(courier|liberationmono|nimbusmono|cousine|freemono)/, 'Courier New'],
  [/^(calibri|carlito)/, 'Calibri'],
  [/^(cambria|caladea)/, 'Cambria'],
  [/^consolas/, 'Consolas'],
  [/^segoeui/, 'Segoe UI'],
  [/^georgia/, 'Georgia'],
  [/^(garamond|egaramond|adobegaramond)/, 'Garamond'],
  [/^(verdana|dejavusans)/, 'Verdana'],
  [/^tahoma/, 'Tahoma'],
  [/^trebuchet/, 'Trebuchet MS'],
  [/^(palatino|bookantiqua|urwpalladio)/, 'Palatino Linotype'],
  [/^(bookman|urwbookman)/, 'Bookman Old Style'],
  [/^(century|schoolbook)/, 'Century Schoolbook'],
  [/^(cmr|cmu|computermodern|latinmodern|lmroman)/, 'Cambria'],
];

interface FontChoice {
  name: string;
  /** The PDF named a face we recognised, rather than us falling back on shape. */
  matched: boolean;
  /** The dominant PostScript name, for the note. '' when none was resolvable. */
  original: string;
}

/**
 * The one family the whole document is set in.
 *
 * One font, not one per run: the docx model here has a single `rFonts` in
 * `docDefaults`, and a document that switches family every other run because
 * a subset tag differed is worse than one that is uniformly close.
 */
function pickFont(pages: PageStructure[]): FontChoice {
  const weights = new Map<string, number>();
  let serif = 0;
  let monospace = 0;
  let total = 0;

  for (const page of pages) {
    for (const line of page.lines) {
      for (const run of line.runs) {
        if (run.spacer) continue;
        // Weighted by characters, so a 40pt cover title does not outvote the
        // body text it sits above.
        const weight = run.text.length;
        total += weight;
        if (run.serif) serif += weight;
        if (run.monospace) monospace += weight;
        if (run.fontName) weights.set(run.fontName, (weights.get(run.fontName) ?? 0) + weight);
      }
    }
  }

  let original = '';
  let best = 0;
  for (const [name, weight] of weights) {
    if (weight > best) {
      best = weight;
      original = name;
    }
  }

  // Strip the weight suffix as well as the punctuation: `Arial-BoldMT` and
  // `ArialMT` are the same family and must not vote separately.
  const key = original.toLowerCase().replace(/[^a-z]/g, '');
  for (const [pattern, family] of FONT_ALIASES) {
    if (pattern.test(key)) return { name: family, matched: true, original };
  }

  if (total > 0 && monospace / total > 0.6) return { name: 'Courier New', matched: false, original };
  if (total > 0 && serif / total > 0.5) return { name: 'Times New Roman', matched: false, original };
  return { name: 'Arial', matched: false, original };
}

// ── page geometry ───────────────────────────────────────────────────────

/**
 * Below a quarter of an inch is inside most printers' unprintable border, and
 * above an inch and a half the reconstruction has stopped being a margin and
 * started being a design decision we have no business making.
 */
const MIN_MARGIN = 18;
const MAX_MARGIN = 108;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

interface Geometry {
  page: DocxPage;
  /** The document mixes page sizes; only the commonest one is honoured. */
  sizesVary: boolean;
}

/**
 * Page size is read; margins are measured.
 *
 * A PDF records no margins at all — there is only the page box and wherever
 * the ink happens to start. So the margins here are the smallest rectangle the
 * body text sits inside, taken as a median across pages rather than a minimum,
 * because one page with a full-bleed rule or a wide table would otherwise pull
 * the whole document's margins to nothing.
 *
 * Running heads and folios are excluded from the measurement for the same
 * reason they are dropped below: they sit in the margin by definition, and
 * counting them would produce a document with no margin at all.
 */
function pageGeometry(pages: PageStructure[]): Geometry {
  const counts = new Map<string, { width: number; height: number; count: number }>();
  for (const page of pages) {
    const key = `${Math.round(page.width)}x${Math.round(page.height)}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { width: page.width, height: page.height, count: 1 });
  }

  let dominant = { width: 595.28, height: 841.89, count: 0 };
  for (const size of counts.values()) if (size.count > dominant.count) dominant = size;

  const lefts: number[] = [];
  const rights: number[] = [];
  const tops: number[] = [];
  const bottoms: number[] = [];

  for (const page of pages) {
    if (Math.round(page.width) !== Math.round(dominant.width)) continue;
    if (Math.round(page.height) !== Math.round(dominant.height)) continue;

    const body = page.blocks.filter((block) => block.kind !== 'running');
    if (body.length === 0) continue;

    lefts.push(Math.min(...body.map((block) => block.x)));
    rights.push(page.width - Math.max(...body.map((block) => block.right)));
    tops.push(Math.min(...body.map((block) => block.top)));
    bottoms.push(page.height - Math.max(...body.map((block) => block.bottom)));
  }

  const clamp = (value: number): number =>
    Math.round(Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, value)));

  return {
    page: {
      width: dominant.width,
      height: dominant.height,
      margin: {
        top: clamp(median(tops)),
        right: clamp(median(rights)),
        bottom: clamp(median(bottoms)),
        left: clamp(median(lefts)),
      },
    },
    sizesVary: counts.size > 1,
  };
}

// ── runs ────────────────────────────────────────────────────────────────

/** Matches pagetext's own threshold, so a run boundary lands where its text says it does. */
const SPACE_GAP = 0.18;

/** Two sizes within this are the same size; PDFs report 11.04pt for 11pt text. */
const SAME_SIZE = 0.25;

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
}

/**
 * One line's runs, merged into stretches that share an appearance.
 *
 * The space rules mirror `joinRuns` in pagetext.ts deliberately: that function
 * produces `line.text`, and if this one spaced words differently then the .docx
 * would disagree with the text the same module reports for word counts and OCR
 * sniffing. The difference is only that emphasis survives here, which is the
 * whole reason for not simply taking `line.text`.
 */
function lineSegments(line: TextLine): Segment[] {
  const out: Segment[] = [];
  let right = Number.NaN;
  let pending = false;

  const tail = (): string => out[out.length - 1]?.text ?? '';

  const push = (text: string, run: TextRun): void => {
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      Math.abs(last.size - run.fontSize) < SAME_SIZE
    ) {
      last.text += text;
      return;
    }
    out.push({ text, bold: run.bold, italic: run.italic, size: run.fontSize });
  };

  for (const run of line.runs) {
    // A glyph drawn without advancing the pen is a decoration sitting on the
    // text, not part of it — a bullet, a tick, an overstruck accent.
    if (!run.spacer && run.right - run.x < 0.5) {
      push((out.length > 0 && !/\s$/.test(tail()) ? ' ' : '') + run.text, run);
      pending = true;
      continue;
    }

    if (run.spacer) {
      // Worth exactly one space: a 40pt tab is not forty of them.
      pending = true;
      right = Number.isNaN(right) ? run.right : Math.max(right, run.right);
      continue;
    }

    const gap = Number.isNaN(right) ? 0 : run.x - right;
    const space = out.length > 0 && (pending || gap > run.fontSize * SPACE_GAP) && !/\s$/.test(tail());
    push((space ? ' ' : '') + run.text, run);
    right = run.right;
    pending = false;
  }

  return out;
}

/** A hyphen at a line end, with a lower-case word continuing under it. */
const SOFT_HYPHEN_END = /(\p{Ll})[-‐]$/u;

interface Flow {
  segments: Segment[];
  dehyphenated: number;
}

/**
 * A block's lines, welded back into one flowing paragraph.
 *
 * Every line break inside a PDF paragraph is a typesetting artefact — the
 * author never typed it — so they all become spaces. The exception is a word
 * the typesetter split across the break: joining "govern-" and "ment" with a
 * space produces a word that does not exist. The lower-case test is what keeps
 * "well-known" and "COVID-19" intact, since a real compound almost never has a
 * capital or a digit on the far side of a line break.
 */
function flowLines(lines: TextLine[]): Flow {
  const segments: Segment[] = [];
  let dehyphenated = 0;

  for (const line of lines) {
    const parts = lineSegments(line);
    if (parts.length === 0) continue;

    const last = segments[segments.length - 1];
    if (last) {
      const broken = SOFT_HYPHEN_END.exec(last.text);
      if (broken && /^\p{Ll}/u.test(parts[0].text)) {
        last.text = last.text.slice(0, -1);
        dehyphenated += 1;
      } else if (!/\s$/.test(last.text) && !/^\s/.test(parts[0].text)) {
        last.text += ' ';
      }
    }

    for (const part of parts) {
      const previous = segments[segments.length - 1];
      if (
        previous &&
        previous.bold === part.bold &&
        previous.italic === part.italic &&
        Math.abs(previous.size - part.size) < SAME_SIZE
      ) {
        previous.text += part.text;
      } else {
        segments.push({ ...part });
      }
    }
  }

  return { segments, dehyphenated };
}

/**
 * Sizes outside this are not typography.
 *
 * A glyph drawn without advancing the pen — the bullet a resume builder places
 * on top of its text — reports a fraction of a point, and copying that into
 * `w:sz` sets the run to half a point and makes it invisible in Word. The
 * ceiling catches the mirror case, a decorative capital scaled by the text
 * matrix. Both inherit the document default instead.
 */
const MIN_RUN_SIZE = 5;
const MAX_RUN_SIZE = 96;

/**
 * Segments to Word runs.
 *
 * `size` is emitted only where it differs from the document default, so a
 * normal paragraph inherits `docDefaults` and a user changing the body size in
 * Word gets what they expect instead of a document pinned run by run. Headings
 * pass `body: null`, which suppresses sizes entirely — their size belongs to
 * the built-in Heading style, and an explicit `w:sz` on the run would override
 * it and quietly break the outline's visual hierarchy.
 */
function toDocxRuns(segments: Segment[], body: number | null): DocxRun[] {
  const runs: DocxRun[] = [];

  for (const segment of segments) {
    if (!segment.text) continue;
    const run: DocxRun = { text: segment.text };
    if (segment.bold) run.bold = true;
    if (segment.italic) run.italic = true;
    if (
      body !== null &&
      segment.size >= MIN_RUN_SIZE &&
      segment.size <= MAX_RUN_SIZE &&
      Math.abs(segment.size - body) >= 0.75
    ) {
      run.size = Math.round(segment.size * 2) / 2;
    }
    runs.push(run);
  }

  return runs;
}

/**
 * Removes a list marker from the front of a block's text.
 *
 * `Paragraph.text` comes with the marker already stripped, but `Paragraph.lines`
 * — which is what has to be walked to keep bold and italic — still contains the
 * glyph. Without this the bullet is written twice: once as the marker and once
 * as the first character of the text under it.
 *
 * Returns the separator that followed the marker — "." or ")" for an ordered
 * item, an empty string for a bullet — or null when the marker is not there to
 * remove at all, which happens when the bullet was a drawn path rather than a
 * character. The caller adds its own either way, so a null is not a failure.
 */
function dropMarker(segments: Segment[], marker: string): string | null {
  const joined = segments.map((segment) => segment.text).join('');
  const lead = joined.length - joined.trimStart().length;
  if (!joined.startsWith(marker, lead)) return null;

  let remove = lead + marker.length;

  // An ordered marker's separator is not part of the marker pagetext reports:
  // "3. Market size" yields marker "3", so the "." is still sitting at the head
  // of the text. Left there, the item is rebuilt as "3<tab>. Market size" —
  // every numbered item in every converted document carrying a stray full stop
  // after the tab. Take the separator with the number it belongs to.
  let separator = '';
  if (remove < joined.length && /[.)\]:]/.test(joined[remove])) {
    separator = joined[remove];
    remove += 1;
  }

  while (remove < joined.length && /\s/.test(joined[remove])) remove += 1;

  for (const segment of segments) {
    if (remove <= 0) break;
    const take = Math.min(remove, segment.text.length);
    segment.text = segment.text.slice(take);
    remove -= take;
  }

  return separator;
}

// ── tables ──────────────────────────────────────────────────────────────

/** A cell whose text is a quantity rather than a label. */
const NUMERIC_CELL = /^[^\p{L}]*\p{Nd}[\p{Nd}\s.,%()+\-–−$€£¥]*$/u;

/**
 * Is row 0 a header?
 *
 * Bold across the row is the strong signal and is taken on its own. Failing
 * that, a header is the row of words sitting above rows of numbers — which
 * only means anything if there are numbers below it, hence the count.
 */
function hasHeaderRow(table: TableBlock): boolean {
  const first = table.rows[0];
  const rest = table.rows.slice(1);
  if (!first || rest.length === 0) return false;

  const inked = first.filter((cell) => cell.text.trim().length > 0);
  if (inked.length === 0) return false;

  if (inked.every((cell) => cell.runs.some((run) => !run.spacer && run.bold))) return true;

  const numeric = (text: string): boolean => NUMERIC_CELL.test(text.trim());
  if (inked.some((cell) => numeric(cell.text))) return false;

  const below = rest.reduce(
    (count, row) => count + row.filter((cell) => numeric(cell.text)).length,
    0
  );
  return below >= rest.length;
}

function toDocxTable(table: TableBlock, body: number): DocxTable {
  const rows: DocxTableCell[][] = table.rows.map((row) =>
    row.map((cell) => {
      // The cell's runs are re-lined rather than taking `cell.text`, so a
      // two-line cell wraps as two lines' worth of words and its emphasis
      // survives — `cell.text` is already flattened to a string.
      const { segments } = flowLines(toLines(cell.runs));
      return { runs: toDocxRuns(segments, body) };
    })
  );

  return {
    type: 'table',
    rows,
    headerRow: hasHeaderRow(table),
    // Column widths are the only part of the original grid that is measurable
    // rather than inferred: they are where the text actually sits.
    columnWeights: table.columns.map((column) => Math.max(1, column.right - column.x)),
  };
}

// ── assembly ────────────────────────────────────────────────────────────

/**
 * A gap this many times the body size is a section break the author put there,
 * not paragraph leading. The docx model has no per-paragraph spacing, so the
 * only way to keep it is an empty paragraph.
 */
const SECTION_GAP = 2.2;

/** A `running` block longer than this is body text the detector mislabelled. */
const RUNNING_MAX_CHARS = 120;

interface Tally {
  headings: number;
  paragraphs: number;
  listItems: number;
  tables: number;
  /** Grids that scored below the floor and came out as tab-separated lines. */
  demoted: number;
  running: number;
  dehyphenated: number;
  /** Blank pages after the last page with anything on it. */
  trailingBlank: number;
}

function assemble(structure: DocumentStructure, body: number): { blocks: DocxBlock[]; tally: Tally } {
  const blocks: DocxBlock[] = [];
  const tally: Tally = {
    headings: 0,
    paragraphs: 0,
    listItems: 0,
    tables: 0,
    demoted: 0,
    running: 0,
    dehyphenated: 0,
    trailingBlank: 0,
  };

  // Page breaks are counted rather than flagged, because a PDF page that
  // contributes nothing still has to push the next one onto a fresh sheet —
  // otherwise a deliberately blank page silently disappears from the middle of
  // the document.
  let pending = 0;
  let first = true;

  /** Emits a block, spending any page breaks that are owed first. */
  const emit = (block: DocxBlock): void => {
    // A paragraph can carry the last break itself. A table has nowhere to put
    // one, so it gets an empty paragraph to hang it on.
    const carries = block.type === 'paragraph' ? 1 : 0;
    while (pending > carries) {
      blocks.push({ type: 'paragraph', runs: [], pageBreakBefore: true });
      pending -= 1;
    }
    if (pending === 1 && block.type === 'paragraph') {
      block.pageBreakBefore = true;
      pending = 0;
    }
    blocks.push(block);
  };

  for (const page of structure.pages) {
    if (!first) pending += 1;
    first = false;

    for (const block of page.blocks) {
      if (block.kind === 'table') {
        // Below the floor this is a guess, and a wrong table is far harder to
        // undo in Word than a run of tab-separated lines is to turn into one.
        if (block.confidence < TABLE_CONFIDENCE_FLOOR) {
          tally.demoted += 1;
          for (const row of block.rows) {
            const text = row.map((cell) => cell.text).join('\t').replace(/\t+$/, '');
            if (!text.trim()) continue;
            emit({ type: 'paragraph', runs: [{ text }] });
            tally.paragraphs += 1;
          }
          continue;
        }

        emit(toDocxTable(block, body));
        tally.tables += 1;
        continue;
      }

      const paragraph: Paragraph = block;

      // A running head is dropped: this writer has no header/footer part, and
      // "Page 3 of 12" landing in the middle of the body reads as a mistake.
      // The length guard is because the detector matches on position and
      // digit-folded text, so a body line that happens to repeat near the top
      // of most pages can be caught by it — and deleting a real paragraph is a
      // far worse failure than keeping a stray folio.
      if (paragraph.kind === 'running' && paragraph.text.trim().length <= RUNNING_MAX_CHARS) {
        tally.running += 1;
        continue;
      }

      const { segments, dehyphenated } = flowLines(paragraph.lines);
      tally.dehyphenated += dehyphenated;

      const marker = paragraph.kind === 'list-item' ? paragraph.marker : null;
      // The separator travels with the number it belongs to, so the rebuilt
      // item reads "3." and not "3" with a stray "." after the tab.
      const separator = marker ? (dropMarker(segments, marker) ?? '') : '';

      if (segments.every((segment) => !segment.text.trim())) continue;

      const heading = paragraph.kind === 'heading';
      const runs = toDocxRuns(segments, heading ? null : body);
      if (runs.length === 0) continue;

      if (marker) {
        // No numbering.xml here, so the bullet or the number comes back as
        // literal text followed by a tab. It looks like a list and behaves like
        // a sentence; the notes say so.
        runs.unshift({ text: `${marker}${separator}\t` });
        tally.listItems += 1;
      } else if (heading) {
        tally.headings += 1;
      } else {
        tally.paragraphs += 1;
      }

      if (!heading && paragraph.spaceBefore > body * SECTION_GAP && blocks.length > 0 && pending === 0) {
        blocks.push({ type: 'paragraph', runs: [] });
      }

      emit({
        type: 'paragraph',
        runs,
        heading: heading ? paragraph.level : undefined,
        align: paragraph.align,
      });
    }
  }

  tally.trailingBlank = pending;
  return { blocks, tally };
}

// ── the operation ───────────────────────────────────────────────────────

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

export async function pdfToWord(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to convert.' };

  const started = performance.now();

  // Detaches `file.bytes`, and captures its length first — nothing may read
  // the buffer after this line.
  const read = await readDocumentStructure(file.bytes);
  if (!read.ok) return { ok: false, error: read.error };

  const structure = read.document;

  // A page with no text layer is a picture of a page. `readDocumentStructure`
  // already refuses a document that is nothing but those; this catches the
  // mixed case — a scan with a typed cover sheet, or a few pages stamped with
  // a page number — where converting would produce a document that looks
  // complete and has lost most of its content.
  const blank = structure.pages.filter((page) => page.empty).length;
  if (structure.pages.length >= 3 && blank / structure.pages.length >= 0.6) {
    return {
      ok: false,
      error:
        `${blank} of this PDF's ${structure.pages.length} pages are images with no text in them, so most of the document cannot be read as words. ` +
        'Run it through the OCR tool first — that turns the pictures into text — then convert the result.',
    };
  }

  const font = pickFont(structure.pages);
  const geometry = pageGeometry(structure.pages);
  const body = Math.round(structure.bodyFontSize * 2) / 2;
  const { blocks, tally } = assemble(structure, body);

  if (blocks.length === 0) {
    return { ok: false, error: 'Nothing in this PDF came through as text worth converting.' };
  }

  let bytes: Uint8Array;
  try {
    bytes = buildDocx({ blocks, page: geometry.page, font: font.name, size: body });
  } catch (error) {
    return { ok: false, error: `This document could not be written: ${(error as Error).message}` };
  }

  // ── the honesty contract ───────────────────────────────────────────────
  // A PDF has no paragraphs, no headings and no tables. Everything structural
  // below the first note is something this converter decided, and a user who
  // does not know that will trust the wrong half of the result.

  const notes: string[] = [
    'Converted here, in this tab. The PDF was never uploaded.',
    'Read from the file: the words, their font size, bold and italic, the page size, and where the text sits on each page.',
  ];

  const inferred: string[] = [
    'where each paragraph begins and ends',
    'which lines are headings',
    'the margins, which a PDF does not record at all',
  ];
  if (tally.listItems > 0) inferred.push('which paragraphs are list items');
  if (tally.tables > 0 || tally.demoted > 0) inferred.push('which blocks are tables');
  inferred.push('the alignment of each paragraph');

  // Below the refusal threshold these pages still convert — to empty ones. The
  // notes list is otherwise exhaustive, which is exactly what makes leaving
  // this out read as coverage: two scanned signature pages in the middle of a
  // ten-page contract arrive blank with nothing to say why.
  if (blank > 0) {
    notes.push(
      `${blank} page${blank === 1 ? ' is' : 's are'} an image with no text layer, so ${blank === 1 ? 'it came' : 'they came'} across blank. Run the original through OCR first if you need what is on ${blank === 1 ? 'it' : 'them'}.`
    );
  }

  notes.push(
    `Inferred, not read: ${inferred.join(', ')}. A PDF stores glyphs at coordinates — the structure was reconstructed from size, position and spacing, so check anything that matters.`
  );

  const carried = [plural(tally.headings, 'heading'), plural(tally.paragraphs, 'paragraph')];
  if (tally.listItems > 0) carried.push(plural(tally.listItems, 'list item'));
  if (tally.tables > 0) carried.push(plural(tally.tables, 'table'));
  notes.push(
    `Carried across: ${carried.join(', ')} over ${plural(structure.pages.length, 'page')}. Headings use Word's built-in styles, so they appear in the Navigation Pane.`
  );

  if (tally.demoted > 0) {
    notes.push(
      `${plural(tally.demoted, 'block')} looked like a grid but scored too low to be trusted as one, so ${tally.demoted === 1 ? 'it came' : 'they came'} across as tab-separated lines instead. A wrong table is much harder to undo in Word than plain text is to turn into one.`
    );
  }

  if (tally.tables > 0) {
    notes.push(
      'Table cells hold one paragraph each. Merged cells, cell shading and the original borders are not recovered — only the grid, its column widths and the text in it.'
    );
  }

  if (tally.listItems > 0) {
    notes.push(
      'List items come across as ordinary paragraphs starting with their bullet or number as literal text — not Word list formatting, so Word will not renumber them. Indentation is not carried either, so nested lists come back flush with the margin.'
    );
  }

  if (tally.running > 0) {
    notes.push(
      `${plural(tally.running, 'repeated page header or footer', 'repeated page headers and footers')} — the same line in the same margin on most pages — ${tally.running === 1 ? 'was' : 'were'} left out. Word keeps those in a header area this converter does not write, and repeating them mid-document would read as body text.`
    );
  }

  const margin = geometry.page.margin;
  notes.push(
    `Page size ${Math.round(geometry.page.width)}×${Math.round(geometry.page.height)}pt was read from the PDF. The margins (${margin.top}/${margin.right}/${margin.bottom}/${margin.left}pt) are measured from where the text sits, which is the closest a PDF can get to recording them.`
  );

  if (geometry.sizesVary) {
    notes.push(
      'This PDF mixes page sizes. A .docx has one page size for the whole document, so the commonest one was used and the rest will re-flow onto it.'
    );
  }

  notes.push(
    `Each PDF page starts a new page in Word, but the text within it is re-flowed: Word breaks lines itself, so they will not fall where they did in the PDF.${tally.dehyphenated > 0 ? ` ${plural(tally.dehyphenated, 'word')} split across a line break ${tally.dehyphenated === 1 ? 'was' : 'were'} rejoined.` : ''}`
  );

  notes.push(
    `Set in ${font.name} throughout${font.matched && font.original ? `, matched from the ${font.original} the PDF names most` : ', chosen to match the shape of the original since the PDF does not name a font Word can resolve'}. The original's own fonts are not carried, so spacing and line lengths will differ.`
  );

  notes.push(
    'Not carried over: images, drawn lines and shapes, background colour, text colour, underline and strikethrough, links, form fields, footnote links, and anything printed sideways. This reads the text layer, not the appearance of the page.'
  );

  if (tally.trailingBlank > 0) {
    notes.push(
      `${plural(tally.trailingBlank, 'blank page')} at the end of the PDF ${tally.trailingBlank === 1 ? 'was' : 'were'} not carried over.`
    );
  }

  // pagetext's own caveats last: unreadable pages, columns, sideways text and
  // the bad-OCR warning are all things it is better placed to judge than this
  // file is, and it already writes them as user-facing prose.
  notes.push(...structure.notes);

  const summary =
    tally.tables > 0
      ? `${plural(tally.paragraphs + tally.headings + tally.listItems, 'paragraph')} and ${plural(tally.tables, 'table')} from ${plural(structure.pages.length, 'page')}`
      : `${plural(tally.paragraphs + tally.headings + tally.listItems, 'paragraph')} from ${plural(structure.pages.length, 'page')}`;

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}.docx`, bytes, type: DOCX_MIME }],
    bytesIn: structure.bytesIn,
    bytesOut: bytes.length,
    pages: structure.pageCount,
    durationMs: performance.now() - started,
    summary,
    notes,
  };
}
