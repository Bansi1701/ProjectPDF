/**
 * What is this PDF actually made of?
 *
 * Lossless compression repacks structure. If a file is 95% one scanned JPEG,
 * there is no structure to repack and the honest answer is "we cannot help with
 * this, and here is why" — not a silent 0.4%.
 *
 * Every competitor answers that case by quietly re-encoding the image and
 * calling it compression. Saying it out loud is the differentiator.
 */
import { PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';

export interface Composition {
  totalBytes: number;
  imageBytes: number;
  /** 0–1 */
  imageShare: number;
  imageCount: number;
  /** True when the file is essentially a scan: few images, most of the bytes. */
  isScan: boolean;
}

export function analyse(doc: PDFDocument, totalBytes: number): Composition {
  let imageBytes = 0;
  let imageCount = 0;

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;

    const subtype = obj.dict.get(PDFName.of('Subtype'));
    if (subtype !== PDFName.of('Image')) continue;

    imageCount += 1;
    imageBytes += obj.contents.length;
  }

  const imageShare = totalBytes > 0 ? imageBytes / totalBytes : 0;

  return {
    totalBytes,
    imageBytes,
    imageShare,
    imageCount,
    // A handful of images carrying most of the file is a scan or a photo deck.
    isScan: imageShare > 0.6 && imageCount <= 40,
  };
}

/**
 * The sentence shown when lossless barely moved the needle. It must explain
 * the cause, not apologise.
 */
export function explainSmallSaving(composition: Composition): string | null {
  const percent = Math.round(composition.imageShare * 100);

  if (composition.imageShare > 0.6) {
    const what = composition.imageCount === 1 ? 'a single scanned image' : 'scanned images';
    return `${percent}% of this file is ${what}. Lossless compression repacks structure, and there is almost none here — the pictures are the file. Making this meaningfully smaller means re-encoding them, which changes the pixels.`;
  }

  if (composition.imageShare > 0.25) {
    return `${percent}% of this file is images, which lossless compression cannot touch. The rest was already packed tightly.`;
  }

  return null;
}
