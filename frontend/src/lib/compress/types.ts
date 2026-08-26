/** What the user asked for. Lossless never touches a pixel. */
export type CompressMode = 'lossless';

export interface CompressRequest {
  bytes: Uint8Array;
  mode: CompressMode;
}

/** Where the savings came from. Shown to the user — the honesty is the product. */
export interface Savings {
  metadata: number;
  pieceInfo: number;
  attachments: number;
  structural: number;
}

export interface CompressResult {
  /** Why the result is what it is. Null when the saving speaks for itself. */
  explanation: string | null;
  imageShare: number;
  ok: true;
  bytes: Uint8Array;
  bytesIn: number;
  bytesOut: number;
  /** 0–1. Negative is impossible: we return the original rather than grow a file. */
  ratio: number;
  pages: number;
  durationMs: number;
  savings: Savings;
  /** True when the input was already optimal and we returned it untouched. */
  unchanged: boolean;
  notes: string[];
}

export interface CompressFailure {
  ok: false;
  error: string;
}

export type CompressResponse = CompressResult | CompressFailure;

export interface WorkerRequest {
  id: number;
  bytes: ArrayBuffer;
  mode: CompressMode;
}

export interface WorkerResponse {
  id: number;
  result: CompressResponse;
}
