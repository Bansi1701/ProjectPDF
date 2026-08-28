/**
 * Comparing two drafts.
 *
 * The previous implementation compared the two files byte for byte and said
 * "identical" or "different", which is a thing you already knew — and the
 * homepage has always promised "what changed, in words not pixels". This is a
 * word-level diff of the text layer.
 *
 * Pages are aligned before they are diffed. Index alignment is wrong the moment
 * somebody inserts a page: every page after it reads as rewritten, which buries
 * the one real change in noise. So pages are matched on content similarity
 * first, and only then compared.
 */
import { loadPdfjs, documentOptions } from './pdfjs';
import type { InputFile, OpResult } from './types';

export type ChangeKind = 'same' | 'added' | 'removed';

export interface Change {
  kind: ChangeKind;
  text: string;
}

export interface PageComparison {
  /** 1-based page in the first document, or null when the page is new. */
  before: number | null;
  /** 1-based page in the second document, or null when the page was removed. */
  after: number | null;
  added: number;
  removed: number;
  changes: Change[];
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

/** Words, with punctuation kept attached — a diff on "don't" is not two edits. */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

async function pageTexts(bytes: ArrayBuffer): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), ...documentOptions() });
  const doc = await loadingTask.promise;
  const out: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const parts = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      out.push(parts.replace(/\s+/g, ' ').trim());
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}

/**
 * Longest common subsequence, returned as an edit script.
 *
 * O(n*m) in memory, which is fine for a page of words and not for a whole
 * document — hence diffing per page rather than over the concatenated text.
 */
function diff(before: string[], after: string[]): Change[] {
  const n = before.length;
  const m = after.length;

  // A page against an empty page needs no table.
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ kind: 'added', text: after.join(' ') }];
  if (m === 0) return [{ kind: 'removed', text: before.join(' ') }];

  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const changes: Change[] = [];
  const push = (kind: ChangeKind, word: string) => {
    const last = changes[changes.length - 1];
    if (last && last.kind === kind) last.text += ` ${word}`;
    else changes.push({ kind, text: word });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      push('same', before[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('removed', before[i]);
      i += 1;
    } else {
      push('added', after[j]);
      j += 1;
    }
  }
  while (i < n) push('removed', before[i++]);
  while (j < m) push('added', after[j++]);

  return changes;
}

/** How alike two pages are, 0–1, on shared word frequency. */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      counts.set(word, left - 1);
      shared += 1;
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Matches pages between the two documents.
 *
 * An LCS over page similarity rather than a greedy nearest match: greedy pairs
 * a repeated boilerplate page with the first one it sees and then drags every
 * later pairing out of step.
 */
function alignPages(before: string[][], after: string[][]): [number | null, number | null][] {
  const n = before.length;
  const m = after.length;
  const SAME = 0.6;

  const table: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const score = similarity(before[i], after[j]);
      table[i][j] = Math.max(
        score >= SAME ? table[i + 1][j + 1] + score : 0,
        table[i + 1][j],
        table[i][j + 1]
      );
    }
  }

  const pairs: [number | null, number | null][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const score = similarity(before[i], after[j]);
    if (score >= SAME && table[i][j] === table[i + 1][j + 1] + score) {
      pairs.push([i + 1, j + 1]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      pairs.push([i + 1, null]);
      i += 1;
    } else {
      pairs.push([null, j + 1]);
      j += 1;
    }
  }
  while (i < n) pairs.push([i++ + 1, null]);
  while (j < m) pairs.push([null, j++ + 1]);
  return pairs;
}

function report(
  firstName: string,
  secondName: string,
  pages: PageComparison[],
  totals: { added: number; removed: number }
): string {
  const lines = [
    '# What changed',
    '',
    `Comparing **${firstName}** with **${secondName}**.`,
    '',
    `- ${totals.added} words added`,
    `- ${totals.removed} words removed`,
    `- ${pages.filter((page) => page.added || page.removed).length} of ${pages.length} pages differ`,
    '',
    'Generated in the browser. Neither document was uploaded.',
    '',
  ];

  for (const page of pages) {
    if (!page.added && !page.removed) continue;

    const heading = page.before === null
      ? `## Page ${page.after} — added`
      : page.after === null
        ? `## Page ${page.before} — removed`
        : `## Page ${page.before}${page.before === page.after ? '' : ` → ${page.after}`}`;
    lines.push(heading, '');

    for (const change of page.changes) {
      if (change.kind === 'added') lines.push(`**+** ${change.text}`, '');
      if (change.kind === 'removed') lines.push(`**−** ~~${change.text}~~`, '');
    }
  }

  return lines.join('\n');
}

export async function compare(files: InputFile[]): Promise<OpResult> {
  if (files.length !== 2) return { ok: false, error: 'Choose exactly two PDFs to compare.' };

  const started = performance.now();
  const [firstText, secondText] = await Promise.all([
    pageTexts(files[0].bytes),
    pageTexts(files[1].bytes),
  ]);

  const before = firstText.map(words);
  const after = secondText.map(words);
  const emptyBoth = before.every((page) => page.length === 0) && after.every((page) => page.length === 0);

  if (emptyBoth) {
    return {
      ok: false,
      error:
        'Neither document has a text layer, so there are no words to compare. These are probably scans — run them through OCR first.',
    };
  }

  const pages: PageComparison[] = alignPages(before, after).map(([left, right]) => {
    const changes = diff(left ? before[left - 1] : [], right ? after[right - 1] : []);
    return {
      before: left,
      after: right,
      added: changes.filter((c) => c.kind === 'added').reduce((n, c) => n + words(c.text).length, 0),
      removed: changes.filter((c) => c.kind === 'removed').reduce((n, c) => n + words(c.text).length, 0),
      changes,
    };
  });

  const totals = pages.reduce(
    (sum, page) => ({ added: sum.added + page.added, removed: sum.removed + page.removed }),
    { added: 0, removed: 0 }
  );
  const changed = pages.filter((page) => page.added || page.removed).length;

  const notes: string[] = [];
  if (changed === 0) {
    notes.push('Every word matches. The files may still differ in layout, fonts or metadata — this compares the text.');
  } else {
    notes.push(`${totals.added} word${totals.added === 1 ? '' : 's'} added, ${totals.removed} removed, across ${changed} of ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
  }

  const inserted = pages.filter((page) => page.before === null).length;
  const deleted = pages.filter((page) => page.after === null).length;
  if (inserted) notes.push(`${inserted} page${inserted === 1 ? ' was' : 's were'} added in the second document.`);
  if (deleted) notes.push(`${deleted} page${deleted === 1 ? ' is' : 's are'} in the first document but not the second.`);
  if (inserted || deleted) {
    notes.push('Pages were matched on their content, not their number, so an inserted page does not make every page after it look rewritten.');
  }

  notes.push('This reads the text layer. A change to an image, a colour or a font is not a word, so it is not reported here.');

  const markdown = report(files[0].name, files[1].name, pages, totals);

  return {
    ok: true,
    files: [
      {
        name: `${baseName(files[0].name)}-changes.md`,
        bytes: new TextEncoder().encode(markdown),
        type: 'text/markdown',
      },
    ],
    bytesIn: files[0].bytes.byteLength + files[1].bytes.byteLength,
    bytesOut: markdown.length,
    pages: pages.length,
    durationMs: performance.now() - started,
    summary: changed === 0
      ? 'No wording changed'
      : `${totals.added} added, ${totals.removed} removed`,
    notes,
    comparison: pages,
  };
}
