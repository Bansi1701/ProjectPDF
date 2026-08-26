/**
 * PDF/A conversion, and repair.
 *
 * Both tools share a habit: check first whether the thing being asked for is
 * actually achievable on this document, and say so plainly when it is not.
 *
 * PDF/A is the one most likely to be misrepresented. The format's central
 * requirement is that a document renders identically in fifty years, which
 * means every font it uses must be embedded inside it. A converter that adds
 * the PDF/A metadata without embedding the missing fonts produces a file that
 * claims conformance and fails validation — worse than not converting, because
 * the claim is what an archive relies on.
 */
import { PDFDict, PDFDocument, PDFName, PDFRef } from '@cantoo/pdf-lib';

import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/** Font descriptors carrying no embedded program. */
function unembeddedFonts(doc: PDFDocument): string[] {
  const missing = new Set<string>();

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (String(obj.get(PDFName.of('Type'))) !== '/FontDescriptor') continue;

    const embedded = ['FontFile', 'FontFile2', 'FontFile3'].some((key) =>
      obj.has(PDFName.of(key))
    );
    if (embedded) continue;

    const name = String(obj.get(PDFName.of('FontName')) ?? '(unnamed)').replace(/^\//, '');
    // Subset prefixes are noise when listing what is missing.
    missing.add(name.replace(/^[A-Z]{6}\+/, ''));
  }

  return [...missing];
}

export async function toPdfA(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to convert.' };

  const started = performance.now();

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (error) {
    return { ok: false, error: `This file could not be read as a PDF: ${(error as Error).message}` };
  }

  const missing = unembeddedFonts(doc);

  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `This document uses ${missing.length} font${missing.length === 1 ? '' : 's'} it does not carry: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', and others' : ''}. ` +
        'PDF/A requires every font to be embedded, and the font files are not in the document to embed. ' +
        'Converting anyway would produce a file that claims conformance and fails validation, which is worse than not converting. Re-export it from the original application with fonts embedded.',
    };
  }

  try {
    // Adds the OutputIntent, /ID and the PDF/A XMP, and syncs it with /Info.
    (doc as unknown as { convertToPDFA: (o: { conformance: string }) => void }).convertToPDFA({
      conformance: '2B',
    });
  } catch (error) {
    return { ok: false, error: `Could not convert: ${(error as Error).message}` };
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-pdfa.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages: doc.getPageCount(),
    durationMs: performance.now() - started,
    summary: 'Converted to PDF/A-2b',
    notes: [
      'Every font this document uses is embedded, which is what makes the conversion honest.',
      'This adds the archival structure: an sRGB output intent, a file identifier, and PDF/A metadata. It does not rewrite page content, so a document that was already valid stays valid.',
      'We cannot validate the result here — the only complete PDF/A validator is veraPDF, which is Java. If this is going into a formal archive, validate it there before relying on it.',
    ],
  };
}

/**
 * Repair.
 *
 * Two tiers, and an honest ceiling. A rebuild recovers the common damage —
 * a truncated download, a mangled cross-reference table, an editor that wrote
 * a broken trailer — because the page objects survive and only the index that
 * finds them is wrong.
 *
 * What it cannot do is reconstruct a document whose content streams are
 * corrupt. That needs an engine that can rasterise what is left, and the ones
 * that do it well are AGPL. Rather than pretend, this reports which pages
 * could not be recovered.
 */
export async function repair(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to repair.' };

  const started = performance.now();

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, {
      updateMetadata: false,
      // The whole point is to accept a document a strict parser would reject.
      throwOnInvalidObject: false,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        `This file is damaged past what can be rebuilt here: ${(error as Error).message}. ` +
        'The page objects themselves are unreadable, not just the index that finds them.',
    };
  }

  const total = doc.getPageCount();
  if (total === 0) {
    return { ok: false, error: 'This document has no recoverable pages.' };
  }

  // Copy pages one at a time so a single bad page costs one page, not the file.
  const rebuilt = await PDFDocument.create();
  const lost: number[] = [];

  for (let i = 0; i < total; i += 1) {
    try {
      const [page] = await rebuilt.copyPages(doc, [i]);
      rebuilt.addPage(page);
    } catch {
      lost.push(i + 1);
    }
  }

  if (rebuilt.getPageCount() === 0) {
    return { ok: false, error: 'Every page failed to copy. Nothing could be recovered from this file.' };
  }

  const bytes = await rebuilt.save({ useObjectStreams: true, addDefaultPage: false });

  const notes: string[] = [];
  if (lost.length > 0) {
    notes.push(
      `Could not recover page${lost.length === 1 ? '' : 's'} ${lost.slice(0, 8).join(', ')}${lost.length > 8 ? ` and ${lost.length - 8} more` : ''}. Those pages were dropped so the rest of the document opens.`
    );
  } else {
    notes.push('Every page was recovered.');
  }

  notes.push(
    'Rebuilding writes a fresh cross-reference table and drops anything nothing references. Bookmarks, form fields and attachments do not survive it — pages and their contents do.'
  );

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-repaired.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages: rebuilt.getPageCount(),
    durationMs: performance.now() - started,
    summary:
      lost.length > 0
        ? `Recovered ${rebuilt.getPageCount()} of ${total} pages`
        : `Rebuilt ${rebuilt.getPageCount()} pages`,
    notes,
  };
}
