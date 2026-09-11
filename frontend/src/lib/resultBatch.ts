import { extensionOf, safeFilename, stemOf } from './filename';

export interface BatchFile { name: string; blob: Blob; url: string }
export const previewableResult = (type: string) => /^(application\/pdf|image\/(?:png|jpeg|webp)|text\/plain)(?:;|$)/i.test(type);

/** Do not overwrite duplicate outputs in the archive (including case collisions). */
export function batchNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(original => {
    const extension = extensionOf(original);
    const clean = safeFilename(original, extension);
    let candidate = clean, suffix = 2;
    while (used.has(candidate.toLowerCase())) candidate = safeFilename(`${suffix++} - ${stemOf(clean)}`, extension);
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Store existing compressed bytes without recompressing or changing any file. */
export async function resultArchive(files: BatchFile[], cancelled: () => boolean, progress: (done: number) => void): Promise<Blob> {
  const { Zip, ZipPassThrough } = await import('fflate');
  const names = batchNames(files.map(file => file.name));
  const chunks: BlobPart[] = [];
  const zip = new Zip((error, data) => { if (error) throw error; chunks.push(data as BlobPart); });
  for (const [index, file] of files.entries()) {
    if (cancelled()) throw new DOMException('Results closed', 'AbortError');
    const entry = new ZipPassThrough(names[index]);
    zip.add(entry);
    for (let offset = 0; offset < Math.max(1, file.blob.size); offset += 1048576) {
      if (cancelled()) throw new DOMException('Results closed', 'AbortError');
      entry.push(new Uint8Array(await file.blob.slice(offset, offset + 1048576).arrayBuffer()), offset + 1048576 >= file.blob.size);
      // Let the page respond during large batches; never zip on the PDF worker.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    progress(index + 1);
  }
  zip.end();
  return new Blob(chunks, { type: 'application/zip' });
}

/** One tab avoids popup-blocked bursts. Names are DOM text, never HTML. */
export function openResultCollection(files: BatchFile[]): boolean {
  const viewer = window.open('', '_blank');
  if (!viewer) return false;
  viewer.opener = null;
  const doc = viewer.document;
  doc.title = `${files.length} files — Filozy`;
  doc.documentElement.lang = 'en';
  const meta = doc.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width, initial-scale=1'; doc.head.append(meta);
  const style = doc.createElement('style');
  style.textContent = 'body{margin:0;padding:20px;font:14px/1.5 system-ui,sans-serif;background:#f8fafc;color:#0f172a}h1{font-size:22px;margin:0 0 8px}p{color:#475569}main{display:grid;grid-template-columns:minmax(200px,320px) minmax(0,1fr);gap:20px}ol{margin:0;padding-left:24px}li{margin-bottom:12px;overflow-wrap:anywhere}button,a{font:inherit;min-height:44px}button{display:block;border:1px solid #cbd5e1;border-radius:8px;padding:8px 12px;background:white;color:#0f172a;text-align:left;cursor:pointer;width:100%;overflow-wrap:anywhere}a{color:#be123c}iframe{width:100%;height:75vh;border:1px solid #cbd5e1;background:white}button[aria-pressed=true]{border-color:#e11d48;background:#fff1f2}@media(max-width:650px){main{grid-template-columns:1fr}iframe{height:65vh}}@media(prefers-color-scheme:dark){body{background:#0b0f17;color:#f1f5f9}p{color:#94a3b8}button{background:#151d2a;color:#f1f5f9;border-color:#475569}button[aria-pressed=true]{background:#42202c}a{color:#fb7185}}';
  doc.head.append(style);
  const title = doc.createElement('h1'); title.textContent = `${files.length} result files`;
  const note = doc.createElement('p'); note.textContent = 'Choose a file to preview. Keep the original Filozy tab open; this viewer does not save copies. Office files and other unsupported formats can be downloaded.';
  const main = doc.createElement('main'), list = doc.createElement('ol'), preview = doc.createElement('section');
  preview.setAttribute('aria-label', 'Selected file preview');
  const buttons: HTMLButtonElement[] = [];
  files.forEach(file => {
    const item = doc.createElement('li'), choose = doc.createElement('button'), download = doc.createElement('a');
    choose.textContent = file.name; choose.type = 'button'; choose.setAttribute('aria-pressed', 'false'); buttons.push(choose);
    download.href = file.url; download.download = file.name; download.textContent = 'Download file';
    choose.addEventListener('click', () => {
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button === choose)));
      preview.replaceChildren();
      if (previewableResult(file.blob.type)) {
        const frame = doc.createElement('iframe'); frame.src = file.url; frame.title = file.name; preview.append(frame);
      } else { const message = doc.createElement('p'); message.textContent = 'Preview is unavailable for this format. Use Download file to open it in its own app.'; preview.append(message); }
    });
    item.append(choose, download); list.append(item);
  });
  main.append(list, preview); doc.body.replaceChildren(title, note, main);
  buttons[0]?.click();
  return true;
}
