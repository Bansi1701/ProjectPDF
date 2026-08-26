/**
 * Content stream scanning and glyph renumbering.
 *
 * This is the part that must be exactly right. A naive regex over the whole
 * stream picks up hex that is not a glyph id at all — an earlier version of
 * this scanner reported a maximum glyph id of 65279, which is 0xFEFF, a
 * byte-order mark sitting in an unrelated string. Acting on that would have
 * kept the wrong glyphs and dropped real ones.
 *
 * So: a real tokenizer, and glyph ids are only read from the operands of the
 * text-showing operators (Tj TJ ' ") while a target font is selected inside a
 * BT…ET block.
 */

export interface Token {
  kind: 'hex' | 'literal' | 'name' | 'operator' | 'other';
  /** For strings: the bytes between the delimiters. Otherwise the raw text. */
  value: string;
  start: number;
  end: number;
}

const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\f', '\0']);
const DELIMITER = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/** Latin-1 in, latin-1 out — content streams are bytes, not text. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (WHITESPACE.has(ch)) {
      i += 1;
      continue;
    }

    // comment
    if (ch === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
      continue;
    }

    // hex string  <...>  (but not a dictionary  <<)
    if (ch === '<' && text[i + 1] !== '<') {
      const close = text.indexOf('>', i + 1);
      if (close < 0) break;
      tokens.push({ kind: 'hex', value: text.slice(i + 1, close), start: i, end: close + 1 });
      i = close + 1;
      continue;
    }

    // literal string  (...)  with balanced parens and backslash escapes
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        j += 1;
      }
      tokens.push({ kind: 'literal', value: text.slice(i + 1, j - 1), start: i, end: j });
      i = j;
      continue;
    }

    // name
    if (ch === '/') {
      let j = i + 1;
      while (j < text.length && !WHITESPACE.has(text[j]) && !DELIMITER.has(text[j])) j += 1;
      tokens.push({ kind: 'name', value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    if (DELIMITER.has(ch)) {
      tokens.push({ kind: 'other', value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    let j = i;
    while (j < text.length && !WHITESPACE.has(text[j]) && !DELIMITER.has(text[j])) j += 1;
    const value = text.slice(i, j);
    tokens.push({
      kind: /^[+-.\d]/.test(value) ? 'other' : 'operator',
      value,
      start: i,
      end: j,
    });
    i = j;
  }

  return tokens;
}

const SHOW_TEXT = new Set(['Tj', 'TJ', "'", '"']);

/** Two-byte big-endian codes. For Identity-H these are the glyph ids. */
function codesFromHex(hex: string): number[] {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  const codes: number[] = [];
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    codes.push(parseInt(clean.slice(i, i + 4), 16));
  }
  return codes;
}

function codesFromLiteral(value: string): number[] {
  // Unescape, then read big-endian pairs.
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\') {
      bytes.push(value.charCodeAt(i) & 0xff);
      continue;
    }
    const next = value[i + 1];
    const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1, i + 4))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    bytes.push(escapes[next] ?? (next ?? '').charCodeAt(0) & 0xff);
    i += 1;
  }

  const codes: number[] = [];
  for (let i = 0; i + 2 <= bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
  return codes;
}

/**
 * Walks a content stream and reports which glyph ids each font actually draws.
 *
 * `fontByName` maps a resource name (`/F1`) to a stable key the caller chose —
 * normally the font's indirect reference.
 */
export function scanGlyphs(
  text: string,
  fontByName: Map<string, string>,
  isTarget: (key: string) => boolean
): Map<string, Set<number>> {
  const usage = new Map<string, Set<number>>();
  const tokens = tokenize(text);

  let inText = false;
  let current: string | null = null;
  let pendingStrings: Token[] = [];

  for (const token of tokens) {
    if (token.kind === 'operator') {
      if (token.value === 'BT') {
        inText = true;
        current = null;
        pendingStrings = [];
        continue;
      }
      if (token.value === 'ET') {
        inText = false;
        current = null;
        pendingStrings = [];
        continue;
      }
      if (token.value === 'Tf') {
        // operands are: /Name size Tf — the name is the last name token seen
        continue;
      }
      if (SHOW_TEXT.has(token.value)) {
        if (inText && current && isTarget(current)) {
          let set = usage.get(current);
          if (!set) usage.set(current, (set = new Set()));
          for (const str of pendingStrings) {
            const codes =
              str.kind === 'hex' ? codesFromHex(str.value) : codesFromLiteral(str.value);
            for (const code of codes) set.add(code);
          }
        }
        pendingStrings = [];
        continue;
      }
      pendingStrings = [];
      continue;
    }

    if (token.kind === 'name') {
      // Remember it; if the next operator is Tf this was the font.
      const mapped = fontByName.get(token.value);
      if (mapped !== undefined) current = mapped;
      continue;
    }

    if (token.kind === 'hex' || token.kind === 'literal') {
      pendingStrings.push(token);
    }
  }

  return usage;
}

const toHex = (codes: number[]): string =>
  codes.map((code) => code.toString(16).toUpperCase().padStart(4, '0')).join('');

/**
 * Rewrites glyph ids in place using per-font old→new maps.
 *
 * Returns null when any referenced glyph has no mapping, which means the
 * caller's used-glyph analysis disagreed with the stream and nothing should be
 * changed.
 */
export function renumberGlyphs(
  text: string,
  fontByName: Map<string, string>,
  mappings: Map<string, Map<number, number>>
): string | null {
  const tokens = tokenize(text);
  const edits: { start: number; end: number; replacement: string }[] = [];

  let inText = false;
  let current: string | null = null;
  let pendingStrings: Token[] = [];
  let failed = false;

  for (const token of tokens) {
    if (token.kind === 'operator') {
      if (token.value === 'BT') {
        inText = true;
        current = null;
        pendingStrings = [];
        continue;
      }
      if (token.value === 'ET') {
        inText = false;
        current = null;
        pendingStrings = [];
        continue;
      }
      if (SHOW_TEXT.has(token.value)) {
        const map = inText && current ? mappings.get(current) : undefined;
        if (map) {
          for (const str of pendingStrings) {
            // Only hex strings are rewritten. A literal string carrying CIDs is
            // legal but vanishingly rare, and silently mangling one is worse
            // than declining to subset that font.
            if (str.kind !== 'hex') {
              failed = true;
              break;
            }
            const codes = codesFromHex(str.value);
            const next: number[] = [];
            for (const code of codes) {
              const mapped = map.get(code);
              if (mapped === undefined) {
                failed = true;
                break;
              }
              next.push(mapped);
            }
            if (failed) break;
            edits.push({ start: str.start + 1, end: str.end - 1, replacement: toHex(next) });
          }
        }
        pendingStrings = [];
        if (failed) break;
        continue;
      }
      pendingStrings = [];
      continue;
    }

    if (token.kind === 'name') {
      const mapped = fontByName.get(token.value);
      if (mapped !== undefined) current = mapped;
      continue;
    }

    if (token.kind === 'hex' || token.kind === 'literal') {
      pendingStrings.push(token);
    }
  }

  if (failed) return null;
  if (edits.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  out += text.slice(cursor);

  return out;
}
