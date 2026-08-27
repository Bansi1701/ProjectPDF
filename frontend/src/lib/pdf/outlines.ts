/**
 * Read, remap and rebuild PDF outlines (the sidebar bookmarks).
 *
 * `copyPages` copies page dictionaries only. An outline lives in the document
 * catalog and points back to pages by indirect reference, so copied outline
 * dictionaries would still point into the old document. Page-plan operations
 * resolve destinations to source page numbers and rebuild the tree against the
 * new page references instead.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from '@cantoo/pdf-lib';
import type { PDFObject } from '@cantoo/pdf-lib';

import type { PagePlan } from './types';

interface SourceOutline {
  title: string;
  page: number | null;
  children: SourceOutline[];
}

interface OutputOutline {
  title: string;
  page: number;
  children: OutputOutline[];
}

export interface OutlineCopyReport {
  preserved: number;
  dropped: number;
}

const N = {
  outlines: PDFName.of('Outlines'),
  first: PDFName.of('First'),
  last: PDFName.of('Last'),
  next: PDFName.of('Next'),
  prev: PDFName.of('Prev'),
  parent: PDFName.of('Parent'),
  title: PDFName.of('Title'),
  dest: PDFName.of('Dest'),
  a: PDFName.of('A'),
  s: PDFName.of('S'),
  d: PDFName.of('D'),
  names: PDFName.of('Names'),
  dests: PDFName.of('Dests'),
  kids: PDFName.of('Kids'),
  count: PDFName.of('Count'),
  type: PDFName.of('Type'),
};

function namedDestinations(doc: PDFDocument): Map<string, PDFObject> {
  const found = new Map<string, PDFObject>();

  const walk = (node: PDFDict, depth: number): void => {
    if (depth > 32) return;
    const pairs = node.lookupMaybe(N.names, PDFArray);
    if (pairs) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        const key = pairs.lookupMaybe(i, PDFString, PDFHexString);
        const value = pairs.lookup(i + 1);
        if (key && value) found.set(key.decodeText(), value);
      }
    }
    const kids = node.lookupMaybe(N.kids, PDFArray);
    if (!kids) return;
    for (let i = 0; i < kids.size(); i += 1) {
      const child = kids.lookupMaybe(i, PDFDict);
      if (child) walk(child, depth + 1);
    }
  };

  try {
    const names = doc.catalog.lookupMaybe(N.names, PDFDict);
    const tree = names?.lookupMaybe(N.dests, PDFDict);
    if (tree) walk(tree, 0);

    const flat = doc.catalog.lookupMaybe(N.dests, PDFDict);
    if (flat) {
      for (const key of flat.keys()) {
        const value = flat.lookup(key);
        if (value) found.set(key.decodeText(), value);
      }
    }
  } catch {
    // A malformed destination tree costs only bookmarks that rely on it.
  }

  return found;
}

function destination(item: PDFDict, named: Map<string, PDFObject>): PDFArray | undefined {
  let value: PDFObject | undefined;
  if (item.has(N.dest)) {
    value = item.lookup(N.dest);
  } else {
    const action = item.lookupMaybe(N.a, PDFDict);
    if (!action) return undefined;
    const kind = action.lookupMaybe(N.s, PDFName);
    if (kind && kind.asString() !== '/GoTo') return undefined;
    value = action.lookup(N.d);
  }

  for (let hop = 0; hop < 2 && value; hop += 1) {
    if (value instanceof PDFArray) return value;
    if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
      value = named.get(value.decodeText());
      continue;
    }
    if (value instanceof PDFDict) {
      value = value.lookup(N.d);
      continue;
    }
    return undefined;
  }
  return value instanceof PDFArray ? value : undefined;
}

function readSourceOutline(doc: PDFDocument): SourceOutline[] {
  const root = doc.catalog.lookupMaybe(N.outlines, PDFDict);
  if (!root) return [];

  const pageIndex = new Map<string, number>();
  doc.getPages().forEach((page, index) => pageIndex.set(page.ref.tag, index));
  const named = namedDestinations(doc);
  const visited = new Set<string>();

  const siblings = (first: PDFDict | undefined, depth: number): SourceOutline[] => {
    if (!first || depth > 64) return [];
    const result: SourceOutline[] = [];
    let item: PDFDict | undefined = first;

    for (let guard = 0; item && guard < 20_000; guard += 1) {
      const nextRef = item.get(N.next);
      const title = item.lookupMaybe(N.title, PDFString, PDFHexString)?.decodeText().trim() ?? '';
      const array = destination(item, named);
      const target = array && array.size() > 0 ? array.get(0) : undefined;
      let page: number | null = null;
      if (target instanceof PDFRef) page = pageIndex.get(target.tag) ?? null;
      else if (target instanceof PDFNumber) {
        const candidate = Math.trunc(target.asNumber());
        if (candidate >= 0 && candidate < doc.getPageCount()) page = candidate;
      }

      const children = siblings(item.lookupMaybe(N.first, PDFDict), depth + 1);
      if (title || page !== null || children.length > 0) {
        result.push({ title: title || 'Untitled bookmark', page, children });
      }

      if (nextRef instanceof PDFRef) {
        if (visited.has(nextRef.tag)) break;
        visited.add(nextRef.tag);
      }
      item = item.lookupMaybe(N.next, PDFDict);
    }
    return result;
  };

  return siblings(root.lookupMaybe(N.first, PDFDict), 0);
}

function count(nodes: OutputOutline[]): number {
  return nodes.reduce((sum, node) => sum + 1 + count(node.children), 0);
}

/**
 * Copies every bookmark whose destination remains in the page plan. A parent
 * whose own page was removed stays when one of its children survives and is
 * remapped to that first child, preserving the hierarchy instead of flattening
 * a chapter into unrelated headings.
 */
export function preserveDocumentOutlines(
  sources: PDFDocument[],
  target: PDFDocument,
  plan: PagePlan[]
): OutlineCopyReport {
  const destinations = new Map<string, number>();
  plan.forEach((entry, outputIndex) => {
    const key = `${entry.file}:${entry.page - 1}`;
    if (!destinations.has(key)) destinations.set(key, outputIndex);
  });

  let dropped = 0;
  const remap = (node: SourceOutline, file: number): OutputOutline | null => {
    const children = node.children
      .map((child) => remap(child, file))
      .filter((child): child is OutputOutline => Boolean(child));
    const mapped = node.page === null ? undefined : destinations.get(`${file}:${node.page}`);
    if (mapped === undefined && children.length === 0) {
      dropped += 1;
      return null;
    }
    return { title: node.title, page: mapped ?? children[0].page, children };
  };

  const roots: OutputOutline[] = [];
  sources.forEach((source, file) => {
    try {
      for (const node of readSourceOutline(source)) {
        const mapped = remap(node, file);
        if (mapped) roots.push(mapped);
      }
    } catch {
      // A broken optional outline must never make valid pages impossible to
      // organise. Other source documents and their readable trees continue.
      dropped += 1;
    }
  });
  if (roots.length === 0) return { preserved: 0, dropped };

  const context = target.context;
  const outlineRoot = context.obj({});
  const rootRef = context.register(outlineRoot);

  const writeSiblings = (nodes: OutputOutline[], parent: PDFRef): PDFRef[] => {
    const dicts = nodes.map(() => context.obj({}));
    const refs = dicts.map((dict) => context.register(dict));

    dicts.forEach((dict, index) => {
      const node = nodes[index];
      dict.set(N.title, PDFHexString.fromText(node.title));
      dict.set(N.parent, parent);
      if (index > 0) dict.set(N.prev, refs[index - 1]);
      if (index + 1 < refs.length) dict.set(N.next, refs[index + 1]);
      dict.set(N.dest, context.obj([target.getPage(node.page).ref, 'Fit']));

      if (node.children.length > 0) {
        const childRefs = writeSiblings(node.children, refs[index]);
        dict.set(N.first, childRefs[0]);
        dict.set(N.last, childRefs[childRefs.length - 1]);
        dict.set(N.count, PDFNumber.of(count(node.children)));
      }
    });
    return refs;
  };

  const refs = writeSiblings(roots, rootRef);
  outlineRoot.set(N.type, N.outlines);
  outlineRoot.set(N.first, refs[0]);
  outlineRoot.set(N.last, refs[refs.length - 1]);
  outlineRoot.set(N.count, PDFNumber.of(count(roots)));
  target.catalog.set(N.outlines, rootRef);

  return { preserved: count(roots), dropped };
}
