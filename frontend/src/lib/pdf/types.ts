/**
 * Option shapes live with the tool that implements them and are pulled in as
 * TYPES only. That keeps one definition of each — the alternative, restating
 * them here, is the drift that has already cost this codebase real bugs — and
 * type-only imports are erased, so importing back from the tools is not a
 * runtime cycle.
 */
import type { FlattenOptions } from './flatten';
import type { ImposeOptions } from './impose';
import type { ExtractImagesOptions } from './extractimages';
import type { OverlayOptions } from './overlay';
import type { TextDocOptions } from './textdoc';
import type { MetadataChanges, MetadataReport } from './metadata';
import type { HeaderFooterOptions } from './headerfooter';
import type { SplitByOptions } from './splitby';
import type { GrayscaleOptions } from './grayscale';
import type { AutoCropOptions } from './autocrop';

/** Every tool the worker can run. */
export type Operation =
  | 'compress'
  | 'merge'
  | 'split'
  | 'rotate'
  | 'reorder'
  | 'extract'
  | 'delete'
  | 'edit'
  | 'watermark'
  | 'page-numbers'
  | 'compare'
  | 'images-to-pdf'
  | 'pdf-to-images'
  | 'protect'
  | 'unlock'
  | 'pdf-to-markdown'
  | 'forms'
  | 'sign'
  | 'pdf-a'
  | 'repair'
  | 'ocr'
  | 'redact'
  | 'word-to-pdf'
  | 'excel-to-pdf'
  | 'powerpoint-to-pdf'
  | 'compose'
  | 'pdf-to-word'
  | 'pdf-to-excel'
  | 'crop'
  | 'scan'
  | 'flatten'
  | 'impose'
  | 'extract-images'
  | 'overlay'
  | 'text-to-pdf'
  | 'metadata'
  | 'header-footer'
  | 'split-by'
  | 'grayscale'
  | 'auto-crop';

/**
 * One page of the output: which source page it is, and how it is turned.
 *
 * This is the shared model behind reorder, rotate, delete, extract, split and
 * merge — see pageplan.ts for why those are one operation and not six.
 */
export interface PagePlan {
  /** Index into the request's `files`. */
  file: number;
  /** One-based page number within that file. */
  page: number;
  /** Extra clockwise degrees, on top of the rotation the page already has. */
  rotate: number;
}

/** Which editing affordances the page grid offers for a given tool. */
export type GridMode = 'organise' | 'rotate' | 'delete' | 'extract' | 'split' | 'merge';

/** A page's size as it is meant to be seen, with its own rotation applied. */
export interface PageGeometry {
  file: number;
  page: number;
  width: number;
  height: number;
}

/** A rectangle to remove, in fractions of the page so scale never matters. */
export interface RedactionBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A normalized point in the page preview (top-left origin). */
export interface EditPoint {
  x: number;
  y: number;
}

/** Common geometry for marks that occupy a rectangular area. */
export interface EditBox {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  opacity?: number;
  fill?: string;
}

/**
 * A visible edit placed in the shared browser workspace.
 *
 * Positions are fractions of the displayed page and use a top-left origin.
 * Keeping them independent of the preview scale means the same edit lands in
 * the same place at 70% zoom, 150% zoom, and in the exported PDF.
 */
export type EditMark =
  | {
      id: string;
      kind: 'text';
      page: number;
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
    }
  | {
      id: string;
      kind: 'highlight' | 'rectangle' | 'whiteout';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      strokeWidth: number;
      opacity?: number;
      fill?: string;
    }
  | (EditBox & {
      kind: 'underline' | 'strike' | 'strike-through' | 'strikethrough' | 'circle';
    })
  | (EditBox & {
      /** A speech bubble/callout. `text` is optional so a bubble can be empty. */
      kind: 'callout';
      text?: string;
      anchor?: EditPoint;
      fill?: string;
    })
  | {
      id: string;
      kind: 'line' | 'arrow';
      page: number;
      /** Preferred geometry for free-positioned line tools. */
      start?: EditPoint;
      end?: EditPoint;
      /** Box geometry is accepted as a convenient UI/editor shorthand. */
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
      color: string;
      strokeWidth: number;
      opacity?: number;
    }
  | {
      id: string;
      kind: 'polygon' | 'cloud';
      page: number;
      points: EditPoint[];
      color: string;
      strokeWidth: number;
      fill?: string;
      opacity?: number;
    }
  | {
      id: string;
      kind: 'stamp';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      strokeWidth?: number;
      /** Built-in visual stamp names. */
      stamp: 'check' | 'cross' | 'dot' | 'circle' | 'crossout' | string;
      opacity?: number;
    }
  | {
      id: string;
      kind: 'signature' | 'signature-text';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      color?: string;
      strokeWidth?: number;
      /** Optional local image bytes for a drawn/uploaded visual signature. */
      image?: ArrayBuffer | Uint8Array;
      /** Alias accepted by editors that call the payload `bytes`. */
      bytes?: ArrayBuffer | Uint8Array;
      mimeType?: 'image/png' | 'image/jpeg' | 'image/jpg';
      /** Text placeholder when no image is available. */
      text?: string;
      size?: number;
      opacity?: number;
    }
  | {
      id: string;
      kind: 'replace-text' | 'replace';
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      size: number;
      color: string;
      /** Replacement is a visible cover, not secure redaction. */
      backgroundColor?: string;
      strokeWidth?: number;
    }
  | {
      id: string;
      kind: 'ink';
      page: number;
      points: EditPoint[];
      color: string;
      strokeWidth: number;
    };

/** Images → PDF: the shape each page takes. */
export type PageSize = 'fit' | 'a4' | 'letter';

/** PDF → image: the raster format written out. */
export type ImageFormat = 'png' | 'jpeg';

export interface InputFile {
  name: string;
  bytes: ArrayBuffer;
}

export interface OutputFile {
  name: string;
  bytes: Uint8Array;
  /** MIME type for the download. Defaults to application/pdf. */
  type?: string;
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

/**
 * Answer to a `probe` request: page geometry only, no rendering.
 *
 * PDF → image needs to know how big the pages are before it can offer a DPI,
 * and pdf-lib is already in the worker bundle — so the DPI selector can be
 * limited without downloading the renderer first.
 */
/** One fillable field, as the UI needs to render it. */
export interface FormField {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'unsupported';
  value: string;
  options?: string[];
  readOnly?: boolean;
  multiline?: boolean;
}

export interface ProbeSuccess {
  ok: true;
  probe: true;
  pages: number;
  /** Highest whole DPI at which no page exceeds the canvas budget. */
  maxDpi: number;
  /** Forms only. */
  fields?: FormField[];
}

/** Answer to a `preview` request: a strip of small page thumbnails, not a result to save. */
export interface PreviewSuccess {
  ok: true;
  preview: true;
  pages: number;
  thumbnails: { page: number; bytes: Uint8Array }[];
}

/** Answer to `session: 'open'`: every page's size, nothing rendered yet. */
export interface SessionSuccess {
  ok: true;
  session: true;
  geometry: PageGeometry[];
  /** Pages past this many get a numbered placeholder rather than a picture. */
  previewLimit?: number;
}

/** Answer to `session: 'render'`: bitmaps, transferred rather than copied. */
export interface ThumbsSuccess {
  ok: true;
  thumbs: true;
  frames: { file: number; page: number; bitmap: ImageBitmap }[];
}

/**
 * Answer to a metadata read: what the file is carrying, not a file to save.
 * Shaped like the other probes so the worker's single response path covers it.
 */
export interface MetadataSuccess extends MetadataReport {
  ok: true;
}

export type OpResult =
  | MetadataSuccess
  | OpSuccess
  | OpFailure
  | ProbeSuccess
  | PreviewSuccess
  | SessionSuccess
  | ThumbsSuccess;

export interface WorkerRequest {
  id: number;
  op: Operation;
  files: InputFile[];
  /** Split only: comma-separated page groups, e.g. "1-3, 4-6, 9". */
  ranges?: string;
  /** Rotate only: degrees clockwise. */
  turn?: number;
  /** Images → PDF only. */
  pageSize?: PageSize;
  /** PDF → image only. */
  format?: ImageFormat;
  /** PDF → image only: 72, 150 or 300. Clamped per page if a page is huge. */
  dpi?: number;
  /** PDF → image only: measure the pages and return DPI limits, render nothing. */
  probe?: boolean;
  /** Render a strip of low-resolution page thumbnails instead of running `op`. */
  preview?: boolean;
  /**
   * Page-grid session. `open` parses the files and reports page sizes,
   * `render` draws the pages named in `wanted`, `close` releases them.
   */
  session?: 'open' | 'render' | 'close';
  /**
   * Which grid session the message belongs to.
   *
   * Not the message id: every message has a fresh one of those, and keying
   * the open documents by it meant every later request looked up a session
   * that could not exist.
   */
  sessionId?: number;
  /** session: 'render' only — which pages to draw now. */
  wanted?: { file: number; page: number }[];
  /** session: 'render' only — pixel width per page. Defaults to a thumbnail. */
  thumbWidth?: number;
  /** compose only: the output, page by page. */
  plan?: PagePlan[];
  /** compose only: plan indexes after which a new output file begins. */
  cuts?: number[];
  /** compose only: base name for the produced file(s). */
  label?: string;
  /** Crop only: the rectangle to keep, in fractions of the page as displayed. */
  cropBox?: { x: number; y: number; width: number; height: number };
  /** Crop only: one-based pages to crop. Absent means every page. */
  cropPages?: number[];
  /** Scan only: how the captured page is cleaned up. */
  scanMode?: 'text' | 'grey' | 'colour';
  /** Scan only: find the page in the frame and straighten it. */
  detectEdges?: boolean;
  /**
   * Scan only: corners set by hand, per file, as fractions of each frame.
   * Null entries are left to the detector. Fractions rather than pixels so
   * resampling on the way in cannot shift them.
   */
  quads?: (readonly [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] | null)[];

  // --- the cheap-win tools, each carrying its own option shape ----------
  flattenOptions?: FlattenOptions;
  imposeOptions?: ImposeOptions;
  extractOptions?: ExtractImagesOptions;
  overlayOptions?: OverlayOptions;
  textDocOptions?: TextDocOptions;
  metadataChanges?: MetadataChanges;
  headerFooterOptions?: HeaderFooterOptions;
  splitByOptions?: SplitByOptions;
  grayscaleOptions?: GrayscaleOptions;
  autoCropOptions?: AutoCropOptions;
  /** Reorder only: zero-based page indexes in their new order. */
  pageOrder?: number[];
  /** Text tools only. */
  text?: string;
  /** Shared live-workspace edits, applied before the tool's own operation. */
  edits?: EditMark[];
  /** Edit only: one-based target page. */
  targetPage?: number;
  /** Page-number tool only. */
  startNumber?: number;
  prefix?: string;
  /** Redact only. */
  boxes?: RedactionBox[];
  /** OCR only: also produce a searchable PDF, not just text. */
  searchable?: boolean;
  /** Sign only: PNG of the drawn or typed mark, plus where it goes. */
  signature?: ArrayBuffer;
  corner?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  signatureWidth?: number;
  /** Forms only: field name → value, and whether to bake them in. */
  fieldValues?: Record<string, string>;
  flatten?: boolean;
  /** Protect / unlock. */
  userPassword?: string;
  ownerPassword?: string;
  permissions?: {
    printing: boolean;
    copying: boolean;
    modifying: boolean;
    annotating: boolean;
  };
}

export interface WorkerResponse {
  id: number;
  result: OpResult;
}
