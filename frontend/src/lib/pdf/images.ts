/**
 * Images ↔ PDF.
 *
 * Two rules shape this file.
 *
 * Going *in*, a JPEG is already a PDF image: `/DCTDecode` is baseline JPEG, so
 * the bytes are copied into the document verbatim. Decoding and re-encoding
 * would lose quality and take a hundred times longer for no gain. PNG embeds
 * losslessly the same way. WebP has no PDF filter at all, so it is the one
 * format that must be transcoded — and the UI says so, because a tool that
 * quietly re-encodes your photos is lying to you.
 *
 * Coming *out*, pdf-lib cannot rasterise anything: it manipulates objects, it
 * does not draw. That job needs pdf.js, which is imported lazily so the other
 * four tools never pay for 3 MB of renderer they do not use.
 */
import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import type { PDFImage } from '@cantoo/pdf-lib';

import { documentOptions, loadPdfjs } from './pdfjs';
import type { ImageFormat, InputFile, OpResult, OutputFile, PageSize } from './types';
import { parsePageSet } from './pageset';

/**
 * iOS Safari refuses to allocate a canvas backing store above roughly 16.7 M
 * pixels, and it fails by returning a blank context rather than throwing. We
 * stop well short of the cliff: Letter at 300 DPI is 8.4 MP and fine, 600 DPI
 * is 33.7 MP and is not.
 */
export const MAX_CANVAS_PIXELS = 12_000_000;

const PAGE_SIZES: Record<'a4' | 'letter', readonly [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/** Breathing room on a fixed-size page, so the image is not printed to the bleed. */
const PAGE_MARGIN = 18;

const baseName = (name: string): string => name.replace(/\.[^./\\]+$/, '');

const total = (files: OutputFile[]): number =>
  files.reduce((sum, file) => sum + file.bytes.length, 0);

/* ------------------------------------------------------------------ *
 * Images → PDF
 * ------------------------------------------------------------------ */

type ImageKind = 'jpeg' | 'png' | 'webp';

/**
 * Trust the bytes, not the extension. Phones hand out `.jpg` files that are
 * actually HEIC, and a mislabelled file would otherwise fail deep inside
 * pdf-lib with an unreadable error.
 */
function sniff(bytes: Uint8Array): ImageKind | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }

  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'webp';

  return null;
}

/**
 * EXIF orientation, or 1 when there is none.
 *
 * A phone photo is almost always stored in sensor order with a tag saying how
 * to turn it. Passing the JPEG through untouched means nothing applies that
 * tag, so a portrait photo would land in the PDF on its side. We read the tag
 * and rotate at the *page* level instead — the compressed bytes stay exactly
 * as they arrived.
 */
function exifOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; // past SOI

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return 1;
    const marker = view.getUint8(offset + 1);

    // Start of scan: image data begins, no more metadata segments.
    if (marker === 0xda || marker === 0xd9) return 1;

    const length = view.getUint16(offset + 2);
    if (length < 2) return 1;

    if (marker === 0xe1 && offset + 10 <= view.byteLength) {
      const header = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (header === 'Exif') {
        const tiff = offset + 10;
        if (tiff + 8 > view.byteLength) return 1;

        const little = view.getUint16(tiff) === 0x4949;
        const ifd = tiff + view.getUint32(tiff + 4, little);
        if (ifd + 2 > view.byteLength) return 1;

        const entries = view.getUint16(ifd, little);
        for (let i = 0; i < entries; i += 1) {
          const entry = ifd + 2 + i * 12;
          if (entry + 12 > view.byteLength) return 1;
          if (view.getUint16(entry, little) === 0x0112) {
            const value = view.getUint16(entry + 8, little);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
    }

    offset += 2 + length;
  }

  return 1;
}

/** EXIF orientation → clockwise degrees. The mirrored values map to 0; see below. */
const EXIF_TURN: Record<number, number> = { 1: 0, 2: 0, 3: 180, 4: 0, 5: 0, 6: 90, 7: 0, 8: 270 };

/** Orientations that also flip the image. pdf-lib cannot express a mirror. */
const EXIF_MIRRORED = new Set([2, 4, 5, 7]);

interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate: number;
}

/**
 * Where to put a `dw × dh` box with its lower-left corner at (bx, by), given
 * that pdf-lib draws the image into a box anchored at (x, y) and *then* spins
 * that box counter-clockwise about (x, y). The corner therefore has to move to
 * wherever the rotation will throw it.
 */
function place(bx: number, by: number, dw: number, dh: number, turn: number): Placement {
  switch (turn) {
    case 90:
      return { x: bx, y: by + dh, width: dh, height: dw, rotate: 270 };
    case 180:
      return { x: bx + dw, y: by + dh, width: dw, height: dh, rotate: 180 };
    case 270:
      return { x: bx + dw, y: by, width: dh, height: dw, rotate: 90 };
    default:
      return { x: bx, y: by, width: dw, height: dh, rotate: 0 };
  }
}

/**
 * The one lossy path in this tool. WebP has no PDF filter — no viewer can read
 * it — so it is decoded and re-encoded as JPEG at quality 0.92.
 */
async function webpToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/webp' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    bitmap.close();
    throw new Error('This browser could not open a drawing surface for the WebP image.');
  }

  // JPEG has no alpha channel. Without a white sheet underneath, everything
  // transparent comes out black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  canvas.width = canvas.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function imagesToPdf(files: InputFile[], pageSize: PageSize): Promise<OpResult> {
  if (files.length === 0) return { ok: false, error: 'Choose at least one image.' };

  const started = performance.now();
  const pdf = await PDFDocument.create();

  let bytesIn = 0;
  let verbatim = 0;
  let transcoded = 0;
  let rotated = 0;
  let mirrored = 0;
  const rejected: number[] = [];

  for (const [index, file] of files.entries()) {
    const raw = new Uint8Array(file.bytes);
    bytesIn += raw.length;

    const kind = sniff(raw);
    if (!kind) {
      rejected.push(index + 1);
      continue;
    }

    let image: PDFImage;
    let turn = 0;

    try {
      if (kind === 'jpeg') {
        const orientation = exifOrientation(raw);
        turn = EXIF_TURN[orientation] ?? 0;
        if (turn !== 0) rotated += 1;
        if (EXIF_MIRRORED.has(orientation)) mirrored += 1;
        image = await pdf.embedJpg(raw);
        verbatim += 1;
      } else if (kind === 'png') {
        image = await pdf.embedPng(raw);
        verbatim += 1;
      } else {
        image = await pdf.embedJpg(await webpToJpeg(raw));
        transcoded += 1;
      }
    } catch (error) {
      return {
        ok: false,
        error: `Image ${index + 1} could not be read: ${(error as Error).message}`,
      };
    }

    // A quarter turn swaps which way the image reads on the page.
    const upright = turn === 90 || turn === 270;
    const natW = upright ? image.height : image.width;
    const natH = upright ? image.width : image.height;

    let page;
    let spot: Placement;

    if (pageSize === 'fit') {
      page = pdf.addPage([natW, natH]);
      spot = place(0, 0, natW, natH, turn);
    } else {
      const [pw, ph] = PAGE_SIZES[pageSize];
      page = pdf.addPage([pw, ph]);
      const scale = Math.min((pw - PAGE_MARGIN * 2) / natW, (ph - PAGE_MARGIN * 2) / natH);
      const dw = natW * scale;
      const dh = natH * scale;
      spot = place((pw - dw) / 2, (ph - dh) / 2, dw, dh, turn);
    }

    page.drawImage(image, { ...spot, rotate: degrees(spot.rotate) });
  }

  if (pdf.getPageCount() === 0) {
    return { ok: false, error: 'None of those files are a JPG, PNG or WebP image.' };
  }

  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });

  const notes: string[] = [];
  if (verbatim > 0) {
    notes.push(
      `${verbatim} JPG/PNG image${verbatim === 1 ? '' : 's'} embedded byte-for-byte — not re-encoded, so nothing was lost.`
    );
  }
  if (transcoded > 0) {
    notes.push(
      `${transcoded} WebP image${transcoded === 1 ? '' : 's'} re-encoded as JPEG at quality 0.92. PDF has no WebP filter, so this is unavoidable.`
    );
  }
  if (rotated > 0) {
    notes.push(
      `${rotated} photo${rotated === 1 ? '' : 's'} carried an EXIF rotation, applied to the page rather than to the pixels.`
    );
  }
  if (mirrored > 0) {
    notes.push(
      `${mirrored} photo${mirrored === 1 ? ' has' : 's have'} a mirrored EXIF orientation, which a PDF page cannot express. Placed unmirrored.`
    );
  }
  if (rejected.length > 0) {
    notes.push(
      `Skipped image${rejected.length === 1 ? '' : 's'} ${rejected.join(', ')} — not a JPG, PNG or WebP.`
    );
  }

  return {
    ok: true,
    files: [{ name: 'images.pdf', bytes, type: 'application/pdf' }],
    bytesIn,
    bytesOut: bytes.length,
    pages: pdf.getPageCount(),
    durationMs: performance.now() - started,
    summary: `${pdf.getPageCount()} page${pdf.getPageCount() === 1 ? '' : 's'} from ${verbatim + transcoded} image${verbatim + transcoded === 1 ? '' : 's'}`,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * PDF → images
 * ------------------------------------------------------------------ */

/** Highest DPI at which a page of this size stays inside the canvas budget. */
const dpiCeiling = (widthPt: number, heightPt: number): number =>
  Math.floor(72 * Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, widthPt * heightPt)));

/**
 * Page geometry only — no renderer downloaded, no pixel drawn.
 *
 * The DPI a page can take depends on how big the page is, and pdf-lib is
 * already in this bundle, so the UI can grey out an impossible choice the
 * moment a file is picked rather than failing after a long render.
 */
export async function probePdf(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  let maxDpi = Number.POSITIVE_INFINITY;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    maxDpi = Math.min(maxDpi, dpiCeiling(width, height));
  }

  return { ok: true, probe: true, pages: doc.getPageCount(), maxDpi };
}

/** Stop before the tab dies rather than after. */
const OUTPUT_BUDGET = 400 * 1024 * 1024;

export async function pdfToImages(
  files: InputFile[],
  format: ImageFormat,
  dpi: number,
  pageSpec = ''
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to export.' };

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;
  const api = await loadPdfjs();

  const doc = await api.getDocument({
    data: new Uint8Array(file.bytes),
    ...documentOptions(),
  }).promise;

  const out: OutputFile[] = [];
  const stem = baseName(file.name);
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const extension = format === 'png' ? 'png' : 'jpg';
  const pad = String(doc.numPages).length;

  let clamped = 0;
  let lowest = dpi;

  // Exporting 300 pages to get the one with the chart on it is a lot of
  // rendering, and a lot of files to pick through afterwards.
  const chosen = parsePageSet(pageSpec, doc.numPages).pages;
  if (chosen.length === 0) {
    await doc.destroy();
    return { ok: false, error: `That page selection matches nothing. This document has ${doc.numPages} pages.` };
  }

  try {
    for (const n of chosen) {
      const page = await doc.getPage(n);
      const unit = page.getViewport({ scale: 1 });

      const ceiling = dpiCeiling(unit.width, unit.height);
      const effective = Math.min(dpi, ceiling);
      if (effective < dpi) {
        clamped += 1;
        lowest = Math.min(lowest, effective);
      }

      const viewport = page.getViewport({ scale: effective / 72 });
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height))
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) return { ok: false, error: 'This browser could not open a drawing surface.' };

      // A PDF page has no background of its own. PNG keeps the transparency;
      // JPEG cannot, so it gets paper.
      if (format === 'jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      const blob = await canvas.convertToBlob({
        type: mime,
        ...(format === 'jpeg' ? { quality: 0.9 } : {}),
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());

      // Free the backing store before the next page allocates its own.
      canvas.width = canvas.height = 0;
      page.cleanup();

      out.push({
        name: `${stem}-${String(n).padStart(pad, '0')}.${extension}`,
        bytes,
        type: mime,
      });

      if (total(out) > OUTPUT_BUDGET) {
        return {
          ok: false,
          error: `Stopped at page ${n}: the images had already passed 400 MB, which would crash this tab. Choose a lower DPI, or split the document first.`,
        };
      }
    }
  } catch (error) {
    return { ok: false, error: `Rendering failed: ${(error as Error).message}` };
  } finally {
    await doc.loadingTask.destroy();
  }

  const notes: string[] = [];
  if (chosen.length < doc.numPages) {
    notes.push(`${chosen.length} of ${doc.numPages} pages were exported, keeping their original page numbers in the filenames.`);
  }
  if (clamped > 0) {
    notes.push(
      `${clamped} page${clamped === 1 ? ' is' : 's are'} too large for ${dpi} DPI and ${clamped === 1 ? 'was' : 'were'} rendered at ${lowest} DPI instead. Above about 16.7 million pixels a canvas fails outright on iOS, so we stop at 12 million.`
    );
  }

  // Don't claim a resolution we did not deliver.
  const resolution =
    clamped === 0 ? `${dpi} DPI` : clamped === out.length ? `${lowest} DPI` : `up to ${dpi} DPI`;

  return {
    ok: true,
    files: out,
    bytesIn,
    bytesOut: total(out),
    pages: out.length,
    durationMs: performance.now() - started,
    summary: `${out.length} ${format === 'png' ? 'PNG' : 'JPG'}${out.length === 1 ? '' : 's'} at ${resolution}`,
    notes,
  };
}
