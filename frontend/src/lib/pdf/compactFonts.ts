/** Keep EVERY glyph ID. Never infer usage or rewrite page text/Unicode maps. */
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';
import { glyphCount, loadHb, subsetFont, tableOffset, advanceWidth } from './hb';
import { replaceStream } from './streams';

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const table = (f: Uint8Array, name: string) => { const t = tableOffset(f, name); return t ? f.subarray(t.offset, t.offset + t.length) : new Uint8Array(); };

export function sameGlyphs(a: Uint8Array, b: Uint8Array): boolean {
  try {
    const count = glyphCount(a);
    if (!count || glyphCount(b) !== count) return false;
    for (const tag of ['fpgm', 'prep', 'cvt ', 'gasp', 'vhea', 'vmtx']) if (!equal(table(a, tag), table(b, tag))) return false;
    if (!equal(table(a, 'head').subarray(18, 20), table(b, 'head').subarray(18, 20))) return false;
    const glyph = (f: Uint8Array, id: number) => {
      const view = new DataView(f.buffer, f.byteOffset, f.length);
      const loca = tableOffset(f, 'loca')!; const glyf = tableOffset(f, 'glyf')!; const head = tableOffset(f, 'head')!;
      const long = view.getInt16(head.offset + 50) === 1;
      const offset = (n: number) => long ? view.getUint32(loca.offset + n * 4) : view.getUint16(loca.offset + n * 2) * 2;
      const start = glyf.offset + offset(id); let end = glyf.offset + offset(id + 1);
      // TrueType glyph records may differ only in trailing zero alignment bytes.
      while (end > start && f[end - 1] === 0) end--;
      return f.subarray(start, end);
    };
    const bearing = (f: Uint8Array, id: number) => {
      const v = new DataView(f.buffer, f.byteOffset, f.length); const h = tableOffset(f, 'hhea')!; const m = tableOffset(f, 'hmtx')!;
      const n = v.getUint16(h.offset + 34);
      return v.getInt16(m.offset + (id < n ? id * 4 + 2 : n * 4 + (id - n) * 2));
    };
    for (let id = 0; id < count; id++) {
      if (!equal(glyph(a, id), glyph(b, id)) || advanceWidth(a, id)?.width !== advanceWidth(b, id)?.width || bearing(a, id) !== bearing(b, id)) return false;
    }
    return true;
  } catch { return false; }
}

export async function compactFonts(doc: PDFDocument, wasm?: BufferSource): Promise<Set<string>> {
  const changed = new Set<string>();
  // Preserve font programs used for future interactive form input as well.
  if (doc.catalog.has(PDFName.of('AcroForm'))) return changed;
  const refs = new Map<string, PDFRef>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const ref = object.get(PDFName.of('FontFile2'));
    if (ref instanceof PDFRef) refs.set(ref.toString(), ref);
  }
  for (const ref of refs.values()) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    try {
      const font = decodePDFRawStream(stream).decode();
      if (font.length > 4_000_000 || ['fvar', 'CFF ', 'CFF2', 'COLR', 'SVG '].some(tag => tableOffset(font, tag))) continue;
      const count = glyphCount(font);
      if (!count || !tableOffset(font, 'glyf') || !tableOffset(font, 'loca')) continue;
      const rebuilt = subsetFont(await loadHb(wasm), font, new Set(Array.from({ length: count }, (_, i) => i)), true).font;
      if (!sameGlyphs(font, rebuilt)) continue;
      replaceStream(doc, ref, rebuilt);
      const replacement = doc.context.lookup(ref) as PDFRawStream;
      if (replacement.getContentsSize() >= stream.contents.length) doc.context.assign(ref, stream);
      else changed.add(ref.toString());
    } catch { doc.context.assign(ref, stream); changed.delete(ref.toString()); }
  }
  return changed;
}
