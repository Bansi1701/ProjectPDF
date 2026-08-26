/**
 * The compress pipeline.
 *
 * strip → rewrite → validate → hand back the smaller file, or the original.
 * There is no fourth step where anything is uploaded.
 */
import { PDFDocument } from '@cantoo/pdf-lib';

import { analyse, explainSmallSaving } from './composition';
import { rewrite, stripNonRendering } from './lossless';
import type { CompressResponse } from './types';
import { validate } from './validate';

export async function compress(input: Uint8Array): Promise<CompressResponse> {
  const started = performance.now();
  const bytesIn = input.length;

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input, {
      // Do not stamp a new ModDate — the user did not edit the document.
      updateMetadata: false,
    });
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.toLowerCase().includes('encrypt')
        ? 'This PDF is password-protected. Unlock it first.'
        : `This file could not be read as a PDF: ${message}`,
    };
  }

  const pages = doc.getPageCount();
  if (pages === 0) {
    return { ok: false, error: 'This PDF has no pages' };
  }

  const composition = analyse(doc, bytesIn);
  const { savings, notes } = stripNonRendering(doc);

  let candidate: Uint8Array;
  try {
    candidate = await rewrite(doc);
  } catch (error) {
    return { ok: false, error: `Could not rewrite the document: ${(error as Error).message}` };
  }

  savings.structural = Math.max(
    0,
    bytesIn - candidate.length - savings.metadata - savings.pieceInfo - savings.attachments
  );

  const verdict = await validate(input, candidate, pages);

  // Not smaller is not a failure — some PDFs are already optimal. Say so and
  // hand back exactly what we were given.
  if (!verdict.safe) {
    const alreadyOptimal = verdict.reason === 'Result was not smaller than the original';

    if (!alreadyOptimal) {
      return {
        ok: false,
        error: `${verdict.reason}. Your original file was not modified.`,
      };
    }

    return {
      ok: true,
      bytes: input,
      bytesIn,
      bytesOut: bytesIn,
      ratio: 0,
      pages,
      durationMs: performance.now() - started,
      savings: { metadata: 0, pieceInfo: 0, attachments: 0, structural: 0 },
      unchanged: true,
      explanation:
        explainSmallSaving(composition) ??
        'This PDF is already packed as tightly as lossless compression allows.',
      imageShare: composition.imageShare,
      notes: [],
    };
  }

  return {
    ok: true,
    bytes: candidate,
    bytesIn,
    bytesOut: candidate.length,
    ratio: (bytesIn - candidate.length) / bytesIn,
    pages,
    durationMs: performance.now() - started,
    savings,
    unchanged: false,
    // Only explain when the number would otherwise look like a failure.
    explanation: (bytesIn - candidate.length) / bytesIn < 0.08
      ? explainSmallSaving(composition)
      : null,
    imageShare: composition.imageShare,
    notes,
  };
}
