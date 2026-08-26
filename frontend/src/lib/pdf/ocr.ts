/**
 * OCR — read text off a scanned page.
 *
 * Three decisions shape this, all of them about honesty and payload.
 *
 * The engine and its language data are SELF-HOSTED. tesseract.js defaults to
 * fetching both from a public CDN, which would tell a third party the moment
 * anyone opens this tool — on the one product whose entire claim is that
 * nothing leaves the device. Roughly 5 MB is served from our own origin
 * instead, and only once someone actually runs a job.
 *
 * The output is a SEARCHABLE PDF, not a replacement. The original page image
 * stays exactly as it was and the recognised words are drawn over it
 * invisibly, so the document still looks like the scan and can now be searched
 * and copied. Replacing the image with recognised text would silently discard
 * whatever the recogniser got wrong.
 *
 * And it reports its own CONFIDENCE. OCR on a clean 300 DPI scan is close to
 * perfect; on a phone photo of a creased page it is guesswork. A number the
 * reader can see is worth more than a paragraph of caveats.
 */
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

import { documentOptions, loadPdfjs } from './pdfjs';
import type { InputFile, OpResult, OutputFile } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/** Recognition happens at this DPI regardless of the page's own size. */
const OCR_DPI = 200;

/** Above this, a page is rendered smaller rather than risk the canvas dying. */
const MAX_PIXELS = 12_000_000;

interface Word {
  text: string;
  confidence: number;
  /** In rendered-canvas pixels. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export async function ocrPdf(files: InputFile[], searchable: boolean): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to read.' };

  const started = performance.now();

  // Absolute, same-origin. A root-relative path cannot be resolved by
  // importScripts inside a Worker — there is no document to resolve against.
  const origin = (path: string): string =>
    new URL(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path}`, self.location.href).href;

  const [{ createWorker }, api] = await Promise.all([
    import('tesseract.js'),
    loadPdfjs(),
  ]);

  const source = await api.getDocument({
    data: new Uint8Array(file.bytes),
    ...documentOptions(),
  }).promise;

  // Everything served from our own origin. corePath and langPath are the two
  // that otherwise reach for a CDN.
  const worker = await createWorker('eng', 1, {
    workerPath: origin('tesseract/worker.min.js'),
    corePath: origin('tesseract/'),
    langPath: origin('tessdata/'),
    gzip: true,
  });

  const output = searchable ? await PDFDocument.create() : null;
  const helvetica = output ? await output.embedFont(StandardFonts.Helvetica) : null;

  const text: string[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;

  try {
    for (let n = 1; n <= source.numPages; n += 1) {
      const page = await source.getPage(n);
      const unit = page.getViewport({ scale: 1 });

      let scale = OCR_DPI / 72;
      if (unit.width * scale * unit.height * scale > MAX_PIXELS) {
        scale = Math.sqrt(MAX_PIXELS / (unit.width * unit.height));
      }

      const viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return { ok: false, error: 'This browser would not give us a canvas to render into.' };

      // OCR reads dark-on-light; a transparent background comes out black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas }).promise;

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const result = await worker.recognize(blob, {}, { blocks: true, text: true });

      text.push(result.data.text.trim());

      if (typeof result.data.confidence === 'number') {
        confidenceSum += result.data.confidence;
        confidenceCount += 1;
      }

      if (output && helvetica) {
        // The scan itself, unchanged.
        const image = await output.embedPng(await blob.arrayBuffer());
        const sheet = output.addPage([unit.width, unit.height]);
        sheet.drawImage(image, { x: 0, y: 0, width: unit.width, height: unit.height });

        const words: Word[] = [];
        for (const block of (result.data.blocks ?? []) as Array<Record<string, unknown>>) {
          for (const para of (block.paragraphs ?? []) as Array<Record<string, unknown>>) {
            for (const line of (para.lines ?? []) as Array<Record<string, unknown>>) {
              for (const word of (line.words ?? []) as unknown as Word[]) {
                if (word.text?.trim()) words.push(word);
              }
            }
          }
        }

        // Invisible, but selectable and searchable: the text is really in the
        // content stream, it just does not paint.
        for (const word of words) {
          const height = (word.bbox.y1 - word.bbox.y0) / scale;
          const size = Math.max(1, height * 0.92);
          sheet.drawText(word.text, {
            x: word.bbox.x0 / scale,
            y: unit.height - word.bbox.y1 / scale + height * 0.12,
            size,
            font: helvetica,
            opacity: 0,
          });
        }
      }

      page.cleanup();
    }
  } catch (error) {
    await worker.terminate();
    await source.destroy();
    return { ok: false, error: `OCR failed: ${(error as Error).message}` };
  }

  await worker.terminate();
  await source.destroy();

  const joined = text.join('\n\n').trim();
  if (!joined) {
    return {
      ok: false,
      error: 'Nothing legible was found on these pages. If the scan is faint or skewed, a straighter, higher-contrast copy will do much better.',
    };
  }

  const outputs: OutputFile[] = [
    { name: `${baseName(file.name)}.txt`, bytes: new TextEncoder().encode(joined + '\n'), type: 'text/plain' },
  ];

  if (output) {
    outputs.unshift({
      name: `${baseName(file.name)}-searchable.pdf`,
      bytes: await output.save({ useObjectStreams: true, addDefaultPage: false }),
    });
  }

  const confidence = confidenceCount > 0 ? Math.round(confidenceSum / confidenceCount) : 0;
  const words = joined.split(/\s+/).filter(Boolean).length;

  const notes = [
    `Average confidence ${confidence}%. Below about 80 the text is worth reading through before relying on it.`,
  ];

  if (output) {
    notes.push(
      'The searchable PDF keeps your original page image and puts the recognised words behind it, invisibly. It still looks like the scan, and now it can be searched and copied.'
    );
  }

  notes.push('English only for now. The engine and its language data were served from this site, not a CDN.');

  return {
    ok: true,
    files: outputs,
    bytesIn: file.bytes.byteLength,
    bytesOut: outputs.reduce((sum, item) => sum + item.bytes.length, 0),
    pages: source.numPages,
    durationMs: performance.now() - started,
    summary: `Read ${words.toLocaleString()} words`,
    notes,
  };
}
