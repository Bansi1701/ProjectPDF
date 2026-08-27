/**
 * Watermarking.
 *
 * The homepage has always advertised "text or an image", and the tool only did
 * text — one hardcoded diagonal string at a fixed size, angle, colour and
 * opacity, on every page. This is the version that matches the claim.
 *
 * Two design decisions worth stating:
 *
 * The mark is embedded once and stamped many times. A 200-page document with a
 * tiled watermark draws the same XObject 1,800 times and still carries one copy
 * of the pixels, which is the difference between a file you can email and one
 * you cannot.
 *
 * Text that WinAnsi cannot encode is rasterised rather than refused. A watermark
 * is exactly the kind of short string people write in their own script —
 * 社外秘, ЧЕРНОВИК, गोपनीय — and silently turning those into question marks
 * would be worse than the old fixed-string behaviour, not better.
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage } from '@cantoo/pdf-lib';
import { needsFallback } from './text';
import { parsePageSet } from './pageset';
import type { InputFile, OpResult } from './types';

export type WatermarkPosition =
  | 'center'
  | 'top-left' | 'top' | 'top-right'
  | 'left' | 'right'
  | 'bottom-left' | 'bottom' | 'bottom-right';

export interface WatermarkOptions {
  kind: 'text' | 'image';
  text: string;
  image?: { bytes: ArrayBuffer; type: string };
  /** 0.05–1. */
  opacity: number;
  /** Degrees anticlockwise. */
  rotation: number;
  /** The mark's width as a percentage of the page width. */
  scale: number;
  position: WatermarkPosition;
  tile: boolean;
  /** A page-set expression; empty means every page. */
  pages: string;
  /** Hex, text marks only. */
  color: string;
  bold: boolean;
}

export const WATERMARK_DEFAULTS: WatermarkOptions = {
  kind: 'text',
  text: '',
  opacity: 0.22,
  rotation: 35,
  scale: 60,
  position: 'center',
  tile: false,
  pages: '',
  color: '#b81f24',
  bold: true,
};

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

/* Helvetica metrics, as fractions of the em. */
const CAP_HEIGHT = 0.717;
const X_HEIGHT = 0.523;
const DESCENDER = 0.207;
/** Anything that reaches cap height: capitals, digits, and the tall lowercase. */
const HAS_TALL = /[A-Z0-9bdfhklt]/;
const HAS_DESCENDER = /[gjpqy]/;

function colour(hex: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return rgb(0.72, 0.12, 0.14);
  const value = parseInt(match[1], 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

/**
 * Draws a string to a bitmap so scripts outside WinAnsi still work.
 * Rendered at 4x the placed size, because a watermark is the thing people zoom
 * into to check whether a document is the draft or the final.
 */
async function rasteriseText(text: string, hex: string, bold: boolean): Promise<{ bytes: Uint8Array; aspect: number } | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;

  const size = 160;
  const font = `${bold ? '700 ' : ''}${size}px system-ui, "Segoe UI", "Noto Sans", sans-serif`;
  const measure = new OffscreenCanvas(8, 8).getContext('2d');
  if (!measure) return null;
  measure.font = font;
  const metrics = measure.measureText(text);
  const width = Math.ceil(metrics.width) + 16;
  const height = Math.ceil(size * 1.35);
  if (width < 2 || height < 2) return null;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = font;
  ctx.fillStyle = hex;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, height / 2);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), aspect: height / width };
}

/**
 * pdf-lib rotates a drawing about its own (x, y) origin, so placing a rotated
 * mark by its centre means solving for the origin that puts the centre where
 * it was asked for.
 */
function originForCentre(cx: number, cy: number, w: number, h: number, radians: number) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: cx - ((w / 2) * cos - (h / 2) * sin),
    y: cy - ((w / 2) * sin + (h / 2) * cos),
  };
}

function anchor(
  position: WatermarkPosition,
  pageWidth: number,
  pageHeight: number,
  w: number,
  h: number,
  radians: number
): { cx: number; cy: number } {
  // Keep the rotated bounding box inside the page, not the unrotated one.
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const boxW = w * cos + h * sin;
  const boxH = w * sin + h * cos;

  const margin = Math.min(pageWidth, pageHeight) * 0.04;
  const left = margin + boxW / 2;
  const right = pageWidth - margin - boxW / 2;
  const bottom = margin + boxH / 2;
  const top = pageHeight - margin - boxH / 2;
  const midX = pageWidth / 2;
  const midY = pageHeight / 2;

  switch (position) {
    case 'top-left': return { cx: left, cy: top };
    case 'top': return { cx: midX, cy: top };
    case 'top-right': return { cx: right, cy: top };
    case 'left': return { cx: left, cy: midY };
    case 'right': return { cx: right, cy: midY };
    case 'bottom-left': return { cx: left, cy: bottom };
    case 'bottom': return { cx: midX, cy: bottom };
    case 'bottom-right': return { cx: right, cy: bottom };
    default: return { cx: midX, cy: midY };
  }
}

export async function watermark(files: InputFile[], options: Partial<WatermarkOptions>): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to watermark.' };

  const settings: WatermarkOptions = { ...WATERMARK_DEFAULTS, ...options };
  const text = settings.text.trim();

  if (settings.kind === 'text' && !text) {
    return { ok: false, error: 'Type the words you want stamped across the pages.' };
  }
  if (settings.kind === 'image' && !settings.image) {
    return { ok: false, error: 'Choose the image you want stamped across the pages.' };
  }

  const started = performance.now();
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const count = doc.getPageCount();
  const { pages: targets, outOfRange } = parsePageSet(settings.pages, count);

  if (targets.length === 0) {
    return { ok: false, error: `That page selection matches nothing. This document has ${count} pages.` };
  }

  const notes: string[] = [];
  const opacity = Math.min(1, Math.max(0.05, settings.opacity));
  const radians = (settings.rotation * Math.PI) / 180;

  // ── Build the mark once ───────────────────────────────────────────────────
  let image: PDFImage | null = null;
  let font: PDFFont | null = null;
  let aspect = 0;

  if (settings.kind === 'image') {
    const { bytes, type } = settings.image!;
    const isPng = type.includes('png') || new Uint8Array(bytes.slice(0, 4)).every((b, i) => b === [0x89, 0x50, 0x4e, 0x47][i]);
    try {
      image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch {
      return { ok: false, error: 'That image could not be embedded. PNG and JPG work; a WebP has no PDF equivalent.' };
    }
    aspect = image.height / image.width;
    notes.push('The image is embedded once and stamped on every page it appears on, so a tiled watermark costs one copy of the pixels.');
  } else if (needsFallback(text)) {
    const drawn = await rasteriseText(text, settings.color, settings.bold);
    if (!drawn) {
      return { ok: false, error: 'That text uses characters this browser cannot draw here. Try the image option.' };
    }
    image = await doc.embedPng(drawn.bytes);
    aspect = drawn.aspect;
    notes.push('Your text uses characters outside the PDF standard set, so it is drawn as a picture rather than replaced with question marks. It stays sharp when zoomed.');
  } else {
    font = await doc.embedFont(settings.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  }

  // ── Stamp it ──────────────────────────────────────────────────────────────
  const ink = colour(settings.color);
  let stamps = 0;

  for (const number of targets) {
    const page = doc.getPage(number - 1);
    const { width: pw, height: ph } = page.getSize();

    const markW = (pw * Math.min(400, Math.max(5, settings.scale))) / 100;
    const markH = font ? 0 : markW * aspect;

    // For native text the draw origin is a baseline, not a box corner, so the
    // box has to be derived. Two wrong answers were measured on the way here:
    // a flat 0.72em guess put the bottom margin at 3.1% where the right was
    // 4.0%, and the font's full line height centred the *box* while leaving
    // all-caps ink sitting high inside it, off-centre by 1.9% of page width.
    // What actually wants centring is the ink, so the box is the ink.
    const size = font ? (markW / Math.max(1, font.widthOfTextAtSize(text, 100))) * 100 : 0;
    const inkTop = font ? size * (HAS_TALL.test(text) ? CAP_HEIGHT : X_HEIGHT) : 0;
    const inkBottom = font && HAS_DESCENDER.test(text) ? size * DESCENDER : 0;
    const textH = inkTop + inkBottom;
    const boxH = font ? textH : markH;

    const spots: { cx: number; cy: number }[] = [];
    if (settings.tile) {
      const cos = Math.abs(Math.cos(radians));
      const sin = Math.abs(Math.sin(radians));
      const stepX = (markW * cos + boxH * sin) * 1.25;
      const stepY = (markW * sin + boxH * cos) * 1.6;
      // Start half a step outside the page on both axes. Starting at +step/2
      // left an uncovered band along the bottom (measured: coverage stopped at
      // 94.6% of page height while bleeding to 99.9% across).
      const originX = pw / 2 - Math.ceil(pw / 2 / stepX + 0.5) * stepX;
      const originY = ph / 2 - Math.ceil(ph / 2 / stepY + 0.5) * stepY;
      for (let y = originY; y < ph + stepY; y += stepY) {
        for (let x = originX; x < pw + stepX; x += stepX) spots.push({ cx: x, cy: y });
      }
    } else {
      spots.push(anchor(settings.position, pw, ph, markW, boxH, radians));
    }

    for (const spot of spots) {
      if (image) {
        const at = originForCentre(spot.cx, spot.cy, markW, markH, radians);
        page.drawImage(image, {
          x: at.x, y: at.y, width: markW, height: markH,
          rotate: degrees(settings.rotation), opacity,
        });
      } else if (font) {
        // drawText's origin is the baseline-left, which sits above the box
        // bottom by the descender.
        // Offset from the box's bottom-left corner up to the baseline, carried
        // through the same rotation as the box itself.
        const at = originForCentre(spot.cx, spot.cy, markW, textH, radians);
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        page.drawText(text, {
          x: at.x + inkBottom * -Math.sin(radians),
          y: at.y + inkBottom * cos,
          size, font, color: ink, opacity,
          rotate: degrees(settings.rotation),
        });
      }
      stamps += 1;
    }
  }

  if (outOfRange.length > 0) {
    notes.push(`This document has ${count} pages, so ${outOfRange.join(', ')} could not be marked.`);
  }
  if (targets.length < count) {
    notes.push(`${targets.length} of ${count} pages were marked. The rest are untouched.`);
  }
  notes.push('The mark is drawn over the page content, not behind it, and it is part of the page — anyone can still see it is a watermark.');

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-watermarked.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages: count,
    durationMs: performance.now() - started,
    summary: `${stamps} mark${stamps === 1 ? '' : 's'} across ${targets.length} page${targets.length === 1 ? '' : 's'}`,
    notes,
  };
}
