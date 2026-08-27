/**
 * Every PDF operation runs here, never on the main thread.
 *
 * pdf-lib parses and rewrites documents synchronously in places; on a large
 * file that is hundreds of milliseconds of frozen page. The engine itself is
 * imported lazily so a tool page costs nothing until someone picks a file.
 */
import { compress } from './compress';
import { imagesToPdf, pdfToImages, probePdf } from './images';
import { compose } from './pageplan';
import { autoCrop } from './autocrop';
import { crop } from './crop';
import { extractImages } from './extractimages';
import { flattenPdf } from './flatten';
import { grayscale } from './grayscale';
import { headerFooter } from './headerfooter';
import { impose } from './impose';
import { readMetadata, writeMetadata } from './metadata';
import { overlay } from './overlay';
import { splitBy } from './splitby';
import { textDocToPdf } from './textdoc';
import { pdfToExcel } from './pdftoexcel';
import { pdfToWord } from './pdftoword';
import { scanToPdf } from './scan';
import { renderThumbnails } from './preview';
import { closeSession, openSession, renderThumbs } from './thumbs';
import { applyEdits, compare, editDocument, pageNumbers, watermark } from './edit';
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
    if (request.op === 'forms') return probeForm(request.files);
    // Metadata's probe is the tool's read half: it shows what the file is
    // carrying before anyone decides what to change.
    if (request.op === 'metadata') return readMetadata(request.files);
    return probePdf(request.files);
  }

  if (request.preview) return renderThumbnails(request.files);

  // The page grid keeps its documents open between requests, so its messages
  // are addressed to a session rather than run as a one-shot operation.
  if (request.session === 'open') return openSession(request.sessionId ?? 0, request.files);
  if (request.session === 'render') {
    return renderThumbs(request.sessionId ?? 0, request.wanted ?? [], request.thumbWidth);
  }
  if (request.session === 'close') {
    closeSession(request.sessionId ?? 0);
    return { ok: true, session: true, geometry: [] };
  }

  // Quick edits from the shared page workspace are part of the same local
  // transaction as the selected tool. The dedicated editor returns them
  // directly; other tools receive an in-memory edited input and continue as
  // normal. No intermediate file is downloaded or uploaded.
  if (
    request.op === 'sign' &&
    !request.signature &&
    request.edits?.some((mark) => mark.kind === 'signature' || mark.kind === 'signature-text')
  ) {
    const placed = await editDocument(request.files, request.edits);
    if (!placed.ok || !('files' in placed)) return placed;
    const sourceName = request.files[0]?.name ?? 'document.pdf';
    return {
      ...placed,
      files: placed.files.map((file, index) => index === 0
        ? { ...file, name: `${sourceName.replace(/\.pdf$/i, '')}-signed.pdf` }
        : file),
      summary: 'Placed the signature on the page',
      notes: [
        'This is a visual signature placed exactly where you chose in the page editor.',
        'It is not a certificate-backed digital signature and does not prove the PDF was unchanged later.',
      ],
    };
  }
  if (request.edits?.length) {
    if (request.op === 'edit') return editDocument(request.files, request.edits);
    request = { ...request, files: await applyEdits(request.files, request.edits) };
  }

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
      return editDocument(request.files, request.edits ?? []);
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
    case 'flatten':
      return flattenPdf(request.files, request.flattenOptions ?? {});
    case 'impose':
      return impose(
        request.files,
        request.imposeOptions ?? { kind: 'n-up', perSheet: 2 }
      );
    case 'extract-images':
      return extractImages(request.files, request.extractOptions ?? {});
    case 'overlay':
      return overlay(request.files, request.overlayOptions ?? {});
    case 'text-to-pdf':
      return textDocToPdf(request.files, request.textDocOptions ?? {});
    case 'metadata':
      return writeMetadata(request.files, request.metadataChanges ?? {});
    case 'header-footer':
      return headerFooter(request.files, request.headerFooterOptions ?? {});
    case 'auto-crop':
      return autoCrop(request.files, request.autoCropOptions ?? {});
    case 'grayscale':
      return grayscale(request.files, request.grayscaleOptions ?? {});
    case 'split-by':
      return splitBy(request.files, request.splitByOptions ?? { mode: 'every', every: 10 });
    case 'pdf-to-word':
      return pdfToWord(request.files);
    case 'pdf-to-excel':
      return pdfToExcel(request.files);
    case 'crop':
      return crop(
        request.files,
        request.cropBox ?? { x: 0, y: 0, width: 1, height: 1 },
        request.cropPages
      );
    case 'scan':
      return scanToPdf(
        request.files,
        request.scanMode ?? 'text',
        request.pageSize ?? 'fit',
        request.detectEdges ?? true,
        request.quads ?? []
      );
    case 'compose':
      return compose(
        request.files,
        request.plan ?? [],
        request.cuts ?? [],
        request.label ?? 'pages'
      );
    default:
      return { ok: false, error: `Unknown operation: ${String(request.op)}` };
  }
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  // This worker is intentionally a closed, local-only boundary: it never
  // fetches URLs or forwards document bytes. Keep a small runtime guard here
  // because postMessage data is untrusted at runtime even though the caller is
  // typed as WorkerRequest.
  const candidate = event.data as unknown;
  if (!candidate || typeof candidate !== 'object') {
    ctx.postMessage({ id: -1, result: { ok: false, error: 'Invalid worker request.' } } satisfies WorkerResponse);
    return;
  }
  const request = candidate as WorkerRequest;
  if (!Number.isInteger(request.id) || !Array.isArray(request.files)) {
    ctx.postMessage({ id: Number.isInteger(request.id) ? request.id : -1, result: { ok: false, error: 'Invalid worker request.' } } satisfies WorkerResponse);
    return;
  }

  try {
    const result = await run(request);
    const response: WorkerResponse = { id: request.id, result };

    // Transfer output buffers and bitmaps rather than copying them. A grid
    // scrolling through a long document moves a lot of pixels; copying them
    // would cost more than the rendering.
    const transfer: Transferable[] =
      result.ok && 'files' in result
        ? result.files.map((file) => file.bytes.buffer as ArrayBuffer)
        : result.ok && 'thumbs' in result
          ? result.frames.map((frame) => frame.bitmap)
          : [];

    ctx.postMessage(response, transfer);
  } catch (error) {
    ctx.postMessage({
      id: request.id,
      result: { ok: false, error: (error as Error).message },
    } satisfies WorkerResponse);
  }
};
