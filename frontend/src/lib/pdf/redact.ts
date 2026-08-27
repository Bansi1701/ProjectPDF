/**
 * Redaction.
 *
 * A black rectangle drawn over text is not redaction. The text is still in the
 * content stream, still selectable, still extractable by anyone who opens the
 * file in a text editor — and people have lost cases and jobs over exactly
 * that. Every "redact" feature that draws a box is a liability wearing a
 * feature's clothing.
 *
 * This takes the approach that cannot leak: every page carrying a redaction is
 * RASTERISED. The marked areas are painted over those pixels and that image
 * replaces the page entirely. Pages without a redaction are copied losslessly,
 * so a mark on page 40 does not make the other 399 pages unsearchable.
 *
 * The cost on those pages is real and stated plainly: they become images, so
 * their text is no longer selectable or searchable and the file can become
 * larger. That is the trade for a guarantee, and the guarantee is verified
 * rather than asserted — the output is re-opened and every redacted page is
 * checked to contain no extractable text at all.
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

  let original: PDFDocument;
  try {
    original = await PDFDocument.load(file.bytes.slice(0), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    return {
      ok: false,
      error: 'That PDF could not be read. If it is password-protected, remove the password first with Unlock.',
    };
  }

  const source = await api.getDocument({
    // pdf.js may take ownership of and detach the buffer it receives. Keep the
    // original bytes available to pdf-lib for untouched pages.
    data: new Uint8Array(file.bytes.slice(0)),
    ...documentOptions(),
  }).promise;

  const output = await PDFDocument.create();
  const redactedPages = new Set(boxes.map((box) => box.page));

  for (const box of boxes) {
    if (!Number.isInteger(box.page) || box.page < 1 || box.page > source.numPages) {
      await source.loadingTask.destroy();
      return { ok: false, error: `A redaction refers to page ${box.page}, but this PDF has ${source.numPages} pages.` };
    }
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.x < 0 ||
      box.y < 0 ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.x + box.width > 1.000001 ||
      box.y + box.height > 1.000001
    ) {
      await source.loadingTask.destroy();
      return { ok: false, error: 'One redaction box falls outside its page. Draw that box again before saving.' };
    }
  }

  try {
    for (let n = 1; n <= source.numPages; n += 1) {
      if (!redactedPages.has(n)) {
        const [copied] = await output.copyPages(original, [n - 1]);
        output.addPage(copied);
        continue;
      }

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
    await source.loadingTask.destroy();
    return { ok: false, error: `Could not redact: ${(error as Error).message}` };
  }

  await source.loadingTask.destroy();

  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });

  // ── prove it ──────────────────────────────────────────────────────────
  // Re-open the result and try to extract text from every redacted page. A
  // rasterised page has none; anything found there means content survived and
  // the file must not be handed over. Untouched pages intentionally stay text.
  let leaked = '';
  try {
    const check = await api.getDocument({ data: bytes.slice(), ...documentOptions() }).promise;
    for (let n = 1; n <= check.numPages; n += 1) {
      if (!redactedPages.has(n)) continue;
      const page = await check.getPage(n);
      const content = await page.getTextContent();
      leaked += content.items.map((item) => String((item as { str?: string }).str ?? '')).join('');
      page.cleanup();
    }
    await check.loadingTask.destroy();
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

  const pageCount = redactedPages.size;
  const untouched = output.getPageCount() - pageCount;

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-redacted.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: output.getPageCount(),
    durationMs: performance.now() - started,
    summary: `Redacted ${boxes.length} area${boxes.length === 1 ? '' : 's'} on ${pageCount} page${pageCount === 1 ? '' : 's'}`,
    notes: [
      `${pageCount} redacted page${pageCount === 1 ? ' was' : 's were'} rasterised. What was under a black box is not hidden — it is gone because that page's text and vector layers no longer exist in this file.`,
      `Verified: ${pageCount === 1 ? 'the redacted page contains' : 'all redacted pages contain'} no extractable text. If any text had survived there, you would have got an error instead of a file.`,
      untouched > 0
        ? `${untouched} untouched page${untouched === 1 ? ' stayed' : 's stayed'} searchable and selectable, with no re-encoding.`
        : 'Every page was redacted, so the whole document is now images and its text is no longer searchable or selectable.',
      'The output is rebuilt without document metadata, bookmarks or attachments. Keep your original somewhere safe.',
    ],
  };
}
