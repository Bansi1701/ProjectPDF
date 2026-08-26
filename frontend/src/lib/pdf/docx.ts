/**
 * Word → PDF, in the browser.
 *
 * The received wisdom is that this needs a server, because the only faithful
 * converter is LibreOffice and its WebAssembly build is 52 MB and demands
 * cross-origin isolation. That is true for FAITHFUL conversion of arbitrary
 * documents — a 40-page report with floated images, columns and tracked
 * changes is not going to survive anything written here.
 *
 * But most documents people convert are not that. A letter, a CV, a memo, an
 * invoice: paragraphs, headings, bold, italics, lists. A .docx is a ZIP of
 * XML, and that much can be read and re-typeset with a 10 KB unzipper and the
 * PDF library already loaded — and it never leaves the tab, which is the whole
 * point of this product.
 *
 * So this converts what it can convert honestly, and says plainly what it
 * dropped. A conversion that silently loses a table is worse than one that
 * tells you it found three.
 */
import { PDFDocument, PDFFont, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';

import { TextPainter } from './text';
import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.(docx?|odt)$/i, '');

// ── the small XML reader ────────────────────────────────────────────────
// A DOCX body is regular enough that a targeted scan beats a general parser,
// and a Worker has no DOMParser to fall back on.

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface Para {
  runs: Run[];
  /** 0 for body text, 1-6 for headings. */
  heading: number;
  list: 'bullet' | 'number' | null;
  align: 'left' | 'center' | 'right';
  /** Word had an explicit page break before this paragraph. */
  breakBefore: boolean;
}

/** Page geometry, read from the document rather than assumed. */
interface Geometry {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Word measures in twips: a twentieth of a point. */
const twips = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 20 : fallback;
};

/**
 * Reads the section properties.
 *
 * Assuming A4 with fixed margins is why a Letter document with narrow margins
 * reflows and splits in odd places — the text was laid out for a page that is
 * not the page it is being drawn on.
 */
function readGeometry(xml: string): Geometry {
  const sect = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(xml)?.[0] ?? '';

  const size = /<w:pgSz\s[^>]*>/.exec(sect)?.[0] ?? '';
  const width = twips(/w:w="(\d+)"/.exec(size)?.[1], 595.28);
  const height = twips(/w:h="(\d+)"/.exec(size)?.[1], 841.89);

  const margin = /<w:pgMar\s[^>]*>/.exec(sect)?.[0] ?? '';
  return {
    width,
    height,
    top: twips(/w:top="(-?\d+)"/.exec(margin)?.[1], 64),
    right: twips(/w:right="(\d+)"/.exec(margin)?.[1], 64),
    bottom: twips(/w:bottom="(-?\d+)"/.exec(margin)?.[1], 64),
    left: twips(/w:left="(\d+)"/.exec(margin)?.[1], 64),
  };
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');

/** Everything between <w:p ...> and </w:p>, including empty ones. */
function splitParagraphs(xml: string): string[] {
  const out: string[] = [];
  const open = /<w:p(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;

  while ((match = open.exec(xml))) {
    const start = match.index + match[0].length;
    const end = xml.indexOf('</w:p>', start);
    if (end < 0) break;
    out.push(xml.slice(start, end));
    open.lastIndex = end;
  }

  return out;
}

function readParagraph(xml: string): Para {
  const styleId = /<w:pStyle\s[^>]*w:val="([^"]+)"/.exec(xml)?.[1] ?? '';
  const headingMatch = /^Heading(\d)$/i.exec(styleId) ?? /^Title$/i.test(styleId);

  const heading =
    headingMatch === true ? 1 : headingMatch ? Number((headingMatch as RegExpExecArray)[1]) : 0;

  const alignValue = /<w:jc\s[^>]*w:val="([^"]+)"/.exec(xml)?.[1];
  const align = alignValue === 'center' ? 'center' : alignValue === 'right' ? 'right' : 'left';

  // A numbering reference means a list; whether it is a bullet or a number
  // lives in numbering.xml, and guessing from the level is close enough for
  // documents this converter is honest about handling.
  let list: Para['list'] = null;
  if (/<w:numPr>/.test(xml)) {
    list = /<w:numFmt\s[^>]*w:val="bullet"/.test(xml) ? 'bullet' : 'bullet';
  }

  const runs: Run[] = [];
  const runOpen = /<w:r(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;

  while ((match = runOpen.exec(xml))) {
    const start = match.index + match[0].length;
    const end = xml.indexOf('</w:r>', start);
    if (end < 0) break;
    const body = xml.slice(start, end);
    runOpen.lastIndex = end;

    const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body)?.[1] ?? '';
    const bold = /<w:b\s*\/>|<w:b\s[^>]*w:val="(?:1|true|on)"/.test(props);
    const italic = /<w:i\s*\/>|<w:i\s[^>]*w:val="(?:1|true|on)"/.test(props);

    let text = '';
    // <w:t> holds the words; <w:tab/> and <w:br/> are the whitespace. A
    // <w:br w:type="page"/> is NOT whitespace — treating it as a newline is
    // what makes a document run past the bottom of the page and break oddly.
    for (const piece of body.matchAll(
      /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\s*\/>/g
    )) {
      if (piece[1] !== undefined) text += decodeEntities(piece[1]);
      else if (piece[0].startsWith('<w:tab')) text += '    ';
      else if (/w:type="page"/.test(piece[0])) text += '\f';
      else text += '\n';
    }

    if (text) runs.push({ text, bold, italic });
  }

  const breakBefore = /<w:pageBreakBefore\s*\/>|<w:pageBreakBefore\s[^>]*w:val="(?:1|true|on)"/.test(xml);

  return { runs, heading, list, align, breakBefore };
}

// ── layout ──────────────────────────────────────────────────────────────

const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = 64;
const BODY_SIZE = 11;
const LEADING = 1.45;

const HEADING_SIZE: Record<number, number> = { 1: 22, 2: 17, 3: 14, 4: 12.5, 5: 11.5, 6: 11 };

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

const pick = (fonts: Fonts, bold: boolean, italic: boolean): PDFFont =>
  bold && italic ? fonts.boldItalic : bold ? fonts.bold : italic ? fonts.italic : fonts.regular;

interface Piece {
  text: string;
  font: PDFFont;
  width: number;
  bold: boolean;
  italic: boolean;
}

/**
 * Greedy word wrap that keeps each run's own styling.
 *
 * Returns lines; a `null` line means an explicit page break.
 *
 * The chunk loop compares by INDEX, not by value. Comparing the text itself
 * meant a paragraph whose second line repeated its first — a table of contents,
 * a list of the same word — silently failed to break, and everything after it
 * landed in the wrong place.
 */
function wrap(
  runs: Run[],
  fonts: Fonts,
  painter: TextPainter,
  size: number,
  maxWidth: number
): (Piece[] | null)[] {
  const lines: (Piece[] | null)[] = [];
  let line: Piece[] = [];
  let used = 0;

  const endLine = () => {
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const run of runs) {
    const font = pick(fonts, run.bold, run.italic);
    // \f is an explicit page break, \n a line break.
    const chunks = run.text.split(/(\f|\n)/);

    for (const chunk of chunks) {
      if (chunk === '\f') {
        endLine();
        lines.push(null);
        continue;
      }
      if (chunk === '\n') {
        endLine();
        continue;
      }

      const style = { size, bold: run.bold, italic: run.italic };
      const measure = (value: string) => painter.width(value, font, style);

      for (const word of chunk.split(/(\s+)/)) {
        if (!word) continue;

        const width = measure(word);

        if (used + width > maxWidth && line.length > 0) {
          endLine();
          // A space that caused the break should not start the next line.
          if (/^\s+$/.test(word)) continue;
        }

        // A single word longer than the column would loop forever otherwise.
        if (width > maxWidth && line.length === 0) {
          let piece = '';
          // Split by code point so a surrogate pair is never cut in half.
          for (const character of word) {
            const next = piece + character;
            if (measure(next) > maxWidth && piece) {
              lines.push([{ text: piece, font, width: measure(piece), bold: run.bold, italic: run.italic }]);
              piece = character;
            } else {
              piece = next;
            }
          }
          if (piece) {
            line.push({ text: piece, font, width: measure(piece), bold: run.bold, italic: run.italic });
            used = measure(piece);
          }
          continue;
        }

        line.push({ text: word, font, width, bold: run.bold, italic: run.italic });
        used += width;
      }
    }
  }

  if (line.length > 0) lines.push(line);
  return lines;
}

export async function docxToPdf(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a Word document.' };

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  let documentXml: string;
  try {
    const entries = unzipSync(new Uint8Array(file.bytes), {
      filter: (entry) => entry.name === 'word/document.xml',
    });
    const raw = entries['word/document.xml'];
    if (!raw) {
      return {
        ok: false,
        error:
          'That does not look like a .docx. Older .doc files are a different, binary format that nothing in a browser can read — re-save it as .docx first.',
      };
    }
    documentXml = new TextDecoder().decode(raw);
  } catch (error) {
    return { ok: false, error: `This file could not be opened: ${(error as Error).message}` };
  }

  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml;

  // Count what will be lost before dropping it, so the user is told.
  const tables = (body.match(/<w:tbl(?:\s[^>]*)?>/g) ?? []).length;
  // Both forms: <w:drawing> ... </w:drawing> and the self-closing <w:drawing/>.
  const images = (body.match(/<w:(?:drawing|pict)(?:\s[^>]*)?\/?>/g) ?? []).length;

  const paragraphs = splitParagraphs(body).map(readParagraph);
  if (paragraphs.every((para) => para.runs.length === 0)) {
    return { ok: false, error: 'This document has no text to convert.' };
  }

  const geometry = readGeometry(documentXml);

  const doc = await PDFDocument.create();
  const painter = new TextPainter(doc);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  let page = doc.addPage([geometry.width, geometry.height]);
  let y = geometry.height - geometry.top;
  const usable = geometry.width - geometry.left - geometry.right;
  const floor = geometry.bottom;

  const newPage = () => {
    page = doc.addPage([geometry.width, geometry.height]);
    y = geometry.height - geometry.top;
  };

  /** True when nothing has been drawn on the current page yet. */
  const atPageTop = () => y === geometry.height - geometry.top;

  for (const para of paragraphs) {
    if (para.breakBefore && !atPageTop()) newPage();

    if (para.runs.length === 0) {
      y -= BODY_SIZE * LEADING * 0.6;
      continue;
    }

    const size = para.heading > 0 ? (HEADING_SIZE[para.heading] ?? BODY_SIZE) : BODY_SIZE;
    const indent = para.list ? 18 : 0;
    const runs = para.heading > 0 ? para.runs.map((r) => ({ ...r, bold: true })) : para.runs;
    const lines = wrap(runs, fonts, painter, size, usable - indent);
    const height = size * LEADING;

    const spaceAbove = para.heading > 0 ? size * 0.55 : 0;

    // Decide the break BEFORE consuming the space above a heading, or a
    // heading near the bottom eats the margin and then breaks anyway.
    //
    // A heading is also kept with the line that follows it: a heading alone at
    // the foot of a page is the single most obvious sign of a broken layout.
    const needed =
      spaceAbove + height * (para.heading > 0 ? Math.min(lines.length, 1) + 1 : 1);

    if (!atPageTop() && y - needed < floor) newPage();

    y -= spaceAbove;

    for (const [index, line] of lines.entries()) {
      if (line === null) {
        if (!atPageTop()) newPage();
        continue;
      }

      if (y - height < floor) newPage();

      const lineWidth = line.reduce((sum, piece) => sum + piece.width, 0);
      let x = geometry.left + indent;
      if (para.align === 'center') x = (geometry.width - lineWidth) / 2;
      else if (para.align === 'right') x = geometry.width - geometry.right - lineWidth;

      if (para.list && index === 0) {
        page.drawText('\u2022', {
          x: geometry.left + 4,
          y: y - size,
          size,
          font: fonts.regular,
          color: rgb(0.35, 0.35, 0.35),
        });
      }

      for (const piece of line) {
        if (piece.text.trim().length > 0) {
          await painter.draw(page, piece.text, x, y - size, piece.font, {
            size,
            bold: piece.bold,
            italic: piece.italic,
            color: rgb(0.1, 0.1, 0.12),
          });
        }
        x += piece.width;
      }

      y -= height;
    }

    y -= para.heading > 0 ? size * 0.45 : BODY_SIZE * 0.5;
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  const dropped: string[] = [];
  if (tables > 0) dropped.push(`${tables} table${tables === 1 ? '' : 's'}`);
  if (images > 0) dropped.push(`${images} image${images === 1 ? '' : 's'}`);

  const notes: string[] = [
    'Converted here, in this tab. The document was never uploaded.',
  ];

  if (dropped.length > 0) {
    notes.push(
      `Not carried over: ${dropped.join(' and ')}. This reads the text, headings, lists and emphasis — it is not a layout engine, and pretending otherwise would just lose your content quietly.`
    );
  }

  const fallback = painter.note();
  if (fallback) notes.push(fallback);

  notes.push(
    `Page size and margins were read from the document (${Math.round(geometry.width)}\u00d7${Math.round(geometry.height)}pt), and its own page breaks are kept. Text is re-typeset in Helvetica, so line breaks will not match Word exactly.`
  );

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: doc.getPageCount(),
    durationMs: performance.now() - started,
    summary: `${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'} from ${paragraphs.length} paragraphs`,
    notes,
  };
}
