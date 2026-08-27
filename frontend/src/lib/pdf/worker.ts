/**
 * Every PDF operation runs here, never on the main thread.
 *
 * pdf-lib parses and rewrites documents synchronously in places; on a large
 * file that is hundreds of milliseconds of frozen page. The engine itself is
 * imported lazily so a tool page costs nothing until someone picks a file.
 */
import type { WorkerRequest, WorkerResponse, OpResult } from './types';

/* Each engine is imported only when its operation is requested. A merge no
   longer downloads OCR, Office conversion, scanning and every other engine
   merely because they share this worker entrypoint. Literal import paths let
   Vite emit stable route-level chunks while keeping the single worker API. */
async function run(request: WorkerRequest): Promise<OpResult> {
  // A probe inspects the document and renders nothing, so each tool that needs
  // one answers for itself.
  if (request.probe) {
    if (request.op === 'forms') return (await import('./forms')).probeForm(request.files);
    // Metadata's probe is the tool's read half: it shows what the file is
    // carrying before anyone decides what to change.
    if (request.op === 'metadata') return (await import('./metadata')).readMetadata(request.files);
    return (await import('./images')).probePdf(request.files);
  }

  if (request.preview) return (await import('./preview')).renderThumbnails(request.files);

  // The page grid keeps its documents open between requests, so its messages
  // are addressed to a session rather than run as a one-shot operation.
  if (request.session === 'open') return (await import('./thumbs')).openSession(request.sessionId ?? 0, request.files);
  if (request.session === 'render') {
    return (await import('./thumbs')).renderThumbs(request.sessionId ?? 0, request.wanted ?? [], request.thumbWidth);
  }
  if (request.session === 'close') {
    (await import('./thumbs')).closeSession(request.sessionId ?? 0);
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
    const { editDocument } = await import('./edit');
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
    const { applyEdits, editDocument } = await import('./edit');
    if (request.op === 'edit') return editDocument(request.files, request.edits);
    request = { ...request, files: await applyEdits(request.files, request.edits) };
  }

  switch (request.op) {
    case 'compress':
      return (await import('./compress')).compress(request.files);
    case 'merge':
      return (await import('./organise')).merge(request.files);
    case 'split':
      return (await import('./organise')).split(request.files, request.ranges ?? '');
    case 'rotate':
      return (await import('./organise')).rotate(request.files, request.turn ?? 90, request.rotatePages ?? '');
    case 'images-to-pdf':
      return (await import('./images')).imagesToPdf(request.files, request.pageSize ?? 'fit');
    case 'pdf-to-images':
      return (await import('./images')).pdfToImages(request.files, request.format ?? 'png', request.dpi ?? 150, request.imagePages ?? '');
    case 'reorder':
      return (await import('./organise')).reorder(request.files, request.pageOrder ?? []);
    case 'extract':
      return (await import('./organise')).extract(request.files, request.ranges ?? '');
    case 'delete':
      return (await import('./organise')).deletePages(request.files, request.ranges ?? '');
    case 'edit':
      return (await import('./edit')).editDocument(request.files, request.edits ?? []);
    case 'watermark':
      return (await import('./watermark')).watermark(request.files, {
        ...request.watermarkOptions,
        text: request.watermarkOptions?.text ?? request.text ?? '',
      });
    case 'page-numbers':
      return (await import('./edit')).pageNumbers(request.files, {
        ...request.pageNumberOptions,
        start: request.pageNumberOptions?.start ?? request.startNumber ?? 1,
      });
    case 'compare':
      return (await import('./compare')).compare(request.files);
    case 'protect':
      return (await import('./security')).protect(
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
      return (await import('./security')).unlock(request.files, request.userPassword ?? '');
    case 'pdf-to-markdown':
      return (await import('./markdown')).pdfToMarkdown(request.files);
    case 'forms':
      return (await import('./forms')).fillForm(request.files, request.fieldValues ?? {}, request.flatten ?? false);
    case 'sign':
      return (await import('./sign')).signPdf(
        request.files,
        request.signature,
        request.targetPage ?? -1,
        request.corner ?? 'bottom-right',
        request.signatureWidth ?? 160
      );
    case 'pdf-a':
      return (await import('./archive')).toPdfA(request.files);
    case 'repair':
      return (await import('./archive')).repair(request.files);
    case 'ocr':
      return (await import('./ocr')).ocrPdf(request.files, request.searchable ?? true, request.ocrPages ?? '');
    case 'redact':
      return (await import('./redact')).redact(request.files, request.boxes ?? []);
    case 'word-to-pdf':
      return (await import('./docx')).docxToPdf(request.files);
    case 'excel-to-pdf':
      return (await import('./spreadsheet')).xlsxToPdf(request.files);
    case 'powerpoint-to-pdf':
      return (await import('./slides')).pptxToPdf(request.files);
    case 'flatten':
      return (await import('./flatten')).flattenPdf(request.files, request.flattenOptions ?? {});
    case 'impose':
      return (await import('./impose')).impose(
        request.files,
        request.imposeOptions ?? { kind: 'n-up', perSheet: 2 }
      );
    case 'extract-images':
      return (await import('./extractimages')).extractImages(request.files, request.extractOptions ?? {});
    case 'overlay':
      return (await import('./overlay')).overlay(request.files, request.overlayOptions ?? {});
    case 'text-to-pdf':
      return (await import('./textdoc')).textDocToPdf(request.files, request.textDocOptions ?? {});
    case 'metadata':
      return (await import('./metadata')).writeMetadata(request.files, request.metadataChanges ?? {});
    case 'header-footer':
      return (await import('./headerfooter')).headerFooter(request.files, request.headerFooterOptions ?? {});
    case 'auto-crop':
      return (await import('./autocrop')).autoCrop(request.files, request.autoCropOptions ?? {});
    case 'grayscale':
      return (await import('./grayscale')).grayscale(request.files, request.grayscaleOptions ?? {});
    case 'split-by':
      return (await import('./splitby')).splitBy(request.files, request.splitByOptions ?? { mode: 'every', every: 10 });
    case 'pdf-to-word':
      return (await import('./pdftoword')).pdfToWord(request.files);
    case 'pdf-to-excel':
      return (await import('./pdftoexcel')).pdfToExcel(request.files);
    case 'crop':
      return (await import('./crop')).crop(
        request.files,
        request.cropBox ?? { x: 0, y: 0, width: 1, height: 1 },
        request.cropPages
      );
    case 'scan':
      return (await import('./scan')).scanToPdf(
        request.files,
        request.scanMode ?? 'text',
        request.pageSize ?? 'fit',
        request.detectEdges ?? true,
        request.quads ?? []
      );
    case 'compose':
      return (await import('./pageplan')).compose(
        request.files,
        request.plan ?? [],
        request.cuts ?? [],
        request.label ?? 'pages'
      );
    default:
      return { ok: false, error: `Unknown operation: ${String(request.op)}` };
  }
}

import { setProgressSink } from './progress';

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

  // Scoped to this request, so a report can never land on the next job's bar.
  setProgressSink((progress) => {
    ctx.postMessage({ id: request.id, progress } satisfies import('./types').WorkerProgress);
  });

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
  } finally {
    setProgressSink(null);
  }
};
