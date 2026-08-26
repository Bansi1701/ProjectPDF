/**
 * Decoded views of the streams a document contains, and safe replacement.
 *
 * Subsetting needs the inflated bytes of content streams and font programs,
 * and pdf-lib hands back the encoded ones. `decodePDFRawStream` applies the
 * stream's own /Filter chain, so this works for Flate, LZW and the rest
 * without us implementing any of them.
 */
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

/** ref string → decoded bytes. Streams that will not decode are omitted. */
export function decodeAll(doc: PDFDocument): Map<string, Uint8Array> {
  const decoded = new Map<string, Uint8Array>();

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      decoded.set(ref.toString(), decodePDFRawStream(obj).decode());
    } catch {
      // An undecodable stream simply is not a subsetting candidate.
    }
  }

  return decoded;
}

/** Set by the new stream itself; carrying the old values over would lie. */
const REGENERATED = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);

/**
 * Replaces a stream's contents, re-compressing with Flate.
 *
 * Carries the original dictionary across. A fresh stream would otherwise be
 * born with only /Length and /Filter, and a FontFile2 that has lost its
 * /Length1 — the uncompressed size of the font program, which the spec
 * requires — renders fine in lenient viewers and can be rejected by strict
 * ones. That is a bug you find in Acrobat, not in a test.
 */
export function replaceStream(doc: PDFDocument, ref: PDFRef, bytes: Uint8Array): void {
  const previous = doc.context.lookup(ref);
  const next = doc.context.flateStream(bytes);

  if (previous instanceof PDFRawStream) {
    for (const [key, value] of previous.dict.entries()) {
      const name = String(key).slice(1);
      if (REGENERATED.has(name)) continue;
      next.dict.set(key, value);
    }

    // /Length1 must describe the NEW program, not the one we replaced.
    if (previous.dict.has(PDFName.of('Length1'))) {
      next.dict.set(PDFName.of('Length1'), PDFNumber.of(bytes.length));
    }
  }

  doc.context.assign(ref, next);
}

/** True when a stream still carries the entries its type requires. */
export function hasRequiredKeys(dict: PDFDict, keys: string[]): boolean {
  return keys.every((key) => dict.has(PDFName.of(key)));
}
