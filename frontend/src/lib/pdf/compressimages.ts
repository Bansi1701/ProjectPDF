/**
 * The optional lossy image pass for Compress.
 *
 * The rest of the compress pipeline is strictly lossless, and on the documents
 * people actually want smaller that leaves nothing to win: a 346 KB PDF that is
 * 95% embedded JPEG compressed by 0.0%, and an 831 KB scan by 0.0%. iLovePDF
 * saved 87.6% and 47.4% on the same two files, at no visible cost — measured at
 * 99.8% ink similarity against our own untouched output. The bytes are in the
 * pictures, so a tool that never touches a picture cannot compete.
 *
 * Deliberately narrow. This handles plain DCTDecode (JPEG) image XObjects
 * reached through page resources, and declines everything else — indexed and
 * separation colour, CMYK, image masks, /Decode arrays, Flate rasters needing
 * predictor undo, images inside patterns, Type3 glyphs and annotation
 * appearances. grayscale.ts already has the machinery for all of that, and
 * generalising it is a refactor of nine hundred lines that would put a working
 * tool at risk for a smaller marginal gain. What it declines, it counts and
 * reports, so a modest saving is explained rather than mysterious.
 *
 * Two rules keep it safe:
 *   1. Per-image ratchet — a re-encoded image is kept only if it is smaller.
 *   2. Never upscale, and never resample below what the page can show.
 */
import { inflateSync, unzlibSync } from 'fflate';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';

export type ImagePreset = 'lossless' | 'balanced' | 'smallest';

interface Recipe {
  /** Longest side a picture may keep, expressed as dots per inch of page. */
  dpi: number;
  quality: number;
}

const RECIPES: Record<Exclude<ImagePreset, 'lossless'>, Recipe> = {
  balanced: { dpi: 150, quality: 0.82 },
  smallest: { dpi: 110, quality: 0.6 },
};

/** Above this a canvas allocation stops being reliable on iOS. */
const MAX_PIXELS = 12_000_000;

export interface ImagePassResult {
  /** Images whose stream was replaced with a smaller one. */
  rewritten: number;
  /** Images looked at and left alone, by reason. */
  skipped: Map<string, number>;
  bytesBefore: number;
  bytesAfter: number;
}

const usable =
  typeof OffscreenCanvas !== 'undefined' &&
  typeof createImageBitmap === 'function' &&
  typeof Blob !== 'undefined';

const nameOf = (value: unknown): string => String(value ?? '');

/**
 * lookupMaybe returns undefined for a missing object but THROWS when the object
 * is present and is not the type asked for — a /DecodeParms written as an array
 * rather than a dictionary took down the whole pass with "Expected instance of
 * e, but got instance of K". Every lookup here is a guess about a file we did
 * not write, so every one of them has to be allowed to be wrong.
 */
function look<T>(doc: PDFDocument, value: unknown, type: new (...args: never[]) => T): T | null {
  try {
    const found = doc.context.lookupMaybe(value as never, type as never);
    return (found as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** How many samples a pixel has, or null when we should not guess. */
function componentsOf(dict: PDFDict, doc: PDFDocument): number | null {
  const space = dict.get(PDFName.of('ColorSpace'));
  const direct = nameOf(space);
  if (direct === '/DeviceRGB') return 3;
  if (direct === '/DeviceGray') return 1;

  const array = look(doc, space, PDFArray);
  if (array && nameOf(array.get(0)) === '/ICCBased') {
    const stream = look(doc, array.get(1), PDFRawStream);
    const n = stream && look(doc, stream.dict.get(PDFName.of('N')), PDFNumber);
    const components = n?.asNumber();
    if (components === 1 || components === 3) return components;
  }
  return null;
}

/** FlateDecode with no predictor — raw samples we can read directly. */
function isPlainFlate(dict: PDFDict, doc: PDFDocument): boolean {
  const filter = dict.get(PDFName.of('Filter'));
  const bare = filter instanceof PDFName && nameOf(filter) === '/FlateDecode';
  const array = look(doc, filter, PDFArray);
  const wrapped = Boolean(array) && array!.size() === 1 && nameOf(array!.get(0)) === '/FlateDecode';
  if (!bare && !wrapped) return false;

  // A predictor means the rows are PNG-filtered and have to be un-filtered
  // before they mean anything. grayscale.ts can do that; this pass declines.
  const parms = look(doc, dict.get(PDFName.of('DecodeParms')), PDFDict);
  if (parms?.has(PDFName.of('Predictor'))) return false;
  return true;
}

/**
 * Un-deflates a PDF stream.
 *
 * /FlateDecode is zlib (RFC 1950), not raw deflate (RFC 1951) — the two-byte
 * 78 9c header in front of the deflate data is why fflate's `inflateSync`
 * answered "invalid block type" on a stream that was perfectly good. zlib is
 * tried first because it is what the spec says; raw is the fallback for the
 * producers that write it anyway.
 *
 * Synchronous on purpose too: fflate's async `inflate` works in a nested worker,
 * so the failure surfaced as an uncaught error that killed the whole PDF worker
 * rather than being caught and turned into a skipped image.
 */
function inflateSafely(bytes: Uint8Array): Uint8Array | null {
  try {
    return unzlibSync(bytes);
  } catch {
    try {
      return inflateSync(bytes);
    } catch {
      return null;
    }
  }
}

/** DCTDecode, whether written bare or as a one-element array. */
function isPlainJpeg(dict: PDFDict, doc: PDFDocument): boolean {
  const filter = dict.get(PDFName.of('Filter'));
  if (filter instanceof PDFName) return nameOf(filter) === '/DCTDecode';
  const array = look(doc, filter, PDFArray);
  if (!array) return false;
  // A JPEG behind another filter would have to be un-wrapped first.
  return array.size() === 1 && nameOf(array.get(0)) === '/DCTDecode';
}

/**
 * Whether this is a picture we can safely rebuild.
 *
 * Everything uncertain is declined. A wrong answer here does not make a file
 * larger, it makes it wrong.
 */
function reasonToSkip(dict: PDFDict, doc: PDFDocument): string | null {
  if (nameOf(dict.get(PDFName.of('Subtype'))) !== '/Image') return 'not an image';
  if (dict.has(PDFName.of('ImageMask'))) return 'a stencil mask';
  if (dict.has(PDFName.of('Decode'))) return 'an inverted or remapped sample range';
  if (dict.has(PDFName.of('SMask')) || dict.has(PDFName.of('Mask'))) return 'a transparency mask';

  const bpc = look(doc, dict.get(PDFName.of('BitsPerComponent')), PDFNumber);
  if (bpc && bpc.asNumber() !== 8) return 'not eight bits a channel';

  const space = dict.get(PDFName.of('ColorSpace'));
  const direct = nameOf(space);
  if (direct === '/DeviceRGB' || direct === '/DeviceGray') return null;

  const array = look(doc, space, PDFArray);
  if (array && nameOf(array.get(0)) === '/ICCBased') {
    const stream = look(doc, array.get(1), PDFRawStream);
    const n = stream && look(doc, stream.dict.get(PDFName.of('N')), PDFNumber);
    const components = n?.asNumber();
    // Canvas hands back RGBA; a four-channel ICC space is CMYK and would be
    // silently converted, which is a colour change, not a compression.
    if (components === 1 || components === 3) return null;
    return 'a CMYK or unusual colour space';
  }

  return 'a colour space this pass does not rebuild';
}

/** Every image XObject reachable from a page's own resources. */
function imagesOnPages(doc: PDFDocument): Map<string, { ref: PDFRef; stream: PDFRawStream; pageSide: number }> {
  const found = new Map<string, { ref: PDFRef; stream: PDFRawStream; pageSide: number }>();

  for (const page of doc.getPages()) {
    const size = page.getSize();
    const pageSide = Math.max(size.width, size.height);

    const resources = look(doc, page.node.get(PDFName.of('Resources')), PDFDict);
    const xobjects = resources && look(doc, resources.get(PDFName.of('XObject')), PDFDict);
    if (!xobjects) continue;

    for (const [, value] of xobjects.entries()) {
      if (!(value instanceof PDFRef)) continue;
      const stream = look(doc, value, PDFRawStream);
      if (!stream) continue;
      const key = `${value.objectNumber} ${value.generationNumber}`;
      const previous = found.get(key);
      // One object drawn on several pages is rebuilt once, against the largest
      // page it appears on so it stays sharp wherever it is biggest.
      if (previous) previous.pageSide = Math.max(previous.pageSide, pageSide);
      else found.set(key, { ref: value, stream, pageSide });
    }
  }

  return found;
}

export async function compressImages(
  doc: PDFDocument,
  preset: Exclude<ImagePreset, 'lossless'>
): Promise<ImagePassResult> {
  const result: ImagePassResult = { rewritten: 0, skipped: new Map(), bytesBefore: 0, bytesAfter: 0 };
  const note = (reason: string) => result.skipped.set(reason, (result.skipped.get(reason) ?? 0) + 1);

  if (!usable) {
    note('this browser has no canvas to rebuild pictures with');
    return result;
  }

  const recipe = RECIPES[preset];

  for (const { ref, stream, pageSide } of imagesOnPages(doc).values()) {
    const dict = stream.dict;

    const skip = reasonToSkip(dict, doc);
    if (skip) { note(skip); continue; }
    const jpeg = isPlainJpeg(dict, doc);
    const flate = !jpeg && isPlainFlate(dict, doc);
    if (!jpeg && !flate) { note('stored in a format this pass does not rebuild'); continue; }

    const width = look(doc, dict.get(PDFName.of('Width')), PDFNumber)?.asNumber() ?? 0;
    const height = look(doc, dict.get(PDFName.of('Height')), PDFNumber)?.asNumber() ?? 0;
    if (width < 2 || height < 2) { note('too small to be worth rebuilding'); continue; }
    if (width * height > MAX_PIXELS) { note('too large to open safely in a canvas'); continue; }

    const original = stream.contents;
    result.bytesBefore += original.length;

    // The most a page can show. Resampling past this throws away detail nobody
    // can see; stopping short of it keeps the picture sharp when zoomed.
    const ceiling = Math.max(320, Math.round((pageSide / 72) * recipe.dpi));
    const longest = Math.max(width, height);
    const scale = longest > ceiling ? ceiling / longest : 1;

    let replacement: Uint8Array | null = null;
    try {
      const target = new OffscreenCanvas(
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale))
      );
      const ctx = target.getContext('2d');
      if (!ctx) throw new Error('no context');

      // JPEG has no alpha; paper underneath keeps a stray transparent edge
      // from decoding to black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, target.width, target.height);

      if (jpeg) {
        const bitmap = await createImageBitmap(
          new Blob([original.slice() as BlobPart], { type: 'image/jpeg' })
        );
        ctx.drawImage(bitmap, 0, 0, target.width, target.height);
        bitmap.close();
      } else {
        // Raw samples: inflate, widen to RGBA, then let the canvas do the
        // resampling. This is the path that matters — a PNG placed in a PDF is
        // stored uncompressed-per-pixel, and it is usually the biggest object
        // in the file by a wide margin.
        const components = componentsOf(dict, doc);
        if (components === null) throw new Error('unknown colour space');
        const samples = inflateSafely(original.slice());
        if (!samples) throw new Error('sample data would not inflate');
        const expected = width * height * components;
        if (samples.length < expected) throw new Error('short sample data');

        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let i = 0, at = 0, s2 = 0; i < width * height; i += 1, at += 4, s2 += components) {
          if (components === 1) {
            rgba[at] = rgba[at + 1] = rgba[at + 2] = samples[s2];
          } else {
            rgba[at] = samples[s2];
            rgba[at + 1] = samples[s2 + 1];
            rgba[at + 2] = samples[s2 + 2];
          }
          rgba[at + 3] = 255;
        }

        const source = new OffscreenCanvas(width, height);
        const sctx = source.getContext('2d');
        if (!sctx) throw new Error('no source context');
        sctx.putImageData(new ImageData(rgba, width, height), 0, 0);
        ctx.drawImage(source, 0, 0, target.width, target.height);
        source.width = 0;
        source.height = 0;
      }

      const blob = await target.convertToBlob({ type: 'image/jpeg', quality: recipe.quality });
      replacement = new Uint8Array(await blob.arrayBuffer());
      target.width = 0;
      target.height = 0;
    } catch {
      note('could not be decoded here');
      result.bytesAfter += original.length;
      continue;
    }

    // The ratchet. A picture that came out larger is left exactly as it was.
    if (!replacement || replacement.length >= original.length) {
      note('already smaller than anything this pass could make');
      result.bytesAfter += original.length;
      continue;
    }

    const rebuilt = doc.context.stream(replacement, {});
    for (const [key, value] of dict.entries()) {
      const key_ = nameOf(key).slice(1);
      if (key_ === 'Length' || key_ === 'Filter' || key_ === 'DecodeParms') continue;
      rebuilt.dict.set(key, value);
    }
    // Written back as a JPEG: re-flating one costs a few percent and buys
    // nothing, since it is already entropy-coded.
    rebuilt.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    rebuilt.dict.set(PDFName.of('Width'), PDFNumber.of(Math.max(1, Math.round(width * scale))));
    rebuilt.dict.set(PDFName.of('Height'), PDFNumber.of(Math.max(1, Math.round(height * scale))));
    doc.context.assign(ref, rebuilt);

    result.rewritten += 1;
    result.bytesAfter += replacement.length;
  }

  return result;
}

/** Plain-language lines for the receipt. */
export function describeImagePass(result: ImagePassResult, preset: ImagePreset): string[] {
  const notes: string[] = [];
  if (result.rewritten > 0) {
    const saved = result.bytesBefore - result.bytesAfter;
    notes.push(
      `${result.rewritten} picture${result.rewritten === 1 ? '' : 's'} re-encoded, saving ${(saved / 1024).toFixed(0)} KB. ` +
        (preset === 'smallest'
          ? 'This one is lossy and meant for sending, not archiving — keep the original.'
          : 'This step is lossy: the pixels are re-compressed, so keep the original if you may need it again.')
    );
  }
  for (const [reason, count] of result.skipped) {
    notes.push(`${count} image${count === 1 ? ' was' : 's were'} left alone — ${reason}.`);
  }
  return notes;
}
