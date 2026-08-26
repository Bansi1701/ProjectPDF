/**
 * Decoded views of the streams a document contains.
 *
 * Subsetting needs the inflated bytes of content streams and font programs,
 * and pdf-lib hands back the encoded ones. `decodePDFRawStream` applies the
 * stream's own /Filter chain, so this works for Flate, LZW and the rest
 * without us implementing any of them.
 */
import { PDFDocument, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';

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

/** Replaces a stream's contents, re-compressing with Flate. */
export function replaceStream(doc: PDFDocument, ref: PDFRef, bytes: Uint8Array): void {
  doc.context.assign(ref, doc.context.flateStream(bytes));
}
