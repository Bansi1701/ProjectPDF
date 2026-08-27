/**
 * Greyscale — taking the colour out without taking the document apart.
 *
 * The easy version of this tool renders every page, desaturates the pixels and
 * calls it done. It looks right in a thumbnail and it is the wrong trade. The
 * text layer goes with the colour: no selection, no search, no copy-paste, no
 * screen reader, no accessibility tree. redact.ts does rasterise, deliberately
 * and at length, because there the whole point is that nothing survives behind
 * the black box. Nobody converting a document to greyscale is asking for that.
 * And on anything but a scan the "compressed" result comes out several times
 * LARGER than the input, because a page of glyph codes is a few kilobytes and
 * a page of pixels is a few hundred.
 *
 * So nothing here rasterises anything. Colour is rewritten where the file
 * writes it down, and only there:
 *
 *   - in content streams, the colour operators (rg RG k K cs CS sc scn SC SCN)
 *     are replaced in place with their DeviceGray equivalents. Every other
 *     operator, including all the text and all the geometry, comes out byte
 *     for byte as it went in;
 *   - in image XObjects the samples are converted and re-encoded as
 *     single-channel DeviceGray, which is where the file size actually falls —
 *     three channels become one before compression even starts;
 *   - in Indexed images only the PALETTE is converted. The pixel data is not
 *     touched at all, because it is a table of indexes and the indexes do not
 *     change. That is the cheapest correct conversion in this file and it is
 *     exact.
 *
 * What cannot be converted honestly is left in colour and counted, and the
 * counts are reported rather than quietly swallowed. A Separation ink is a
 * named plate on a press, not a number this code is entitled to reinterpret;
 * a DeviceN is several of them; a shading carries its colours inside a
 * function; and a luminosity soft mask uses colour to mean *transparency*, so
 * greying it would silently change what is visible rather than what is
 * coloured. Each of those is left exactly as it was.
 *
 * On the luminance weights, because "convert to grey" hides two decisions:
 *
 *   Naive code sums the components — (R+G+B)/3 — which makes pure blue as
 *   light as pure yellow and turns a chart into mush. The weights below are
 *   Rec. 709's, which is what "luminance" means for anything sRGB-shaped.
 *
 *   Less obviously, the weighted sum has to happen on LIGHT, not on the
 *   numbers. DeviceRGB values are gamma-encoded; adding them directly (the
 *   Rec. 601 luma most tools use) treats an encoded number as if it were an
 *   amount of light and systematically mis-weights saturated colour. So each
 *   component is linearised, weighted, and the result re-encoded. Black stays
 *   black and white stays white either way — the difference is in the mid
 *   tones, which is most of a document.
 *
 * PDF's DeviceRGB is not formally sRGB; it is "whatever the device does".
 * Every reader in use treats it as sRGB, so this does too, and says so in the
 * notes rather than pretending the conversion is colour-managed.
 *
 * Nothing here uploads, logs or names a file. The document is read, rewritten
 * and handed back in this tab.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

import { tokenize, type Token } from './content';
import { replaceStream } from './streams';
import type { InputFile, OpResult } from './types';

export interface GrayscaleOptions {
  /**
   * Quality for JPEGs that have to be decoded and re-encoded, 0–1.
   *
   * Only DCTDecode images are affected — everything else in this file is
   * converted without a second lossy pass. The default keeps the picture: at
   * 0.82 a re-encoded scan is hard to tell from the original at 100%, and
   * below about 0.7 the ringing around text starts to show, which on a scanned
   * document is exactly the thing you were keeping.
   *
   * Note that keeping the picture and shrinking the file are not the same
   * goal, and on an already hard-packed scan they conflict: measured on a
   * 2416 × 3200 colour scan whose JPEG was stored at about a third of a bit
   * per pixel, the grey re-encode came out 21% LARGER at 0.82 and only 3%
   * smaller at 0.4. Dropping quality until the number looks good is not a
   * decision this file makes for anyone — it converts, measures, and says
   * what happened.
   */
  jpegQuality?: number;
}

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/**
 * The most pixels this will hand a canvas for one image.
 *
 * A JPEG is the one thing here that needs a decoder we do not own, so it goes
 * through OffscreenCanvas — and an oversized allocation there does not throw,
 * it takes the tab with it. Anything past this is left in colour and counted.
 */
const MAX_IMAGE_PIXELS = 40_000_000;

/** Bail out of a stream rather than re-tokenize it this many times. See scanContent. */
const MAX_INLINE_IMAGES = 64;

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** sRGB's transfer curve, undone. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** …and put back. */
const fromLinear = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

const R_WEIGHT = 0.2126;
const G_WEIGHT = 0.7152;
const B_WEIGHT = 0.0722;

/** One RGB colour, 0–1 per component, as a single DeviceGray value. */
function greyOfRgb(r: number, g: number, b: number): number {
  const light =
    R_WEIGHT * toLinear(clamp01(r)) + G_WEIGHT * toLinear(clamp01(g)) + B_WEIGHT * toLinear(clamp01(b));
  return clamp01(fromLinear(light));
}

/**
 * CMYK the way the spec says a device without a profile must do it
 * (ISO 32000-1 §8.6.4.4): each ink is subtracted from the corresponding
 * additive component and clipped, then black on top.
 *
 * This is ink, so it is an approximation of an approximation — the real answer
 * lives in a press profile this file has no access to and will not invent. It
 * matches what a reader shows on screen, which is the thing the user is
 * looking at when they ask for grey.
 */
function greyOfCmyk(c: number, m: number, y: number, k: number): number {
  return greyOfRgb(
    1 - Math.min(1, clamp01(c) + clamp01(k)),
    1 - Math.min(1, clamp01(m) + clamp01(k)),
    1 - Math.min(1, clamp01(y) + clamp01(k))
  );
}

/**
 * The same maths as `greyOfRgb`, in tables, for the per-pixel path.
 *
 * An image is millions of calls; two `Math.pow`s per component each time is the
 * difference between a conversion that feels instant and one that does not.
 * The forward table is exact (256 inputs); the inverse is quantised to 12 bits,
 * which is four times finer than the 8-bit answer it produces.
 */
const LINEAR_OF_BYTE = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = toLinear(i / 255);
  return table;
})();

const BYTE_OF_LINEAR = (() => {
  const table = new Uint8Array(4096);
  for (let i = 0; i < 4096; i += 1) table[i] = Math.round(fromLinear(i / 4095) * 255);
  return table;
})();

const greyByteOfRgb = (r: number, g: number, b: number): number =>
  BYTE_OF_LINEAR[
    Math.round(
      (R_WEIGHT * LINEAR_OF_BYTE[r] + G_WEIGHT * LINEAR_OF_BYTE[g] + B_WEIGHT * LINEAR_OF_BYTE[b]) *
        4095
    )
  ];

const greyByteOfCmyk = (c: number, m: number, y: number, k: number): number => {
  const r = Math.max(0, 255 - c - k);
  const g = Math.max(0, 255 - m - k);
  const b = Math.max(0, 255 - y - k);
  return greyByteOfRgb(r, g, b);
};

/** PDF numbers, short. `0.5000` in a content stream is four wasted bytes. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const fixed = n.toFixed(4);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed;
}

/* ------------------------------------------------------------------ *
 * Colour spaces
 * ------------------------------------------------------------------ */

/**
 * A colour space, reduced to the two things this file needs: how many operands
 * it takes, and whether grey can stand in for it.
 */
type SpaceKind =
  | { kind: 'grey' }
  | { kind: 'rgb' }
  | { kind: 'cmyk' }
  /** Indexed: operands are indexes into a palette, so only the palette moves. */
  | { kind: 'indexed'; array: PDFArray }
  /**
   * Pattern. `underlying` is set only for the array form, `[/Pattern base]`,
   * which means an UNCOLOURED pattern: the shape is in the pattern and the
   * colour is in the page's `scn` operands. Those operands are left alone —
   * see the note where they are counted.
   */
  | { kind: 'pattern'; underlying?: SpaceKind }
  | { kind: 'other'; reason: string };

const nameOf = (obj: PDFObject | undefined): string | null =>
  obj instanceof PDFName ? String(obj).replace(/^\//, '') : null;

const DEVICE_SPACES: Record<string, SpaceKind> = {
  DeviceGray: { kind: 'grey' },
  G: { kind: 'grey' },
  CalGray: { kind: 'grey' },
  DeviceRGB: { kind: 'rgb' },
  RGB: { kind: 'rgb' },
  CalRGB: { kind: 'rgb' },
  DeviceCMYK: { kind: 'cmyk' },
  CMYK: { kind: 'cmyk' },
  Pattern: { kind: 'pattern' },
};

/**
 * Reads a colour space object.
 *
 * ICCBased is the interesting one, and it is everywhere — every PDF that has
 * ever been near Illustrator or Word tags its RGB as ICCBased. The profile
 * itself cannot be evaluated here, so this does what ISO 32000-1 §8.6.5.5 tells
 * a reader that cannot use the profile to do: fall through to /Alternate, or,
 * when there is none, to the device space implied by /N. That is the spec's own
 * fallback rather than an invention, and it is stated in the notes, because a
 * wide-gamut profile will shift a little under it.
 */
function classify(obj: PDFObject | undefined, doc: PDFDocument, depth = 0): SpaceKind {
  if (!obj || depth > 4) return { kind: 'other', reason: 'a colour space that could not be read' };

  const resolved = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;

  const asName = nameOf(resolved);
  if (asName) {
    const device = DEVICE_SPACES[asName];
    return device ?? { kind: 'other', reason: 'a colour space named by a resource that is missing' };
  }

  if (!(resolved instanceof PDFArray) || resolved.size() === 0) {
    return { kind: 'other', reason: 'a colour space that could not be read' };
  }

  const family = nameOf(resolved.lookup(0));

  switch (family) {
    case 'ICCBased': {
      const profile = resolved.lookup(1);
      const dict = profile instanceof PDFRawStream ? profile.dict : undefined;
      const alternate = dict?.lookup(PDFName.of('Alternate'));
      if (alternate) return classify(alternate, doc, depth + 1);
      const n = dict?.lookup(PDFName.of('N'));
      const components = n instanceof PDFNumber ? n.asNumber() : 0;
      if (components === 1) return { kind: 'grey' };
      if (components === 3) return { kind: 'rgb' };
      if (components === 4) return { kind: 'cmyk' };
      return { kind: 'other', reason: 'an ICC colour space with an unusual number of channels' };
    }
    case 'CalGray':
      return { kind: 'grey' };
    case 'CalRGB':
      return { kind: 'rgb' };
    case 'DeviceGray':
      return { kind: 'grey' };
    case 'DeviceRGB':
      return { kind: 'rgb' };
    case 'DeviceCMYK':
      return { kind: 'cmyk' };
    case 'Indexed':
    case 'I':
      return { kind: 'indexed', array: resolved };
    case 'Pattern':
      return {
        kind: 'pattern',
        underlying: resolved.size() > 1 ? classify(resolved.lookup(1), doc, depth + 1) : undefined,
      };
    case 'Separation':
      return { kind: 'other', reason: 'a Separation ink, which names a printing plate' };
    case 'DeviceN':
      return { kind: 'other', reason: 'a DeviceN ink set, which names printing plates' };
    case 'Lab':
      return { kind: 'other', reason: 'a Lab colour space' };
    default:
      return { kind: 'other', reason: 'a colour space this tool does not recognise' };
  }
}

/**
 * Resolves a colour space the way a content stream or an image names one.
 *
 * `/DeviceRGB` means itself; `/CS0` means whatever the resources dictionary in
 * scope says it means. Anything that is not a name — an inline array, a
 * reference to one — goes straight to the classifier.
 */
function spaceFromResources(
  obj: PDFObject | undefined,
  resources: PDFDict | undefined,
  doc: PDFDocument
): SpaceKind {
  const asName = nameOf(obj instanceof PDFRef ? doc.context.lookup(obj) : obj);
  if (!asName) return classify(obj, doc);

  const device = DEVICE_SPACES[asName];
  if (device) return device;

  const table = resources?.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
  const entry = table?.get(PDFName.of(asName));
  if (!entry) return { kind: 'other', reason: 'a colour space named by a resource that is missing' };
  return classify(entry, doc);
}

/* ------------------------------------------------------------------ *
 * Content streams
 * ------------------------------------------------------------------ */

/** Colour spaces as the graphics state tracks them, per ISO 32000-1 §8.4. */
interface ColourState {
  kind: SpaceKind['kind'];
  /** True when the space has been swapped for DeviceGray and operands must collapse. */
  converted: boolean;
  /** False while this is only the DeviceGray the spec starts every stream with. */
  explicit: boolean;
}

/**
 * The colour part of the graphics state as it stands between streams.
 *
 * It has to survive between them. A page's /Contents is allowed to be an ARRAY
 * of streams, and the spec is explicit that they are one stream cut at token
 * boundaries — so a producer can legally set `/CS0 cs` at the end of one part
 * and write `0.2 0.4 0.6 scn` at the start of the next. Rewriting each part as
 * if it began fresh would convert the first and not the second, leaving three
 * operands aimed at a one-channel space: a page that renders wrong, from a
 * file that parses fine.
 */
interface StreamState {
  fill: ColourState;
  stroke: ColourState;
  stack: ColourState[];
}

const GREY_STATE: ColourState = { kind: 'grey', converted: false, explicit: false };

const freshState = (): StreamState => ({
  fill: { ...GREY_STATE },
  stroke: { ...GREY_STATE },
  stack: [],
});

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

interface RewriteResult {
  text: string;
  /** The colour state at the end, for the next part of a split content stream. */
  state: StreamState;
  /** Colour operators actually changed. */
  operators: number;
  inlineImages: number;
  /** One entry per construct left in colour, ready for the tally. */
  skipped: string[];
  /** False when the stream could not be read safely and must be left untouched. */
  ok: boolean;
}

const isNumber = (token: Token): boolean =>
  token.kind === 'other' && /^[-+]?(\d+\.?\d*|\.\d+)$/.test(token.value);

const numberOf = (token: Token): number => Number.parseFloat(token.value);

const isSpace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\0';

/**
 * Finds the end of an inline image's sample data.
 *
 * `EI` can occur inside the samples by coincidence, so this only accepts one
 * that is delimited on both sides — the same heuristic every reader uses, and
 * the reason inline images are a bad idea in a format that also has XObjects.
 * When no delimited `EI` turns up, the caller declines the whole stream rather
 * than edit around a boundary it cannot see.
 */
function findInlineEnd(text: string, from: number): number {
  for (let i = from; i + 1 < text.length; i += 1) {
    if (text[i] !== 'E' || text[i + 1] !== 'I') continue;
    if (!isSpace(text[i - 1])) continue;
    const after = text[i + 2];
    if (after === undefined || isSpace(after) || after === '/' || after === '[' || after === '<') {
      return i + 2;
    }
  }
  return -1;
}

/**
 * Tokenizes a content stream, stepping over inline image data.
 *
 * content.ts's tokenizer is the right one — it is the careful one, with real
 * string and comment handling — but like every PDF tokenizer it cannot be
 * pointed at the bytes between `ID` and `EI`, which are raw samples and can
 * contain anything. A single unbalanced `(` in a JPEG would swallow the rest
 * of the page, and the offsets that came back would be fiction. Every edit in
 * this file is an offset into this text, so fiction here means a corrupt file.
 *
 * The samples are therefore skipped without ever being tokenized, and the
 * inline images themselves are counted and left in colour.
 */
function scanContent(text: string): { tokens: Token[]; inlineImages: number; ok: boolean } {
  const tokens: Token[] = [];
  let base = 0;
  let inlineImages = 0;

  for (;;) {
    const slice = base === 0 ? text : text.slice(base);
    const batch = tokenize(slice);

    const biAt = batch.findIndex((token) => token.kind === 'operator' && token.value === 'BI');
    if (biAt < 0) {
      for (const token of batch) {
        tokens.push({ ...token, start: token.start + base, end: token.end + base });
      }
      return { tokens, inlineImages, ok: true };
    }

    for (let i = 0; i < biAt; i += 1) {
      const token = batch[i];
      tokens.push({ ...token, start: token.start + base, end: token.end + base });
    }

    // BI…ID is a dictionary and tokenizes fine; only what follows ID does not.
    const id = batch.slice(biAt).find((token) => token.kind === 'operator' && token.value === 'ID');
    if (!id) return { tokens, inlineImages, ok: false };

    const end = findInlineEnd(slice, id.end + 1);
    if (end < 0) return { tokens, inlineImages, ok: false };

    inlineImages += 1;
    if (inlineImages > MAX_INLINE_IMAGES) return { tokens, inlineImages, ok: false };
    base += end;

    // A stand-in for the image, so the walker's pending operands are cleared.
    // Without it an operand sitting in front of `BI` would be read as though it
    // belonged to the first operator after `EI`.
    tokens.push({ kind: 'operator', value: 'EI', start: base, end: base });
  }
}

/**
 * Rewrites every colour operator in one content stream.
 *
 * The graphics state matters here in a way that is easy to miss: `1 0 0 rg`
 * does not only set a colour, it sets the current colour SPACE to DeviceRGB.
 * Rewrite it to `0.2 g` and the space is now DeviceGray, so a later `0 1 0 sc`
 * — three operands, perfectly legal before the edit — becomes a malformed
 * operator that readers handle by ignoring the colour, or the page. So the
 * state machine tracks what each edit did to the space, and collapses the
 * operands of any `sc`/`scn` that follows. q/Q save and restore it, because
 * the colour space is part of the graphics state that q/Q saves.
 */
function rewriteColour(
  text: string,
  lookup: (name: string) => SpaceKind,
  carried: StreamState = freshState()
): RewriteResult {
  const scan = scanContent(text);
  if (!scan.ok) {
    return {
      text,
      state: carried,
      operators: 0,
      inlineImages: scan.inlineImages,
      skipped: [],
      ok: false,
    };
  }

  const edits: Edit[] = [];
  const skipped: string[] = [];
  const stack: ColourState[] = carried.stack;
  let fill: ColourState = carried.fill;
  let stroke: ColourState = carried.stroke;
  let operands: Token[] = [];
  let operators = 0;

  /** Replaces `operands…operator` with a single grey value and `op`. */
  const collapse = (op: Token, values: number[], grey: number, replacementOp: string): void => {
    const first = operands[operands.length - values.length];
    if (!first) {
      skipped.push('a colour operator with the wrong number of operands');
      return;
    }
    edits.push({ start: first.start, end: op.end, replacement: `${fmt(grey)} ${replacementOp}` });
    operators += 1;
  };

  const tail = (count: number): number[] | null => {
    if (operands.length < count) return null;
    const slice = operands.slice(operands.length - count);
    if (!slice.every(isNumber)) return null;
    return slice.map(numberOf);
  };

  for (const token of scan.tokens) {
    if (token.kind !== 'operator') {
      operands.push(token);
      continue;
    }

    switch (token.value) {
      case 'q':
        stack.push({ ...fill }, { ...stroke });
        break;
      case 'Q': {
        const savedStroke = stack.pop();
        const savedFill = stack.pop();
        if (savedFill && savedStroke) {
          fill = savedFill;
          stroke = savedStroke;
        }
        break;
      }

      case 'g':
        fill = { kind: 'grey', converted: false, explicit: true };
        break;
      case 'G':
        stroke = { kind: 'grey', converted: false, explicit: true };
        break;

      case 'rg':
      case 'RG': {
        const values = tail(3);
        if (!values) {
          skipped.push('a colour operator with the wrong number of operands');
          break;
        }
        const grey = greyOfRgb(values[0], values[1], values[2]);
        collapse(token, values, grey, token.value === 'rg' ? 'g' : 'G');
        const state: ColourState = { kind: 'rgb', converted: true, explicit: true };
        if (token.value === 'rg') fill = state;
        else stroke = state;
        break;
      }

      case 'k':
      case 'K': {
        const values = tail(4);
        if (!values) {
          skipped.push('a colour operator with the wrong number of operands');
          break;
        }
        const grey = greyOfCmyk(values[0], values[1], values[2], values[3]);
        collapse(token, values, grey, token.value === 'k' ? 'g' : 'G');
        const state: ColourState = { kind: 'cmyk', converted: true, explicit: true };
        if (token.value === 'k') fill = state;
        else stroke = state;
        break;
      }

      case 'cs':
      case 'CS': {
        const operand = operands[operands.length - 1];
        const asName = operand && operand.kind === 'name' ? operand.value.slice(1) : null;
        if (!asName) {
          skipped.push('a colour space set by something other than a name');
          break;
        }
        const space = lookup(asName);
        let state: ColourState = { kind: space.kind, converted: false, explicit: true };

        if (space.kind === 'rgb' || space.kind === 'cmyk') {
          // /DeviceGray is one of the three names the spec lets a content
          // stream use without a matching resource entry, so this needs no
          // edit to the page's /Resources.
          edits.push({ start: operand.start, end: operand.end, replacement: '/DeviceGray' });
          state = { kind: space.kind, converted: true, explicit: true };
          operators += 1;
        } else if (space.kind === 'other') {
          skipped.push(space.reason);
        } else if (
          space.kind === 'pattern' &&
          (space.underlying?.kind === 'rgb' || space.underlying?.kind === 'cmyk')
        ) {
          // `[/Pattern /DeviceRGB] cs` is an uncoloured tiling pattern: the
          // pattern draws a shape with no colour of its own and the page
          // supplies the colour through `scn`. Greying those operands means
          // greying the space in the resources dictionary too — an object that
          // may be shared with a stream this pass could not rewrite, which
          // would leave that stream feeding three numbers to a one-channel
          // space. Not worth a corrupt page; reported instead.
          skipped.push('an uncoloured tiling pattern, which is coloured by the page rather than by itself');
        }

        if (token.value === 'cs') fill = state;
        else stroke = state;
        break;
      }

      case 'sc':
      case 'scn':
      case 'SC':
      case 'SCN': {
        const state = token.value === 'sc' || token.value === 'scn' ? fill : stroke;
        if (!state.converted) {
          // Nothing in this stream set the space, yet three or four numbers
          // are arriving — which the DeviceGray every stream starts in cannot
          // take. So the space was set by whatever invoked this form, and a
          // form inherits the graphics state of its caller. We do not know
          // what that space was, so the colour stays and is declared.
          if (
            !state.explicit &&
            state.kind === 'grey' &&
            (operands.length === 3 || operands.length === 4)
          ) {
            skipped.push('a colour set in a space this stream inherited from whatever drew it');
          }
          break;
        }
        const count = state.kind === 'cmyk' ? 4 : 3;
        const values = tail(count);
        if (!values) {
          // The space says three or four numbers and the stream disagrees.
          // Leaving it alone keeps a readable file; rewriting it would not.
          skipped.push('a colour operator whose operands did not match its colour space');
          break;
        }
        const grey =
          state.kind === 'cmyk'
            ? greyOfCmyk(values[0], values[1], values[2], values[3])
            : greyOfRgb(values[0], values[1], values[2]);
        collapse(token, values, grey, token.value);
        break;
      }

      // `sh` is deliberately absent. A gradient's colours are not in the
      // content stream, they are in the shading object, which is converted
      // where it is defined — and counted once there rather than once per
      // time the page happens to paint it.

      default:
        break;
    }

    operands = [];
  }

  const state: StreamState = { fill, stroke, stack };

  if (edits.length === 0) {
    return { text, state, operators: 0, inlineImages: scan.inlineImages, skipped, ok: true };
  }

  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  out += text.slice(cursor);

  return { text: out, state, operators, inlineImages: scan.inlineImages, skipped, ok: true };
}

/* ------------------------------------------------------------------ *
 * Image samples
 * ------------------------------------------------------------------ */

/**
 * Undoes a PNG or TIFF predictor.
 *
 * pdf-lib's `decodePDFRawStream` runs the /Filter chain and stops there — it
 * does not know about /DecodeParms, so a Flate image written with /Predictor 15
 * (which is most of them, because it compresses better) comes back as filtered
 * rows with a filter byte in front of each. Converting those bytes as if they
 * were samples produces noise, and noise that still decodes: the failure would
 * ship. So the predictor is undone here or the image is left alone.
 */
function undoPredictor(
  data: Uint8Array,
  predictor: number,
  colors: number,
  bpc: number,
  columns: number
): Uint8Array | null {
  if (predictor <= 1) return data;
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    // TIFF horizontal differencing. Only the 8-bit form is handled; the
    // sub-byte forms exist but are not produced by anything in the wild.
    if (bpc !== 8) return null;
    const rows = Math.floor(data.length / rowLength);
    const out = data.slice(0, rows * rowLength);
    for (let row = 0; row < rows; row += 1) {
      const start = row * rowLength;
      for (let i = bytesPerPixel; i < rowLength; i += 1) {
        out[start + i] = (out[start + i] + out[start + i - bytesPerPixel]) & 0xff;
      }
    }
    return out;
  }

  // PNG predictors: one filter-type byte per row, then rowLength bytes.
  const stride = rowLength + 1;
  const rows = Math.floor(data.length / stride);
  if (rows === 0) return null;
  const out = new Uint8Array(rows * rowLength);

  for (let row = 0; row < rows; row += 1) {
    const type = data[row * stride];
    const src = row * stride + 1;
    const dst = row * rowLength;
    const above = dst - rowLength;

    for (let i = 0; i < rowLength; i += 1) {
      const raw = data[src + i];
      const left = i >= bytesPerPixel ? out[dst + i - bytesPerPixel] : 0;
      const up = row > 0 ? out[above + i] : 0;
      const upLeft = row > 0 && i >= bytesPerPixel ? out[above + i - bytesPerPixel] : 0;

      let value: number;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          return null;
      }
      out[dst + i] = value & 0xff;
    }
  }

  return out;
}

interface Parms {
  predictor: number;
  colors: number;
  bpc: number;
  columns: number;
}

function decodeParmsOf(dict: PDFDict, doc: PDFDocument, index: number): Parms | null {
  const raw = dict.lookup(PDFName.of('DecodeParms'));
  const entry =
    raw instanceof PDFArray ? doc.context.lookup(raw.get(index)) : raw instanceof PDFDict ? raw : null;
  if (!(entry instanceof PDFDict)) return null;

  const number = (key: string, fallback: number): number => {
    const value = entry.lookup(PDFName.of(key));
    return value instanceof PDFNumber ? value.asNumber() : fallback;
  };

  return {
    predictor: number('Predictor', 1),
    colors: number('Colors', 1),
    bpc: number('BitsPerComponent', 8),
    columns: number('Columns', 1),
  };
}

const filtersOf = (dict: PDFDict): string[] => {
  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName) return [String(filter).replace(/^\//, '')];
  if (filter instanceof PDFArray) {
    return filter.asArray().map((entry) => String(entry).replace(/^\//, ''));
  }
  return [];
};

const numberEntry = (dict: PDFDict, key: string): number | null => {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : null;
};

/** Applies /Decode, which remaps sample values before they mean a colour. */
function decodeRanges(dict: PDFDict, components: number): number[] | null {
  const raw = dict.lookup(PDFName.of('Decode'));
  if (!(raw instanceof PDFArray)) return null;
  if (raw.size() !== components * 2) return null;
  const out: number[] = [];
  for (let i = 0; i < raw.size(); i += 1) {
    const value = raw.lookup(i);
    if (!(value instanceof PDFNumber)) return null;
    out.push(value.asNumber());
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The tally
 * ------------------------------------------------------------------ */

class Tally {
  contentStreams = 0;
  colourOperators = 0;
  imagesConverted = 0;
  palettesConverted = 0;
  jpegsReEncoded = 0;
  imagesAlreadyGrey = 0;
  imageBytesBefore = 0;
  imageBytesAfter = 0;
  /**
   * Counted apart from `leftInColour` on purpose. A transparency group's
   * CONTENTS were converted like anything else; only the space it blends them
   * in was left alone. Filing it under "left in colour" would read as though a
   * hundred things on the page were still coloured, which is not true, and an
   * overstated note is as much a defect as an overstated saving.
   */
  transparencyGroups = 0;
  shadingsConverted = 0;
  readonly leftInColour = new Map<string, number>();

  skip(reason: string, times = 1): void {
    this.leftInColour.set(reason, (this.leftInColour.get(reason) ?? 0) + times);
  }

  get skippedTotal(): number {
    let total = 0;
    for (const count of this.leftInColour.values()) total += count;
    return total;
  }

  get touched(): number {
    return (
      this.colourOperators +
      this.imagesConverted +
      this.palettesConverted +
      this.jpegsReEncoded +
      this.shadingsConverted
    );
  }
}

/* ------------------------------------------------------------------ *
 * The conversion
 * ------------------------------------------------------------------ */

const decodeLatin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

/** Content streams are bytes. TextEncoder would UTF-8 them and change the file. */
function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const canRasterise = (): boolean =>
  typeof OffscreenCanvas !== 'undefined' &&
  typeof createImageBitmap === 'function' &&
  typeof Blob !== 'undefined';

class Converter {
  private readonly seenStreams = new Set<string>();
  private readonly seenImages = new Set<string>();
  private readonly seenPalettes = new Set<PDFArray>();
  private readonly seenResources = new Set<PDFDict>();
  private readonly seenShadings = new Set<PDFDict>();
  readonly tally = new Tally();

  constructor(
    private readonly doc: PDFDocument,
    private readonly jpegQuality: number
  ) {}

  /** Colour-space names resolve against whichever resources dict is in scope. */
  private lookupFor(resources: PDFDict | undefined): (name: string) => SpaceKind {
    return (name) => {
      const space = spaceFromResources(PDFName.of(name), resources, this.doc);
      // Seeing an Indexed space named by a `cs` is enough reason to grey its
      // palette: the operands that follow are indexes and stay valid.
      if (space.kind === 'indexed') this.convertPalette(space.array);
      return space;
    };
  }

  /**
   * Rewrites one content stream and reports the colour state it ends in, so a
   * page whose /Contents is an array can hand it to the next part.
   */
  async rewriteStream(
    ref: PDFRef,
    resources: PDFDict | undefined,
    carried?: StreamState
  ): Promise<StreamState | undefined> {
    const key = ref.toString();
    // A form XObject drawn on two pages is one object. Rewriting it twice
    // would grey the already-grey and, worse, count it twice.
    if (this.seenStreams.has(key)) return carried;
    this.seenStreams.add(key);

    const stream = this.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return carried;

    let text: string;
    try {
      text = decodeLatin1(decodePDFRawStream(stream).decode());
    } catch {
      this.tally.skip('a content stream this tool could not decode');
      return undefined;
    }

    const result = rewriteColour(text, this.lookupFor(resources), carried);
    if (result.inlineImages > 0) this.tally.skip('an inline image', result.inlineImages);
    if (!result.ok) {
      this.tally.skip('a content stream whose inline image data could not be stepped over safely');
      return undefined;
    }
    for (const reason of result.skipped) this.tally.skip(reason);

    if (result.text !== text) {
      replaceStream(this.doc, ref, encodeLatin1(result.text));
      this.tally.contentStreams += 1;
      this.tally.colourOperators += result.operators;
    }

    return result.state;
  }

  /**
   * Greys an Indexed palette in place.
   *
   * This is the one conversion with no cost at all: the samples are indexes,
   * the indexes still point at the same entries, and only the few hundred
   * bytes of the lookup table change. It also fixes every image sharing the
   * space at once, which is why the array itself is the key.
   */
  private convertPalette(array: PDFArray): boolean {
    if (this.seenPalettes.has(array)) return true;

    const base = classify(array.lookup(1), this.doc);
    const hival = array.lookup(2);
    if (!(hival instanceof PDFNumber)) {
      this.tally.skip('an Indexed palette whose size could not be read');
      return false;
    }
    if (base.kind === 'grey') {
      this.seenPalettes.add(array);
      return true;
    }
    if (base.kind !== 'rgb' && base.kind !== 'cmyk') {
      this.tally.skip(
        base.kind === 'other' ? base.reason : 'an Indexed palette built on a colour space grey cannot stand in for'
      );
      return false;
    }

    const components = base.kind === 'rgb' ? 3 : 4;
    const entries = Math.floor(hival.asNumber()) + 1;

    const lookupRef = array.get(3);
    const lookup = array.lookup(3);
    let table: Uint8Array;
    if (lookup instanceof PDFRawStream) {
      try {
        table = decodePDFRawStream(lookup).decode();
      } catch {
        this.tally.skip('an Indexed palette this tool could not decode');
        return false;
      }
    } else if (lookup instanceof PDFString || lookup instanceof PDFHexString) {
      table = lookup.asBytes();
    } else {
      this.tally.skip('an Indexed palette stored in a form this tool does not read');
      return false;
    }

    if (table.length < entries * components) {
      this.tally.skip('an Indexed palette shorter than its own entry count');
      return false;
    }

    const grey = new Uint8Array(entries);
    for (let i = 0; i < entries; i += 1) {
      const at = i * components;
      grey[i] =
        components === 3
          ? greyByteOfRgb(table[at], table[at + 1], table[at + 2])
          : greyByteOfCmyk(table[at], table[at + 1], table[at + 2], table[at + 3]);
    }

    array.set(1, PDFName.of('DeviceGray'));
    if (lookup instanceof PDFRawStream && lookupRef instanceof PDFRef) {
      replaceStream(this.doc, lookupRef, grey);
    } else {
      array.set(3, PDFHexString.fromBytes(grey));
    }

    this.seenPalettes.add(array);
    this.tally.palettesConverted += 1;
    return true;
  }

  /**
   * Greys a gradient.
   *
   * A shading's colours are not in the content stream; they come out of a
   * function, and the function is the thing that has to be converted. Two
   * kinds can be, honestly and exactly:
   *
   *   - FunctionType 2, the exponential ramp between /C0 and /C1, which is
   *     what every "fade from this colour to that colour" is. Both ends are
   *     converted and the shading is told it is now DeviceGray;
   *   - FunctionType 3, which stitches several of those together end to end.
   *
   * FunctionType 0 (a sampled table) and FunctionType 4 (a small PostScript
   * program) are left alone. The table could be rewritten, in principle; the
   * program would have to be parsed, executed and re-emitted, and a gradient
   * that comes back wrong is more obviously broken than one that stays
   * coloured. Mesh shadings (types 4–7) keep their colours inside the mesh
   * data itself and are left alone for the same reason.
   *
   * The check and the edit are separate passes on purpose: a stitching
   * function whose third child turns out to be a PostScript program must not
   * leave the first two already converted and the shading half-grey.
   *
   * One honest imprecision, since it is measurable: greying the two ends and
   * letting the reader interpolate between them is not the same as greying
   * every colour along the ramp. The interpolation happens in a different
   * space afterwards, so the middle of a saturated fade can land a few percent
   * off — measured at worst 22 of 255 on a blue-to-blue button, over a few
   * dozen pixels. The alternative is replacing the gradient with a sampled
   * table of our own, which trades a small error for a bigger file and a
   * shading no longer shaped like the one the author wrote.
   */
  private convertShading(target: PDFObject | undefined): void {
    const resolved = target instanceof PDFRef ? this.doc.context.lookup(target) : target;

    if (resolved instanceof PDFRawStream) {
      this.tally.skip('a mesh gradient, whose colours are woven into the mesh data');
      return;
    }
    if (!(resolved instanceof PDFDict)) return;
    if (this.seenShadings.has(resolved)) return;
    this.seenShadings.add(resolved);

    const space = classify(resolved.get(PDFName.of('ColorSpace')), this.doc);
    if (space.kind === 'grey') return;
    if (space.kind !== 'rgb' && space.kind !== 'cmyk') {
      this.tally.skip(
        space.kind === 'other' ? space.reason : 'a gradient painted in a colour space grey cannot stand in for'
      );
      return;
    }
    const components = space.kind === 'rgb' ? 3 : 4;

    let fn = resolved.lookup(PDFName.of('Function'));
    if (fn instanceof PDFArray) {
      if (fn.size() !== 1) {
        this.tally.skip('a gradient whose channels are driven by separate functions');
        return;
      }
      fn = fn.lookup(0);
    }

    if (!this.functionConvertible(fn, components)) {
      this.tally.skip('a gradient built from a sampled table or a PostScript function');
      return;
    }

    this.applyFunctionGrey(fn, components);
    resolved.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));

    const background = resolved.lookup(PDFName.of('Background'));
    if (background instanceof PDFArray) this.greyNumberArray(background);

    this.tally.shadingsConverted += 1;
  }

  private functionConvertible(fn: PDFObject | undefined, components: number): boolean {
    const dict = fn instanceof PDFDict ? fn : undefined;
    if (!dict) return false;

    const type = dict.lookup(PDFName.of('FunctionType'));
    const kind = type instanceof PDFNumber ? type.asNumber() : -1;

    if (kind === 2) {
      return (
        this.isNumberArray(dict.lookup(PDFName.of('C0')), components) &&
        this.isNumberArray(dict.lookup(PDFName.of('C1')), components)
      );
    }

    if (kind === 3) {
      const children = dict.lookup(PDFName.of('Functions'));
      if (!(children instanceof PDFArray) || children.size() === 0) return false;
      for (let i = 0; i < children.size(); i += 1) {
        if (!this.functionConvertible(children.lookup(i), components)) return false;
      }
      return true;
    }

    return false;
  }

  private applyFunctionGrey(fn: PDFObject | undefined, components: number): void {
    if (!(fn instanceof PDFDict)) return;
    const type = fn.lookup(PDFName.of('FunctionType'));
    const kind = type instanceof PDFNumber ? type.asNumber() : -1;

    if (kind === 2) {
      for (const key of ['C0', 'C1'] as const) {
        const values = fn.lookup(PDFName.of(key));
        if (values instanceof PDFArray) this.greyNumberArray(values);
      }
      // A /Range describes how many numbers come out. One now.
      if (fn.has(PDFName.of('Range'))) {
        fn.set(PDFName.of('Range'), this.doc.context.obj([0, 1]));
      }
      return;
    }

    if (kind === 3) {
      const children = fn.lookup(PDFName.of('Functions'));
      if (!(children instanceof PDFArray)) return;
      for (let i = 0; i < children.size(); i += 1) {
        this.applyFunctionGrey(children.lookup(i), components);
      }
      if (fn.has(PDFName.of('Range'))) {
        fn.set(PDFName.of('Range'), this.doc.context.obj([0, 1]));
      }
    }
  }

  private isNumberArray(value: PDFObject | undefined, length: number): boolean {
    if (!(value instanceof PDFArray) || value.size() !== length) return false;
    for (let i = 0; i < length; i += 1) {
      if (!(value.lookup(i) instanceof PDFNumber)) return false;
    }
    return true;
  }

  /** Collapses a 3- or 4-number colour array in place. Returns false if it is neither. */
  private greyNumberArray(colour: PDFArray): boolean {
    const size = colour.size();
    if (size !== 3 && size !== 4) return false;
    const values: number[] = [];
    for (let i = 0; i < size; i += 1) {
      const value = colour.lookup(i);
      if (!(value instanceof PDFNumber)) return false;
      values.push(value.asNumber());
    }
    const grey =
      size === 3
        ? greyOfRgb(values[0], values[1], values[2])
        : greyOfCmyk(values[0], values[1], values[2], values[3]);
    colour.set(0, PDFNumber.of(Number(fmt(grey))));
    for (let i = size - 1; i >= 1; i -= 1) colour.remove(i);
    return true;
  }

  async convertImage(ref: PDFRef, resources: PDFDict | undefined): Promise<void> {
    const key = ref.toString();
    if (this.seenImages.has(key)) return;
    this.seenImages.add(key);

    const image = this.doc.context.lookup(ref);
    if (!(image instanceof PDFRawStream)) return;
    const dict = image.dict;

    // A stencil mask has no colour of its own — it is a shape, painted in
    // whatever colour the page had selected, which this file has already
    // converted. Nothing to do and nothing to report.
    const isMask = dict.lookup(PDFName.of('ImageMask'));
    if (isMask && String(isMask) === 'true') return;

    const space = spaceFromResources(dict.get(PDFName.of('ColorSpace')), resources, this.doc);

    if (space.kind === 'grey') {
      this.tally.imagesAlreadyGrey += 1;
      return;
    }
    if (space.kind === 'indexed') {
      // Counted as a palette, not as an image: its samples were never read.
      this.convertPalette(space.array);
      return;
    }
    if (space.kind === 'pattern' || space.kind === 'other') {
      this.tally.skip(space.kind === 'other' ? space.reason : 'an image painted through a pattern');
      return;
    }

    // A colour-key /Mask lists a range PER COMPONENT: [250 255 250 255 250 255]
    // means "hide anything near-white". Collapse the image to one channel and
    // that array is both the wrong length and the wrong question — the pixels
    // it used to hide are no longer distinguishable from the ones it did not.
    // Rather than guess a grey range and change what is visible, this image
    // keeps its colour.
    const mask = dict.lookup(PDFName.of('Mask'));
    if (mask instanceof PDFArray) {
      this.tally.skip('an image whose transparency is keyed to specific colours');
      return;
    }

    const width = numberEntry(dict, 'Width');
    const height = numberEntry(dict, 'Height');
    const bpc = numberEntry(dict, 'BitsPerComponent');
    if (!width || !height || width < 1 || height < 1) {
      this.tally.skip('an image with no readable size');
      return;
    }

    const filters = filtersOf(dict);
    const last = filters[filters.length - 1];

    if (last === 'JPXDecode') {
      // Re-encoding JPEG 2000 needs an encoder no browser exposes, and
      // decoding it to something else would make the file much larger.
      this.tally.skip('a JPEG 2000 image');
      return;
    }

    if (last === 'DCTDecode') {
      await this.convertJpeg(ref, image, space.kind, width, height, filters);
      return;
    }

    if (bpc !== 8) {
      this.tally.skip(`an image stored at ${bpc ?? '?'} bits per channel`);
      return;
    }

    const components = space.kind === 'rgb' ? 3 : 4;

    let samples: Uint8Array;
    try {
      samples = decodePDFRawStream(image).decode();
    } catch {
      this.tally.skip('an image this tool could not decode');
      return;
    }

    const parms = decodeParmsOf(dict, this.doc, Math.max(0, filters.length - 1));
    if (parms && parms.predictor > 1) {
      const restored = undoPredictor(
        samples,
        parms.predictor,
        parms.colors || components,
        parms.bpc || 8,
        parms.columns || width
      );
      if (!restored) {
        this.tally.skip('an image compressed with a predictor this tool could not undo');
        return;
      }
      samples = restored;
    }

    const pixels = width * height;
    if (samples.length < pixels * components) {
      this.tally.skip('an image with fewer samples than its dimensions claim');
      return;
    }

    const ranges = decodeRanges(dict, components);
    const grey = new Uint8Array(pixels);

    if (ranges) {
      // /Decode remaps each sample before it means anything — most often
      // [1 0 1 0 1 0 1 0] on a CMYK image, which inverts every channel.
      const scaled = new Uint8Array(components);
      for (let i = 0; i < pixels; i += 1) {
        const at = i * components;
        for (let c = 0; c < components; c += 1) {
          const min = ranges[c * 2];
          const max = ranges[c * 2 + 1];
          scaled[c] = Math.round(clamp01(min + (samples[at + c] / 255) * (max - min)) * 255);
        }
        grey[i] =
          components === 3
            ? greyByteOfRgb(scaled[0], scaled[1], scaled[2])
            : greyByteOfCmyk(scaled[0], scaled[1], scaled[2], scaled[3]);
      }
    } else if (components === 3) {
      for (let i = 0; i < pixels; i += 1) {
        const at = i * 3;
        grey[i] = greyByteOfRgb(samples[at], samples[at + 1], samples[at + 2]);
      }
    } else {
      for (let i = 0; i < pixels; i += 1) {
        const at = i * 4;
        grey[i] = greyByteOfCmyk(samples[at], samples[at + 1], samples[at + 2], samples[at + 3]);
      }
    }

    const before = image.contents.length;
    replaceStream(this.doc, ref, grey);

    // replaceStream carries the old dictionary across so nothing required goes
    // missing, which means the entries that describe the OLD colour have to be
    // corrected here. /Decode has already been applied above, so leaving it
    // would apply it twice.
    const rewritten = this.doc.context.lookup(ref);
    if (rewritten instanceof PDFRawStream) {
      rewritten.dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));
      rewritten.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      rewritten.dict.delete(PDFName.of('Decode'));
      this.tally.imageBytesBefore += before;
      this.tally.imageBytesAfter += rewritten.contents.length;
    }

    this.tally.imagesConverted += 1;
  }

  /**
   * The JPEG path, which is the only place this file needs a decoder it does
   * not own.
   *
   * A DCTDecode stream is a JPEG, and the only way to change its pixels is to
   * decode and re-encode it — a second lossy pass on data that has already had
   * one. That is worth it on a scan (a colour scan is usually most of the
   * file, and its colour is usually noise) and it is stated plainly in the
   * notes, because "lossless except for the photographs" is not lossless.
   *
   * Two limits worth knowing. The browser's encoder only writes three-channel
   * JPEGs, so the result is grey pixels in a colour container: the two chroma
   * planes are flat and cost almost nothing, but the /ColorSpace stays as it
   * was rather than becoming DeviceGray. And CMYK JPEGs are not offered to it
   * at all — browsers decode those inconsistently or not at all, and a silent
   * colour shift on a print file is worse than leaving it alone.
   */
  private async convertJpeg(
    ref: PDFRef,
    image: PDFRawStream,
    kind: 'rgb' | 'cmyk',
    width: number,
    height: number,
    filters: string[]
  ): Promise<void> {
    if (kind === 'cmyk') {
      this.tally.skip('a CMYK JPEG, which browsers do not decode reliably');
      return;
    }
    if (filters.length !== 1) {
      this.tally.skip('a JPEG wrapped in another filter');
      return;
    }
    if (width * height > MAX_IMAGE_PIXELS) {
      this.tally.skip('an image too large to decode here without risking the tab');
      return;
    }
    if (!canRasterise()) {
      this.tally.skip('a JPEG, because this environment has no image decoder');
      return;
    }
    // A /Decode array remaps each channel before the samples mean anything —
    // [1 0 1 0 1 0] is an inverted image. The raw-sample path applies it and
    // then drops the entry; the decoder used here does not see it at all, so
    // converting would compute greys from unmapped samples and then delete the
    // array that said they were unmapped. The result looks like a photographic
    // negative. Left in colour and counted instead.
    if (image.dict.has(PDFName.of('Decode'))) {
      this.tally.skip('a JPEG with a custom /Decode array, which this cannot apply');
      return;
    }

    const original = image.contents;
    let blob: Blob;
    try {
      const bitmap = await createImageBitmap(
        new Blob([original.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        this.tally.skip('a JPEG, because this browser would not give us a canvas');
        bitmap.close();
        return;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = frame.data;
      for (let i = 0; i < data.length; i += 4) {
        const grey = greyByteOfRgb(data[i], data[i + 1], data[i + 2]);
        data[i] = grey;
        data[i + 1] = grey;
        data[i + 2] = grey;
      }
      ctx.putImageData(frame, 0, 0);

      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: this.jpegQuality });
    } catch {
      this.tally.skip('a JPEG that could not be decoded');
      return;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());

    // The bytes ARE a JPEG, so they go in as a JPEG: re-flating them would add
    // a few percent and buy nothing. This is the one place a stream is built by
    // hand rather than through replaceStream, and the dictionary is carried
    // across the same way.
    const rewritten = this.doc.context.stream(bytes, {});
    for (const [name, value] of image.dict.entries()) {
      const plain = String(name).slice(1);
      if (plain === 'Length' || plain === 'Filter' || plain === 'DecodeParms' || plain === 'DL') {
        continue;
      }
      rewritten.dict.set(name, value);
    }
    rewritten.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    rewritten.dict.delete(PDFName.of('Decode'));
    this.doc.context.assign(ref, rewritten);

    this.tally.imageBytesBefore += original.length;
    this.tally.imageBytesAfter += bytes.length;
    this.tally.jpegsReEncoded += 1;
  }

  /**
   * Walks one resources dictionary and everything it can reach.
   *
   * Depth is capped and every stream is visited once, because a form XObject
   * can name its own parent's resources and a pattern can use a form that uses
   * the pattern. A cycle here is a hung tab.
   */
  async walk(resources: PDFDict | undefined, depth = 0): Promise<void> {
    if (!resources || depth > 12) return;
    // Pages share resource dictionaries constantly — a 49-page report is often
    // one dictionary seen 49 times. Without this the work is done once and
    // COUNTED forty-nine times, which turns the notes into fiction.
    if (this.seenResources.has(resources)) return;
    this.seenResources.add(resources);

    const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xobjects) {
      for (const [, value] of xobjects.entries()) {
        if (!(value instanceof PDFRef)) continue;
        const target = this.doc.context.lookup(value);
        if (!(target instanceof PDFRawStream)) continue;
        const subtype = String(target.dict.get(PDFName.of('Subtype')) ?? '');
        if (subtype === '/Image') {
          await this.convertImage(value, resources);
        } else if (subtype === '/Form') {
          const own = target.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
          // A transparency group declares the colour space it blends in. Its
          // contents are converted like anything else; the blending space is
          // left alone, because changing it changes how the group composites
          // rather than what colour it is.
          if (!this.seenStreams.has(value.toString()) && target.dict.has(PDFName.of('Group'))) {
            this.tally.transparencyGroups += 1;
          }
          await this.rewriteStream(value, own);
          await this.walk(own, depth + 1);
        }
      }
    }

    const patterns = resources.lookupMaybe(PDFName.of('Pattern'), PDFDict);
    if (patterns) {
      for (const [, value] of patterns.entries()) {
        if (!(value instanceof PDFRef)) continue;
        const target = this.doc.context.lookup(value);
        if (target instanceof PDFRawStream) {
          const own = target.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
          await this.rewriteStream(value, own);
          await this.walk(own, depth + 1);
        } else if (target instanceof PDFDict) {
          // PatternType 2 — a gradient used as a fill. The colours live in the
          // shading it points at.
          this.convertShading(target.get(PDFName.of('Shading')));
        }
      }
    }

    const shadings = resources.lookupMaybe(PDFName.of('Shading'), PDFDict);
    if (shadings) {
      for (const [, value] of shadings.entries()) this.convertShading(value);
    }

    const colourSpaces = resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
    if (colourSpaces) {
      for (const [, value] of colourSpaces.entries()) {
        const space = classify(value, this.doc);
        if (space.kind === 'indexed') this.convertPalette(space.array);
      }
    }

    const extGStates = resources.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
    if (extGStates) {
      for (const [, value] of extGStates.entries()) {
        const state = value instanceof PDFRef ? this.doc.context.lookup(value) : value;
        if (!(state instanceof PDFDict)) continue;
        const smask = state.lookup(PDFName.of('SMask'));
        if (smask instanceof PDFDict) {
          // A luminosity soft mask uses colour to mean transparency: the
          // brightness of the mask's content IS the alpha channel. Converting
          // it would change what shows through, not what colour it is.
          this.tally.skip('a soft mask whose brightness controls transparency');
        }
      }
    }

    const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (fonts) {
      for (const [, value] of fonts.entries()) {
        const font = value instanceof PDFRef ? this.doc.context.lookup(value) : value;
        if (!(font instanceof PDFDict)) continue;
        if (String(font.get(PDFName.of('Subtype')) ?? '') !== '/Type3') continue;
        // A Type 3 glyph is a content stream, and it is allowed to set colour.
        const procs = font.lookupMaybe(PDFName.of('CharProcs'), PDFDict);
        const own = font.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
        if (!procs) continue;
        for (const [, proc] of procs.entries()) {
          if (proc instanceof PDFRef) await this.rewriteStream(proc, own);
        }
        await this.walk(own, depth + 1);
      }
    }
  }

  /** Annotation appearances are form XObjects and get the same treatment. */
  async walkAnnotations(annots: PDFArray | undefined, pageResources: PDFDict | undefined): Promise<void> {
    if (!annots) return;

    for (let i = 0; i < annots.size(); i += 1) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;

      for (const key of ['C', 'IC'] as const) {
        const colour = annot.lookup(PDFName.of(key));
        if (colour instanceof PDFArray) this.greyArray(colour);
      }

      // The default-appearance string is a miniature content stream. Left
      // alone, a form field repaints itself in its original colour the moment
      // someone types in it.
      const da = annot.lookup(PDFName.of('DA'));
      if (da instanceof PDFString || da instanceof PDFHexString) {
        this.greyAppearanceString(annot, da);
      }

      const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
      if (!ap) continue;

      for (const [, value] of ap.entries()) {
        const target = value instanceof PDFRef ? this.doc.context.lookup(value) : value;
        if (value instanceof PDFRef && target instanceof PDFRawStream) {
          const own = target.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? pageResources;
          await this.rewriteStream(value, own);
          await this.walk(own, 1);
        } else if (target instanceof PDFDict) {
          // An appearance with named states: /N << /Off 5 0 R /Yes 6 0 R >>
          for (const [, state] of target.entries()) {
            if (!(state instanceof PDFRef)) continue;
            const stream = this.doc.context.lookup(state);
            if (!(stream instanceof PDFRawStream)) continue;
            const own = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? pageResources;
            await this.rewriteStream(state, own);
            await this.walk(own, 1);
          }
        }
      }
    }
  }

  greyArray(colour: PDFArray): void {
    if (this.greyNumberArray(colour)) this.tally.colourOperators += 1;
  }

  greyAppearanceString(owner: PDFDict, da: PDFString | PDFHexString): void {
    const text = decodeLatin1(da.asBytes());
    const result = rewriteColour(text, () => ({ kind: 'other', reason: 'a default appearance' }));
    if (!result.ok || result.text === text) return;
    owner.set(PDFName.of('DA'), PDFString.of(result.text));
    this.tally.colourOperators += result.operators;
  }
}

/** Contents can be one stream or an array of them, by reference either way. */
function contentRefs(node: PDFDict, doc: PDFDocument): PDFRef[] {
  const raw = node.get(PDFName.of('Contents'));
  const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;

  if (resolved instanceof PDFArray) {
    const refs: PDFRef[] = [];
    for (let i = 0; i < resolved.size(); i += 1) {
      const entry = resolved.get(i);
      if (entry instanceof PDFRef) refs.push(entry);
    }
    return refs;
  }

  return raw instanceof PDFRef ? [raw] : [];
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function grayscale(
  files: InputFile[],
  options: GrayscaleOptions = {}
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to convert to greyscale.' };

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;
  const input = new Uint8Array(file.bytes);
  const quality = Math.min(1, Math.max(0.3, options.jpegQuality ?? 0.82));

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input, { updateMetadata: false });
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.toLowerCase().includes('encrypt')
        ? `${file.name} is password-protected. Remove the password with Unlock first, then convert it.`
        : `${file.name} could not be read as a PDF: ${message}`,
    };
  }

  const pages = doc.getPages();
  if (pages.length === 0) return { ok: false, error: 'This PDF has no pages.' };

  /**
   * What this document would weigh if it were rewritten and NOT changed.
   *
   * Measured because the alternative is taking credit for someone else's work.
   * A PDF handed back through pdf-lib is written as one fresh revision with
   * object streams, which on its own can be a third smaller — no colour
   * involved. Reporting that as a greyscale saving would be a lie told in
   * numbers, and the number people act on. One extra save buys a true one.
   */
  let baseline = 0;
  try {
    const untouched = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 2000,
    });
    baseline = untouched.length;
  } catch {
    // Only the receipt is poorer for this; the conversion does not need it.
  }

  const converter = new Converter(doc, quality);

  try {
    for (const page of pages) {
      const resources =
        page.node.Resources() ??
        (page.node.getInheritableAttribute(PDFName.of('Resources')) as PDFDict | undefined);

      // One page, one graphics state — even when /Contents is several streams.
      let carried: StreamState | undefined;
      for (const ref of contentRefs(page.node, doc)) {
        carried = await converter.rewriteStream(ref, resources, carried);
      }
      await converter.walk(resources);
      await converter.walkAnnotations(page.node.Annots(), resources);
    }

    // Field appearances are regenerated from the form's own default appearance
    // string, so a blue /DA on the AcroForm undoes the work above the first
    // time someone fills the form in.
    const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const formDa = acroForm?.lookup(PDFName.of('DA'));
    if (acroForm && (formDa instanceof PDFString || formDa instanceof PDFHexString)) {
      converter.greyAppearanceString(acroForm, formDa);
    }
    if (acroForm) {
      await converter.walk(acroForm.lookupMaybe(PDFName.of('DR'), PDFDict), 1);
    }
  } catch (error) {
    return {
      ok: false,
      error: `Could not convert this PDF to greyscale: ${(error as Error).message}. Your original file was not changed.`,
    };
  }

  const tally = converter.tally;

  if (tally.touched === 0) {
    return {
      ok: true,
      files: [{ name: file.name, bytes: input }],
      bytesIn,
      bytesOut: bytesIn,
      pages: pages.length,
      durationMs: performance.now() - started,
      summary: 'Already greyscale',
      unchanged: true,
      notes: [
        tally.leftInColour.size === 0
          ? 'Nothing in this document was in colour, so you have your original file back, byte for byte.'
          : 'Nothing here could be converted that was not already grey, so you have your original file back, byte for byte. What colour is left is the kind this tool will not touch:',
        ...describeSkipped(tally),
      ],
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 2000 });
  } catch (error) {
    return {
      ok: false,
      error: `Could not write the converted PDF: ${(error as Error).message}. Your original file was not changed.`,
    };
  }

  // Re-open before handing it over. A greyscale converter that quietly breaks
  // a document is worse than one that refuses, because the damage is found
  // later, by someone who has thrown the original away.
  try {
    const check = await PDFDocument.load(bytes, { updateMetadata: false });
    if (check.getPageCount() !== pages.length) {
      return {
        ok: false,
        error: `The converted file came back with ${check.getPageCount()} pages instead of ${pages.length}, so it was not returned. Your original file was not changed. Please report this.`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `The converted file could not be re-opened (${(error as Error).message}), so it was not returned. Your original file was not changed.`,
    };
  }

  const delta = bytesIn - bytes.length;
  const percent = Math.round((Math.abs(delta) / bytesIn) * 100);

  const parts: string[] = ['Converted to greyscale'];
  const images = tally.imagesConverted + tally.jpegsReEncoded + tally.palettesConverted;
  if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'}`);
  parts.push(delta > 0 ? `${percent}% smaller` : delta === 0 ? 'same size' : `${percent}% larger`);

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-grey.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: pages.length,
    durationMs: performance.now() - started,
    summary: parts.join(' · '),
    ratio: delta > 0 ? delta / bytesIn : 0,
    unchanged: false,
    notes: buildNotes(tally, bytesIn, bytes.length, baseline),
  };
}

/** Everything left in colour, in one line per reason, with counts. */
function describeSkipped(tally: Tally): string[] {
  if (tally.leftInColour.size === 0) return [];
  const parts = [...tally.leftInColour.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} × ${reason}`);
  return [`Left in colour on purpose, because grey would misrepresent them: ${parts.join('; ')}.`];
}

function buildNotes(tally: Tally, bytesIn: number, bytesOut: number, baseline: number): string[] {
  const notes: string[] = [];
  const delta = bytesIn - bytesOut;
  const percent = Math.round((Math.abs(delta) / bytesIn) * 100);

  notes.push(
    'The text was not touched. Nothing was rasterised: the words in this file are the same words, still selectable, still searchable, still readable by a screen reader.'
  );

  if (tally.colourOperators > 0) {
    notes.push(
      `Rewrote ${tally.colourOperators} colour instruction${tally.colourOperators === 1 ? '' : 's'} across ${tally.contentStreams} stream${tally.contentStreams === 1 ? '' : 's'}, using Rec. 709 luminance on light rather than a flat average of the numbers — so colours of the same brightness end up the same grey.`
    );
  }

  if (tally.imagesConverted > 0) {
    const saved = tally.imageBytesBefore - tally.imageBytesAfter;
    notes.push(
      `Converted ${tally.imagesConverted} image${tally.imagesConverted === 1 ? '' : 's'} from three or four channels to one${saved > 0 ? `, which alone accounts for ${formatBytes(saved)} of the change` : ''}. No pixel was resampled and no image changed size.`
    );
  }

  if (tally.palettesConverted > 0) {
    notes.push(
      `${tally.palettesConverted} indexed image${tally.palettesConverted === 1 ? ' had its palette' : 's had their palettes'} converted. The pixel data was not re-encoded at all — only the few hundred bytes of the colour table changed.`
    );
  }

  if (tally.jpegsReEncoded > 0) {
    notes.push(
      `${tally.jpegsReEncoded} JPEG${tally.jpegsReEncoded === 1 ? ' was' : 's were'} decoded and re-encoded, which is a second lossy pass on top of the one they already had — the only lossy step in this conversion. They are stored as three identical channels because the browser's encoder writes colour JPEGs; the two empty channels cost a few percent and the pixels are genuinely grey.`
    );
  }

  if (tally.imagesAlreadyGrey > 0) {
    notes.push(
      `${tally.imagesAlreadyGrey} image${tally.imagesAlreadyGrey === 1 ? ' was' : 's were'} already greyscale and were left exactly as they were.`
    );
  }

  if (tally.shadingsConverted > 0) {
    notes.push(
      `Converted ${tally.shadingsConverted} gradient${tally.shadingsConverted === 1 ? '' : 's'} by greying the colour at each end of the ramp, so ${tally.shadingsConverted === 1 ? 'it still fades' : 'they still fade'} rather than going flat. The fade is then re-interpolated in grey, which can sit a few percent away from greying every step of the original — visible only if you go looking for it with a colour picker.`
    );
  }

  if (tally.transparencyGroups > 0) {
    notes.push(
      `${tally.transparencyGroups} transparency group${tally.transparencyGroups === 1 ? '' : 's'} kept the colour space ${tally.transparencyGroups === 1 ? 'it blends' : 'they blend'} in. What ${tally.transparencyGroups === 1 ? 'it draws was' : 'they draw were'} converted like everything else — the blending space only decides how the layers mix, and changing it would change the mixing rather than the colour.`
    );
  }

  notes.push(...describeSkipped(tally));

  notes.push(
    'Colours tagged with an ICC profile were converted through the alternate space the PDF spec names for a reader that cannot apply the profile — the same fallback your viewer uses. A wide-gamut original will shift slightly under it.'
  );

  const imageDelta = tally.imageBytesBefore - tally.imageBytesAfter;

  if (delta > 0) {
    notes.push(`The file is ${formatBytes(delta)} smaller (${percent}%).`);
  } else if (delta < 0) {
    notes.push(
      `This file came out ${formatBytes(-delta)} LARGER (${percent}%). You have grey, but no saving. Your original is untouched on your machine.`
    );
    if (tally.jpegsReEncoded > 0 && imageDelta < 0) {
      // The specific reason, because the general one would be wrong here. An
      // already-hard-packed scan is the case where greyscale costs size: the
      // browser's JPEG encoder cannot match whatever squeezed the original,
      // and one channel encoded worse beats three channels encoded better.
      notes.push(
        `${formatBytes(-imageDelta)} of that is the JPEG: the original was packed harder than the browser's encoder can pack it, so re-encoding it in grey cost more than the colour did. A lower quality setting would trade sharpness for size, and Compress will do more for a scan like this than greyscale can — it can also reduce the resolution, which this tool deliberately does not.`
      );
    }
  } else {
    notes.push('The file came out the same size.');
  }

  // The split between "the colour went" and "the file was rewritten". Without
  // it, a document whose colour was a few hundred bytes of instructions
  // reports a third off and lets the user believe greyscale did it.
  if (baseline > 0) {
    const fromColour = baseline - bytesOut;
    const fromRewrite = bytesIn - baseline;
    if (Math.abs(fromRewrite) > 1024) {
      notes.push(
        `Of that: ${describeDelta(fromColour)} from removing the colour, and ${describeDelta(fromRewrite)} from writing the document out as a single fresh revision — which happens whatever you do to a PDF here, so that part was never really about the colour.`
      );
    }
  }

  notes.push(
    'Greyscale is not reversible: the colour is gone from this copy, not hidden. Keep your original if you might need it.'
  );
  notes.push('Everything happened in this tab. Nothing was uploaded.');

  return notes;
}

/** "27.8 kB less" / "1.2 kB more" / "nothing". Direction stated, never implied. */
function describeDelta(bytes: number): string {
  if (Math.abs(bytes) < 64) return 'nothing';
  return bytes > 0 ? `${formatBytes(bytes)} less` : `${formatBytes(-bytes)} more`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
