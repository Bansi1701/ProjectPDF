/**
 * Every PDF operation runs here, never on the main thread.
 *
 * pdf-lib parses and rewrites documents synchronously in places; on a large
 * file that is hundreds of milliseconds of frozen page. The engine itself is
 * imported lazily so a tool page costs nothing until someone picks a file.
 */
import { compress } from './compress';
import { imagesToPdf, pdfToImages, probePdf } from './images';
import { renderThumbnails } from './preview';
import { addText, compare, pageNumbers, watermark } from './edit';
import { deletePages, extract, merge, reorder, rotate, split } from './organise';
import { repair, toPdfA } from './archive';
import { fillForm, probeForm } from './forms';
import { pdfToMarkdown } from './markdown';
import { ocrPdf } from './ocr';
import { docxToPdf } from './docx';
import { redact } from './redact';
import { pptxToPdf } from './slides';
import { xlsxToPdf } from './spreadsheet';
import { protect, unlock } from './security';
import { signPdf } from './sign';
import type { WorkerRequest, WorkerResponse, OpResult } from './types';

/* Static imports: Vite cannot code-split a worker bundle, and the laziness
   that matters is already there — the worker is not constructed until someone
   picks a file, so a tool page still loads no engine code.

   The one exception is pdf.js, which is 3 MB and only PDF → image needs it.
   `images.ts` reaches for it with a dynamic import, and `worker.format: 'es'`
   in astro.config.mjs keeps that a separate chunk. */
async function run(request: WorkerRequest): Promise<OpResult> {
  // A probe inspects the document and renders nothing, so each tool that needs
  // one answers for itself.
  if (request.probe) {
    return request.op === 'forms' ? probeForm(request.files) : probePdf(request.files);
  }

  if (request.preview) return renderThumbnails(request.files);

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
    case 'reorder':
      return reorder(request.files, request.pageOrder ?? []);
    case 'extract':
      return extract(request.files, request.ranges ?? '');
    case 'delete':
      return deletePages(request.files, request.ranges ?? '');
    case 'edit':
      return addText(request.files, request.text ?? '', request.targetPage ?? 1);
    case 'watermark':
      return watermark(request.files, request.text ?? '');
    case 'page-numbers':
      return pageNumbers(request.files, request.startNumber ?? 1, request.prefix ?? '');
    case 'compare':
      return compare(request.files);
    case 'protect':
      return protect(
        request.files,
        request.userPassword ?? '',
        request.ownerPassword ?? '',
        request.permissions ?? {
          printing: true,
          copying: false,
          modifying: false,
          annotating: false,
        }
      );
    case 'unlock':
      return unlock(request.files, request.userPassword ?? '');
    case 'pdf-to-markdown':
      return pdfToMarkdown(request.files);
    case 'forms':
      return fillForm(request.files, request.fieldValues ?? {}, request.flatten ?? false);
    case 'sign':
      return signPdf(
        request.files,
        request.signature,
        request.targetPage ?? -1,
        request.corner ?? 'bottom-right',
        request.signatureWidth ?? 160
      );
    case 'pdf-a':
      return toPdfA(request.files);
    case 'repair':
      return repair(request.files);
    case 'ocr':
      return ocrPdf(request.files, request.searchable ?? true);
    case 'redact':
      return redact(request.files, request.boxes ?? []);
    case 'word-to-pdf':
      return docxToPdf(request.files);
    case 'excel-to-pdf':
      return xlsxToPdf(request.files);
    case 'powerpoint-to-pdf':
      return pptxToPdf(request.files);
    default:
      return { ok: false, error: `Unknown operation: ${String(request.op)}` };
  }
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    const result = await run(request);
    const response: WorkerResponse = { id: request.id, result };

    // Transfer output buffers rather than copying them.
    const transfer =
      result.ok && 'files' in result
        ? result.files.map((file) => file.bytes.buffer as ArrayBuffer)
        : [];

    ctx.postMessage(response, transfer);
  } catch (error) {
    ctx.postMessage({
      id: request.id,
      result: { ok: false, error: (error as Error).message },
    } satisfies WorkerResponse);
  }
};
