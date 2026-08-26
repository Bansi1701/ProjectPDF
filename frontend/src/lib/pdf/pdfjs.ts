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

/**
 * The options that stop a page rendering blank.
 *
 * Without cMapUrl and standardFontDataUrl, CJK text and non-embedded base-14
 * fonts produce an empty page — a failure that looks exactly like success.
 */
export const documentOptions = () => ({
  cMapUrl: assetUrl('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('standard_fonts'),
  wasmUrl: assetUrl('wasm'),
  iccUrl: assetUrl('iccs'),
  // The default is computed from `document.baseURI`, which does not exist in a
  // worker. Say it explicitly or getDocument throws before it starts.
  useWorkerFetch: true,
  // `document.fonts` does not exist here either; glyphs are drawn as outlines.
  disableFontFace: true,
  isEvalSupported: false,
});
