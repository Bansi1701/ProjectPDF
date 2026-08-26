/**
 * Pulling the original images back out of a PDF.
 *
 * The thing people actually want here is the photograph that was put *into*
 * the document, at the size it was put in at. That is not what a page render
 * gives you: rasterising page 3 at 150 DPI and cropping to the picture returns
 * a 600 px reinterpretation of a 3000 px original, resampled, recompressed and
 * with the page's text baked into whatever overlapped it. So nothing here
 * renders a page. Every image is read from the object that stores it.
 *
 * Two readers are needed, because neither one alone can do the job:
 *
 *  - pdf.js knows which images are *drawn*, and decodes them. It handles the
 *    colour work nobody wants to reimplement — CMYK separations, indexed
 *    palettes, JBIG2 and CCITT bilevel scans, soft masks — and it hands back
 *    pixels with the transparency already composited in.
 *  - pdf-lib can see the bytes as the file stores them. That matters for one
 *    case, and it is the common one: a `/DCTDecode` image *is* a JPEG. Its
 *    bytes can be written straight to disk. Decoding it and re-encoding as PNG
 *    would produce a file several times larger that is, pixel for pixel, worse.
 *
 * So: pdf-lib supplies the verbatim JPEGs, pdf.js supplies everything else,
 * and PNGs are written here rather than through a canvas — `convertToBlob` is
 * fine but a canvas stores colour premultiplied by alpha, and there is no
 * reason to round-trip a bilevel scan through 32-bit RGBA to get a 1-bit PNG
 * back out.
 *
 * Nothing here logs and nothing here leaves the browser. The images are
 * document content under the project's privacy rule, which is exactly why this
 * has to be done in the client at all.
 */
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } from '@cantoo/pdf-lib';
import { zlibSync } from 'fflate';

import { documentOptions, loadPdfjs } from './pdfjs';
import type { PdfPage } from './pagetext';
import type { InputFile, OpResult, OutputFile } from './types';

export interface ExtractImagesOptions {
  /**
   * Images shorter than this on either side are left behind. Defaults to 32.
   *
   * A page is full of images that are not pictures: the 1×8 gradient stretched
   * into a rule, the 6×6 bullet, the 1×1 spacer, the hairline that draws a
   * table border. Without a floor a two-page invoice yields ninety files and
   * the four the user wanted are somewhere in the middle. Pass 0 to keep
   * everything.
   */
  minSize?: number;
  /**
   * Include stencil masks — 1-bit shapes the page paints in a colour of its
   * own choosing. Defaults to false, because they are usually glyph-like
   * decoration and they come out as silhouettes; see the note in
   * `rasterFromMask` for why the colour cannot be recovered.
   */
  includeMasks?: boolean;
}

/**
 * What one recovered image turned out to be.
 *
 * `OpResult` has nowhere to carry this, so for now it only shapes the naming
 * and the counts below. It is exported so that a caller which grows a place
 * for it does not have to redeclare it.
 */
export interface ExtractedImage {
  name: string;
  width: number;
  height: number;
  /** 'jpeg' means the file's own bytes, untouched. 'png' means re-encoded here. */
  encoding: 'jpeg' | 'png';
  /** One-based pages this image is drawn on, in order. */
  pages: number[];
}

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/**
 * How long to wait for one image's pixels after its page's operator list has
 * arrived.
 *
 * pdf.js sends decoded images to the API side in their own messages, and
 * `getOperatorList()` resolves without waiting for them — the render path
 * waits on dependencies, and we are not the render path. In practice the
 * pixels are already there; this is the ceiling for the case where they are
 * not, so a single undecodable image costs a note rather than a hung tab.
 */
const IMAGE_WAIT_MS = 15_000;

/** Stop before the tab dies rather than after. Mirrors the PDF → images budget. */
const OUTPUT_BUDGET = 400 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * PNG output
 *
 * Written by hand for three reasons, none of them "not invented here":
 * a canvas cannot express a 1-bit image, its readback quantises partial alpha
 * against the premultiplied backing store, and OffscreenCanvas encoding is
 * asynchronous per image. fflate is already in the bundle and a PNG IDAT is
 * exactly a zlib stream, so this costs about a hundred lines and no dependency.
 * ------------------------------------------------------------------ */

/** 0 grey, 2 truecolour, 3 palette, 4 grey+alpha, 6 truecolour+alpha. */
type ColourType = 0 | 2 | 3 | 4 | 6;

interface Raster {
  width: number;
  height: number;
  colourType: ColourType;
  bitDepth: 1 | 8;
  /** Packed scanlines, `stride` bytes each, with no filter byte in front. */
  pixels: Uint8Array;
  /** Palette images only: three bytes per entry. */
  palette?: Uint8Array;
  /** The one grey sample that means "fully transparent". Stencil masks only. */
  transparentGrey?: number;
}

const CHANNELS: Record<ColourType, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const strideOf = (raster: Raster): number =>
  Math.ceil((raster.width * CHANNELS[raster.colourType] * raster.bitDepth) / 8);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Length, type, body, CRC — the shape every PNG chunk has. */
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Filters one scanline, choosing between None, Sub, Up and Paeth.
 *
 * The choice is made by the minimum-sum-of-absolute-values heuristic from the
 * PNG spec's own recommendations — it is not optimal and it is not meant to
 * be, it is the cheap rule that gets most of the win. Average is left out
 * because it costs a fifth pass over every row and, on the photographic and
 * bilevel content this tool actually sees, almost never wins.
 *
 * Sub and Paeth reference the pixel to the left, which is meaningless for
 * palette indexes and for sub-byte packing, so those get None or Up only.
 */
function filterRow(
  row: Uint8Array,
  previous: Uint8Array | null,
  bpp: number,
  wide: boolean
): { type: number; data: Uint8Array } {
  const length = row.length;
  const candidates: { type: number; data: Uint8Array }[] = [{ type: 0, data: row }];

  if (previous) {
    const up = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) up[i] = (row[i] - previous[i]) & 0xff;
    candidates.push({ type: 2, data: up });
  }

  if (wide) {
    const sub = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) sub[i] = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff;
    candidates.push({ type: 1, data: sub });

    const pae = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const above = previous ? previous[i] : 0;
      const corner = previous && i >= bpp ? previous[i - bpp] : 0;
      pae[i] = (row[i] - paeth(left, above, corner)) & 0xff;
    }
    candidates.push({ type: 4, data: pae });
  }

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    let score = 0;
    for (let i = 0; i < length; i += 1) {
      const value = candidate.data[i];
      score += value < 128 ? value : 256 - value;
    }
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function encodePng(raster: Raster): Uint8Array {
  const { width, height, colourType, bitDepth } = raster;
  const stride = strideOf(raster);
  const bpp = Math.max(1, (CHANNELS[colourType] * bitDepth) >> 3);
  // Sub and Paeth only make sense once a pixel occupies whole bytes and
  // neighbouring values are on the same scale — not for palette indexes.
  const wide = bitDepth === 8 && colourType !== 3;

  const raw = new Uint8Array((stride + 1) * height);
  let previous: Uint8Array | null = null;

  for (let y = 0; y < height; y += 1) {
    const row = raster.pixels.subarray(y * stride, (y + 1) * stride);
    const { type, data } = filterRow(row, previous, bpp, wide);
    raw[y * (stride + 1)] = type;
    raw.set(data, y * (stride + 1) + 1);
    previous = row;
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  // Compression 0, filter 0, interlace 0 — the only values PNG defines.

  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];

  if (raster.palette) parts.push(chunk('PLTE', raster.palette));
  if (raster.transparentGrey !== undefined) {
    const trns = new Uint8Array(2);
    new DataView(trns.buffer).setUint16(0, raster.transparentGrey);
    parts.push(chunk('tRNS', trns));
  }

  parts.push(chunk('IDAT', zlibSync(raw, { level: 6 })));
  parts.push(chunk('IEND', new Uint8Array(0)));

  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/* ------------------------------------------------------------------ *
 * Pixels → raster
 * ------------------------------------------------------------------ */

/** Above this many distinct colours a palette stops paying for itself. */
const PALETTE_LIMIT = 256;

/**
 * Chooses the narrowest PNG form that holds this RGBA buffer without changing
 * a single pixel.
 *
 * Every branch here is lossless. A page's screenshot or logo arrives as RGBA
 * because that is the only shape pdf.js will hand over once a soft mask is
 * involved, but the image underneath is often grey, or opaque, or has eleven
 * colours in it — and writing it as RGBA anyway makes the file three or four
 * times larger for no information gained. An indexed-palette image in the PDF
 * lands back in a palette here for the same reason, though not necessarily
 * with the original's palette order.
 */
function rasterFromRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): { raster: Raster; partialAlpha: boolean } {
  const count = width * height;

  let opaque = true;
  let partialAlpha = false;
  let grey = true;
  for (let i = 0; i < count; i += 1) {
    const at = i * 4;
    const alpha = data[at + 3];
    if (alpha !== 255) {
      opaque = false;
      if (alpha !== 0) partialAlpha = true;
    }
    if (grey && (data[at] !== data[at + 1] || data[at + 1] !== data[at + 2])) grey = false;
  }

  if (opaque && grey) {
    const pixels = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) pixels[i] = data[i * 4];
    return { raster: { width, height, colourType: 0, bitDepth: 8, pixels }, partialAlpha };
  }

  if (opaque) {
    return { raster: rasterFromRgb(data, width, height, 4), partialAlpha };
  }

  if (grey) {
    const pixels = new Uint8Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      pixels[i * 2] = data[i * 4];
      pixels[i * 2 + 1] = data[i * 4 + 3];
    }
    return { raster: { width, height, colourType: 4, bitDepth: 8, pixels }, partialAlpha };
  }

  const pixels = new Uint8Array(count * 4);
  pixels.set(data.subarray(0, count * 4));
  return { raster: { width, height, colourType: 6, bitDepth: 8, pixels }, partialAlpha };
}

/**
 * Opaque colour, as a palette where one fits and as truecolour where it does not.
 *
 * `stride` is 3 for pdf.js's packed RGB and 4 for RGBA whose alpha has already
 * been found to be uniformly opaque, which lets both callers share the one
 * scan. The palette matters more than it looks: a PDF that stores an image in
 * an /Indexed colour space has its palette expanded to full RGB by the
 * decoder, and writing that back out as truecolour triples a screenshot or a
 * logo for nothing.
 */
function rasterFromRgb(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride: 3 | 4
): Raster {
  const count = width * height;

  const seen = new Map<number, number>();
  const indexes = new Uint8Array(count);
  let indexed = true;

  for (let i = 0; i < count; i += 1) {
    const at = i * stride;
    const key = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
    let index = seen.get(key);
    if (index === undefined) {
      if (seen.size >= PALETTE_LIMIT) {
        indexed = false;
        break;
      }
      index = seen.size;
      seen.set(key, index);
    }
    indexes[i] = index;
  }

  if (indexed) {
    const palette = new Uint8Array(seen.size * 3);
    for (const [key, index] of seen) {
      palette[index * 3] = (key >> 16) & 0xff;
      palette[index * 3 + 1] = (key >> 8) & 0xff;
      palette[index * 3 + 2] = key & 0xff;
    }
    return { width, height, colourType: 3, bitDepth: 8, pixels: indexes, palette };
  }

  if (stride === 3) {
    return { width, height, colourType: 2, bitDepth: 8, pixels: padTo(data, count * 3, 0xff) };
  }

  const pixels = new Uint8Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    pixels[i * 3] = data[i * 4];
    pixels[i * 3 + 1] = data[i * 4 + 1];
    pixels[i * 3 + 2] = data[i * 4 + 2];
  }
  return { width, height, colourType: 2, bitDepth: 8, pixels };
}

/** Grows a short buffer to the length the dimensions imply. Truncated streams happen. */
function padTo(source: Uint8Array | Uint8ClampedArray, length: number, fill: number): Uint8Array {
  if (source.length >= length) return new Uint8Array(source.buffer, source.byteOffset, length);
  const out = new Uint8Array(length);
  out.set(source);
  out.fill(fill, source.length);
  return out;
}

/**
 * A bilevel image, kept bilevel.
 *
 * pdf.js packs `GRAYSCALE_1BPP` eight pixels to a byte, high bit first, with 0
 * meaning black — which is precisely PNG's 1-bit greyscale layout, including
 * the row stride. A scanned page therefore copies across without touching a
 * pixel, and a 2500 × 3500 fax that would be 26 MB as RGBA is a few hundred
 * kilobytes here.
 */
function rasterFromGrey1(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Raster {
  const stride = (width + 7) >> 3;
  return {
    width,
    height,
    colourType: 0,
    bitDepth: 1,
    // Missing rows are white, matching what pdf.js paints for a short stream.
    pixels: padTo(data, stride * height, 0xff),
  };
}

/**
 * A stencil mask: a 1-bit shape with no colour of its own.
 *
 * The PDF paints these in whatever fill colour is current at the moment they
 * are drawn, so the same mask can be black on one page and red on the next.
 * Recovering that would mean tracking the colour operators and would still
 * give a different answer per use, so the shape is written as black on
 * transparent and `notes` says so. The bit layout is again PNG's, so this is a
 * copy plus a tRNS chunk saying "sample 1 is transparent".
 */
function rasterFromMask(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Raster {
  const stride = (width + 7) >> 3;
  return {
    width,
    height,
    colourType: 0,
    bitDepth: 1,
    // Unpainted is 1, and a short stream leaves the rest unpainted.
    pixels: padTo(data, stride * height, 0xff),
    transparentGrey: 1,
  };
}

/* ------------------------------------------------------------------ *
 * What pdf.js hands over
 * ------------------------------------------------------------------ */

/** pdf.js's ImageKind. */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

interface PdfImageObject {
  width: number;
  height: number;
  /** Absent for stencil masks and for anything returned as a bitmap. */
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray | null;
  bitmap?: ImageBitmap | null;
  /** The source object, as `"12R"` or `"12R1"`. Absent for masks and inline images. */
  ref?: string;
}

function asImageObject(value: unknown): PdfImageObject | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<PdfImageObject>;
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') return null;
  if (candidate.width <= 0 || candidate.height <= 0) return null;
  return candidate as PdfImageObject;
}

/**
 * Reads a bitmap back to bytes.
 *
 * pdf.js returns an `ImageBitmap` rather than a pixel array wherever the
 * platform has OffscreenCanvas, which in this worker is everywhere. That is
 * the path a browser actually takes, and the only way back to bytes is a
 * canvas — so partial alpha has already been through a premultiplied backing
 * store by the time we see it, twice. Fully opaque and fully transparent
 * pixels, which is nearly all of them, are exact.
 */
function bytesFromBitmap(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser would not give us a surface to read the image back from.');
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  canvas.width = canvas.height = 0;
  return pixels;
}

interface Decoded {
  raster: Raster;
  /** True only when genuinely part-transparent pixels came back through a canvas. */
  softened: boolean;
}

function decode(image: PdfImageObject, isMask: boolean): Decoded {
  const { width, height } = image;

  if (image.bitmap) {
    const { raster, partialAlpha } = rasterFromRgba(bytesFromBitmap(image.bitmap), width, height);
    // Fully opaque and fully clear pixels survive premultiplication exactly, so
    // a hard-edged cut-out is not worth a caveat. Only the in-between is.
    return { raster, softened: partialAlpha };
  }

  const data = image.data;
  if (!data) throw new Error('pdf.js could not decode this image.');

  if (isMask) return { raster: rasterFromMask(data, width, height), softened: false };

  switch (image.kind) {
    case GRAYSCALE_1BPP:
      return { raster: rasterFromGrey1(data, width, height), softened: false };
    case RGB_24BPP:
      return { raster: rasterFromRgb(padTo(data, width * height * 3, 0xff), width, height, 3), softened: false };
    case RGBA_32BPP:
      return {
        raster: rasterFromRgba(padTo(data, width * height * 4, 0), width, height).raster,
        softened: false,
      };
    default:
      throw new Error('pdf.js returned this image in a form we do not recognise.');
  }
}

/* ------------------------------------------------------------------ *
 * What the file itself stores
 * ------------------------------------------------------------------ */

interface StoredImage {
  width: number;
  height: number;
  /** The `/DCTDecode` bytes exactly as the file holds them, when writing them out is safe. */
  jpeg: Uint8Array | null;
  /** True when the image carries an /SMask or /Mask — transparency to composite. */
  masked: boolean;
  /** True when the colour space is CMYK or a separation, so pdf.js had to convert. */
  converted: boolean;
}

/** Names that make a `/DCTDecode` stream a self-contained, correctly-coloured JPEG. */
const PLAIN_COLOUR = new Set(['DeviceRGB', 'DeviceGray', 'CalRGB', 'CalGray', 'G', 'RGB']);

/**
 * The component count from a JPEG's frame header, or null if there isn't one.
 *
 * The check that matters: four components means CMYK or YCCK, and an Adobe
 * APP14 marker usually means those values are stored inverted. Written out
 * verbatim such a file opens in most viewers as a photographic negative. So a
 * four-component JPEG goes down the decode path instead, where pdf.js applies
 * the colour transform properly and we lose the "verbatim" claim honestly.
 */
function jpegComponents(bytes: Uint8Array): number | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;

  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Start of scan, or end of image: no frame header is coming.
    if (marker === 0xda || marker === 0xd9) return null;

    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return null;

    // SOF0–SOF15, minus the three markers that share the range but are not frames.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return at + 9 < bytes.length ? bytes[at + 9] : null;

    at += 2 + length;
  }
  return null;
}

const nameOf = (value: unknown): string | null =>
  value instanceof PDFName ? value.asString().replace(/^\//, '') : null;

/**
 * Catalogues every image XObject the file stores, keyed the way pdf.js names
 * its source object: `"12R"`, or `"12R1"` when the generation is not zero.
 *
 * The bytes are copied out here rather than referenced, because pdf.js takes
 * ownership of the input buffer and detaches it — a view into the original
 * would be empty by the time it was needed.
 */
function catalogue(doc: PDFDocument): Map<string, StoredImage> {
  const stored = new Map<string, StoredImage>();

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;

    const dict = object.dict;
    if (nameOf(dict.get(PDFName.of('Subtype'))) !== 'Image') continue;

    const width = dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0;
    const height = dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() ?? 0;
    if (width <= 0 || height <= 0) continue;

    const filterEntry = dict.lookup(PDFName.of('Filter'));
    const filters =
      filterEntry instanceof PDFArray
        ? filterEntry.asArray().map((entry) => nameOf(entry))
        : [nameOf(filterEntry)];

    const masked = dict.has(PDFName.of('SMask')) || dict.has(PDFName.of('Mask'));

    const space = dict.lookup(PDFName.of('ColorSpace'));
    const spaceName = nameOf(space);
    const family = space instanceof PDFArray ? nameOf(space.get(0)) : spaceName;
    const converted =
      family === 'DeviceCMYK' || family === 'Separation' || family === 'DeviceN';

    let jpeg: Uint8Array | null = null;
    // Verbatim output is only honest when the stored bytes are the whole
    // picture: one JPEG filter and nothing layered on top, no /Decode
    // inversion, no transparency to composite, a colour space a standalone
    // JPEG can carry, and three components or fewer.
    if (
      filters.length === 1 &&
      filters[0] === 'DCTDecode' &&
      !masked &&
      !dict.has(PDFName.of('Decode')) &&
      spaceName !== null &&
      PLAIN_COLOUR.has(spaceName)
    ) {
      const bytes = object.getContents();
      const components = jpegComponents(bytes);
      if (components !== null && components <= 3) jpeg = bytes.slice();
    }

    const key =
      ref.generationNumber === 0
        ? `${ref.objectNumber}R`
        : `${ref.objectNumber}R${ref.generationNumber}`;
    stored.set(key, { width, height, jpeg, masked, converted });
  }

  return stored;
}

/* ------------------------------------------------------------------ *
 * Walking the page
 * ------------------------------------------------------------------ */

/** One image-painting operator, reduced to what identifies the image. */
interface Hit {
  /** The pdf.js object id, or null for an image carried inline in the operator. */
  id: string | null;
  isMask: boolean;
  inline: PdfImageObject | null;
}

function readMaskArg(arg: unknown): string | null {
  if (typeof arg !== 'object' || arg === null) return null;
  const data = (arg as { data?: unknown }).data;
  return typeof data === 'string' ? data : null;
}

async function imagesOnPage(page: PdfPage): Promise<Hit[]> {
  const { OPS } = await loadPdfjs();
  const operators = await page.getOperatorList();
  const hits: Hit[] = [];

  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const op = operators.fnArray[index];
    const args: unknown = operators.argsArray[index];
    if (!Array.isArray(args)) continue;

    if (op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat) {
      // Both carry the object id first; Repeat is the same image stamped at a
      // list of positions, which for extraction is one image either way.
      const id: unknown = args[0];
      if (typeof id === 'string') hits.push({ id, isMask: false, inline: null });
    } else if (op === OPS.paintImageMaskXObject || op === OPS.paintImageMaskXObjectRepeat) {
      const id = readMaskArg(args[0]);
      if (id) hits.push({ id, isMask: true, inline: null });
    } else if (op === OPS.paintImageMaskXObjectGroup) {
      const group: unknown = args[0];
      if (!Array.isArray(group)) continue;
      for (const entry of group) {
        const id = readMaskArg(entry);
        if (id) hits.push({ id, isMask: true, inline: null });
      }
    } else if (op === OPS.paintInlineImageXObject) {
      // A small inline image never becomes an object — its pixels are the
      // operator's argument, so there is nothing to resolve.
      const inline = asImageObject(args[0]);
      if (inline) hits.push({ id: null, isMask: false, inline });
    }
  }

  return hits;
}

interface ObjectStore {
  has(id: string): boolean;
  get(id: string): unknown;
  get(id: string, callback: (data: unknown) => void): null;
}

/**
 * The image behind an id, or null if it never arrived.
 *
 * Three things are load-bearing. Objects only exist after `getOperatorList()`
 * has run, which is why this is never called before it. `get()` throws rather
 * than returning undefined for an id that has not resolved, so `has()` is not
 * optional. And a globally-cached image is sent to the *document*'s object
 * store rather than the page's, so both have to be asked — a picture repeated
 * across forty pages is exactly the case pdf.js promotes, and exactly the case
 * this tool cares about.
 */
async function resolveImage(page: PdfPage, id: string): Promise<PdfImageObject | null> {
  const local = page.objs as unknown as ObjectStore;
  const shared = page.commonObjs as unknown as ObjectStore;

  if (local.has(id)) return asImageObject(local.get(id));
  if (shared.has(id)) return asImageObject(shared.get(id));

  // Still in flight. Globally-cached ids are prefixed with the document id.
  const store = id.startsWith('g_') ? shared : local;
  const value = await new Promise<unknown>((resolve) => {
    let settled = false;
    const finish = (data: unknown) => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    const timer = setTimeout(() => finish(null), IMAGE_WAIT_MS);
    store.get(id, (data: unknown) => {
      clearTimeout(timer);
      finish(data);
    });
  });

  return asImageObject(value);
}

/* ------------------------------------------------------------------ *
 * The tool
 * ------------------------------------------------------------------ */

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Cheap content hash, for images the file gives no identity of its own. */
function fingerprint(bytes: Uint8Array | Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}

interface Collected {
  file: OutputFile;
  detail: ExtractedImage;
}

export async function extractImages(
  files: InputFile[],
  options: ExtractImagesOptions = {}
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to pull the images out of.' };

  const minSize = Math.max(0, options.minSize ?? 32);
  const includeMasks = options.includeMasks ?? false;

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  // pdf.js takes ownership of the buffer it is handed and detaches it, so it
  // gets a copy and pdf-lib keeps the original. Two passes over the same file
  // is the price of having both the decoded pixels and the stored bytes.
  const forRenderer = new Uint8Array(file.bytes.slice(0));

  let stored: Map<string, StoredImage>;
  try {
    const doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
    stored = catalogue(doc);
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.toLowerCase().includes('encrypt')
        ? 'This PDF is password-protected. Unlock it first, then try again.'
        : `This file could not be read as a PDF: ${message}`,
    };
  }

  const api = await loadPdfjs();
  const source = await api.getDocument({ data: forRenderer, ...documentOptions() }).promise;

  const stem = baseName(file.name);
  const pad = String(source.numPages).length;

  const collected: Collected[] = [];

  /**
   * Two indexes, because an image has two identities and both matter.
   *
   * `byImage` is keyed on the source object the file stores — that is what
   * makes twenty pages of the same letterhead one file instead of twenty.
   * pdf.js gives that image a *different* object id on every page unless it
   * happens to promote it to the document-wide cache, so its ids cannot be the
   * primary key. `byObjId` is the shortcut on top: once an id is known, a
   * later page skips resolving and re-encoding entirely.
   */
  const byImage = new Map<string, number>();
  const byObjId = new Map<string, number>();
  /** Ids and content keys already ruled out, so they are not re-counted per page. */
  const dismissed = new Set<string>();

  let tooSmall = 0;
  let masksSkipped = 0;
  let failed = 0;
  let verbatim = 0;
  let reencoded = 0;
  let cmyk = 0;
  let composited = 0;
  let softened = 0;
  let downscaled = 0;
  let budgetHitAt = 0;
  let bytesOut = 0;

  try {
    for (let n = 1; n <= source.numPages && budgetHitAt === 0; n += 1) {
      const page = await source.getPage(n);
      let ordinal = 0;

      let hits: Hit[];
      try {
        hits = await imagesOnPage(page);
      } catch {
        // A page whose content stream will not parse has no readable images.
        // The rest of the document is unaffected, so carry on.
        failed += 1;
        page.cleanup();
        continue;
      }

      /** Notes that this page also draws an image already written out. */
      const alsoHere = (index: number): void => {
        const pages = collected[index].detail.pages;
        if (pages[pages.length - 1] !== n) pages.push(n);
      };

      for (const hit of hits) {
        // Cheapest path first: an id seen before needs neither resolving nor
        // re-encoding, only a page number.
        if (hit.id !== null) {
          const known = byObjId.get(hit.id);
          if (known !== undefined) {
            alsoHere(known);
            continue;
          }
          if (dismissed.has(hit.id)) continue;
        }

        if (hit.isMask && !includeMasks) {
          masksSkipped += 1;
          continue;
        }

        let image: PdfImageObject | null;
        try {
          image = hit.inline ?? (hit.id ? await resolveImage(page, hit.id) : null);
        } catch {
          image = null;
        }
        if (!image) {
          failed += 1;
          if (hit.id) dismissed.add(hit.id);
          continue;
        }

        const record = image.ref ? stored.get(image.ref) : undefined;

        /**
         * The image's identity across the whole document.
         *
         * `ref` is the file's own object number, which is the real answer.
         * Masks and inline images have none, so they fall back to a hash of
         * their pixels — the same inline logo on every page hashes the same,
         * and hashing here rather than after encoding means a repeat costs
         * nothing to detect.
         */
        const identity =
          image.ref !== undefined
            ? `ref:${image.ref}`
            : image.data
              ? `pix:${image.width}x${image.height}:${fingerprint(image.data)}`
              : null;

        if (identity !== null) {
          const known = byImage.get(identity);
          if (known !== undefined) {
            if (hit.id) byObjId.set(hit.id, known);
            alsoHere(known);
            continue;
          }
          if (dismissed.has(identity)) {
            if (hit.id) dismissed.add(hit.id);
            continue;
          }
        }

        // The size filter judges the original, not the decoder's copy of it:
        // pdf.js reports what it decoded to, which is smaller when it had to
        // shrink a huge image, and larger when a soft mask outsizes its image.
        const width = Math.max(record?.width ?? 0, image.width);
        const height = Math.max(record?.height ?? 0, image.height);

        if (minSize > 0 && (width < minSize || height < minSize)) {
          tooSmall += 1;
          if (hit.id) dismissed.add(hit.id);
          if (identity) dismissed.add(identity);
          continue;
        }

        let bytes: Uint8Array;
        let encoding: 'jpeg' | 'png';
        let outWidth: number;
        let outHeight: number;
        let soft = false;
        let shrunk = false;

        if (record?.jpeg) {
          bytes = record.jpeg;
          encoding = 'jpeg';
          outWidth = record.width;
          outHeight = record.height;
        } else {
          let raster: Raster;
          try {
            const decoded = decode(image, hit.isMask);
            raster = decoded.raster;
            bytes = encodePng(raster);
            soft = decoded.softened;
          } catch {
            failed += 1;
            if (hit.id) dismissed.add(hit.id);
            if (identity) dismissed.add(identity);
            continue;
          }
          encoding = 'png';
          outWidth = raster.width;
          outHeight = raster.height;
          shrunk = !!record && (record.width > raster.width || record.height > raster.height);
        }

        // Last resort for an image the file gives no identity to and that
        // pdf.js handed over as a bitmap rather than as bytes — a stencil mask
        // in a browser, in practice. The encoded file is all there is to
        // compare, so the comparison waits until there is one.
        const settled = identity ?? `out:${fingerprint(bytes)}`;
        const twin = byImage.get(settled);
        if (twin !== undefined) {
          if (hit.id) byObjId.set(hit.id, twin);
          alsoHere(twin);
          continue;
        }

        if (encoding === 'jpeg') verbatim += 1;
        else {
          reencoded += 1;
          if (soft) softened += 1;
          if (shrunk) downscaled += 1;
          if (record?.converted) cmyk += 1;
          if (record?.masked) composited += 1;
        }

        ordinal += 1;
        const name = `${stem}-p${String(n).padStart(pad, '0')}-${ordinal}.${encoding === 'jpeg' ? 'jpg' : 'png'}`;
        const index = collected.length;

        byImage.set(settled, index);
        if (hit.id) byObjId.set(hit.id, index);
        collected.push({
          file: { name, bytes, type: encoding === 'jpeg' ? 'image/jpeg' : 'image/png' },
          detail: { name, width: outWidth, height: outHeight, encoding, pages: [n] },
        });

        bytesOut += bytes.length;
        if (bytesOut > OUTPUT_BUDGET) {
          budgetHitAt = n;
          break;
        }
      }

      page.cleanup();
    }
  } catch (error) {
    await source.destroy();
    return { ok: false, error: `Could not read the images: ${(error as Error).message}` };
  }

  const pageCount = source.numPages;
  await source.destroy();

  if (collected.length === 0) {
    const reason =
      tooSmall > 0
        ? ` Every one of the ${tooSmall} it does have is under ${minSize} px on one side. Lower the minimum size to get them anyway.`
        : ' Its pages are drawn entirely with text and vector graphics.';
    return { ok: false, error: `This PDF has no images to pull out.${reason}` };
  }

  const repeated = collected.filter((entry) => entry.detail.pages.length > 1).length;

  const notes: string[] = [];

  if (verbatim > 0) {
    notes.push(
      verbatim === 1
        ? '1 image came out byte-for-byte: it was stored as a JPEG and was copied rather than decoded and re-saved, so nothing was lost.'
        : `${verbatim} images came out byte-for-byte: they were stored as JPEGs and were copied rather than decoded and re-saved, so nothing was lost.`
    );
  }
  if (reencoded > 0) {
    notes.push(
      `${plural(reencoded, 'image')} ${reencoded === 1 ? 'was' : 'were'} written as PNG. PDF stores these in formats no image viewer reads on its own, so they were decoded and re-saved — losslessly, at their full stored resolution.`
    );
  }
  if (composited > 0) {
    notes.push(
      `${plural(composited, 'image')} had a transparency mask, which was applied. A cut-out comes out as a cut-out rather than a rectangle on black.`
    );
  }
  if (softened > 0) {
    notes.push(
      `${plural(softened, 'image')} with partly-transparent pixels passed through a canvas on the way out, which stores colour multiplied by opacity. Fully opaque and fully clear pixels are exact; the faintest edge pixels can be off by one.`
    );
  }
  if (cmyk > 0) {
    notes.push(
      `${plural(cmyk, 'image')} ${cmyk === 1 ? 'was' : 'were'} stored in CMYK or a spot colour and ${cmyk === 1 ? 'is' : 'are'} now RGB. PNG has no CMYK, so this conversion is unavoidable and not reversible — go back to the PDF if you need the press values.`
    );
  }
  if (repeated > 0) {
    notes.push(
      `${plural(repeated, 'image')} ${repeated === 1 ? 'is' : 'are'} drawn on more than one page and ${repeated === 1 ? 'was' : 'were'} written once, named for the first page ${repeated === 1 ? 'it appears' : 'they appear'} on.`
    );
  }
  if (downscaled > 0) {
    notes.push(
      `${plural(downscaled, 'image')} ${downscaled === 1 ? 'was' : 'were'} larger than the decoder would hold in one piece and came back scaled down. The size shown is the original's; the pixels are not all there.`
    );
  }
  if (tooSmall > 0) {
    notes.push(
      `Left behind ${plural(tooSmall, 'image')} under ${minSize} px — rules, bullets, spacers and hairlines. Lower the minimum size if you want them.`
    );
  }
  if (masksSkipped > 0) {
    notes.push(
      `Skipped ${plural(masksSkipped, 'stencil-mask drawing')} — 1-bit shapes the page paints in a colour of its own, so they can only come back as black silhouettes. Turn masks on if you want them. One shape reused across pages is counted once per use here, so there are fewer distinct shapes than that.`
    );
  }
  if (includeMasks) {
    notes.push(
      'Stencil masks were included. They are written black on transparent: the colour they are painted in belongs to the page, not to the image, and can differ each time one is used.'
    );
  }
  if (failed > 0) {
    notes.push(
      `${plural(failed, 'image')} could not be decoded and ${failed === 1 ? 'was' : 'were'} skipped. That usually means a damaged or truncated stream in the file itself.`
    );
  }
  if (budgetHitAt > 0) {
    notes.push(
      `Stopped at page ${budgetHitAt}: the images had already passed 400 MB, which would crash this tab. Split the document and run it again on the part you need.`
    );
  }

  notes.push(
    'These are the images as the document stores them, not screenshots of the pages — so an image that appears small on the page can come out very large, and one used as a background comes out with the page text nowhere on it.'
  );

  return {
    ok: true,
    files: collected.map((entry) => entry.file),
    bytesIn,
    bytesOut,
    pages: pageCount,
    durationMs: performance.now() - started,
    summary: `${plural(collected.length, 'image')} from ${plural(pageCount, 'page')}`,
    notes,
  };
}
