/**
 * Minimal binding to hb-subset.
 *
 * harfbuzzjs ships the wasm but exposes no JS helper for subsetting, so this
 * drives the raw exports.
 *
 * The load is deferred: 598 KB of wasm is fetched only when a document turns
 * out to contain fonts worth subsetting, never on page load.
 */
interface HbExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lenPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_glyph_set(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

const HB_MEMORY_MODE_READONLY = 0;

/**
 * Deliberately NOT retain-gids.
 *
 * Retaining ids keeps the glyph tables sized to the HIGHEST id kept, so a font
 * addressed at glyph 6,573 stays a 6,574-entry table however few glyphs are
 * actually used. Renumbering packs them to 0..n-1 — which is the whole saving —
 * at the cost of having to rewrite every glyph reference in the document.
 */
const HB_SUBSET_FLAGS_DEFAULT = 0;

/** Stops GSUB/GPOS from pulling extra glyphs into the retained set. */
const HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE = 0x00000200;

let cached: Promise<HbExports> | null = null;

/** `bytes` is only for tests; the browser fetches the asset URL. */
export function loadHb(bytes?: BufferSource): Promise<HbExports> {
  if (!cached) {
    cached = (async () => {
      // Served from our own origin (see scripts/copy-wasm.mjs) and fetched
      // only once a document turns out to have fonts worth rebuilding.
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const source = bytes ?? (await (await fetch(`${base}/wasm/harfbuzz-subset.wasm`)).arrayBuffer());
      const { instance } = await WebAssembly.instantiate(source as BufferSource, {});
      return instance.exports as unknown as HbExports;
    })();
  }
  return cached;
}

export interface SubsetResult {
  font: Uint8Array;
  /** old glyph id → new glyph id */
  mapping: Map<number, number>;
}

/**
 * Subset `font` down to `keep`, renumbering glyphs.
 *
 * hb packs retained glyphs in ascending order of their original id, so the new
 * id of an old id is its index in the sorted set. That assumption is verified
 * against the output's own metrics by `verifyWidths` before anything ships.
 */
export function subsetFont(hb: HbExports, font: Uint8Array, keep: Set<number>): SubsetResult {
  const ordered = [...keep].sort((a, b) => a - b);

  const heap = () => new Uint8Array(hb.memory.buffer);
  const fontPtr = hb.malloc(font.length);
  heap().set(font, fontPtr);

  const blob = hb.hb_blob_create(fontPtr, font.length, HB_MEMORY_MODE_READONLY, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  const input = hb.hb_subset_input_create_or_fail();

  const release = () => {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.hb_blob_destroy(blob);
    hb.free(fontPtr);
  };

  if (!input) {
    release();
    throw new Error('hb_subset_input_create_or_fail returned null');
  }

  const glyphSet = hb.hb_subset_input_glyph_set(input);
  for (const gid of ordered) hb.hb_set_add(glyphSet, gid);
  hb.hb_subset_input_set_flags(
    input,
    HB_SUBSET_FLAGS_DEFAULT | HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE
  );

  const newFace = hb.hb_subset_or_fail(face, input);
  if (!newFace) {
    release();
    throw new Error('hb_subset_or_fail returned null');
  }

  const outBlob = hb.hb_face_reference_blob(newFace);
  const lenPtr = hb.malloc(4);
  const dataPtr = hb.hb_blob_get_data(outBlob, lenPtr);
  const len = new Uint32Array(hb.memory.buffer, lenPtr, 1)[0];
  const out = heap().slice(dataPtr, dataPtr + len);

  hb.free(lenPtr);
  hb.hb_blob_destroy(outBlob);
  hb.hb_face_destroy(newFace);
  release();

  const mapping = new Map<number, number>();
  ordered.forEach((oldGid, index) => mapping.set(oldGid, index));

  return { font: out, mapping };
}

/**
 * Expands a glyph set to include the components of every composite glyph.
 *
 * A composite glyph (an accented letter, say) is drawn by referencing other
 * glyphs. hb retains those components whether or not they were asked for, so
 * unless they are in the set up front the retained set is larger than the one
 * we sorted — and every id after the first surprise is off by one. That
 * silently shifts text to the wrong glyphs.
 */
export function closeOverComposites(font: Uint8Array, seed: Set<number>): Set<number> {
  const loca = tableOffset(font, 'loca');
  const glyf = tableOffset(font, 'glyf');
  const head = tableOffset(font, 'head');
  const maxp = tableOffset(font, 'maxp');
  if (!loca || !glyf || !head || !maxp) return new Set(seed);

  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const longFormat = view.getInt16(head.offset + 50) === 1;
  const numGlyphs = view.getUint16(maxp.offset + 4);

  const offsetOf = (gid: number): number =>
    longFormat ? view.getUint32(loca.offset + gid * 4) : view.getUint16(loca.offset + gid * 2) * 2;

  const closed = new Set(seed);
  const queue = [...seed];

  while (queue.length > 0) {
    const gid = queue.pop()!;
    if (gid < 0 || gid >= numGlyphs) continue;

    const start = offsetOf(gid);
    const end = offsetOf(gid + 1);
    if (end <= start || glyf.offset + end > font.byteLength) continue;

    const at = glyf.offset + start;
    if (view.getInt16(at) >= 0) continue; // simple glyph, no components

    // composite: a run of (flags, glyphIndex, args...) entries
    let cursor = at + 10;
    for (;;) {
      if (cursor + 4 > glyf.offset + end) break;
      const flags = view.getUint16(cursor);
      const component = view.getUint16(cursor + 2);
      cursor += 4;

      if (!closed.has(component)) {
        closed.add(component);
        queue.push(component);
      }

      cursor += flags & 0x0001 ? 4 : 2; // ARG_1_AND_2_ARE_WORDS
      if (flags & 0x0008) cursor += 2; // WE_HAVE_A_SCALE
      else if (flags & 0x0040) cursor += 4; // X_AND_Y_SCALE
      else if (flags & 0x0080) cursor += 8; // TWO_BY_TWO
      if (!(flags & 0x0020)) break; // MORE_COMPONENTS
    }
  }

  return closed;
}

// ── TrueType table reading, used to check our own work ───────────────────

function tableOffset(font: Uint8Array, tag: string): { offset: number; length: number } | null {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const count = view.getUint16(4);

  for (let i = 0; i < count; i += 1) {
    const record = 12 + i * 16;
    const name = String.fromCharCode(
      font[record],
      font[record + 1],
      font[record + 2],
      font[record + 3]
    );
    if (name === tag) {
      return { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) };
    }
  }

  return null;
}

export function glyphCount(font: Uint8Array): number | null {
  const maxp = tableOffset(font, 'maxp');
  if (!maxp) return null;
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  return view.getUint16(maxp.offset + 4);
}

export interface Advance {
  width: number;
  /**
   * True when the glyph sits past `numberOfHMetrics` and is therefore reusing
   * the last entry rather than carrying its own. Comparing a clamped advance
   * against an unclamped one is meaningless — the subset legitimately gives
   * the glyph its own entry — so callers must skip those pairs.
   */
  clamped: boolean;
}

/** Advance width of one glyph, in font units. */
export function advanceWidth(font: Uint8Array, gid: number): Advance | null {
  const hhea = tableOffset(font, 'hhea');
  const hmtx = tableOffset(font, 'hmtx');
  if (!hhea || !hmtx) return null;

  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numberOfHMetrics = view.getUint16(hhea.offset + 34);
  if (numberOfHMetrics === 0) return null;

  const clamped = gid >= numberOfHMetrics;
  const index = clamped ? numberOfHMetrics - 1 : gid;
  const at = hmtx.offset + index * 4;
  if (at + 2 > hmtx.offset + hmtx.length) return null;

  return { width: view.getUint16(at), clamped };
}
