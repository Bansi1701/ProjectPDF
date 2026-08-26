/**
 * Compression runs here, never on the main thread.
 *
 * pdf-lib parses and rewrites the whole document synchronously in places; on a
 * large file that is hundreds of milliseconds. On the main thread that is a
 * frozen page.
 */
import { compress } from './index';
import type { WorkerRequest, WorkerResponse } from './types';

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, bytes } = event.data;

  try {
    const result = await compress(new Uint8Array(bytes));
    const response: WorkerResponse = { id, result };

    // Transfer the output buffer rather than copying it.
    if (result.ok) {
      const buffer = result.bytes.buffer as ArrayBuffer;
      self.postMessage(response, [buffer]);
    } else {
      self.postMessage(response);
    }
  } catch (error) {
    const response: WorkerResponse = {
      id,
      result: { ok: false, error: (error as Error).message },
    };
    self.postMessage(response);
  }
};
