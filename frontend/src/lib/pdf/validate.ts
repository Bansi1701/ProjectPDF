/**
 * Output validation.
 *
 * A compressor that silently corrupts a file is worse than no compressor,
 * because the user does not find out until the document matters. Every output
 * is re-opened and checked before it is handed back, and anything suspicious
 * returns the ORIGINAL bytes rather than a smaller broken file.
 *
 * This runs on every compression, not just in tests. The cost is one extra
 * parse; the alternative is shipping a corrupt PDF to someone's lawyer.
 */
import { PDFDocument } from '@cantoo/pdf-lib';

export interface Verdict {
  safe: boolean;
  reason?: string;
  pages?: number;
}

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46]; // %PDF

function hasPdfHeader(bytes: Uint8Array): boolean {
  return PDF_HEADER.every((byte, i) => bytes[i] === byte);
}

/** A valid PDF ends with %%EOF, allowing for trailing whitespace. */
function hasEof(bytes: Uint8Array): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024));
  const text = new TextDecoder('latin1').decode(tail);
  return text.trimEnd().endsWith('%%EOF');
}

/**
 * Counts `%%EOF` markers. More than one means an incremental update left a
 * previous revision in the file — which for a privacy tool is a defect, not an
 * optimisation: everything we just stripped would still be recoverable.
 */
function countEof(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  return (text.match(/%%EOF/g) ?? []).length;
}

export async function validate(
  original: Uint8Array,
  candidate: Uint8Array,
  expectedPages: number
): Promise<Verdict> {
  if (candidate.length === 0) {
    return { safe: false, reason: 'Compression produced an empty file' };
  }

  if (candidate.length >= original.length) {
    return { safe: false, reason: 'Result was not smaller than the original' };
  }

  if (!hasPdfHeader(candidate)) {
    return { safe: false, reason: 'Result is not a PDF' };
  }

  if (!hasEof(candidate)) {
    return { safe: false, reason: 'Result is truncated' };
  }

  const eofs = countEof(candidate);
  if (eofs !== 1) {
    // A full rewrite must produce exactly one revision. More means the strip
    // was cosmetic and the removed data is still in the file.
    return {
      safe: false,
      reason: `Result contains ${eofs} revisions; stripped data could be recovered`,
    };
  }

  // The real check: can it be parsed back, and is the document still intact?
  let reopened: PDFDocument;
  try {
    reopened = await PDFDocument.load(candidate, { updateMetadata: false });
  } catch (error) {
    return {
      safe: false,
      reason: `Result could not be re-opened: ${(error as Error).message}`,
    };
  }

  const pages = reopened.getPageCount();
  if (pages !== expectedPages) {
    return {
      safe: false,
      reason: `Page count changed from ${expectedPages} to ${pages}`,
    };
  }

  return { safe: true, pages };
}
