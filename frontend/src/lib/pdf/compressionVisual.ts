import { documentOptions, loadPdfjs } from './pdfjs';

/** A bounded all-page check; inability to verify means decline optimization. */
export async function compressionVisualMatch(original: Uint8Array, candidate: Uint8Array): Promise<boolean> {
  const api = await loadPdfjs();
  const left = api.getDocument({ data: original.slice(), ...documentOptions() });
  const right = api.getDocument({ data: candidate.slice(), ...documentOptions() });
  try {
    const a = await left.promise; const b = await right.promise;
    if (a.numPages !== b.numPages || a.numPages > 80) return false;
    for (let i = 1; i <= a.numPages; i++) {
      const p = await a.getPage(i); const q = await b.getPage(i);
      const v = p.getViewport({ scale: 1.5 }); const w = q.getViewport({ scale: 1.5 });
      if (v.width !== w.width || v.height !== w.height || v.width * v.height > 3_000_000) return false;
      const text = async (page: typeof p) => (await page.getTextContent()).items.map(item => 'str' in item ? [item.str, item.transform, item.width, item.height] : item);
      if (JSON.stringify(await text(p)) !== JSON.stringify(await text(q))) return false;
      const render = async (page: typeof p) => {
        const canvas = new OffscreenCanvas(Math.ceil(v.width), Math.ceil(v.height));
        try {
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          await page.render({ canvas: null, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: v, background: 'white' }).promise;
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } finally { canvas.width = canvas.height = 0; }
      };
      const pixels = await render(p); const other = await render(q);
      if (pixels.length !== other.length || !pixels.every((value, index) => value === other[index])) return false;
      p.cleanup(); q.cleanup();
    }
    return true;
  } catch { return false; }
  finally { await Promise.allSettled([left.destroy(), right.destroy()]); }
}
