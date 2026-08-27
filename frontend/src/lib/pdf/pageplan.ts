/**
 * One operation behind six tools.
 *
 * Reorder, rotate, delete pages, extract pages, split and merge were six
 * separate code paths that each asked the user to type page numbers into a
 * box while guessing what was on those pages. They are not six operations.
 * They are six views of one:
 *
 *     produce a new page list, where each entry names a source page and
 *     says how it is turned.
 *
 * Reorder moves entries. Rotate changes their angle. Delete and extract are
 * the same subset seen from opposite sides. Merge is a plan that spans files.
 * Split is a plan with cut marks. Once the plan is the shared model, a visual
 * page grid and a typed range are two editors for the same thing rather than
 * two implementations that drift apart — which is exactly how the renderer
 * options rotted until only one tool had a full set.
 */
import { PDFDocument, degrees } from '@cantoo/pdf-lib';

import type { InputFile, OpResult, PagePlan } from './types';
import { preserveDocumentMetadata } from './documentinfo';
import { preserveDocumentOutlines } from './outlines';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

/** Turns a rotation into the 0/90/180/270 that PDF actually stores. */
const normalise = (angle: number): number => ((Math.round(angle / 90) * 90) % 360 + 360) % 360;

export async function compose(
  files: InputFile[],
  plan: PagePlan[],
  cuts: number[],
  label: string
): Promise<OpResult> {
  if (files.length === 0) return { ok: false, error: 'Choose a PDF.' };
  if (plan.length === 0) {
    return {
      ok: false,
      error: 'Every page is marked for removal, so there would be nothing left. Keep at least one.',
    };
  }

  const started = performance.now();
  const bytesIn = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

  // Each source is parsed once however many pages the plan takes from it.
  const sources: PDFDocument[] = [];
  for (const file of files) {
    try {
      sources.push(await PDFDocument.load(file.bytes, { ignoreEncryption: true }));
    } catch {
      return {
        ok: false,
        error: `${file.name} could not be read. If it is password-protected, remove the password first with Unlock.`,
      };
    }
  }

  for (const entry of plan) {
    const source = sources[entry.file];
    if (!source) return { ok: false, error: 'That page plan refers to a file that is not here.' };
    if (entry.page < 1 || entry.page > source.getPageCount()) {
      return {
        ok: false,
        error: `Page ${entry.page} does not exist in ${files[entry.file]?.name ?? 'that file'}.`,
      };
    }
  }

  // Cut points split the plan into groups; with none, it is all one document.
  const bounds = [...new Set(cuts.filter((cut) => cut > 0 && cut < plan.length))].sort(
    (a, b) => a - b
  );
  const groups: PagePlan[][] = [];
  let start = 0;
  for (const bound of bounds) {
    groups.push(plan.slice(start, bound));
    start = bound;
  }
  groups.push(plan.slice(start));

  const outputs: { name: string; bytes: Uint8Array }[] = [];
  let rotated = 0;

  for (const [index, group] of groups.entries()) {
    if (group.length === 0) continue;

    const out = await PDFDocument.create();
    // The first participating source owns the output document metadata. This
    // mirrors how merge tools conventionally treat the first file as the base.
    preserveDocumentMetadata(sources[group[0].file], out);

    // Copy per source file in one call rather than per page: copyPages walks
    // the object graph each time it is invoked, and doing that once per page
    // is the difference between instant and visibly slow on a large document.
    const wanted = new Map<number, number[]>();
    const slots = new Map<number, number[]>();

    group.forEach((entry, position) => {
      const pages = wanted.get(entry.file) ?? [];
      const positions = slots.get(entry.file) ?? [];
      pages.push(entry.page - 1);
      positions.push(position);
      wanted.set(entry.file, pages);
      slots.set(entry.file, positions);
    });

    const placed = new Array<Awaited<ReturnType<PDFDocument['copyPages']>>[number] | null>(
      group.length
    ).fill(null);

    for (const [fileIndex, indices] of wanted) {
      const copied = await out.copyPages(sources[fileIndex], indices);
      const positions = slots.get(fileIndex) ?? [];
      copied.forEach((page, i) => {
        placed[positions[i]] = page;
      });
    }

    placed.forEach((page, position) => {
      if (!page) return;
      const extra = normalise(group[position].rotate ?? 0);
      if (extra !== 0) {
        page.setRotation(degrees(normalise(page.getRotation().angle + extra)));
        rotated += 1;
      }
      out.addPage(page);
    });

    // Outline destinations point at source page references. Rebuild the tree
    // only after every output page exists, remapping each surviving bookmark
    // to the page position the plan gave it in this particular output group.
    preserveDocumentOutlines(sources, out, group);

    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false, updateMetadata: false });
    outputs.push({
      name: groups.length > 1 ? `${label}-${index + 1}.pdf` : `${label}.pdf`,
      bytes,
    });
  }

  if (outputs.length === 0) {
    return { ok: false, error: 'That plan produced no pages.' };
  }

  const totalPages = plan.length;
  const bytesOut = outputs.reduce((sum, file) => sum + file.bytes.length, 0);

  const sourcePages = sources.reduce((sum, source) => sum + source.getPageCount(), 0);
  const removed = sourcePages - totalPages;

  const parts: string[] = [];
  if (outputs.length > 1) parts.push(`${outputs.length} files`);
  parts.push(`${totalPages} page${totalPages === 1 ? '' : 's'}`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (rotated > 0) parts.push(`${rotated} turned`);

  return {
    ok: true,
    files: outputs,
    bytesIn,
    bytesOut,
    pages: totalPages,
    durationMs: performance.now() - started,
    summary: parts.join(' · '),
    notes: [
      'Pages were copied, not re-encoded — text, images and fonts are byte-for-byte what they were.',
      'Title, author, subject, keywords, creator, creation date and every bookmark whose destination remains in this result were preserved and remapped.',
      'Everything happened in this tab. Nothing was uploaded.',
    ],
  };
}
