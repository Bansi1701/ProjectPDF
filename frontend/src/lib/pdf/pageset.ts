/**
 * Parsing "which pages", once.
 *
 * Every tool that takes a page selection had been re-inventing this inline, so
 * they disagreed: some accepted `all`, none accepted `odd`, and a reversed
 * range like `9-4` behaved differently depending on which tool you were in.
 *
 * Accepts, case-insensitively, comma-separated:
 *   all            every page
 *   odd / even     by page number, not by index
 *   last           the final page
 *   4              one page
 *   2-7            a closed range, in either order
 *   5-             from there to the end
 *   -3             from the start to there
 */

export interface PageSet {
  /** 1-based page numbers, ascending, no duplicates. */
  pages: number[];
  /** Set when the text asked for something out of range, for an honest warning. */
  outOfRange: number[];
  /** True when the text was empty or `all`, so callers can say "every page". */
  everything: boolean;
}

const clamp = (value: number, count: number) => Math.min(Math.max(value, 1), count);

export function parsePageSet(spec: string | undefined, count: number): PageSet {
  const text = (spec ?? '').trim();
  const all = Array.from({ length: count }, (_, i) => i + 1);

  if (!text || /^all$/i.test(text)) return { pages: all, outOfRange: [], everything: true };

  const wanted = new Set<number>();
  const outOfRange: number[] = [];

  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;

    if (/^odd$/i.test(part)) {
      for (const n of all) if (n % 2 === 1) wanted.add(n);
      continue;
    }
    if (/^even$/i.test(part)) {
      for (const n of all) if (n % 2 === 0) wanted.add(n);
      continue;
    }
    if (/^last$/i.test(part)) {
      if (count > 0) wanted.add(count);
      continue;
    }

    // `5-` and `-3` are open at one end; `2-7` is closed; a bare number is one page.
    const match = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!match || (!match[1] && !match[3])) continue;

    const open = Boolean(match[2]);
    const first = match[1] ? Number(match[1]) : 1;
    const second = match[3] ? Number(match[3]) : open ? count : first;

    if (!open && match[1] && !match[3]) {
      if (first < 1 || first > count) outOfRange.push(first);
      else wanted.add(first);
      continue;
    }

    const from = Math.min(first, second);
    const to = Math.max(first, second);
    if (from > count) outOfRange.push(from);
    for (let n = clamp(from, count); n <= clamp(to, count); n += 1) wanted.add(n);
  }

  const pages = [...wanted].sort((a, b) => a - b);
  return { pages, outOfRange, everything: pages.length === count && count > 0 };
}
