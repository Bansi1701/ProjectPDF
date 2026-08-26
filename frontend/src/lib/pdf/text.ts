/**
 * Drawing text that PDF's built-in fonts cannot spell.
 *
 * pdf-lib's standard fonts speak WinAnsi: ASCII, Latin-1, and a handful of
 * typographic extras. Everything else — Chinese, Arabic, Devanagari, Cyrillic,
 * Greek, emoji — comes out as `?`. All three Office converters used to sidestep
 * that with `text.replace(/[^\x00-\xFF]/g, '')`, which was wrong twice over:
 * it deleted the characters silently, AND it deleted em dashes, curly quotes,
 * ellipses and euro signs that WinAnsi handles perfectly well. Those appear in
 * nearly every real document.
 *
 * The usual fix is to ship a Unicode font, but a CJK face is 10-20 MB and this
 * site refuses to make people download that to convert one file.
 *
 * So: the browser already has those fonts installed. A run of text WinAnsi
 * cannot encode is rendered to a canvas with the system font stack and embedded
 * as a small transparent image, positioned on the same baseline as the text
 * around it. A mixed string like "Product 名前 v2" comes out as real text,
 * then an image, then real text again — visually seamless, and nothing is lost.
 *
 * The trade, stated where the user can see it: the rasterised fragments are not
 * selectable or searchable. That is worth far more than a row of `?`.
 */
import type { PDFDocument, PDFFont, PDFImage, PDFPage, RGB } from '@cantoo/pdf-lib';

// ── what WinAnsi can actually spell ─────────────────────────────────────

/**
 * The 0x80–0x9F block, where WinAnsi differs from Latin-1. Verified against
 * pdf-lib by drawing each one and reading it back out.
 */
const HIGH_RANGE =
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ' +
  '‘’“”•–—˜™š›œžŸ';

const ENCODABLE = new Set<number>();
for (let cp = 0x20; cp <= 0x7e; cp += 1) ENCODABLE.add(cp);
for (let cp = 0xa0; cp <= 0xff; cp += 1) ENCODABLE.add(cp);
for (const character of HIGH_RANGE) ENCODABLE.add(character.codePointAt(0)!);

/**
 * Characters with a faithful WinAnsi stand-in. Mapping these is much better
 * than rasterising them: a non-breaking hyphen is a hyphen, and a ligature is
 * the letters it joins.
 */
const FOLD: Record<string, string> = {
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  '‐': '-', '‑': '-', '‒': '-', '―': '—', '−': '-',
  '′': "'", '″': '"', '‵': "'", '‶': '"', 'ʼ': "'",
  '⁄': '/', '∕': '/', '∶': ':',
  '←': '<-', '→': '->', '↔': '<->', '⇒': '=>', '⇐': '<=',
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~',
  '●': '•', '▪': '•', '◦': '•', '⁃': '•',
  '​': '', '‌': '', '‍': '', '﻿': '', '­': '',
  ' ': ' ', ' ': ' ', '　': ' ',
};
for (let cp = 0x2000; cp <= 0x200a; cp += 1) FOLD[String.fromCharCode(cp)] = ' ';

/** Applies the fold table and strips control characters. */
export function fold(value: string): string {
  let out = '';
  for (const character of value) {
    const replacement = FOLD[character];
    if (replacement !== undefined) {
      out += replacement;
      continue;
    }
    const cp = character.codePointAt(0)!;
    // C0 and C1 controls have no glyph and upset the encoder.
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
      out += cp === 9 ? '    ' : '';
      continue;
    }
    out += character;
  }
  return out;
}

const canEncode = (character: string): boolean => ENCODABLE.has(character.codePointAt(0)!);

/** True when any part of this string would come out as `?`. */
export const needsFallback = (value: string): boolean =>
  [...fold(value)].some((character) => !canEncode(character));

interface Segment {
  text: string;
  /** False when this run has to be drawn as an image. */
  native: boolean;
}

/** Splits folded text into alternating native and fallback runs. */
function segment(value: string): Segment[] {
  const segments: Segment[] = [];
  for (const character of fold(value)) {
    const native = canEncode(character);
    const last = segments[segments.length - 1];
    if (last && last.native === native) last.text += character;
    else segments.push({ text: character, native });
  }
  return segments;
}

// ── the canvas side ─────────────────────────────────────────────────────

/**
 * Rendered well above the placed size so the glyphs stay sharp when the reader
 * zooms. 4× is the point where the file-size cost stops buying visible detail.
 */
const RASTER_SCALE = 4;

/** A stack with broad script coverage on macOS, Windows, Android and Linux. */
const FALLBACK_STACK =
  '"Helvetica Neue", Helvetica, Arial, "Noto Sans", "Noto Sans CJK SC", ' +
  '"PingFang SC", "Microsoft YaHei", "Hiragino Sans", "Malgun Gothic", ' +
  '"Noto Sans Devanagari", "Noto Color Emoji", "Apple Color Emoji", ' +
  '"Segoe UI Emoji", sans-serif';

const cssFont = (size: number, bold: boolean, italic: boolean): string =>
  `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}${size}px ${FALLBACK_STACK}`;

/** One rasterised fragment, with the baseline offset it was drawn at. */
interface Raster {
  image: PDFImage;
  width: number;
  height: number;
  /** Distance from the top of the bitmap down to the text baseline, in points. */
  ascent: number;
}

export interface RunStyle {
  size: number;
  bold?: boolean;
  italic?: boolean;
  color?: RGB;
}

/**
 * Draws mixed-script text onto PDF pages, keeping one embedded image per
 * distinct fallback run so a phrase repeated across a document costs once.
 */
export class TextPainter {
  private measurer: OffscreenCanvasRenderingContext2D | null = null;
  private readonly cache = new Map<string, Raster | null>();

  /** How many runs had to be drawn as pictures. Surfaced to the user. */
  rasterised = 0;
  /** Characters that could not be drawn at all, if canvas is unavailable. */
  lost = 0;

  constructor(private readonly doc: PDFDocument) {}

  private context(): OffscreenCanvasRenderingContext2D | null {
    if (this.measurer) return this.measurer;
    if (typeof OffscreenCanvas === 'undefined') return null;
    this.measurer = new OffscreenCanvas(8, 8).getContext(
      '2d'
    ) as OffscreenCanvasRenderingContext2D | null;
    return this.measurer;
  }

  /** Width of a fallback run at a given size, in points. */
  private fallbackWidth(text: string, style: RunStyle): number {
    const ctx = this.context();
    if (!ctx) return 0;
    ctx.font = cssFont(style.size, style.bold ?? false, style.italic ?? false);
    return ctx.measureText(text).width;
  }

  /** Total advance width of a string, native and fallback parts together. */
  width(value: string, font: PDFFont, style: RunStyle): number {
    let total = 0;
    for (const part of segment(value)) {
      total += part.native
        ? font.widthOfTextAtSize(part.text, style.size)
        : this.fallbackWidth(part.text, style);
    }
    return total;
  }

  /** Trims a string to fit a width, appending an ellipsis when it had to cut. */
  fit(value: string, font: PDFFont, style: RunStyle, maxWidth: number): string {
    const folded = fold(value);
    if (this.width(folded, font, style) <= maxWidth) return folded;

    // Walk by code point so a surrogate pair is never split in half.
    const characters = [...folded];
    let out = '';
    for (const character of characters) {
      if (this.width(`${out}${character}…`, font, style) > maxWidth) break;
      out += character;
    }
    return out.length > 0 ? `${out}…` : '';
  }

  private async raster(text: string, style: RunStyle): Promise<Raster | null> {
    const bold = style.bold ?? false;
    const italic = style.italic ?? false;
    const color = style.color;
    const key = `${style.size}|${bold}|${italic}|${color?.red},${color?.green},${color?.blue}|${text}`;

    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    let raster: Raster | null = null;
    const measure = this.context();

    if (measure) {
      const scaled = style.size * RASTER_SCALE;
      measure.font = cssFont(scaled, bold, italic);
      const metrics = measure.measureText(text);

      // fontBoundingBox covers the whole line box; actualBoundingBox is tight
      // to the ink. Prefer the former so every run sits on the same baseline,
      // and fall back where a browser does not report it.
      const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || scaled;
      const descent =
        metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || scaled * 0.25;

      const width = Math.ceil(metrics.width) + 2;
      const height = Math.ceil(ascent + descent) + 2;

      if (width > 2 && height > 2 && width * height < 16_000_000) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;

        if (ctx) {
          ctx.font = cssFont(scaled, bold, italic);
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = color
            ? `rgb(${Math.round(color.red * 255)} ${Math.round(color.green * 255)} ${Math.round(color.blue * 255)})`
            : '#1a1a1f';
          ctx.fillText(text, 1, ascent + 1);

          try {
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            const image = await this.doc.embedPng(await blob.arrayBuffer());
            // The exact baseline offset, not a guess: the glyphs were drawn
            // with their baseline at `ascent + 1` inside the bitmap.
            raster = {
              image,
              width: image.width / RASTER_SCALE,
              height: image.height / RASTER_SCALE,
              ascent: (ascent + 1) / RASTER_SCALE,
            };
          } catch {
            raster = null;
          }
        }
      }
    }

    this.cache.set(key, raster);
    return raster;
  }

  /**
   * Draws `value` with its baseline at `y`, starting at `x`. Returns the
   * advance width so callers can lay out what follows.
   */
  async draw(
    page: PDFPage,
    value: string,
    x: number,
    y: number,
    font: PDFFont,
    style: RunStyle
  ): Promise<number> {
    let cursor = x;

    for (const part of segment(value)) {
      if (part.native) {
        const width = font.widthOfTextAtSize(part.text, style.size);
        if (part.text.trim().length > 0) {
          page.drawText(part.text, {
            x: cursor,
            y,
            size: style.size,
            font,
            ...(style.color ? { color: style.color } : {}),
          });
        }
        cursor += width;
        continue;
      }

      const width = this.fallbackWidth(part.text, style);
      const drawn = await this.raster(part.text, style);

      if (drawn) {
        // Sit the bitmap so its own baseline lands on `y`: the part below the
        // baseline is whatever height is left under the recorded ascent.
        page.drawImage(drawn.image, {
          x: cursor,
          y: y - (drawn.height - drawn.ascent),
          width: drawn.width,
          height: drawn.height,
        });
        this.rasterised += 1;
      } else {
        this.lost += [...part.text].length;
      }

      cursor += width;
    }

    return cursor - x;
  }

  /** A note for the result panel, or null when everything was ordinary text. */
  note(): string | null {
    if (this.rasterised === 0 && this.lost === 0) return null;
    if (this.lost > 0) {
      return `${this.lost} character${this.lost === 1 ? '' : 's'} outside the Latin alphabet could not be drawn — this browser did not provide a canvas to render them with.`;
    }
    return 'Text outside the Latin alphabet — Chinese, Arabic, Devanagari, emoji and so on — was drawn using your system fonts so it appears correctly. Those fragments are pictures rather than selectable text.';
  }
}
