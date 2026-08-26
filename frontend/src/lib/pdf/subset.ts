/**
 * Font re-subsetting.
 *
 * The largest remaining lossless win on a text document. A résumé measured
 * here embeds three fonts declaring 19,627 glyph slots to draw 119 glyphs;
 * packing them down turns 30 KB of font programs into about 2 KB.
 *
 * It is also the most dangerous thing in this codebase, because renumbering
 * glyphs means rewriting every glyph reference in the document. Get the widths
 * wrong and text renders at the wrong spacing — silently, on some documents
 * only. Every step below therefore either proves itself or declines to act.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';

import { renumberGlyphs, scanGlyphs } from './content';
import { advanceWidth, closeOverComposites, glyphCount, loadHb, subsetFont } from './hb';
import { buildToUnicode, parseToUnicode, remap } from './tounicode';

const decode = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const encode = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

export interface SubsetOutcome {
  fontsSubset: number;
  bytesBefore: number;
  bytesAfter: number;
  skipped: string[];
}

interface Candidate {
  key: string;
  type0: PDFDict;
  descendant: PDFDict;
  descriptor: PDFDict;
  fileKey: 'FontFile2' | 'FontFile3';
  fileRef: PDFRef;
  program: Uint8Array;
}

/** Only Identity-H CID fonts address glyphs by id, which is what we rewrite. */
function isIdentityCid(fontDict: PDFDict): boolean {
  if (String(fontDict.get(PDFName.of('Subtype'))) !== '/Type0') return false;
  const encoding = String(fontDict.get(PDFName.of('Encoding')) ?? '');
  return encoding === '/Identity-H' || encoding === '/Identity-V';
}

function findCandidates(doc: PDFDocument, raw: Map<string, Uint8Array>): Map<string, Candidate> {
  const found = new Map<string, Candidate>();

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || !isIdentityCid(obj)) continue;

    const descendants = obj.get(PDFName.of('DescendantFonts'));
    const array = descendants ? doc.context.lookupMaybe(descendants, PDFArray) : null;
    if (!array || array.size() === 0) continue;

    const descendant = doc.context.lookupMaybe(array.get(0), PDFDict);
    if (!descendant) continue;

    // CIDToGIDMap must be Identity, or CID and GID differ and our rewrite of
    // the content stream would not line up with the glyphs we kept.
    const cidToGid = descendant.get(PDFName.of('CIDToGIDMap'));
    if (cidToGid !== undefined && String(cidToGid) !== '/Identity') continue;

    const descriptorRef = descendant.get(PDFName.of('FontDescriptor'));
    const descriptor = descriptorRef ? doc.context.lookupMaybe(descriptorRef, PDFDict) : null;
    if (!descriptor) continue;

    for (const fileKey of ['FontFile2', 'FontFile3'] as const) {
      const fileRef = descriptor.get(PDFName.of(fileKey));
      if (!(fileRef instanceof PDFRef)) continue;

      const stream = doc.context.lookup(fileRef);
      if (!(stream instanceof PDFRawStream)) continue;

      const program = raw.get(fileRef.toString());
      if (!program) continue;

      // CFF subsetting through this path is not verified, so leave it alone.
      if (fileKey === 'FontFile3') continue;

      found.set(ref.toString(), {
        key: ref.toString(),
        type0: obj,
        descendant,
        descriptor,
        fileKey,
        fileRef,
        program,
      });
      break;
    }
  }

  return found;
}

/** /W is [ cid [w w w] cid cid w ... ] keyed by CID, which for Identity is GID. */
function readWidths(doc: PDFDocument, descendant: PDFDict): Map<number, number> {
  const widths = new Map<number, number>();
  const wRef = descendant.get(PDFName.of('W'));
  const w = wRef ? doc.context.lookupMaybe(wRef, PDFArray) : null;
  if (!w) return widths;

  let i = 0;
  while (i < w.size()) {
    const first = doc.context.lookupMaybe(w.get(i), PDFNumber)?.asNumber();
    if (first === undefined) break;

    const next = doc.context.lookup(w.get(i + 1));

    if (next instanceof PDFArray) {
      for (let j = 0; j < next.size(); j += 1) {
        const value = doc.context.lookupMaybe(next.get(j), PDFNumber)?.asNumber();
        if (value !== undefined) widths.set(first + j, value);
      }
      i += 2;
      continue;
    }

    const last = doc.context.lookupMaybe(w.get(i + 1), PDFNumber)?.asNumber();
    const value = doc.context.lookupMaybe(w.get(i + 2), PDFNumber)?.asNumber();
    if (last === undefined || value === undefined) break;
    for (let cid = first; cid <= last; cid += 1) widths.set(cid, value);
    i += 3;
  }

  return widths;
}

function writeWidths(doc: PDFDocument, descendant: PDFDict, widths: Map<number, number>): void {
  const entries = [...widths.entries()].sort((a, b) => a[0] - b[0]);
  const array = doc.context.obj([]) as PDFArray;

  // One [cid [w]] run per contiguous block keeps the array compact.
  let index = 0;
  while (index < entries.length) {
    const start = entries[index][0];
    const run: number[] = [entries[index][1]];
    let next = index + 1;
    while (next < entries.length && entries[next][0] === entries[next - 1][0] + 1) {
      run.push(entries[next][1]);
      next += 1;
    }
    array.push(PDFNumber.of(start));
    const inner = doc.context.obj([]) as PDFArray;
    for (const value of run) inner.push(PDFNumber.of(value));
    array.push(inner);
    index = next;
  }

  descendant.set(PDFName.of('W'), array);
}

/**
 * Subsets every eligible font and rewrites the document to match.
 *
 * `decodedStreams` supplies already-inflated bytes for streams, because
 * decoding is the caller's concern and differs between environments.
 */
export async function subsetFonts(
  doc: PDFDocument,
  decodedStreams: Map<string, Uint8Array>,
  writeStream: (ref: PDFRef, bytes: Uint8Array) => void,
  wasmBytes?: BufferSource
): Promise<SubsetOutcome> {
  const outcome: SubsetOutcome = { fontsSubset: 0, bytesBefore: 0, bytesAfter: 0, skipped: [] };

  const candidates = findCandidates(doc, decodedStreams);
  if (candidates.size === 0) return outcome;

  // ── which glyphs does each font actually draw? ────────────────────────
  const usage = new Map<string, Set<number>>();
  const pageStreams: { ref: PDFRef; text: string; fontByName: Map<string, string> }[] = [];

  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const fontsRef = resources?.get(PDFName.of('Font'));
    const fonts = fontsRef ? doc.context.lookupMaybe(fontsRef, PDFDict) : null;
    if (!fonts) continue;

    const fontByName = new Map<string, string>();
    for (const [name, value] of fonts.entries()) {
      if (value instanceof PDFRef) fontByName.set(String(name), value.toString());
    }

    const contents = page.node.get(PDFName.of('Contents'));
    const refs: PDFRef[] = [];
    if (contents instanceof PDFRef) refs.push(contents);
    else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const item = contents.get(i);
        if (item instanceof PDFRef) refs.push(item);
      }
    }

    for (const ref of refs) {
      const bytes = decodedStreams.get(ref.toString());
      if (!bytes) continue;
      const text = decode(bytes);
      pageStreams.push({ ref, text, fontByName });

      const found = scanGlyphs(text, fontByName, (key) => candidates.has(key));
      for (const [key, set] of found) {
        let target = usage.get(key);
        if (!target) usage.set(key, (target = new Set()));
        for (const gid of set) target.add(gid);
      }
    }
  }

  // A font used inside a Form XObject would not be rewritten by the page pass
  // above, so leave those fonts alone entirely rather than half-renumber them.
  const inForms = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (String(obj.dict.get(PDFName.of('Subtype'))) !== '/Form') continue;

    const resources = obj.dict.get(PDFName.of('Resources'));
    const dict = resources ? doc.context.lookupMaybe(resources, PDFDict) : null;
    const fontsRef = dict?.get(PDFName.of('Font'));
    const fonts = fontsRef ? doc.context.lookupMaybe(fontsRef, PDFDict) : null;
    if (!fonts) continue;

    for (const [, value] of fonts.entries()) {
      if (value instanceof PDFRef) inForms.add(value.toString());
    }
  }

  const hb = await loadHb(wasmBytes);
  const mappings = new Map<string, Map<number, number>>();
  const accepted: Candidate[] = [];

  for (const candidate of candidates.values()) {
    const used = usage.get(candidate.key);

    if (inForms.has(candidate.key)) {
      outcome.skipped.push('used inside a form XObject');
      continue;
    }
    if (!used || used.size === 0) continue;

    const keep = new Set(used);
    keep.add(0); // .notdef

    const before = glyphCount(candidate.program);
    if (before === null || keep.size >= before) continue;

    // A glyph id at or beyond the font's glyph count cannot be real; it means
    // the scan picked up bytes that were never a glyph reference.
    for (const gid of [...keep]) if (gid >= before) keep.delete(gid);

    // hb keeps composite components regardless; add them so the retained set
    // matches the one we numbered.
    const closed = closeOverComposites(candidate.program, keep);

    let result;
    try {
      result = subsetFont(hb, candidate.program, closed);
    } catch {
      outcome.skipped.push('harfbuzz declined this font');
      continue;
    }

    // ── prove the renumbering is right before trusting it ───────────────
    const originalWidths = readWidths(doc, candidate.descendant);
    let widthsAgree = true;

    let compared = 0;

    for (const [oldGid, newGid] of result.mapping) {
      const oldAdvance = advanceWidth(candidate.program, oldGid);
      const newAdvance = advanceWidth(result.font, newGid);

      if (oldAdvance === null || newAdvance === null) {
        widthsAgree = false;
        break;
      }
      // Only compare where neither side is reusing the last entry.
      if (oldAdvance.clamped || newAdvance.clamped) continue;

      compared += 1;
      if (oldAdvance.width !== newAdvance.width) {
        widthsAgree = false;
        break;
      }
    }

    // If nothing could be compared we have proved nothing, so decline.
    if (compared === 0) widthsAgree = false;

    if (!widthsAgree) {
      outcome.skipped.push('glyph metrics did not survive renumbering');
      continue;
    }

    mappings.set(candidate.key, result.mapping);
    accepted.push(candidate);

    outcome.bytesBefore += candidate.program.length;
    outcome.bytesAfter += result.font.length;

    // widths, keyed by the new ids
    const remapped = new Map<number, number>();
    for (const [oldGid, newGid] of result.mapping) {
      const width = originalWidths.get(oldGid);
      if (width !== undefined) remapped.set(newGid, width);
    }

    // The /ToUnicode CMap is keyed by the same codes we just renumbered.
    // Leaving it alone yields a document that renders correctly and cannot be
    // copied, searched, or read aloud.
    const toUnicodeRef = candidate.type0.get(PDFName.of('ToUnicode'));
    if (toUnicodeRef instanceof PDFRef) {
      const existing = decodedStreams.get(toUnicodeRef.toString());
      if (existing) {
        const next = remap(parseToUnicode(existing), result.mapping);
        if (next.size > 0) writeStream(toUnicodeRef, buildToUnicode(next));
      }
    }

    writeStream(candidate.fileRef, result.font);
    if (remapped.size > 0) writeWidths(doc, candidate.descendant, remapped);
    outcome.fontsSubset += 1;
  }

  if (accepted.length === 0) return outcome;

  // ── rewrite every content stream to the new ids ──────────────────────
  for (const stream of pageStreams) {
    const next = renumberGlyphs(stream.text, stream.fontByName, mappings);
    if (next === null) {
      // Analysis and stream disagree: abandon the whole pass rather than ship
      // a document where some references were renumbered and others were not.
      return { fontsSubset: 0, bytesBefore: 0, bytesAfter: 0, skipped: ['content stream rewrite failed'] };
    }
    if (next !== stream.text) writeStream(stream.ref, encode(next));
  }

  return outcome;
}
