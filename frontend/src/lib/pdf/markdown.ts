/**
 * PDF → Markdown.
 *
 * pdf.js gives you positioned glyph runs, not a document. Everything that
 * makes the output readable — where a line ends, where a paragraph ends, what
 * is a heading, what is a list — has to be inferred from geometry.
 *
 * The inference is deliberately conservative. A wrong heading is worse than a
 * missing one, because a reader can see a missing heading and cannot see a
 * paragraph that was silently glued to the one above it.
 *
 * Scanned pages have no text layer at all; this reports that plainly instead
 * of returning an empty file.
 */
import { documentOptions, loadPdfjs } from './pdfjs';
import type { InputFile, OpResult } from './types';

interface Span {
  text: string;
  x: number;
  y: number;
  height: number;
  width: number;
  fontName: string;
  bold: boolean;
}

interface Line {
  y: number;
  height: number;
  x: number;
  right: number;
  text: string;
  bold: boolean;
}

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/** Lines whose vertical centres are within this fraction of a line height merge. */
const SAME_LINE = 0.5;

function toLines(spans: Span[]): Line[] {
  const sorted = [...spans].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];

  for (const span of sorted) {
    const last = lines[lines.length - 1];
    const tolerance = Math.max(span.height, last?.height ?? 0) * SAME_LINE;

    if (last && Math.abs(last.y - span.y) <= tolerance) {
      // Insert a space only where the gap is wider than a plausible kern.
      const gap = span.x - last.right;
      const needsSpace = gap > span.height * 0.18 && !/\s$/.test(last.text);
      last.text += (needsSpace ? ' ' : '') + span.text;
      last.right = span.x + span.width;
      last.height = Math.max(last.height, span.height);
      last.bold = last.bold || span.bold;
      continue;
    }

    lines.push({
      y: span.y,
      height: span.height,
      x: span.x,
      right: span.x + span.width,
      text: span.text,
      bold: span.bold,
    });
  }

  return lines.filter((line) => line.text.trim().length > 0);
}

const NUMBERED = /^\s*(\d{1,3})[.)]\s+/;

/**
 * Bullets are found by repetition, not by a list of characters.
 *
 * Word and InDesign draw bullets from a symbol font, so the glyph that arrives
 * is usually a private-use codepoint, not "•". Any short leading token that
 * starts three or more lines on a page is a bullet, whatever it looks like.
 */
function bulletGlyphs(lines: Line[]): Set<string> {
  const counts = new Map<string, number>();

  for (const line of lines) {
    const match = /^(\S{1,2})\s+\S/.exec(line.text.trim());
    if (!match) continue;
    const token = match[1];
    // A leading token that is itself wordy is not a bullet.
    if (/[A-Za-z0-9]/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return new Set([...counts].filter(([, n]) => n >= 3).map(([glyph]) => glyph));
}

/**
 * Does this text layer look like the output of a poor OCR pass?
 *
 * Scanned documents often arrive with a text layer already baked in by
 * whatever scanned them. It extracts cleanly and reads like noise. Saying so
 * is better than handing back confident-looking gibberish.
 */
function looksLikeBadOcr(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => word.length > 1);
  if (words.length < 60) return false;

  // Punctuation buried inside a word, or letters interleaved with digits.
  // Only apostrophes and hyphens legitimately sit inside one.
  const garbled = words.filter(
    (word) => /[A-Za-z][^A-Za-z0-9\s'’-][A-Za-z]/.test(word) || /[A-Za-z]\d|\d[A-Za-z]/.test(word)
  ).length;

  // Bad OCR also shatters words into one- and two-letter fragments.
  const fragments = words.filter((word) => /^[A-Za-z]{1,2}$/.test(word)).length;

  const garbledShare = garbled / words.length;
  const fragmentShare = fragments / words.length;

  // Measured across real documents: a scanned page with a poor baked-in text
  // layer scores about 14% on both, while clean exports sit under 6%.
  return garbledShare >= 0.08 && fragmentShare >= 0.08;
}

/**
 * Heading detection by size, not by guessing at fonts.
 *
 * A line is a heading when it is meaningfully larger than the document's body
 * text and short enough to be a title. Bold alone is not enough — plenty of
 * documents bold a whole paragraph.
 */
function headingLevel(line: Line, bodyHeight: number): number {
  const ratio = line.height / bodyHeight;
  const words = line.text.trim().split(/\s+/).length;

  if (words > 14) return 0;
  if (ratio >= 1.6) return 1;
  if (ratio >= 1.32) return 2;
  if (ratio >= 1.15) return 3;
  // A short, bold, standalone line is a plausible sub-heading.
  if (line.bold && ratio >= 1.02 && words <= 8) return 4;
  return 0;
}

/** The most common line height, which is the body text by definition. */
function modeHeight(lines: Line[]): number {
  const buckets = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.height * 2) / 2;
    buckets.set(key, (buckets.get(key) ?? 0) + line.text.length);
  }
  let best = 12;
  let bestWeight = 0;
  for (const [height, weight] of buckets) {
    if (weight > bestWeight) {
      best = height;
      bestWeight = weight;
    }
  }
  return best || 12;
}

function renderPage(lines: Line[], bodyHeight: number, bullets: Set<string>): string {
  const out: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push(paragraph.join(' ').replace(/\s+/g, ' ').trim());
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = line.text.trim();
    const previous = lines[i - 1];

    // A gap noticeably larger than the leading ends the paragraph.
    const gap = previous ? previous.y - line.y : 0;
    if (previous && gap > bodyHeight * 1.9) flush();

    const level = headingLevel(line, bodyHeight);
    if (level > 0) {
      flush();
      out.push(`${'#'.repeat(Math.min(level, 6))} ${text}`);
      continue;
    }

    const leading = /^(\S{1,2})\s+/.exec(text);
    if (leading && bullets.has(leading[1])) {
      flush();
      out.push(`- ${text.slice(leading[0].length)}`);
      continue;
    }

    const numbered = NUMBERED.exec(text);
    if (numbered) {
      flush();
      out.push(`${numbered[1]}. ${text.slice(numbered[0].length)}`);
      continue;
    }

    paragraph.push(text);
  }

  flush();
  return out.join('\n\n');
}

export async function pdfToMarkdown(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to convert.' };

  const started = performance.now();
  // Captured before pdf.js sees it: getDocument takes ownership of the buffer
  // it is given and detaches it, so byteLength reads 0 afterwards.
  const bytesIn = file.bytes.byteLength;

  const api = await loadPdfjs();

  let doc;
  try {
    doc = await api.getDocument({
      data: new Uint8Array(file.bytes),
      ...documentOptions(),
    }).promise;
  } catch (error) {
    return { ok: false, error: `This PDF could not be opened: ${(error as Error).message}` };
  }

  const sections: string[] = [];
  let totalSpans = 0;

  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();

    const spans: Span[] = [];
    for (const item of content.items as Array<Record<string, unknown>>) {
      const text = String(item.str ?? '');
      if (!text) continue;

      const transform = item.transform as number[] | undefined;
      if (!transform) continue;

      const fontName = String(item.fontName ?? '');
      spans.push({
        text,
        x: transform[4],
        y: transform[5],
        // The vertical scale of the text matrix is the rendered size.
        height: Math.abs(transform[3]) || Math.abs(transform[0]) || 12,
        width: Number(item.width ?? 0),
        fontName,
        bold: /bold|black|heavy|semibold/i.test(fontName),
      });
    }

    totalSpans += spans.length;
    page.cleanup();

    if (spans.length === 0) continue;

    const lines = toLines(spans);
    const body = modeHeight(lines);
    const markdown = renderPage(lines, body, bulletGlyphs(lines));
    if (markdown.trim()) sections.push(markdown);
  }

  await doc.loadingTask.destroy();

  if (totalSpans === 0) {
    return {
      ok: false,
      error:
        'This PDF has no text layer — it is images of pages, most likely a scan. Converting it needs OCR, which is a different tool.',
    };
  }

  const markdown = sections.join('\n\n---\n\n') + '\n';
  const bytes = new TextEncoder().encode(markdown);

  const words = markdown.split(/\s+/).filter(Boolean).length;
  const headings = (markdown.match(/^#{1,6} /gm) ?? []).length;
  const bullets = (markdown.match(/^- /gm) ?? []).length;

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}.md`, bytes, type: 'text/markdown' }],
    bytesIn,
    bytesOut: bytes.length,
    pages: doc.numPages,
    durationMs: performance.now() - started,
    summary: `${words.toLocaleString()} words of Markdown`,
    notes: looksLikeBadOcr(markdown)
      ? [
          'This document already carried a text layer, and it reads like poor OCR — misspellings, stray punctuation, run-together words. That is what was in the file; nothing here re-recognised the page.',
          'Re-running OCR on the images would give a better result than the text layer it shipped with.',
        ]
      : [
          `Found ${headings} heading${headings === 1 ? '' : 's'} and ${bullets} list item${bullets === 1 ? '' : 's'}. Structure is inferred from text size and spacing, so check anything that matters.`,
          'Tables and multi-column layouts come out as running text — the geometry that made them readable is not in the text layer.',
        ],
  };
}
