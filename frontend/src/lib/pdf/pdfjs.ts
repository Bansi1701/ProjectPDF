/**
 * Shared pdf.js loader.
 *
 * pdf.js normally spawns its own Worker. We are already inside one, and nested
 * workers are a long-running source of Safari bugs — so the worker module is
 * imported directly and handed over through `globalThis.pdfjsWorker`, which is
 * pdf.js's supported same-thread path. "Same thread" here still means off the
 * main thread; the page stays responsive either way.
 *
 * Loaded on demand: 3 MB that only the render-adjacent tools need.
 */
export type PdfjsApi = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjs: Promise<PdfjsApi> | null = null;

export function loadPdfjs(): Promise<PdfjsApi> {
  pdfjs ??= (async () => {
    const [api, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]);
    (globalThis as Record<string, unknown>).pdfjsWorker = worker;
    return api;
  })();

  return pdfjs;
}

/** Absolute, same-origin, and honouring the `base` this site is deployed under. */
export const assetUrl = (folder: string): string => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return new URL(`${base}/pdfjs/${folder}/`, self.location.href).href;
};

/** What pdf.js hands back from a canvas factory, and hollows out again on destroy. */
interface CanvasEntry {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}

/**
 * A canvas factory backed by OffscreenCanvas.
 *
 * Mid-render, pdf.js allocates scratch surfaces of its own — to downscale an
 * oversized image, to tile a pattern, to composite a soft mask — and its
 * default factory reaches for `document.createElement('canvas')`. There is no
 * document in a worker, so those pages die on `undefined.createElement` while
 * plainer ones in the same file render fine. This is pdf.js's supported way to
 * say where canvases come from.
 */
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasEntry {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }

  reset(entry: CanvasEntry, width: number, height: number): void {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }

  destroy(entry: CanvasEntry): void {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    entry.canvas.width = entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

/**
 * pdf.js composes some soft masks through an SVG `<filter>` it appends to the
 * host document. There is no document here, so those return "none" — the mask
 * is still applied, just without its transfer curve. Everything else,
 * including all text and image drawing, is unaffected.
 */
class NoFilterFactory {
  addFilter(): string {
    return 'none';
  }
  addHCMFilter(): string {
    return 'none';
  }
  addAlphaFilter(): string {
    return 'none';
  }
  addLuminosityFilter(): string {
    return 'none';
  }
  addHighlightHCMFilter(): string {
    return 'none';
  }
  destroy(): void {}
}

/**
 * The options that stop a page rendering blank — or not rendering at all.
 *
 * Without cMapUrl and standardFontDataUrl, CJK text and non-embedded base-14
 * fonts produce an empty page — a failure that looks exactly like success.
 * Without the two factories, any page that needs a scratch canvas throws.
 *
 * Every caller spreads this. A tool that assembles its own options drifts out
 * of sync silently, and the gap only shows up on the one document that needs
 * the part it is missing.
 */
export const documentOptions = () => ({
  cMapUrl: assetUrl('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('standard_fonts'),
  // JBIG2 and JPEG 2000 images in scanned documents are decoded by these.
  wasmUrl: assetUrl('wasm'),
  iccUrl: assetUrl('iccs'),
  // The default is computed from `document.baseURI`, which does not exist in a
  // worker. Say it explicitly or getDocument throws before it starts.
  useWorkerFetch: true,
  // `document.fonts` does not exist here either; glyphs are drawn as outlines.
  disableFontFace: true,
  isEvalSupported: false,
  CanvasFactory: OffscreenCanvasFactory,
  FilterFactory: NoFilterFactory,
});
