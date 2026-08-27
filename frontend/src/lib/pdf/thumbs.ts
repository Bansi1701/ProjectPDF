/**
 * Page thumbnails for the grid editor.
 *
 * The old preview rendered a fixed strip of eight and returned PNG bytes. A
 * grid you can actually edit in needs every page, and the naive version of
 * that is unusable: rendering 500 pages up front is half a minute of frozen
 * nothing, and 500 encoded PNGs is a great deal of memory to hold for images
 * measuring 120px across.
 *
 * Three things make it fast instead:
 *
 *  - The document stays OPEN between requests. Re-parsing a 40 MB file for
 *    every batch of thumbnails costs more than the rendering does.
 *  - Only what the viewer can see is rendered, on demand, as it scrolls.
 *  - Frames come back as ImageBitmap, which transfers to the main thread
 *    without a copy and paints through `transferFromImageBitmap` with no
 *    decode step. PNG round-tripping was most of the old cost.
 *
 * Geometry for every page is returned when the session opens, so the grid can
 * lay out correctly sized placeholders immediately and fill them in later.
 * Reserving the right box up front is what stops the page reflowing under
 * someone's cursor while they are dragging.
 */
import { documentOptions, loadPdfjs } from './pdfjs';
import type { InputFile, OpResult, PageGeometry } from './types';

/** Thumbnails are display-only; this is generous at any realistic cell size. */
const THUMB_WIDTH = 220;

/**
 * How many pages will ever be given a picture.
 *
 * Lazy rendering already means only what is on screen gets drawn, so this is
 * not about speed — it is a ceiling on how much a single enormous document
 * can be made to allocate, whether by a 4,000-page scan or by someone poking
 * at it. Past this point cells still appear, still reorder, still rotate and
 * still delete; they just show a page number instead of a picture, which the
 * grid says out loud rather than looking broken.
 */
export const PREVIEW_LIMIT = 600;

/** Most pages that may be asked for in one message, so a batch stays brief. */
const BATCH_LIMIT = 24;

/**
 * The largest single render this will produce.
 *
 * Reading a page to check it is the right one needs far more than a cell does,
 * but a page is not always A4: a plan or a poster at this width is still a
 * sane number of pixels, whereas scaling by a DPI is not.
 */
const MAX_RENDER_WIDTH = 1600;

interface Session {
  docs: Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>[];
  geometry: PageGeometry[];
}

const sessions = new Map<number, Session>();

/**
 * Opens the files and reports every page's size, without rendering anything.
 */
export async function openSession(id: number, files: InputFile[]): Promise<OpResult> {
  closeSession(id);

  if (files.length === 0) return { ok: false, error: 'Choose a PDF.' };

  const api = await loadPdfjs();
  const docs: Session['docs'] = [];
  const geometry: PageGeometry[] = [];

  try {
    for (const [fileIndex, file] of files.entries()) {
      const doc = await api.getDocument({
        data: new Uint8Array(file.bytes),
        ...documentOptions(),
      }).promise;
      docs.push(doc);

      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        // The viewport already folds in the page's own /Rotate, so these are
        // the dimensions as the page is meant to be seen.
        const viewport = page.getViewport({ scale: 1 });
        geometry.push({
          file: fileIndex,
          page: n,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        });
        page.cleanup();
      }
    }
  } catch (error) {
    for (const doc of docs) await doc.loadingTask.destroy().catch(() => undefined);
    return {
      ok: false,
      error: `That file could not be opened for preview: ${(error as Error).message}`,
    };
  }

  sessions.set(id, { docs, geometry });
  return { ok: true, session: true, geometry, previewLimit: PREVIEW_LIMIT };
}

/**
 * Renders the requested pages. Anything that fails renders as nothing rather
 * than failing the batch — one broken page should not empty the grid.
 */
export async function renderThumbs(
  id: number,
  wanted: { file: number; page: number }[],
  width = THUMB_WIDTH
): Promise<OpResult> {
  const session = sessions.get(id);
  if (!session) {
    return { ok: false, error: 'That preview session has closed. Choose the file again.' };
  }

  const frames: { file: number; page: number; bitmap: ImageBitmap }[] = [];

  for (const request of wanted.slice(0, BATCH_LIMIT)) {
    const doc = session.docs[request.file];
    if (!doc || request.page < 1 || request.page > doc.numPages) continue;

    try {
      const page = await doc.getPage(request.page);
      const unit = page.getViewport({ scale: 1 });
      // Clamped so a malformed request cannot ask for a canvas the tab cannot
      // allocate; the enlarged view wants far more than a cell does.
      const scale = Math.min(Math.max(width, 32), MAX_RENDER_WIDTH) / unit.width;
      const viewport = page.getViewport({ scale });

      const canvas = new OffscreenCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height))
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
        canvas: canvas as unknown as HTMLCanvasElement,
      }).promise;

      frames.push({
        file: request.file,
        page: request.page,
        bitmap: canvas.transferToImageBitmap(),
      });
      page.cleanup();
    } catch {
      // A page that will not render is left blank in the grid; the rest still
      // arrive, and the page is still orderable and rotatable.
    }
  }

  return { ok: true, thumbs: true, frames };
}

export function closeSession(id: number): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  for (const doc of session.docs) void doc.loadingTask.destroy().catch(() => undefined);
}

/** Frees every open session. Used when the tool is reset. */
export function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) closeSession(id);
}
