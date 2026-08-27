/**
 * Splitting by something other than a typed range.
 *
 * The typed-range split in `organise.ts` answers the question "which pages do
 * you want?". This file answers four questions people ask far more often and
 * cannot answer in page numbers:
 *
 *   - every N pages          — a stack of scanned two-page forms
 *   - into N equal parts     — hand chapters to N reviewers
 *   - at a target file size  — an attachment limit
 *   - at every bookmark      — the one that is worth the trouble
 *
 * None of these is a new way to copy pages. `pageplan.ts` already owns that,
 * and it takes a plan plus CUT INDEXES and emits one file per group. So this
 * module's whole job is arithmetic and document archaeology: work out where
 * the cuts go, hand them to `compose`, and name the results. Nothing here
 * touches a page.
 *
 * Two of the four are honest arithmetic. The other two are estimates wearing
 * different disguises, and both say so in `notes`:
 *
 *   - A size split cannot be exact. A PDF is not a stack of independent
 *     pages: fonts, images and colour spaces are shared objects, so ten pages
 *     that use one font are far smaller than ten pages that use ten. Cutting
 *     "at 5 MB" therefore means *building candidate documents and measuring
 *     them* — which is what this does — and even then the last page added can
 *     drag a whole font subset in behind it.
 *
 *   - A bookmark split depends on the outline actually pointing somewhere.
 *     pdf-lib has no outline API — verified, there is no `getOutline()` — so
 *     the catalog's `/Outlines` dictionary is walked by hand here: First/Next
 *     siblings, each item's `/Dest` or `/A` GoTo action resolved to a page
 *     reference, named destinations chased through `/Names /Dests`. Real
 *     files get this wrong in every way listed in the walker below.
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

import { compose } from './pageplan';
import type { InputFile, OpResult, OpSuccess, PagePlan } from './types';

/** Which question the user is answering. */
export type SplitByMode = 'every' | 'parts' | 'size' | 'bookmarks';

export interface SplitByOptions {
  mode: SplitByMode;
  /** `every` only: pages per output file. */
  every?: number;
  /** `parts` only: how many output files to divide into. */
  parts?: number;
  /** `size` only: the size to aim at, in bytes. Approximate by nature — see the notes. */
  targetBytes?: number;
}

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** Sizes are quoted back to the user, so they read the way the user typed them. */
const bytes = (n: number): string => {
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${(n >= 10 * 1024 * 1024 ? mb.toFixed(0) : mb.toFixed(1).replace(/\.0$/, ''))} MB`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
};

/** Smallest target worth accepting: below this even one page rarely fits. */
const MIN_TARGET_BYTES = 10 * 1024;

/**
 * How many candidate documents a size split may build before it starts
 * estimating instead.
 *
 * Each cut costs roughly 2·log₂(chunk) builds, so a normal document finishes
 * well inside this. A thousand-page file cut into hundreds of tiny pieces does
 * not, and measuring it exactly would take longer than the split — so the
 * remainder is cut at the observed rate and `notes` says exactly where the
 * measuring stopped.
 */
const MEASURE_BUDGET = 240;

// ─── file names ────────────────────────────────────────────────────────────

/**
 * Windows refuses these as filenames whatever the extension, and a download
 * that silently fails to save is worse than an ugly name.
 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A bookmark title turned into a filename.
 *
 * Titles are attacker-controlled in the sense that matters here — they come
 * out of the document, not out of the UI — so path separators and control
 * characters go before anything else. Everything else is kept, including
 * non-Latin script: a Chinese chapter title stripped to ASCII would be an
 * empty filename, which defeats the entire point of splitting this way.
 */
function sanitiseTitle(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');

  // Long enough to stay recognisable, short enough that the whole set of names
  // survives a path limit when a browser drops them into one folder.
  let trimmed = cleaned.slice(0, 60);
  if (cleaned.length > 60) {
    const lastBreak = trimmed.lastIndexOf('-');
    if (lastBreak > 24) trimmed = trimmed.slice(0, lastBreak);
  }
  trimmed = trimmed.replace(/^[.\-]+|[.\-]+$/g, '');

  if (!trimmed || RESERVED_NAME.test(trimmed)) return '';
  return trimmed;
}

// ─── the outline ───────────────────────────────────────────────────────────

interface Bookmark {
  title: string;
  /** Zero-based index into this document's pages. */
  page: number;
}

interface OutlineReading {
  bookmarks: Bookmark[];
  /** Top-level items whose destination could not be resolved to a page in this file. */
  unresolved: number;
  /** Items whose destination named a page by number rather than by reference. */
  byNumber: number;
  /** True when the document has no `/Outlines` at all — a different failure from "all broken". */
  absent: boolean;
}

const NAME = {
  outlines: PDFName.of('Outlines'),
  first: PDFName.of('First'),
  next: PDFName.of('Next'),
  title: PDFName.of('Title'),
  dest: PDFName.of('Dest'),
  a: PDFName.of('A'),
  s: PDFName.of('S'),
  d: PDFName.of('D'),
  names: PDFName.of('Names'),
  dests: PDFName.of('Dests'),
  kids: PDFName.of('Kids'),
};

/**
 * Every name → destination pair the document declares, from both places it
 * may declare them.
 *
 * `/Names /Dests` is the name tree modern writers use; `/Dests` in the catalog
 * is the flat PDF 1.1 dictionary that older ones (and plenty of current
 * report generators) still emit. Files exist that use both. Built once and
 * reused, because a fifty-chapter outline would otherwise walk the tree fifty
 * times.
 */
function collectNamedDestinations(doc: PDFDocument): Map<string, PDFObject> {
  const found = new Map<string, PDFObject>();

  const walk = (node: PDFDict, depth: number): void => {
    // A name tree is a balanced tree; 32 levels is far past any real one and
    // stops a self-referencing /Kids from hanging the worker.
    if (depth > 32) return;

    const pairs = node.lookupMaybe(NAME.names, PDFArray);
    if (pairs) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        const key = pairs.lookupMaybe(i, PDFString, PDFHexString);
        const value = pairs.lookup(i + 1);
        if (key && value) found.set(key.decodeText(), value);
      }
    }

    const kids = node.lookupMaybe(NAME.kids, PDFArray);
    if (!kids) return;
    for (let i = 0; i < kids.size(); i += 1) {
      const kid = kids.lookupMaybe(i, PDFDict);
      if (kid) walk(kid, depth + 1);
    }
  };

  try {
    const names = doc.catalog.lookupMaybe(NAME.names, PDFDict);
    const tree = names?.lookupMaybe(NAME.dests, PDFDict);
    if (tree) walk(tree, 0);

    const flat = doc.catalog.lookupMaybe(NAME.dests, PDFDict);
    if (flat) {
      for (const key of flat.keys()) {
        const value = flat.lookup(key);
        if (value) found.set(key.decodeText(), value);
      }
    }
  } catch {
    // A malformed name tree costs us the named destinations, not the split.
    // Bookmarks with direct /Dest arrays still resolve.
  }

  return found;
}

/**
 * The destination an outline item points at, as a destination array.
 *
 * Two spellings, both common: `/Dest` directly on the item, or an `/A` action
 * dictionary with `/S /GoTo` and the destination under `/D`. Actions that are
 * not GoTo — `/GoToR` into another file, `/URI`, `/Launch` — deliberately
 * return nothing: they do not name a page of *this* document, and treating
 * them as page 1 would put a cut in the wrong place.
 *
 * Either spelling may hold a name rather than an array, which is then chased
 * through the named destinations.
 */
function destinationArray(
  item: PDFDict,
  named: Map<string, PDFObject>
): PDFArray | undefined {
  let dest: PDFObject | undefined;

  if (item.has(NAME.dest)) {
    dest = item.lookup(NAME.dest);
  } else {
    const action = item.lookupMaybe(NAME.a, PDFDict);
    if (!action) return undefined;
    const kind = action.lookupMaybe(NAME.s, PDFName);
    if (kind && kind.asString() !== '/GoTo') return undefined;
    dest = action.lookup(NAME.d);
  }

  // Two hops at most: a name resolves to an array, or to a dictionary whose
  // /D is the array. A name resolving to another name is not legal and is not
  // chased, so a cycle cannot form here.
  for (let hop = 0; hop < 2 && dest; hop += 1) {
    if (dest instanceof PDFArray) return dest;
    if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) {
      dest = named.get(dest.decodeText());
      continue;
    }
    if (dest instanceof PDFDict) {
      dest = dest.lookup(NAME.d);
      continue;
    }
    return undefined;
  }

  return dest instanceof PDFArray ? dest : undefined;
}

/** Walks the top level of the outline. Nested children are deliberately ignored. */
function readOutline(doc: PDFDocument): OutlineReading {
  const reading: OutlineReading = {
    bookmarks: [],
    unresolved: 0,
    byNumber: 0,
    absent: false,
  };

  const outlines = doc.catalog.lookupMaybe(NAME.outlines, PDFDict);
  if (!outlines) {
    reading.absent = true;
    return reading;
  }

  // A destination names a page by object reference, and the only way back to a
  // page *index* is the document's own page order.
  const pageIndex = new Map<string, number>();
  doc.getPages().forEach((page, index) => pageIndex.set(page.ref.tag, index));

  const named = collectNamedDestinations(doc);

  let item = outlines.lookupMaybe(NAME.first, PDFDict);
  const visited = new Set<string>();

  // Real files contain /Next chains that loop back on themselves — usually
  // from an editor that rewrote half an outline. Both guards are load-bearing:
  // the ref set catches an indirect cycle, the counter catches a direct one
  // built from inline dictionaries that have no ref to remember.
  for (let guard = 0; item && guard < 10_000; guard += 1) {
    const title = item.lookupMaybe(NAME.title, PDFString, PDFHexString);
    const array = destinationArray(item, named);
    const target = array && array.size() > 0 ? array.get(0) : undefined;

    let page: number | undefined;
    if (target instanceof PDFRef) {
      page = pageIndex.get(target.tag);
    } else if (target instanceof PDFNumber) {
      // A page *number* in a destination is how remote go-to actions address
      // pages, and some writers emit it locally too. Zero-based, per spec.
      const asIndex = Math.trunc(target.asNumber());
      if (asIndex >= 0 && asIndex < pageIndex.size) {
        page = asIndex;
        reading.byNumber += 1;
      }
    }

    if (page === undefined) {
      reading.unresolved += 1;
    } else {
      reading.bookmarks.push({ title: title ? title.decodeText().trim() : '', page });
    }

    const nextRef = item.get(NAME.next);
    if (nextRef instanceof PDFRef) {
      if (visited.has(nextRef.tag)) break;
      visited.add(nextRef.tag);
    }
    item = item.lookupMaybe(NAME.next, PDFDict);
  }

  return reading;
}

// ─── size measurement ──────────────────────────────────────────────────────

/**
 * Builds a candidate document and reports how many bytes it would be.
 *
 * The build settings here mirror `compose` exactly — `PDFDocument.create`,
 * `copyPages`, `save({ useObjectStreams: true })`. That is not a coincidence
 * to be tidied away: if this measured a document assembled any other way, the
 * number would describe a file the user never receives.
 */
function measurer(source: PDFDocument): (start: number, count: number) => Promise<number> {
  const cache = new Map<string, number>();

  return async (start: number, count: number): Promise<number> => {
    const key = `${start}:${count}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const candidate = await PDFDocument.create();
    const indices = Array.from({ length: count }, (_, i) => start + i);
    const pages = await candidate.copyPages(source, indices);
    for (const page of pages) candidate.addPage(page);
    const saved = await candidate.save({ useObjectStreams: true, addDefaultPage: false });

    cache.set(key, saved.length);
    return saved.length;
  };
}

interface SizePlan {
  cuts: number[];
  /** Pages that exceeded the target on their own — a file cannot be smaller than one page. */
  oversized: number;
  /** Page index from which cuts were estimated rather than measured, if the budget ran out. */
  estimatedFrom: number | null;
}

/**
 * Greedy: take as many pages as fit, cut, repeat.
 *
 * Size grows monotonically with page count for any fixed starting page, which
 * is what makes a search possible at all. Galloping first and then bisecting
 * costs about 2·log₂ builds per cut instead of the page-at-a-time linear walk,
 * and on a document whose pages are all much smaller than the target that is
 * the difference between a second and a minute.
 */
async function planBySize(
  source: PDFDocument,
  pageCount: number,
  target: number
): Promise<SizePlan> {
  const measure = measurer(source);
  const cuts: number[] = [];
  let oversized = 0;
  let budget = MEASURE_BUDGET;
  let estimatedFrom: number | null = null;

  // Updated from every chunk actually measured, and read only if the budget
  // runs out. Zero until the first chunk is measured, which is why the
  // fallback below checks it rather than dividing by it blind.
  let bytesPerPage = 0;

  let start = 0;
  while (start < pageCount) {
    const remaining = pageCount - start;

    if (budget <= 0) {
      if (estimatedFrom === null) estimatedFrom = start;
      const step = bytesPerPage > 0 ? Math.max(1, Math.floor(target / bytesPerPage)) : remaining;
      const take = Math.min(step, remaining);
      start += take;
      if (start < pageCount) cuts.push(start);
      continue;
    }

    // Gallop: 1, 2, 4, … pages until one overshoots or the document runs out.
    let fits = 1;
    let fitsSize = await measure(start, 1);
    budget -= 1;
    if (fitsSize > target) oversized += 1;

    // One past the largest count known to fit. Only ever narrowed downward,
    // and `probe` can never exceed `remaining`, so it stays in range.
    let ceiling = remaining + 1;

    while (fits * 2 <= remaining && budget > 0) {
      const probe = fits * 2;
      const size = await measure(start, probe);
      budget -= 1;
      if (size > target) {
        ceiling = probe;
        break;
      }
      fits = probe;
      fitsSize = size;
    }

    if (fits === remaining) {
      bytesPerPage = fitsSize / fits;
      start = pageCount;
      break;
    }

    // Bisect the gap the gallop left open: fits is known to fit, ceiling is
    // known not to (or is one past the end).
    while (fits + 1 < ceiling && budget > 0) {
      const middle = Math.floor((fits + ceiling) / 2);
      const size = await measure(start, middle);
      budget -= 1;
      if (size > target) ceiling = middle;
      else {
        fits = middle;
        fitsSize = size;
      }
    }

    bytesPerPage = fitsSize / fits;
    start += fits;
    if (start < pageCount) cuts.push(start);
  }

  return { cuts, oversized, estimatedFrom };
}

// ─── the tool ──────────────────────────────────────────────────────────────

/**
 * Splits one PDF by page count, part count, target size or bookmark.
 *
 * Returns whatever `compose` returns, with the file names, the summary and the
 * notes replaced by ones that describe *this* split rather than a generic one.
 */
export async function splitBy(files: InputFile[], options: SplitByOptions): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to split.' };

  let source: PDFDocument;
  try {
    source = await PDFDocument.load(file.bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    return {
      ok: false,
      error: `${file.name} could not be read. If it is password-protected, remove the password first with Unlock.`,
    };
  }

  const pageCount = source.getPageCount();
  if (pageCount < 2) {
    return {
      ok: false,
      error: 'This PDF has only one page, so there is nowhere to split it.',
    };
  }

  const stem = baseName(file.name);
  let cuts: number[] = [];
  let names: string[] | null = null;
  let summary = '';
  const notes: string[] = [];

  if (options.mode === 'every') {
    const size = Math.trunc(options.every ?? 0);
    if (!Number.isFinite(size) || size < 1) {
      return { ok: false, error: 'Enter how many pages each file should have — 1 or more.' };
    }
    if (size >= pageCount) {
      return {
        ok: false,
        error: `This PDF has ${plural(pageCount, 'page')}, so splitting every ${size} would hand back the same file. Choose ${pageCount - 1} or fewer.`,
      };
    }
    for (let cut = size; cut < pageCount; cut += size) cuts.push(cut);
    const last = pageCount % size;
    summary = `Split every ${plural(size, 'page')} into ${cuts.length + 1} files`;
    if (last !== 0) {
      notes.push(
        `${pageCount} does not divide by ${size}, so the last file has ${plural(last, 'page')} rather than ${size}.`
      );
    }
  } else if (options.mode === 'parts') {
    const parts = Math.trunc(options.parts ?? 0);
    if (!Number.isFinite(parts) || parts < 2) {
      return { ok: false, error: 'Enter how many files to split into — 2 or more.' };
    }
    if (parts > pageCount) {
      return {
        ok: false,
        error: `This PDF has ${plural(pageCount, 'page')}, so it cannot become ${parts} files. Every file needs at least one page.`,
      };
    }
    // Spread the remainder one page at a time across the leading parts rather
    // than dumping it all on the last one: "10,10,10,10,9" beats "12,12,12,13".
    const base = Math.floor(pageCount / parts);
    const extra = pageCount % parts;
    let at = 0;
    for (let part = 0; part < parts - 1; part += 1) {
      at += base + (part < extra ? 1 : 0);
      cuts.push(at);
    }
    summary =
      extra === 0
        ? `Split into ${parts} files of ${plural(base, 'page')}`
        : `Split into ${parts} files of ${base}–${base + 1} pages`;
    if (extra !== 0) {
      notes.push(
        `${pageCount} pages do not divide evenly into ${parts}, so ${extra === 1 ? 'the first file carries' : `the first ${extra} files carry`} one page more than the rest.`
      );
    }
  } else if (options.mode === 'size') {
    const target = Math.trunc(options.targetBytes ?? 0);
    if (!Number.isFinite(target) || target < MIN_TARGET_BYTES) {
      return {
        ok: false,
        error: `Choose a target size of at least ${bytes(MIN_TARGET_BYTES)}. Below that, a single page rarely fits.`,
      };
    }

    const planned = await planBySize(source, pageCount, target);
    cuts = planned.cuts;

    if (cuts.length === 0) {
      return {
        ok: false,
        error: `The whole document already fits under ${bytes(target)}, so there is nothing to split. Compress or split by page count instead.`,
      };
    }

    summary = `Split into ${cuts.length + 1} files aiming at ${bytes(target)} each`;
    notes.push(
      'Sizes are approximate. A PDF is not a stack of independent pages — fonts, images and colour spaces are shared between them — so page count and bytes are not proportional.'
    );
    if (planned.estimatedFrom === null) {
      notes.push(
        'Every cut was placed by building the candidate file and measuring it, not by estimating from an average page.'
      );
    }
    if (planned.oversized > 0) {
      notes.push(
        planned.oversized === 1
          ? `One page is larger than ${bytes(target)} on its own, so it became a file over the target. A file cannot be smaller than one page.`
          : `${planned.oversized} pages are each larger than ${bytes(target)} on their own, so they became files over the target. A file cannot be smaller than one page.`
      );
    }
    if (planned.estimatedFrom !== null) {
      notes.push(
        `Cuts up to page ${planned.estimatedFrom} were measured. From there on they were estimated from the average measured so far, because measuring every remaining candidate would have taken longer than the split — those later files may miss the target by more.`
      );
    }
  } else {
    const reading = readOutline(source);

    if (reading.absent) {
      return {
        ok: false,
        error:
          'This PDF has no bookmarks, so there is nothing to split at. Try splitting every N pages or into equal parts instead.',
      };
    }
    if (reading.bookmarks.length === 0) {
      return {
        ok: false,
        error: `This PDF has an outline, but none of its ${plural(reading.unresolved, 'top-level bookmark')} points at a page in this file — they may link to other documents or to the web. Try splitting every N pages instead.`,
      };
    }

    // Outline order usually follows page order, but nothing enforces it, and a
    // cut list has to be sorted to mean anything. Sorting by page and keeping
    // the first title at each page is what a reader would do looking at the
    // bookmark panel.
    const ordered = [...reading.bookmarks].sort((a, b) => a.page - b.page);
    const sections: Bookmark[] = [];
    let shared = 0;
    for (const mark of ordered) {
      if (sections.length > 0 && sections[sections.length - 1].page === mark.page) {
        shared += 1;
        continue;
      }
      sections.push(mark);
    }

    cuts = sections.map((mark) => mark.page).filter((page) => page > 0);
    if (cuts.length === 0) {
      return {
        ok: false,
        error: `Every bookmark in this PDF points at page 1, so there is no place to cut. Try splitting every N pages instead.`,
      };
    }

    // A document whose first bookmark is not on page 1 has a cover, a contents
    // page, something. Those pages are still a file, and it needs a name.
    const leading = sections[0].page > 0;
    const titles = sections.map((mark) => mark.title);
    const labels = leading ? ['Front matter', ...titles] : titles;

    // The number is not decoration. Two chapters called "Appendix" are common,
    // and without it the second would overwrite the first in the download
    // folder; with it, the set also sorts into reading order.
    const width = String(labels.length).length;
    names = labels.map((title, index) => {
      const safe = sanitiseTitle(title);
      const number = String(index + 1).padStart(width, '0');
      return `${stem}-${number}-${safe || 'untitled-section'}`;
    });

    summary = `Split at ${plural(cuts.length, 'bookmark')} into ${cuts.length + 1} files`;
    notes.push(
      'Files are named after the bookmarks they start at, numbered so they sort in document order. Titles were sanitised for the filesystem; punctuation a filename cannot hold became a dash.'
    );
    if (leading) {
      notes.push(
        `The first bookmark is on page ${sections[0].page + 1}, so the ${plural(sections[0].page, 'page')} before it went into a first file named "front matter" rather than being dropped.`
      );
    }
    if (shared > 0) {
      notes.push(
        `${plural(shared, 'bookmark')} started on a page another bookmark had already claimed, so ${shared === 1 ? 'it did not' : 'they did not'} add a cut. Only the first title on each page names a file.`
      );
    }
    if (reading.unresolved > 0) {
      notes.push(
        `${plural(reading.unresolved, 'top-level bookmark')} could not be resolved to a page in this file and ${reading.unresolved === 1 ? 'was' : 'were'} skipped — a destination that names another document or a web address is not a place in this PDF.`
      );
    }
    if (reading.byNumber > 0) {
      notes.push(
        `${plural(reading.byNumber, 'bookmark')} named its page by number rather than by reference. That is how links into other documents are written, so if a cut looks misplaced, this is the one to check.`
      );
    }
    notes.push(
      'Only top-level bookmarks were used. Sub-bookmarks were ignored, or every nested heading would become its own file.'
    );
  }

  const plan: PagePlan[] = Array.from({ length: pageCount }, (_, index) => ({
    file: 0,
    page: index + 1,
    rotate: 0,
  }));

  // Only this file's pages are in the plan, so only this file is handed over —
  // otherwise `compose` would parse the rest for nothing and count their bytes
  // in `bytesIn`.
  const result = await compose([file], plan, cuts, stem);
  if (!result.ok || !('files' in result)) return result;

  const produced: OpSuccess = result;

  if (names) {
    produced.files.forEach((output, index) => {
      const chosen = names[index];
      if (chosen) output.name = `${chosen}.pdf`;
    });
  }

  // Reported from the files that actually came out, not from the measurements
  // that chose the cuts. When a size split misses, this is where the user sees
  // it — an estimate quoted back as a result would be the dishonest version.
  if (options.mode === 'size') {
    const target = Math.trunc(options.targetBytes ?? 0);
    const sizes = produced.files.map((output) => output.bytes.length);
    const over = sizes.filter((size) => size > target).length;
    notes.unshift(
      over === 0
        ? `Every file came out under the ${bytes(target)} target — largest ${bytes(Math.max(...sizes))}, smallest ${bytes(Math.min(...sizes))}.`
        : `${plural(over, 'file')} came out over the ${bytes(target)} target — largest ${bytes(Math.max(...sizes))}, smallest ${bytes(Math.min(...sizes))}.`
    );
  }

  // Splitting almost always grows the total, sometimes several times over, and
  // a user watching one number go up while nothing was added deserves the
  // reason rather than a support ticket.
  if (produced.bytesOut > produced.bytesIn * 1.05) {
    notes.push(
      `The pieces add up to ${bytes(produced.bytesOut)}, more than the ${bytes(produced.bytesIn)} original. Nothing was added: a font or an image that several pages shared now has to sit in every file that uses it.`
    );
  }

  return {
    ...produced,
    summary: `${summary} · ${plural(pageCount, 'page')}`,
    notes: [
      ...notes,
      'Each piece is a new document. Bookmarks whose destination is inside that piece are retained and remapped; bookmarks and internal links that point to pages in another piece cannot follow it. Attachments stay behind.',
      ...(produced.notes ?? []),
    ],
  };
}
