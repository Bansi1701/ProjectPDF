import { PDFDocument, degrees, rgb } from '@cantoo/pdf-lib';
import type { InputFile, OpResult } from './types';

const baseName = (name: string) => name.replace(/\.pdf$/i, '');
const load = (file: InputFile) => PDFDocument.load(file.bytes, { updateMetadata: false });

export async function addText(files: InputFile[], text: string, targetPage: number): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to edit.' };
  if (!text.trim()) return { ok: false, error: 'Enter the text you want to add.' };
  const started = performance.now();
  const doc = await load(file);
  if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > doc.getPageCount()) {
    return { ok: false, error: `Choose a page from 1 to ${doc.getPageCount()}.` };
  }
  doc.getPage(targetPage - 1).drawText(text.trim(), { x: 36, y: 36, size: 16, color: rgb(0.12, 0.18, 0.28) });
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { ok: true, files: [{ name: `${baseName(file.name)}-edited.pdf`, bytes }], bytesIn: file.bytes.byteLength, bytesOut: bytes.length, pages: doc.getPageCount(), durationMs: performance.now() - started, summary: `Added text to page ${targetPage}` };
}

export async function watermark(files: InputFile[], text: string): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to watermark.' };
  if (!text.trim()) return { ok: false, error: 'Enter watermark text.' };
  const started = performance.now();
  const doc = await load(file);
  doc.getPages().forEach((page) => {
    const { width, height } = page.getSize();
    page.drawText(text.trim(), { x: width * 0.14, y: height * 0.42, size: Math.min(width, height) / 10, rotate: degrees(-35), opacity: 0.22, color: rgb(0.72, 0.12, 0.14) });
  });
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { ok: true, files: [{ name: `${baseName(file.name)}-watermarked.pdf`, bytes }], bytesIn: file.bytes.byteLength, bytesOut: bytes.length, pages: doc.getPageCount(), durationMs: performance.now() - started, summary: `Watermarked ${doc.getPageCount()} pages` };
}

export async function pageNumbers(files: InputFile[], start: number, prefix: string): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to number.' };
  if (!Number.isInteger(start) || start < 1) return { ok: false, error: 'Starting number must be 1 or higher.' };
  const started = performance.now();
  const doc = await load(file);
  doc.getPages().forEach((page, index) => {
    const { width } = page.getSize();
    page.drawText(`${prefix}${start + index}`, { x: Math.max(24, width - 76), y: 24, size: 11, color: rgb(0.18, 0.18, 0.18) });
  });
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { ok: true, files: [{ name: `${baseName(file.name)}-numbered.pdf`, bytes }], bytesIn: file.bytes.byteLength, bytesOut: bytes.length, pages: doc.getPageCount(), durationMs: performance.now() - started, summary: `Numbered ${doc.getPageCount()} pages` };
}

export async function compare(files: InputFile[]): Promise<OpResult> {
  if (files.length !== 2) return { ok: false, error: 'Choose exactly two PDFs to compare.' };
  const started = performance.now();
  const [first, second] = await Promise.all(files.map(load));
  const a = new Uint8Array(files[0].bytes);
  const b = new Uint8Array(files[1].bytes);
  const identical = a.length === b.length && a.every((value, index) => value === b[index]);
  return {
    ok: true, files: [], bytesIn: a.length + b.length, bytesOut: 0,
    pages: first.getPageCount() + second.getPageCount(), durationMs: performance.now() - started,
    summary: identical ? 'Files are exactly identical' : 'Files are different',
    notes: [`First PDF: ${first.getPageCount()} pages`, `Second PDF: ${second.getPageCount()} pages`, 'Comparison checks page count and byte-for-byte file identity.'],
  };
}
