/**
 * Just enough XML for OOXML parts.
 *
 * The Office converters started out matching elements with flat regexes, which
 * works right up until an element can contain another of the same name. It
 * can: a PowerPoint `<p:grpSp>` holds `<p:sp>` children, and a non-greedy
 * `<p:sp>[\s\S]*?</p:sp>` walks straight off the end of the first one it finds.
 * Grouped shapes came out at the wrong coordinates because of exactly that.
 *
 * A full DOM parser is not available in a worker without pulling in a
 * dependency, and `DOMParser` is not defined there either. This is the small
 * piece actually needed: a scanner that respects nesting, so callers can walk
 * a tree instead of pattern-matching a string.
 */

export interface Element {
  name: string;
  attrs: string;
  /** Everything between the open and close tags. Empty for a self-closing tag. */
  inner: string;
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/**
 * Every direct child element of `body`, in document order.
 *
 * Depth is tracked so that a nested element of the same name is skipped over
 * rather than treated as a sibling.
 */
export function children(body: string): Element[] {
  const out: Element[] = [];
  const tag = new RegExp(TAG.source, 'g');

  let depth = 0;
  let start = -1;
  let name = '';
  let attrs = '';
  let match: RegExpExecArray | null;

  while ((match = tag.exec(body)) !== null) {
    const [full, closing, tagName, rawAttrs] = match;
    const selfClosing = /\/\s*$/.test(rawAttrs);

    if (closing) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push({ name, attrs, inner: body.slice(start, match.index) });
        start = -1;
      }
      continue;
    }

    if (selfClosing) {
      if (depth === 0) out.push({ name: tagName, attrs: rawAttrs, inner: '' });
      continue;
    }

    if (depth === 0) {
      name = tagName;
      attrs = rawAttrs;
      start = match.index + full.length;
    }
    depth += 1;
  }

  return out;
}

/** The first descendant with this tag name, at any depth. */
export function find(body: string, name: string): Element | null {
  for (const child of children(body)) {
    if (child.name === name) return child;
    const nested = find(child.inner, name);
    if (nested) return nested;
  }
  return null;
}

/** Every descendant with this tag name, at any depth, in document order. */
export function findAll(body: string, name: string): Element[] {
  const out: Element[] = [];
  for (const child of children(body)) {
    if (child.name === name) out.push(child);
    else out.push(...findAll(child.inner, name));
  }
  return out;
}

export const attr = (attrs: string, name: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match ? match[1] : null;
};

export const numAttr = (attrs: string, name: string, fallback: number): number => {
  const raw = attr(attrs, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const unescapeXml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');

export const decode = (bytes: Uint8Array | undefined): string =>
  bytes ? new TextDecoder().decode(bytes) : '';

/** A package part's relationships: id → target path, resolved against `base`. */
export function relationships(xml: string, base: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const rel of findAll(xml, 'Relationship')) {
    const id = attr(rel.attrs, 'Id');
    const target = attr(rel.attrs, 'Target');
    if (!id || !target) continue;
    if (/^[a-z]+:/i.test(target)) continue; // external link, not a part

    out.set(id, resolvePath(base, target));
  }

  return out;
}

/** Resolves a relationship target the way the package spec does. */
export function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);

  const stack = base.split('/').filter(Boolean);
  for (const part of target.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** The directory a part lives in, for resolving its own relationships. */
export const dirOf = (path: string): string => path.replace(/\/[^/]*$/, '');

/** The `_rels` path for a part. */
export const relsPathOf = (path: string): string =>
  `${dirOf(path)}/_rels/${path.slice(dirOf(path).length + 1)}.rels`;
