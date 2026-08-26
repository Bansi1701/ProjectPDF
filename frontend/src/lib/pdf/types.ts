/** Every tool the worker can run. */
export type Operation = 'compress' | 'merge' | 'split' | 'rotate';

export interface InputFile {
  name: string;
  bytes: ArrayBuffer;
}

export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

/** Where the savings came from. Shown to the user — the honesty is the product. */
export interface Savings {
  metadata: number;
  pieceInfo: number;
  attachments: number;
  structural: number;
  fonts?: number;
}

export interface OpSuccess {
  ok: true;
  files: OutputFile[];
  bytesIn: number;
  bytesOut: number;
  pages: number;
  durationMs: number;
  /** One line describing what happened, e.g. "Merged 3 files". */
  summary: string;

  // --- compress only ---------------------------------------------------
  /** 0–1. Never negative: the original is returned rather than a larger file. */
  ratio?: number;
  /** Why the result is what it is. Null when the number speaks for itself. */
  explanation?: string | null;
  savings?: Savings;
  /** True when the input was already optimal and came back untouched. */
  unchanged?: boolean;
  notes?: string[];
}

export interface OpFailure {
  ok: false;
  error: string;
}

export type OpResult = OpSuccess | OpFailure;

export interface WorkerRequest {
  id: number;
  op: Operation;
  files: InputFile[];
  /** Split only: comma-separated page groups, e.g. "1-3, 4-6, 9". */
  ranges?: string;
  /** Rotate only: degrees clockwise. */
  turn?: number;
}

export interface WorkerResponse {
  id: number;
  result: OpResult;
}
