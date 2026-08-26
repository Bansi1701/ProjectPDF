/**
 * Every PDF operation runs here, never on the main thread.
 *
 * pdf-lib parses and rewrites documents synchronously in places; on a large
 * file that is hundreds of milliseconds of frozen page. The engine itself is
 * imported lazily so a tool page costs nothing until someone picks a file.
 */
import { compress } from './compress';
import { merge, rotate, split, reorder, extract, deletePages } from './organise';
import { addText, watermark, pageNumbers, compare } from './edit';
import type { WorkerRequest, WorkerResponse, OpResult } from './types';

/* Static imports: Vite cannot code-split a worker bundle, and the laziness
   that matters is already there — the worker is not constructed until someone
   picks a file, so a tool page still loads no engine code. */
async function run(request: WorkerRequest): Promise<OpResult> {
  switch (request.op) {
    case 'compress':
      return compress(request.files);
    case 'merge':
      return merge(request.files);
    case 'split':
      return split(request.files, request.ranges ?? '');
    case 'rotate':
      return rotate(request.files, request.turn ?? 90);
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
    const transfer = result.ok
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
