/**
 * Place a signature on a page.
 *
 * This is a VISUAL signature: a picture of a mark, drawn onto the page. It is
 * what people mean by "sign this" and it carries the same weight as signing a
 * printed page — which is to say, real weight in most contexts and no
 * cryptographic weight at all.
 *
 * It is not a digital signature. A digital signature binds the document's
 * bytes to a certificate so any later change is detectable, and that needs a
 * timestamp authority and a revocation check — network calls by definition,
 * and therefore not something this tool can honestly claim. Saying which one
 * this is matters more than the feature.
 */
import { PDFDocument, PDFImage } from '@cantoo/pdf-lib';

import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** Margin from the page edge, in points. */
const MARGIN = 36;

export async function signPdf(
  files: InputFile[],
  signaturePng: ArrayBuffer | undefined,
  targetPage: number,
  corner: Corner,
  widthPoints: number
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to sign.' };
  if (!signaturePng || signaturePng.byteLength === 0) {
    return { ok: false, error: 'Draw or type a signature first.' };
  }

  const started = performance.now();

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.toLowerCase().includes('encrypt')
        ? 'This PDF is password-protected. Unlock it first.'
        : `This file could not be read as a PDF: ${message}`,
    };
  }

  const pageCount = doc.getPageCount();
  const index = targetPage === -1 ? pageCount - 1 : targetPage - 1;

  if (index < 0 || index >= pageCount) {
    return { ok: false, error: `Choose a page from 1 to ${pageCount}.` };
  }

  let image: PDFImage;
  try {
    image = await doc.embedPng(signaturePng);
  } catch (error) {
    return { ok: false, error: `That signature image could not be used: ${(error as Error).message}` };
  }

  const page = doc.getPage(index);
  const { width: pageWidth, height: pageHeight } = page.getSize();

  // Keep the signature proportional and never wider than the page allows.
  const width = Math.min(widthPoints, pageWidth - MARGIN * 2);
  const height = (image.height / image.width) * width;

  const x = corner.endsWith('left') ? MARGIN : pageWidth - MARGIN - width;
  const y = corner.startsWith('bottom') ? MARGIN : pageHeight - MARGIN - height;

  page.drawImage(image, { x, y, width, height });

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-signed.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages: pageCount,
    durationMs: performance.now() - started,
    summary: `Signed page ${index + 1}`,
    notes: [
      'This is a visual signature — a picture of your mark drawn onto the page, the same as signing a printout.',
      'It is not a digital signature: nothing here proves the document was unchanged afterwards. That needs a certificate and a timestamp authority, which are network services.',
    ],
  };
}
