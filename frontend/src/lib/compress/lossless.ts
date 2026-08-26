/**
 * Lossless PDF compression.
 *
 * Not one pixel is re-encoded. Everything here is structural: repack the file,
 * drop what nothing references, and let pdf-lib write object streams.
 *
 * The order matters. Stripping happens before the save, because the save is
 * what actually rewrites the file — and it must be a FULL rewrite, never an
 * incremental update, or the data we just removed survives in the previous
 * revision. That is the difference between deleting something and appearing to.
 */
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';

import type { Savings } from './types';

/**
 * Keys that carry weight but no rendered output.
 *
 * `/PieceInfo` is the one that surprises people: Illustrator and InDesign park
 * their private working data there, and on a file exported from either it can
 * be most of the document. Nothing displays it.
 */
const CATALOG_JUNK = ['PieceInfo', 'Metadata', 'SpiderInfo', 'LastModified'] as const;
const PAGE_JUNK = ['PieceInfo', 'Metadata', 'LastModified', 'Thumb', 'B', 'SeparationInfo'] as const;

/** Removed for privacy as much as for size — a PDF can carry files and scripts. */
const NAME_TREE_JUNK = ['JavaScript', 'EmbeddedFiles'] as const;

const sizeOfStream = (obj: unknown): number =>
  obj instanceof PDFRawStream ? obj.contents.length : 0;

/**
 * Total bytes held by a dictionary entry, following one indirect hop.
 * Used only to report where savings came from, never to decide anything.
 */
function weighEntry(doc: PDFDocument, dict: PDFDict, key: string): number {
  const raw = dict.get(PDFName.of(key));
  if (!raw) return 0;

  if (raw instanceof PDFRef) {
    const target = doc.context.lookup(raw);
    return sizeOfStream(target) || 24;
  }

  return sizeOfStream(raw) || 24;
}

/**
 * Removes the entry AND the object it points at.
 *
 * pdf-lib does not garbage-collect: deleting a dictionary entry unlinks the
 * reference but the object is still written to the output. An orphaned XMP
 * packet was surviving every "strip metadata" pass — present in the file,
 * invisible in the catalog, and fully recoverable by anyone who looked.
 *
 * Only used for keys that are never shared between objects.
 */
function stripKeys(
  doc: PDFDocument,
  dict: PDFDict,
  keys: readonly string[]
): number {
  let freed = 0;

  for (const key of keys) {
    const name = PDFName.of(key);
    if (!dict.has(name)) continue;

    freed += weighEntry(doc, dict, key);

    const target = dict.get(name);
    dict.delete(name);

    if (target instanceof PDFRef) {
      doc.context.delete(target);
    }
  }

  return freed;
}

export interface StripReport {
  savings: Savings;
  notes: string[];
}

/** Mutates `doc` in place. Returns what it removed, for the receipt. */
export function stripNonRendering(doc: PDFDocument): StripReport {
  const notes: string[] = [];
  const savings: Savings = { metadata: 0, pieceInfo: 0, attachments: 0, structural: 0 };

  const catalog = doc.catalog;

  // --- document metadata -------------------------------------------------
  const pieceBefore = weighEntry(doc, catalog, 'PieceInfo');
  savings.pieceInfo += pieceBefore;
  if (pieceBefore > 0) {
    notes.push('Removed application data left behind by the authoring tool');
  }

  savings.metadata += stripKeys(doc, catalog, CATALOG_JUNK);

  // pdf-lib writes an /Info dict; empty every field rather than leave stale ones.
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setProducer('');
  doc.setCreator('');

  // --- scripts and attachments ------------------------------------------
  const namesRef = catalog.get(PDFName.of('Names'));
  const names = namesRef ? doc.context.lookupMaybe(namesRef, PDFDict) : undefined;

  if (names) {
    const freed = stripKeys(doc, names, NAME_TREE_JUNK);
    savings.attachments += freed;
    if (freed > 0) notes.push('Removed embedded files and JavaScript actions');
  }

  if (catalog.has(PDFName.of('OpenAction'))) {
    catalog.delete(PDFName.of('OpenAction'));
    notes.push('Removed an action that ran when the document opened');
  }

  // --- per-page ----------------------------------------------------------
  let pagePieceInfo = 0;

  for (const page of doc.getPages()) {
    pagePieceInfo += weighEntry(doc, page.node, 'PieceInfo');
    savings.metadata += stripKeys(doc, page.node, PAGE_JUNK);
  }

  savings.pieceInfo += pagePieceInfo;

  if (savings.metadata > 0 && !notes.includes('Cleared document metadata')) {
    notes.push('Cleared document metadata (title, author, dates, XMP)');
  }

  return { savings, notes };
}

/**
 * Full rewrite with object streams.
 *
 * `useObjectStreams` packs the many small indirect objects a PDF is made of
 * into a handful of compressed streams. It is the single biggest structural
 * win and it changes nothing about what renders.
 */
export async function rewrite(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    // Higher means fewer yields and a faster save; we are already in a Worker.
    objectsPerTick: 2000,
  });
}
