/**
 * ToUnicode CMap rewriting.
 *
 * A CID font's /ToUnicode maps character codes to Unicode, and for Identity-H
 * the code IS the glyph id. Renumbering glyphs without rewriting this map
 * leaves a document that renders perfectly and cannot be copied, searched or
 * read by a screen reader — the worst kind of bug, because it looks fine.
 */

export type UnicodeMap = Map<number, string>;

/** Parses the bfchar and bfrange sections into code → UTF-16BE hex. */
export function parseToUnicode(bytes: Uint8Array): UnicodeMap {
  const text = new TextDecoder('latin1').decode(bytes);
  const map: UnicodeMap = new Map();

  for (const section of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), pair[2].toUpperCase());
    }
  }

  for (const section of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // <lo> <hi> <dst>
    for (const range of section[1].matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    )) {
      const lo = parseInt(range[1], 16);
      const hi = parseInt(range[2], 16);
      const dst = range[3].toUpperCase();

      // Only the last UTF-16 unit increments across the range.
      const prefix = dst.slice(0, Math.max(0, dst.length - 4));
      const base = parseInt(dst.slice(-4), 16);

      for (let code = lo; code <= hi && code - lo < 65536; code += 1) {
        map.set(
          code,
          prefix + (base + (code - lo)).toString(16).toUpperCase().padStart(4, '0')
        );
      }
    }

    // <lo> <hi> [<dst> <dst> ...]
    for (const range of section[1].matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g
    )) {
      const lo = parseInt(range[1], 16);
      const items = [...range[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((m) => m[1].toUpperCase());
      items.forEach((dst, index) => map.set(lo + index, dst));
    }
  }

  return map;
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

/** Emits a complete, minimal CMap. bfchar only — simple and always correct. */
export function buildToUnicode(map: UnicodeMap): Uint8Array {
  const entries = [...map.entries()]
    .filter(([, value]) => value.length > 0)
    .sort((a, b) => a[0] - b[0]);

  const chunks: string[] = [];
  // The bfchar operator takes at most 100 pairs per block.
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100);
    chunks.push(
      `${slice.length} beginbfchar\n` +
        slice.map(([code, value]) => `<${hex4(code)}> <${value}>`).join('\n') +
        '\nendbfchar'
    );
  }

  const cmap =
    '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\n' +
    'begincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n' +
    '/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    chunks.join('\n') +
    '\nendcmap\n' +
    'CMapName currentdict /CMap defineresource pop\n' +
    'end\nend';

  const out = new Uint8Array(cmap.length);
  for (let i = 0; i < cmap.length; i += 1) out[i] = cmap.charCodeAt(i) & 0xff;
  return out;
}

/** Re-keys a parsed map through old→new glyph ids. */
export function remap(map: UnicodeMap, mapping: Map<number, number>): UnicodeMap {
  const next: UnicodeMap = new Map();
  for (const [oldCode, value] of map) {
    const newCode = mapping.get(oldCode);
    if (newCode !== undefined) next.set(newCode, value);
  }
  return next;
}
