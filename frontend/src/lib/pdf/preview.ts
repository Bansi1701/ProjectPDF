/**
 * A strip of small page thumbnails, rendered off the main thread.
 *
 * Exists so someone can see what is actually inside a file before running a
 * tool on it. Resolution is fixed low and the page count is capped — this is
 * a thumbnail strip, not an export, so it has to stay fast on a 300-page
 * scan rather than compete with the DPI a real render needs.
 */
import { documentOptions, loadPdfjs } from './pdfjs';
import type { InputFile, OpResult } from './types';

const DPI = 48;
const PAGE_LIMIT = 8;

export async function renderThumbnails(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  const api = await loadPdfjs();

  let doc: Awaited<ReturnType<typeof api.getDocument>['promise']>;
  try {
    doc = await api.getDocument({ data: new Uint8Array(file.bytes), ...documentOptions() }).promise;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const totalPages = doc.numPages;
  const limit = Math.min(totalPages, PAGE_LIMIT);
  const thumbnails: { page: number; bytes: Uint8Array }[] = [];

  try {
    for (let n = 1; n <= limit; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: DPI / 72 });
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height))
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) return { ok: false, error: 'This browser would not give us a canvas to render into.' };

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas })
        .promise;

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      thumbnails.push({ page: n, bytes: new Uint8Array(await blob.arrayBuffer()) });

      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    await doc.destroy();
  }

  return { ok: true, preview: true, pages: totalPages, thumbnails };
}
