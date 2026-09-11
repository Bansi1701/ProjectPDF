/** Repack objects and safely compact fonts without changing page content. */
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import type { ImagePreset } from './compressimages';
import type { InputFile, OpResult, OpSuccess } from './types';
import { snapshotDocument, matchesSnapshot } from './compressionSafety';

export async function compress(files: InputFile[], _preset: ImagePreset = 'lossless', targetBytes?: number): Promise<OpResult> {
  const file = files[0];
  if (!file || files.length !== 1) return { ok: false, error: 'Choose one PDF to compress.' };
  if (targetBytes !== undefined && (!Number.isSafeInteger(targetBytes) || targetBytes < 1)) return { ok: false, error: 'Enter a positive target size in KB or MB.' };
  const started = performance.now();
  const input = new Uint8Array(file.bytes);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: true });
  } catch {
    return { ok: false, error: 'This PDF could not be read safely. If password-protected, unlock an authorized copy first. Your original is unchanged.' };
  }
  const pages = doc.getPageCount();
  if (doc.isEncrypted) return { ok: false, error: 'This PDF uses encryption. Unlock an authorized copy first; compression will not silently remove its protection.' };
  if (!pages) return { ok: false, error: 'This PDF has no pages.' };
  const finish = (bytes: Uint8Array, explanation: string, unchanged: boolean): OpSuccess => {
    const targetMet = targetBytes === undefined ? undefined : bytes.length <= targetBytes;
    const notes = ['No glyph renumbering, image-quality reduction, metadata stripping or content removal.'];
    if (targetBytes !== undefined) notes.push(targetMet
      ? `Target met: ${bytes.length.toLocaleString('en-US')} bytes is within your ${targetBytes.toLocaleString('en-US')}-byte limit.`
      : `Target not reached: the safest available result is ${bytes.length.toLocaleString('en-US')} bytes, above your ${targetBytes.toLocaleString('en-US')}-byte limit. We did not reduce quality or remove content to force the size. Try a larger limit or split the PDF if the recipient allows it.`);
    return {
      ok: true, files: [{ name: unchanged ? file.name : file.name.replace(/\.pdf$/i, '') + '-compressed.pdf', bytes }],
      bytesIn: input.length, bytesOut: bytes.length, pages, durationMs: performance.now() - started,
      ratio: (input.length - bytes.length) / input.length,
      summary: targetMet === false ? 'Target not reached - content preserved' : unchanged ? 'Original preserved' : 'Compressed without rebuilding content',
      unchanged, explanation, notes, targetBytes, targetMet,
      savings: { metadata: 0, pieceInfo: 0, attachments: 0, structural: input.length - bytes.length },
    };
  };
  // A rewrite invalidates byte-range signatures, even if pages look identical.
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFRawStream ? object.dict : object instanceof PDFDict ? object : null;
    if (dict && (dict.has(PDFName.of('ByteRange')) || dict.has(PDFName.of('XFA')) || String(dict.get(PDFName.of('FT'))) === '/Sig')) {
      return finish(input, 'Signed PDFs, signature fields and XFA forms are returned unchanged to protect their integrity.', true);
    }
  }
  if (targetBytes !== undefined && input.length <= targetBytes) return finish(input, 'Your original already meets the requested size. No rewrite was needed.', true);
  try {
    const snapshot = snapshotDocument(doc);
    const repacked = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 200 });
    const candidate = repacked.length < input.length ? repacked : input;
    const reopened = await PDFDocument.load(candidate, { updateMetadata: false, throwOnInvalidObject: true });
    if (reopened.getPageCount() !== pages || !matchesSnapshot(snapshot, reopened)) return finish(input, 'The preservation check detected a document change. We discarded that result and returned your original unchanged.', true);
    // A stronger font pass keeps all glyph IDs, outlines and metrics. It never
    // rewrites page text. Only offer it after an all-page visual/text check.
    if (pages <= 80 && typeof OffscreenCanvas !== 'undefined') {
      try {
        const { compactFonts } = await import('./compactFonts');
        const fonts = await compactFonts(reopened);
        if (fonts.size) {
          const optimized = await reopened.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 200 });
          const verified = await PDFDocument.load(optimized, { updateMetadata: false, throwOnInvalidObject: true });
          if (optimized.length < candidate.length && matchesSnapshot(snapshot.filter(item => !fonts.has(item.ref.toString())), verified)) {
            const { compressionVisualMatch } = await import('./compressionVisual');
            if (await compressionVisualMatch(input, optimized)) return finish(optimized, `Compacted ${fonts.size} embedded font programs without renumbering or removing glyphs. Every page passed the rendered-pixel and text-position comparison. Keep your original and review the result in your PDF viewer.`, false);
          }
        }
      } catch { /* The already-verified structural result remains available. */ }
    }
    return finish(candidate, 'Verified every original object and encoded content stream. Further font optimization was unavailable, unnecessary or could not pass preservation checks. Keep the original and review the result in your PDF viewer.', candidate === input);
  } catch {
    return finish(input, 'This PDF could not be repacked and verified safely. Your original is returned unchanged.', true);
  }
}
