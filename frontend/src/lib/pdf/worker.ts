/**
 * Every PDF operation runs here, never on the main thread.
 *
 * pdf-lib parses and rewrites documents synchronously in places; on a large
 * file that is hundreds of milliseconds of frozen page. The engine itself is
 * imported lazily so a tool page costs nothing until someone picks a file.
 */
import { compress } from './compress';
import { imagesToPdf, pdfToImages, probePdf } from './images';
import { merge, rotate, split } from './organise';
import type { WorkerRequest, WorkerResponse, OpResult } from './types';

/* Static imports: Vite cannot code-split a worker bundle, and the laziness
   that matters is already there — the worker is not constructed until someone
   picks a file, so a tool page still loads no engine code.

   The one exception is pdf.js, which is 3 MB and only PDF → image needs it.
   `images.ts` reaches for it with a dynamic import, and `worker.format: 'es'`
   in astro.config.mjs keeps that a separate chunk. */
async function run(request: WorkerRequest): Promise<OpResult> {
  if (request.probe) return probePdf(request.files);

  switch (request.op) {
    case 'compress':
      return compress(request.files);
    case 'merge':
      return merge(request.files);
    case 'split':
      return split(request.files, request.ranges ?? '');
    case 'rotate':
      return rotate(request.files, request.turn ?? 90);
    case 'images-to-pdf':
      return imagesToPdf(request.files, request.pageSize ?? 'fit');
    case 'pdf-to-images':
      return pdfToImages(request.files, request.format ?? 'png', request.dpi ?? 150);
    default:
      return { ok: false, error: `Unknown operation: ${String(request.op)}` };
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    const result = await run(request);
    const response: WorkerResponse = { id: request.id, result };

    // Transfer output buffers rather than copying them.
    const transfer =
      result.ok && 'files' in result
        ? result.files.map((file) => file.bytes.buffer as ArrayBuffer)
        : [];

    self.postMessage(response, transfer);
  } catch (error) {
    self.postMessage({
      id: request.id,
      result: { ok: false, error: (error as Error).message },
    } satisfies WorkerResponse);
  }
};
