/**
 * Redaction.
 *
 * A black rectangle drawn over text is not redaction. The text is still in the
 * content stream, still selectable, still extractable by anyone who opens the
 * file in a text editor — and people have lost cases and jobs over exactly
 * that. Every "redact" feature that draws a box is a liability wearing a
 * feature's clothing.
 *
 * This takes the approach that cannot leak: the page is RASTERISED. Each page
 * is rendered to pixels, the redacted areas are painted over those pixels, and
 * the resulting image replaces the page entirely. There is no text layer, no
 * vector content, no metadata behind the mark — because there is nothing
 * behind it at all. Whatever was under the box is not hidden; it no longer
 * exists in the output.
 *
 * The cost is real and stated plainly: the result is images, so the text is no
 * longer selectable or searchable and the file is larger. That is the trade
 * for a guarantee, and the guarantee is verified rather than asserted — the
 * output is re-opened and checked to contain no extractable text at all.
 */
import { PDFDocument } from '@cantoo/pdf-lib';

import { documentOptions, loadPdfjs } from './pdfjs';
import type { InputFile, OpResult, RedactionBox } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/** Rendering resolution. High enough to read, low enough to stay sane. */
const DPI = 150;
const MAX_PIXELS = 12_000_000;

export async function redact(files: InputFile[], boxes: RedactionBox[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };
  if (boxes.length === 0) {
    return { ok: false, error: 'Drag a box over anything that should be removed first.' };
  }

  const started = performance.now();
  // Captured before pdf.js sees it: getDocument takes ownership of the buffer
  // it is given and detaches it, so byteLength reads 0 afterwards.
  const bytesIn = file.bytes.byteLength;
  const api = await loadPdfjs();

  const source = await api.getDocument({
    data: new Uint8Array(file.bytes),
    ...documentOptions(),
  }).promise;

  const output = await PDFDocument.create();

  try {
    for (let n = 1; n <= source.numPages; n += 1) {
      const page = await source.getPage(n);
      const unit = page.getViewport({ scale: 1 });

      let scale = DPI / 72;
      if (unit.width * scale * unit.height * scale > MAX_PIXELS) {
        scale = Math.sqrt(MAX_PIXELS / (unit.width * unit.height));
      }

      const viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return { ok: false, error: 'This browser would not give us a canvas to render into.' };

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
        canvas,
      }).promise;

      // Paint over the pixels. After this the ink is gone from the bitmap,
      // and the bitmap is all the output page will contain.
      ctx.fillStyle = '#000000';
      for (const box of boxes) {
        if (box.page !== n) continue;
        ctx.fillRect(
          box.x * canvas.width,
          box.y * canvas.height,
          box.width * canvas.width,
          box.height * canvas.height
        );
      }

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const image = await output.embedPng(await blob.arrayBuffer());
      const sheet = output.addPage([unit.width, unit.height]);
      sheet.drawImage(image, { x: 0, y: 0, width: unit.width, height: unit.height });

      page.cleanup();
    }
  } catch (error) {
    await source.destroy();
    return { ok: false, error: `Could not redact: ${(error as Error).message}` };
  }

  await source.destroy();

  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });

  // ── prove it ──────────────────────────────────────────────────────────
  // Re-open the result and try to extract text. A rasterised page has none;
  // anything found here would mean content survived, and the file must not
  // be handed over.
  let leaked = '';
  try {
    const check = await api.getDocument({ data: bytes.slice(), ...documentOptions() }).promise;
    for (let n = 1; n <= check.numPages; n += 1) {
      const page = await check.getPage(n);
      const content = await page.getTextContent();
      leaked += content.items.map((item) => String((item as { str?: string }).str ?? '')).join('');
      page.cleanup();
    }
    await check.destroy();
  } catch {
    return { ok: false, error: 'The redacted file could not be verified, so it was not returned. Your original is untouched.' };
  }

  if (leaked.trim().length > 0) {
    return {
      ok: false,
      error:
        'Verification failed: text was still extractable from the result, so it was not returned. Your original file is untouched. Please report this — it should be impossible.',
    };
  }

  const pageCount = boxes.reduce((set, box) => set.add(box.page), new Set<number>()).size;

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-redacted.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: output.getPageCount(),
    durationMs: performance.now() - started,
    summary: `Redacted ${boxes.length} area${boxes.length === 1 ? '' : 's'} on ${pageCount} page${pageCount === 1 ? '' : 's'}`,
    notes: [
      'Every page was rasterised. What was under a black box is not hidden — it is gone, because the text and vector layers no longer exist in this file.',
      'Verified: the result was re-opened and contains no extractable text at all. If it had, you would have got an error instead of a file.',
      'The trade is that the document is now images. The text cannot be selected or searched, and the file is larger. Keep your original somewhere safe.',
    ],
  };
}
