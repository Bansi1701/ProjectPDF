/**
 * Flatten — turning a document's interactive parts into permanent ink.
 *
 * "Flatten" is three different operations that share a name, and people asking
 * for it usually want all three without knowing they are asking for three:
 *
 *   1. FORM FIELDS become the picture they were drawing. A filled field is a
 *      value plus a cached appearance stream; flattening paints the appearance
 *      into the page and deletes the field, so the text is still there and
 *      there is no longer a box to type in.
 *   2. ANNOTATIONS — highlights, ink, stamps, sticky-note icons, callouts —
 *      are painted into the page. An annotation is not part of the page at
 *      all; it is a separate object a reader composites on top, and any reader
 *      can move or delete it. Painting it makes it page content like any other.
 *   3. OPTIONAL CONTENT (layers) is resolved to what is currently visible.
 *      Hidden layers are removed outright and the layer switch is taken away,
 *      so what you see is all the file contains.
 *
 * This does all three, and the notes on the result say exactly which parts of
 * each one succeeded. That matters more than usual here, because the reason
 * people flatten is that a filled or signed form must not be editable
 * afterwards — and a flatten that quietly left one field behind has not failed
 * loudly, it has failed silently, which is worse. So the output is re-opened
 * and checked before it is handed back: no form fields, no widget annotations.
 * If the check does not pass you get an error and your original, not a file.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not invent appearances. An annotation with no appearance stream —
 * some producers leave highlights and ink for the reader to draw from their
 * /QuadPoints and /InkList — is left in the document untouched and named in
 * the notes. Drawing it here would mean guessing at a viewer's house style for
 * line caps, blend modes and border dashes, and a guess that looks close is
 * the worst outcome: it is wrong and it is convincing.
 *
 * And it does not rasterise. Nothing is re-rendered, so text stays selectable
 * and vectors stay sharp. That is the opposite trade from redact.ts, and the
 * opposite trade is correct here: flattening is about removing interactivity,
 * not about destroying information. If you need content GONE rather than
 * fixed in place, redact is the tool; flatten is not a security feature and
 * this file will not pretend otherwise.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from '@cantoo/pdf-lib';
import type { PDFObject, PDFPage } from '@cantoo/pdf-lib';

import { tokenize } from './content';
import type { InputFile, OpResult } from './types';

/** Which of the three flattens to run. All on is what "flatten" usually means. */
export interface FlattenOptions {
  /** Bake filled values in and delete the fields. Default true. */
  fields?: boolean;
  /** Paint comments, highlights, stamps and ink into the page. Default true. */
  annotations?: boolean;
  /** Delete hidden layers and remove the layer switch. Default true. */
  layers?: boolean;
  /**
   * Leave /Link annotations alone. Default true.
   *
   * A link is the one annotation with no ink of its own: it is a clickable
   * rectangle, and flattening it would delete working navigation while
   * changing nothing on the page. People who flatten a report still expect
   * its table of contents to work.
   */
  keepLinks?: boolean;
}

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

const decodeLatin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const encodeLatin1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

/** Annotation /F flag bits that mean "a reader does not draw this". */
const FLAG_HIDDEN = 1 << 1;
const FLAG_NOVIEW = 1 << 5;

/** Nested form XObjects are followed this deep when hunting for hidden layers. */
const MAX_XOBJECT_DEPTH = 8;

// ── small dictionary helpers ────────────────────────────────────────────────

const numbersOf = (array: PDFArray | undefined, count: number): number[] | null => {
  if (!array || array.size() !== count) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = array.get(i);
    if (!(value instanceof PDFNumber)) return null;
    out.push(value.asNumber());
  }
  return out;
};

/** The dictionary of a stream or dictionary, whichever we were handed. */
const dictOf = (obj: PDFObject | undefined): PDFDict | undefined => {
  if (obj instanceof PDFDict) return obj;
  if (obj instanceof PDFStream) return obj.dict;
  return undefined;
};

/** True when any page still carries a form control, with or without an /AcroForm. */
function hasWidgets(doc: PDFDocument): boolean {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i += 1) {
      const ref = annots.get(i);
      const dict = dictOf(ref instanceof PDFRef ? doc.context.lookup(ref) : ref);
      const subtype = dict?.get(PDFName.of('Subtype'));
      if (subtype instanceof PDFName && subtype.asString() === '/Widget') return true;
    }
  }
  return false;
}

// ── optional content: which groups are switched off ─────────────────────────

/**
 * The set of optional-content groups that are OFF in the document's default
 * configuration — which is what a reader shows when the file is first opened,
 * and therefore what "currently visible" means for a file arriving as bytes.
 *
 * /D can say it two ways round: list what is off, or set /BaseState /OFF and
 * list what is on. Both are in the wild and reading only the first one gets
 * every layered CAD drawing exactly backwards.
 */
function offGroups(doc: PDFDocument): Set<string> | null {
  const props = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (!props) return null;

  const all = props.lookupMaybe(PDFName.of('OCGs'), PDFArray);
  const config = props.lookupMaybe(PDFName.of('D'), PDFDict);
  const off = new Set<string>();

  const baseState = config?.get(PDFName.of('BaseState'));
  if (baseState instanceof PDFName && baseState.asString() === '/OFF' && all) {
    for (let i = 0; i < all.size(); i += 1) {
      const ref = all.get(i);
      if (ref instanceof PDFRef) off.add(ref.toString());
    }
  }

  const on = config?.lookupMaybe(PDFName.of('ON'), PDFArray);
  if (on) {
    for (let i = 0; i < on.size(); i += 1) {
      const ref = on.get(i);
      if (ref instanceof PDFRef) off.delete(ref.toString());
    }
  }

  const explicitlyOff = config?.lookupMaybe(PDFName.of('OFF'), PDFArray);
  if (explicitlyOff) {
    for (let i = 0; i < explicitlyOff.size(); i += 1) {
      const ref = explicitlyOff.get(i);
      if (ref instanceof PDFRef) off.add(ref.toString());
    }
  }

  return off;
}

/**
 * Is the content governed by this /OC entry drawn right now?
 *
 * /OC points at either a group or a membership dictionary, and a membership
 * dictionary combines several groups under a policy. Anything this cannot
 * read — a /VE visibility expression, a group we have no reference for — is
 * reported as visible, because leaving content in is a recoverable mistake
 * and deleting it is not.
 */
function ocVisible(doc: PDFDocument, entry: PDFObject | undefined, off: Set<string>): boolean {
  if (entry === undefined) return true;

  if (entry instanceof PDFRef && off.has(entry.toString())) return false;

  const dict = dictOf(entry instanceof PDFRef ? doc.context.lookup(entry) : entry);
  if (!dict) return true;

  const type = dict.get(PDFName.of('Type'));
  if (!(type instanceof PDFName) || type.asString() !== '/OCMD') return true;

  const groups = dict.get(PDFName.of('OCGs'));
  const refs: PDFRef[] = [];
  if (groups instanceof PDFRef) refs.push(groups);
  const array = doc.context.lookupMaybe(groups, PDFArray);
  if (array) {
    for (let i = 0; i < array.size(); i += 1) {
      const ref = array.get(i);
      if (ref instanceof PDFRef) refs.push(ref);
    }
  }
  if (refs.length === 0) return true;

  // A /VE expression overrides /P entirely and can nest arbitrarily. We do not
  // evaluate it, so the content stays.
  if (dict.has(PDFName.of('VE'))) return true;

  const states = refs.map((ref) => !off.has(ref.toString()));
  const policy = dict.get(PDFName.of('P'));
  const name = policy instanceof PDFName ? policy.asString() : '/AnyOn';

  if (name === '/AllOn') return states.every(Boolean);
  if (name === '/AnyOff') return states.some((visible) => !visible);
  if (name === '/AllOff') return states.every((visible) => !visible);
  return states.some(Boolean);
}

// ── optional content: cutting hidden sections out of a content stream ───────

interface Rewrite {
  ref: PDFRef;
  text: string;
}

/**
 * Removes every `/OC … BDC … EMC` section whose group is off.
 *
 * Returns the new stream text, `null` when there was nothing to cut, and
 * throws when the stream cannot be edited safely. The refusals matter more
 * than the edits:
 *
 *   - An inline image (`BI … ID <binary> EI`) puts raw bytes in the operator
 *     stream, and the tokenizer reads those bytes as tokens. That can conjure
 *     an `EMC` out of image data and cut the wrong range. Any `BI` at all and
 *     this stream is left alone.
 *   - A section that pushes more graphics states than it pops is relying on
 *     the surrounding stream to clean up after it. Cutting that leaves every
 *     later operator running under the wrong transform, which does not error —
 *     it just moves the rest of the page. Also left alone.
 */
function cutHiddenSections(
  doc: PDFDocument,
  text: string,
  properties: PDFDict | undefined,
  off: Set<string>
): string | null {
  const tokens = tokenize(text);
  const cuts: { start: number; end: number }[] = [];

  let depth = 0;
  /** Depths at which a cut began, so nesting closes in the right order. */
  const openCuts: { depth: number; start: number }[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'operator') continue;

    if (token.value === 'BI') {
      throw new Error('inline image');
    }

    if (token.value === 'BDC' || token.value === 'BMC') {
      const tag = token.value === 'BDC' ? tokens[i - 2] : tokens[i - 1];
      if (
        token.value === 'BDC' &&
        tag?.kind === 'name' &&
        tag.value === '/OC' &&
        openCuts.length === 0
      ) {
        const operand = tokens[i - 1];
        const entry =
          operand?.kind === 'name'
            ? properties?.get(PDFName.of(operand.value.slice(1)))
            : undefined;
        if (!ocVisible(doc, entry, off)) {
          openCuts.push({ depth, start: tag.start });
        }
      }
      depth += 1;
      continue;
    }

    if (token.value === 'EMC') {
      depth -= 1;
      const open = openCuts[openCuts.length - 1];
      if (open && open.depth === depth) {
        openCuts.pop();
        cuts.push({ start: open.start, end: token.end });
      }
      continue;
    }
  }

  if (openCuts.length > 0) throw new Error('unbalanced marked content');
  if (cuts.length === 0) return null;

  for (const cut of cuts) {
    let balance = 0;
    for (const token of tokens) {
      if (token.start < cut.start || token.end > cut.end) continue;
      if (token.kind !== 'operator') continue;
      if (token.value === 'q') balance += 1;
      if (token.value === 'Q') balance -= 1;
      if (balance < 0) throw new Error('unbalanced graphics state');
    }
    if (balance !== 0) throw new Error('unbalanced graphics state');
  }

  let out = '';
  let cursor = 0;
  for (const cut of cuts) {
    out += text.slice(cursor, cut.start);
    cursor = cut.end;
  }
  return out + text.slice(cursor);
}

/** Every content stream reachable from a page, following form XObjects. */
function contentStreamRefs(doc: PDFDocument, page: PDFPage): { ref: PDFRef; resources?: PDFDict }[] {
  const found: { ref: PDFRef; resources?: PDFDict }[] = [];
  const seen = new Set<string>();

  const pageResources = page.node.Resources();
  const contents = page.node.get(PDFName.of('Contents'));
  const list = doc.context.lookupMaybe(contents, PDFArray);
  if (list) {
    for (let i = 0; i < list.size(); i += 1) {
      const ref = list.get(i);
      if (ref instanceof PDFRef && !seen.has(ref.toString())) {
        seen.add(ref.toString());
        found.push({ ref, resources: pageResources });
      }
    }
  } else if (contents instanceof PDFRef) {
    seen.add(contents.toString());
    found.push({ ref: contents, resources: pageResources });
  }

  const walk = (resources: PDFDict | undefined, depth: number): void => {
    if (!resources || depth > MAX_XOBJECT_DEPTH) return;
    const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) return;

    for (const [, value] of xobjects.entries()) {
      if (!(value instanceof PDFRef) || seen.has(value.toString())) continue;
      const stream = doc.context.lookup(value);
      if (!(stream instanceof PDFStream)) continue;
      const subtype = stream.dict.get(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.asString() !== '/Form') continue;
      seen.add(value.toString());
      const own = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
      found.push({ ref: value, resources: own ?? resources });
      walk(own, depth + 1);
    }
  };

  walk(pageResources, 0);
  return found;
}

interface LayerOutcome {
  /** Groups that were switched off in the file as it arrived. */
  hidden: number;
  /** Content streams actually edited. */
  cutStreams: number;
  /** Whole objects dropped because their /OC was off. */
  droppedObjects: number;
  /** Why nothing was done, when nothing was done. */
  refusal: string | null;
  /** True when the layer machinery was removed and nothing can be toggled. */
  resolved: boolean;
}

/**
 * Resolve layers to what is visible, or leave every one of them alone.
 *
 * The all-or-nothing shape is the important part. Removing /OCProperties is
 * what makes the result permanent, but a file with no /OCProperties draws ALL
 * optional content — so removing it while any hidden section survived would
 * not just fail to hide that content, it would REVEAL it. So the cuts are
 * planned in full first, and if a single stream refuses, the document keeps
 * its layers exactly as they were and the notes say so.
 */
function flattenLayers(doc: PDFDocument): LayerOutcome {
  const off = offGroups(doc);
  if (!off) {
    return { hidden: 0, cutStreams: 0, droppedObjects: 0, refusal: null, resolved: false };
  }

  const rewrites: Rewrite[] = [];
  const planned = new Set<string>();

  for (const page of doc.getPages()) {
    for (const { ref, resources } of contentStreamRefs(doc, page)) {
      if (planned.has(ref.toString())) continue;
      planned.add(ref.toString());

      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;

      let text: string;
      try {
        text = decodeLatin1(decodePDFRawStream(stream).decode());
      } catch {
        return {
          hidden: off.size,
          cutStreams: 0,
          droppedObjects: 0,
          refusal: 'a content stream would not decompress',
          resolved: false,
        };
      }

      // Cheap gate: no /OC marked content here at all, so nothing to plan.
      if (off.size > 0 && !text.includes('/OC')) continue;

      try {
        const rewritten = cutHiddenSections(
          doc,
          text,
          resources?.lookupMaybe(PDFName.of('Properties'), PDFDict),
          off
        );
        if (rewritten !== null) rewrites.push({ ref, text: rewritten });
      } catch (error) {
        return {
          hidden: off.size,
          cutStreams: 0,
          droppedObjects: 0,
          refusal: (error as Error).message,
          resolved: false,
        };
      }
    }
  }

  // Nothing refused, so it is safe to apply everything and take the switch away.
  for (const rewrite of rewrites) {
    const previous = doc.context.lookup(rewrite.ref);
    const next = doc.context.flateStream(encodeLatin1(rewrite.text));
    if (previous instanceof PDFRawStream) {
      for (const [key, value] of previous.dict.entries()) {
        const name = String(key);
        if (name === '/Length' || name === '/Filter' || name === '/DecodeParms') continue;
        next.dict.set(key, value);
      }
    }
    doc.context.assign(rewrite.ref, next);
  }

  let dropped = 0;

  // Whole objects can carry /OC too: a hidden stamp, an image layer switched
  // off wholesale, a form XObject holding a whole hidden drawing. These need
  // no parsing — the entry either goes or loses its switch.
  //
  // Order matters here and it bit once already. Stripping /OC from every
  // XObject first and asking about visibility afterwards means every hidden
  // one has already lost the evidence and silently becomes visible. Each
  // object is decided and acted on in the same step.
  const visitXObjects = (resources: PDFDict | undefined, depth: number, seen: Set<string>): void => {
    if (!resources || depth > MAX_XOBJECT_DEPTH) return;
    const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) return;

    for (const [key, value] of xobjects.entries()) {
      const id = value instanceof PDFRef ? value.toString() : null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);

      const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
      if (!(stream instanceof PDFStream)) continue;

      const entry = stream.dict.get(PDFName.of('OC'));
      if (entry !== undefined && !ocVisible(doc, entry, off)) {
        // Not deleted outright: the `Do` that names it is still in the content
        // stream, and a Do pointing at nothing is a broken file. An empty form
        // with the same bounding box draws nothing and stays legal.
        const empty = doc.context.flateStream(new Uint8Array(0));
        empty.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
        empty.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
        empty.dict.set(
          PDFName.of('BBox'),
          stream.dict.get(PDFName.of('BBox')) ?? doc.context.obj([0, 0, 0, 0])
        );
        xobjects.set(key, doc.context.register(empty));
        dropped += 1;
        continue;
      }

      if (entry !== undefined) stream.dict.delete(PDFName.of('OC'));
      visitXObjects(stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), depth + 1, seen);
    }
  };

  const seenXObjects = new Set<string>();

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (annots) {
      for (let i = annots.size() - 1; i >= 0; i -= 1) {
        const ref = annots.get(i);
        const dict = dictOf(ref instanceof PDFRef ? doc.context.lookup(ref) : ref);
        const entry = dict?.get(PDFName.of('OC'));
        if (!dict || entry === undefined) continue;
        if (ocVisible(doc, entry, off)) dict.delete(PDFName.of('OC'));
        else {
          annots.remove(i);
          dropped += 1;
        }
      }
    }

    visitXObjects(page.node.Resources(), 0, seenXObjects);
  }

  doc.catalog.delete(PDFName.of('OCProperties'));

  return {
    hidden: off.size,
    cutStreams: rewrites.length,
    droppedObjects: dropped,
    refusal: null,
    resolved: true,
  };
}

// ── annotations: painting an appearance stream where the reader would ───────

/** The appearance stream a reader would draw for this annotation right now. */
function normalAppearance(doc: PDFDocument, annot: PDFDict): PDFRef | null {
  const ap = doc.context.lookupMaybe(annot.get(PDFName.of('AP')), PDFDict);
  if (!ap) return null;

  const normal = ap.get(PDFName.of('N'));
  if (normal === undefined) return null;

  const resolved = normal instanceof PDFRef ? doc.context.lookup(normal) : normal;
  if (resolved instanceof PDFStream) {
    return normal instanceof PDFRef ? normal : doc.context.register(resolved);
  }

  // A sub-dictionary of states: /AS picks one. With no /AS a single-entry
  // dictionary is unambiguous; more than one and we would be guessing.
  if (resolved instanceof PDFDict) {
    const state = annot.get(PDFName.of('AS'));
    const keys = resolved.keys();
    const chosen =
      state instanceof PDFName
        ? resolved.get(state)
        : keys.length === 1
          ? resolved.get(keys[0])
          : undefined;
    if (chosen instanceof PDFRef) return chosen;
    if (chosen instanceof PDFStream) return doc.context.register(chosen);
  }

  return null;
}

/**
 * Paints one annotation's appearance onto its page.
 *
 * This is the algorithm from ISO 32000-1 §12.5.5, and it is not the obvious
 * one. The appearance stream has its own /BBox and /Matrix; you cannot simply
 * translate to /Rect. The BBox is transformed by the Matrix, the *bounding box
 * of that result* is fitted to /Rect, and the fitting transform is what goes
 * into the page. The `Do` operator then applies /Matrix again on its own —
 * which is why /Matrix must not appear in what we push, and why a rotated
 * stamp placed with a naive translate lands askew and clipped.
 */
function paintAnnotation(doc: PDFDocument, page: PDFPage, annot: PDFDict, ref: PDFRef): boolean {
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFStream)) return false;

  const rect = numbersOf(doc.context.lookupMaybe(annot.get(PDFName.of('Rect')), PDFArray), 4);
  if (!rect) return false;

  const rx0 = Math.min(rect[0], rect[2]);
  const ry0 = Math.min(rect[1], rect[3]);
  const rw = Math.abs(rect[2] - rect[0]);
  const rh = Math.abs(rect[3] - rect[1]);

  const bbox = numbersOf(stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray), 4) ?? [0, 0, 1, 1];
  const m = numbersOf(stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray), 6) ??
    [1, 0, 0, 1, 0, 0];

  const corners: [number, number][] = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const tx0 = Math.min(...xs);
  const ty0 = Math.min(...ys);
  const tw = Math.max(...xs) - tx0;
  const th = Math.max(...ys) - ty0;

  // A zero-extent box cannot be scaled to fit anything; place it as-is rather
  // than dividing by zero and writing NaN into the file.
  const sx = tw === 0 ? 1 : rw / tw;
  const sy = th === 0 ? 1 : rh / th;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;

  const key = page.node.newXObject('FlatAnnot', ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy),
    drawObject(key.asString().slice(1)),
    popGraphicsState()
  );
  return true;
}

interface AnnotationOutcome {
  painted: number;
  /** Hidden or set to not display: removed, but nothing drawn in their place. */
  invisible: number;
  /** Popup boxes, which only exist while a comment is open. */
  popups: number;
  /** Links left clickable on purpose. */
  linksKept: number;
  /** Links whose clickability was taken away. They draw nothing, so nothing was painted. */
  linksRemoved: number;
  /** Subtype → count for annotations with no appearance stream to paint. */
  unpaintable: Map<string, number>;
  /** True if any painted annotation carried a comment body in /Contents. */
  droppedComments: number;
}

function flattenAnnotations(doc: PDFDocument, keepLinks: boolean): AnnotationOutcome {
  const out: AnnotationOutcome = {
    painted: 0,
    invisible: 0,
    popups: 0,
    linksKept: 0,
    linksRemoved: 0,
    unpaintable: new Map(),
    droppedComments: 0,
  };

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;

    // Forward order: /Annots is painting order, and a stamp over a highlight
    // has to stay over it. Removals are collected and applied afterwards so
    // the indexes stay valid while we walk.
    const remove: PDFRef[] = [];

    for (let i = 0; i < annots.size(); i += 1) {
      const entry = annots.get(i);
      if (!(entry instanceof PDFRef)) continue;
      const annot = doc.context.lookupMaybe(entry, PDFDict);
      if (!annot) continue;

      const subtypeName = annot.get(PDFName.of('Subtype'));
      const subtype = subtypeName instanceof PDFName ? subtypeName.asString().slice(1) : 'Unknown';

      // Widgets are the fields pass's business, in both directions: baking one
      // here would leave the /Fields entry pointing at an annotation that is
      // no longer on any page, which is a form that looks fillable and is not.
      if (subtype === 'Widget') continue;

      if (subtype === 'Popup') {
        remove.push(entry);
        out.popups += 1;
        continue;
      }

      if (subtype === 'Link') {
        if (keepLinks) {
          out.linksKept += 1;
          continue;
        }
        // A link is the one annotation whose entire content is behaviour. It
        // almost never has an appearance stream, so it does not belong in the
        // "could not paint this" list — there was never anything to paint.
        // Flattening it means the click goes away and the page looks the same.
        const border = normalAppearance(doc, annot);
        if (border) paintAnnotation(doc, page, annot, border);
        remove.push(entry);
        out.linksRemoved += 1;
        continue;
      }

      const flags = annot.get(PDFName.of('F'));
      const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
      if ((f & FLAG_HIDDEN) !== 0 || (f & FLAG_NOVIEW) !== 0) {
        remove.push(entry);
        out.invisible += 1;
        continue;
      }

      const appearance = normalAppearance(doc, annot);
      if (!appearance || !paintAnnotation(doc, page, annot, appearance)) {
        out.unpaintable.set(subtype, (out.unpaintable.get(subtype) ?? 0) + 1);
        continue;
      }

      if ((annot.get(PDFName.of('Contents'))?.toString().length ?? 0) > 2) {
        out.droppedComments += 1;
      }

      remove.push(entry);
      out.painted += 1;
    }

    for (const ref of remove) page.node.removeAnnot(ref);
  }

  return out;
}

// ── form fields ─────────────────────────────────────────────────────────────

interface FieldOutcome {
  flattened: number;
  /** Widgets that were on a page but in no field, baked in by hand. */
  strays: number;
  /** Named because pdf-lib deletes these without painting anything. */
  lost: string[];
  /** True when appearances could not be regenerated before flattening. */
  staleAppearances: boolean;
}

/**
 * Bake the fields, and know in advance which ones will not survive.
 *
 * pdf-lib's `form.flatten()` catches its own per-widget failures, logs them,
 * and then deletes the field anyway — so a field whose appearance stream
 * cannot be resolved vanishes with nothing painted where it was. That is the
 * exact failure this file exists to not do quietly, so the widgets are
 * inspected first and the doomed ones are named on the result.
 */
async function flattenFields(doc: PDFDocument): Promise<FieldOutcome> {
  const form = doc.getForm();
  const out: FieldOutcome = { flattened: 0, strays: 0, lost: [], staleAppearances: false };

  // Values live in the field dictionary; what a reader draws is a separate
  // cached stream. Regenerate before baking or the flattened page shows the
  // appearance from before the last edit — see the same trap in forms.ts.
  // Guarded on there being a field: embedding a font the document does not
  // need would leave an unused Helvetica in every file we touch.
  if (form.getFields().length > 0) {
    try {
      const helvetica = await doc.embedFont(StandardFonts.Helvetica);
      form.updateFieldAppearances(helvetica);
    } catch {
      // Fields wanting a font we cannot embed keep whatever appearance they
      // already had. That is still a real appearance; it just may be stale.
      out.staleAppearances = true;
    }
  }

  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets();
    if (widgets.length === 0) {
      out.lost.push(field.getName());
      continue;
    }
    const drawable = widgets.some((widget) => {
      const normal = widget.getNormalAppearance();
      if (normal instanceof PDFRef) return doc.context.lookup(normal) instanceof PDFStream;
      return normal instanceof PDFDict && normal.keys().length > 0;
    });
    if (drawable) out.flattened += 1;
    else out.lost.push(field.getName());
  }

  // Also sweeps up widgets that are on a page but missing from /Fields — a
  // form whose AcroForm was stripped by an earlier tool still has live boxes
  // on the page, and leaving those is exactly the silent failure this file is
  // here to prevent.
  form.flatten({ updateFieldAppearances: false });

  // Painted here rather than in the annotations pass, which means a stray
  // control ends up UNDER any markup annotation that was above it in /Annots.
  // Two passes cannot preserve one interleaved order, and a control sitting
  // under a highlight is a better failure than a form that stays fillable.
  //
  // pdf-lib only sweeps orphan widgets that carry /FT on the annotation, and
  // a widget without one is skipped and left on the page. It is still a form
  // control — a reader still draws it as a box — so "no fields survive" is not
  // true until these are gone too. They are baked with the annotation painter
  // rather than deleted, so whatever they were showing stays visible.
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;

    const remove: PDFRef[] = [];
    for (let i = 0; i < annots.size(); i += 1) {
      const ref = annots.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const annot = doc.context.lookupMaybe(ref, PDFDict);
      const subtype = annot?.get(PDFName.of('Subtype'));
      if (!annot || !(subtype instanceof PDFName) || subtype.asString() !== '/Widget') continue;

      const appearance = normalAppearance(doc, annot);
      if (appearance && paintAnnotation(doc, page, annot, appearance)) out.strays += 1;
      else {
        const title = annot.get(PDFName.of('T'));
        out.lost.push(title ? title.toString().replace(/^\(|\)$/g, '') : 'an unnamed control');
      }
      remove.push(ref);
    }
    for (const ref of remove) page.node.removeAnnot(ref);
  }

  // /Fields is empty now, but the AcroForm dictionary itself is still a way
  // back in: /NeedAppearances asks a reader to redraw fields, /SigFlags
  // advertises a signature workflow, /DR carries the resources a new field
  // would use. A flattened document should have no form at all.
  doc.catalog.delete(PDFName.of('AcroForm'));

  return out;
}

// ── verification ────────────────────────────────────────────────────────────

/** What re-opening the saved bytes found. Empty string means it passed. */
async function verifyNoForm(bytes: Uint8Array): Promise<string> {
  let check: PDFDocument;
  try {
    check = await PDFDocument.load(bytes.slice(), { updateMetadata: false });
  } catch (error) {
    return `the result could not be re-opened (${(error as Error).message})`;
  }

  const fields = check.getForm().getFields();
  if (fields.length > 0) {
    return `${fields.length} form field${fields.length === 1 ? '' : 's'} survived flattening`;
  }

  for (const page of check.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i += 1) {
      const ref = annots.get(i);
      const dict = dictOf(ref instanceof PDFRef ? check.context.lookup(ref) : ref);
      const subtype = dict?.get(PDFName.of('Subtype'));
      if (subtype instanceof PDFName && subtype.asString() === '/Widget') {
        return 'a form widget was still attached to a page';
      }
    }
  }

  return '';
}

// ── the operation ───────────────────────────────────────────────────────────

export async function flattenPdf(
  files: InputFile[],
  options: FlattenOptions = {}
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  const {
    fields: doFields = true,
    annotations: doAnnotations = true,
    layers: doLayers = true,
    keepLinks = true,
  } = options;

  if (!doFields && !doAnnotations && !doLayers) {
    return {
      ok: false,
      error: 'Nothing to flatten — turn on form fields, annotations or layers first.',
    };
  }

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.toLowerCase().includes('encrypt')
        ? 'This PDF is password-protected. Unlock it first, then flatten it.'
        : `This file could not be read as a PDF: ${message}`,
    };
  }

  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);

  // An XFA document keeps its real form in an XML stream the pages never
  // reference. Flattening the AcroForm side would produce a file that looks
  // flat, still opens as a live form in Acrobat, and tells the user their
  // signed document is locked when it is not. Refusing is the honest answer.
  if (acroForm?.has(PDFName.of('XFA'))) {
    return {
      ok: false,
      error:
        'This is an XFA form. Its fields live in an XML layer, and flattening the ordinary fields would leave that layer live — the file would look flat and still be editable in Acrobat. Use Acrobat to flatten this one.',
    };
  }

  // Order matters. Layers first, while the content streams are still the ones
  // the file shipped with: the passes below append operators, which makes
  // pdf-lib rewrite /Contents and would leave us re-parsing our own output.
  const layers: LayerOutcome = doLayers
    ? flattenLayers(doc)
    : { hidden: 0, cutStreams: 0, droppedObjects: 0, refusal: null, resolved: false };

  let fieldsOut: FieldOutcome | null = null;
  const formPresent = acroForm !== undefined || hasWidgets(doc);
  if (doFields && formPresent) {
    try {
      fieldsOut = await flattenFields(doc);
    } catch (error) {
      return { ok: false, error: `The form could not be flattened: ${(error as Error).message}` };
    }
  }

  const annotsOut: AnnotationOutcome | null = doAnnotations
    ? flattenAnnotations(doc, keepLinks)
    : null;

  /**
   * Did any of the three passes actually touch the document?
   *
   * Worth knowing, because saving through pdf-lib rewrites the whole file —
   * new object streams, a new cross-reference table, a different byte count —
   * and handing that back for a document with nothing to flatten means the
   * user's file changed for no reason they asked for. When nothing was done,
   * their own bytes come back.
   */
  const changed =
    (fieldsOut !== null &&
      (fieldsOut.flattened > 0 || fieldsOut.strays > 0 || fieldsOut.lost.length > 0)) ||
    (annotsOut !== null &&
      annotsOut.painted + annotsOut.invisible + annotsOut.popups + annotsOut.linksRemoved > 0) ||
    layers.resolved;

  let bytes: Uint8Array;
  try {
    bytes = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
  } catch (error) {
    return { ok: false, error: `The flattened file could not be written: ${(error as Error).message}` };
  }

  if (!changed) bytes = new Uint8Array(file.bytes);

  // ── prove it ──────────────────────────────────────────────────────────
  // The whole point of flattening a filled or signed form is that it cannot be
  // edited afterwards. Asserting that is cheap; assuming it is how people end
  // up sending out an editable contract.
  if (doFields) {
    const problem = await verifyNoForm(bytes);
    if (problem) {
      return {
        ok: false,
        error: `Verification failed: ${problem}, so the file was not returned. Your original is untouched. Please report this.`,
      };
    }
  }

  // ── say what happened ─────────────────────────────────────────────────
  const notes: string[] = [];
  const done: string[] = [];

  if (doFields) {
    if (!formPresent) {
      notes.push('There were no form fields in this document.');
    } else if (fieldsOut) {
      if (fieldsOut.flattened > 0) {
        notes.push(
          `${fieldsOut.flattened} form field${fieldsOut.flattened === 1 ? '' : 's'} became part of the page and ${fieldsOut.flattened === 1 ? 'no longer exists as a field' : 'no longer exist as fields'}. Verified: the result was re-opened and has no fields and no form widgets left. Nobody can edit those values now, including you.`
        );
        done.push(`${fieldsOut.flattened} field${fieldsOut.flattened === 1 ? '' : 's'}`);
      } else if (fieldsOut.strays === 0 && fieldsOut.lost.length === 0) {
        notes.push('There were no form fields in this document.');
      }
      if (fieldsOut.strays > 0) {
        notes.push(
          `${fieldsOut.strays} form control${fieldsOut.strays === 1 ? ' was' : 's were'} sitting on a page without belonging to the form — usually the wreckage of an earlier edit. ${fieldsOut.strays === 1 ? 'It was' : 'They were'} painted in and removed as well, because a leftover box is still a box.`
        );
        done.push(`${fieldsOut.strays} stray control${fieldsOut.strays === 1 ? '' : 's'}`);
      }
      if (fieldsOut.lost.length > 0) {
        const shown = fieldsOut.lost.slice(0, 5).join(', ');
        const rest = fieldsOut.lost.length > 5 ? ` and ${fieldsOut.lost.length - 5} more` : '';
        notes.push(
          `${fieldsOut.lost.length} field${fieldsOut.lost.length === 1 ? '' : 's'} had no drawn appearance to keep (${shown}${rest}). They were removed and nothing was painted where they were — if they held values you need, they are only in your original.`
        );
      }
      if (fieldsOut.staleAppearances) {
        notes.push(
          'The field appearances could not be redrawn here, so what was baked in is the appearance the file already carried. If a value was changed by a program that did not refresh appearances, the flattened page shows the older one.'
        );
      }
    }
  }

  if (annotsOut) {
    if (annotsOut.painted > 0) {
      notes.push(
        `${annotsOut.painted} annotation${annotsOut.painted === 1 ? '' : 's'} — comments, highlights, stamps, ink — were painted into the page and deleted as annotations. They are ordinary page content now: not selectable, not movable, not deletable.`
      );
      done.push(`${annotsOut.painted} annotation${annotsOut.painted === 1 ? '' : 's'}`);
    }
    if (annotsOut.droppedComments > 0) {
      notes.push(
        `${annotsOut.droppedComments} of those carried comment text in a pop-up. The mark on the page survived; the words behind it did not, because a pop-up is not part of the page. Export the comments first if you need them.`
      );
    }
    if (annotsOut.unpaintable.size > 0) {
      const listed = [...annotsOut.unpaintable.entries()]
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');
      notes.push(
        `Left untouched and still editable: ${listed}. These carry no appearance stream — the reader draws them from scratch — and painting them here would mean guessing at another program's line weights and blend modes. A wrong guess that looks plausible is worse than leaving them alone.`
      );
    }
    if (annotsOut.invisible > 0) {
      notes.push(
        `${annotsOut.invisible} annotation${annotsOut.invisible === 1 ? ' was' : 's were'} marked hidden and so nothing was drawn for ${annotsOut.invisible === 1 ? 'it' : 'them'}; ${annotsOut.invisible === 1 ? 'it was' : 'they were'} removed rather than left as invisible baggage.`
      );
    }
    if (annotsOut.popups > 0) {
      notes.push(`${annotsOut.popups} pop-up note box${annotsOut.popups === 1 ? '' : 'es'} removed — they only ever appear while a comment is open.`);
    }
    if (annotsOut.linksRemoved > 0) {
      notes.push(
        `${annotsOut.linksRemoved} link${annotsOut.linksRemoved === 1 ? '' : 's'} removed as you asked. A link draws nothing of its own, so the page looks identical — the difference is that those areas no longer go anywhere when clicked.`
      );
      done.push(`${annotsOut.linksRemoved} link${annotsOut.linksRemoved === 1 ? '' : 's'}`);
    }
    if (annotsOut.linksKept > 0) {
      notes.push(
        `${annotsOut.linksKept} link${annotsOut.linksKept === 1 ? '' : 's'} left clickable on purpose. A link draws nothing, so flattening it would only break navigation.`
      );
    }
  }

  if (doLayers) {
    if (layers.refusal) {
      notes.push(
        `Layers were left exactly as they were: ${layers.refusal} in this file, so the hidden layers could not be cut out safely. Removing the layer switch without removing the hidden content would have made that content visible, which is the opposite of what you asked for.`
      );
    } else if (layers.resolved && layers.hidden > 0) {
      notes.push(
        `${layers.hidden} hidden layer${layers.hidden === 1 ? '' : 's'} removed from ${layers.cutStreams} content stream${layers.cutStreams === 1 ? '' : 's'}${layers.droppedObjects > 0 ? ` and ${layers.droppedObjects} object${layers.droppedObjects === 1 ? '' : 's'}` : ''}, and the layer switch is gone. What you see is now all the file contains.`
      );
      done.push(`${layers.hidden} layer${layers.hidden === 1 ? '' : 's'}`);
    } else if (layers.resolved) {
      notes.push('This document had layers but none were hidden, so nothing was cut — the layer switch was removed so they can no longer be turned off.');
    }
  }

  notes.push(
    'Nothing was rasterised. The text is still selectable and the graphics are still vectors — flattening removes interactivity, it does not remove information. Anything that was underneath an annotation is still underneath it; use Redact if content needs to be gone rather than covered.'
  );

  if (!changed) {
    notes.push('Nothing here needed flattening, so your file came back byte for byte as you gave it to us.');
  }

  // `changed` is the wider test — dropping a hidden annotation or taking away
  // the layer switch counts, and neither has anything to name in `done`.
  const summary = done.length > 0
    ? `Flattened ${done.join(', ')}`
    : changed
      ? 'Removed the interactive parts'
      : 'Nothing needed flattening';

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-flattened.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages: doc.getPageCount(),
    durationMs: performance.now() - started,
    summary,
    unchanged: !changed,
    notes,
  };
}
