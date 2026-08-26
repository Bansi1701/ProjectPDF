/**
 * Merge, split and rotate.
 *
 * All three are pure page-dictionary work — no content stream is parsed, no
 * pixel is touched. Rotate in particular only edits `/Rotate`, so it is exactly
 * as lossless as doing nothing.
 */
import { PDFDocument, degrees } from '@cantoo/pdf-lib';

import type { InputFile, OpResult, OutputFile } from './types';

const load = async (file: InputFile): Promise<PDFDocument> =>
  PDFDocument.load(file.bytes, { updateMetadata: false });

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

const total = (files: OutputFile[]): number =>
  files.reduce((sum, file) => sum + file.bytes.length, 0);

export async function merge(files: InputFile[]): Promise<OpResult> {
  if (files.length < 2) {
    return { ok: false, error: 'Choose at least two PDFs to merge.' };
  }

  const started = performance.now();
  const output = await PDFDocument.create();
  let bytesIn = 0;

  for (const file of files) {
    bytesIn += file.bytes.byteLength;
    const source = await load(file);
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }

  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false });
  const out: OutputFile[] = [{ name: 'merged.pdf', bytes }];

  return {
    ok: true,
    files: out,
    bytesIn,
    bytesOut: bytes.length,
    pages: output.getPageCount(),
    durationMs: performance.now() - started,
    summary: `Merged ${files.length} files into ${output.getPageCount()} pages`,
  };
}

/** "1-3, 4-6, 9" → one document per comma-separated group. */
function parseGroup(group: string, pageCount: number): number[] {
  const pages = new Set<number>();

  for (const token of group.trim().split(/[\s,]+/)) {
    if (!token) continue;

    const [startText, endText] = token.split('-');
    const start = Number(startText);
    const end = endText === undefined || endText === '' ? start : Number(endText);

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > pageCount
    ) {
      throw new Error(`"${token}" is not a valid range. This PDF has ${pageCount} pages.`);
    }

    for (let page = start; page <= end; page += 1) pages.add(page - 1);
  }

  if (pages.size === 0) throw new Error('That page group is empty.');
  return [...pages];
}

export async function split(files: InputFile[], ranges: string): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to split.' };

  const started = performance.now();
  const source = await load(file);
  const pageCount = source.getPageCount();

  const groups = ranges
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean);

  if (groups.length === 0) {
    return { ok: false, error: 'Enter at least one page group, for example "1-3, 4-6".' };
  }

  const out: OutputFile[] = [];
  const stem = baseName(file.name);

  try {
    for (const [index, group] of groups.entries()) {
      const indices = parseGroup(group, pageCount);
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(source, indices);
      for (const page of pages) doc.addPage(page);

      out.push({
        name: `${stem}-${index + 1}.pdf`,
        bytes: await doc.save({ useObjectStreams: true, addDefaultPage: false }),
      });
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  return {
    ok: true,
    files: out,
    bytesIn: file.bytes.byteLength,
    bytesOut: total(out),
    pages: pageCount,
    durationMs: performance.now() - started,
    summary: `Split into ${out.length} document${out.length === 1 ? '' : 's'}`,
  };
}

export async function rotate(files: InputFile[], turn: number): Promise<OpResult> {
  if (files.length === 0) return { ok: false, error: 'Choose a PDF to rotate.' };

  const started = performance.now();
  const out: OutputFile[] = [];
  let bytesIn = 0;
  let pages = 0;

  for (const file of files) {
    bytesIn += file.bytes.byteLength;
    const doc = await load(file);

    for (const page of doc.getPages()) {
      // Normalise into 0–359 so repeated turns stay valid.
      const next = (((page.getRotation().angle + turn) % 360) + 360) % 360;
      page.setRotation(degrees(next));
    }

    pages += doc.getPageCount();
    out.push({
      name: `${baseName(file.name)}-rotated.pdf`,
      bytes: await doc.save({ useObjectStreams: true, addDefaultPage: false }),
    });
  }

  return {
    ok: true,
    files: out,
    bytesIn,
    bytesOut: total(out),
    pages,
    durationMs: performance.now() - started,
    summary: `Rotated ${pages} page${pages === 1 ? '' : 's'} by ${turn}°`,
  };
}
