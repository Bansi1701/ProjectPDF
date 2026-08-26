/**
 * PowerPoint → PDF, in the browser.
 *
 * A slide has no flow layout: every shape carries an absolute position and
 * size in EMU on a fixed canvas, so converting one is a coordinate transform
 * and a text draw. That much was right the first time. What that first version
 * missed is everything a deck inherits rather than states:
 *
 *  - A placeholder built from a template usually has NO position of its own.
 *    It takes one from the slide layout, and the layout from the master. The
 *    first version required an `<a:xfrm>` and skipped anything without one,
 *    which meant a normal title slide converted to a blank page.
 *  - Shapes inside a group are positioned in the group's own child coordinate
 *    space, which the group then maps onto the slide. Ignoring that puts every
 *    grouped shape in the top-left corner.
 *  - Colours are usually theme references (`accent1`, `tx1`), not literal RGB.
 *  - Tables live in `<p:graphicFrame>`, which is a different element entirely.
 *
 * So this reads the layout and master chain, resolves the theme palette, and
 * walks the shape tree with a transform stack.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import type { RGB } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';

import {
  attr,
  children,
  decode,
  dirOf,
  find,
  findAll,
  numAttr,
  relationships,
  relsPathOf,
  unescapeXml,
  type Element,
} from './ooxml';
import { TextPainter } from './text';
import type { InputFile, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.pptx?$/i, '');

/** 914400 EMU to the inch, 72 points to the inch. */
const EMU = 12700;
const toPoints = (emu: number): number => emu / EMU;
/** PowerPoint stores angles in sixtieths of a degree. */
const toDegrees = (value: number): number => value / 60000;

// ── colour ──────────────────────────────────────────────────────────────

type Theme = Map<string, string>;

const hexToRgb = (hex: string): RGB | null => {
  const clean = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return rgb(
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255
  );
};

/** `tx1` and `dk1` are the same colour under two names, and so on. */
const THEME_ALIAS: Record<string, string> = {
  tx1: 'dk1',
  bg1: 'lt1',
  tx2: 'dk2',
  bg2: 'lt2',
};

function readTheme(xml: string): Theme {
  const theme: Theme = new Map();
  const scheme = find(xml, 'a:clrScheme');
  if (!scheme) return theme;

  for (const slot of children(scheme.inner)) {
    const name = slot.name.replace(/^a:/, '');
    const srgb = find(slot.inner, 'a:srgbClr');
    const sys = find(slot.inner, 'a:sysClr');
    const value = srgb ? attr(srgb.attrs, 'val') : sys ? attr(sys.attrs, 'lastClr') : null;
    if (value) theme.set(name, value);
  }

  return theme;
}

/** Reads a colour out of any element that can hold one. */
function colorIn(body: string, theme: Theme): RGB | null {
  const srgb = find(body, 'a:srgbClr');
  if (srgb) {
    const value = attr(srgb.attrs, 'val');
    if (value) return hexToRgb(value);
  }

  const scheme = find(body, 'a:schemeClr');
  if (scheme) {
    const raw = attr(scheme.attrs, 'val') ?? '';
    // `phClr` means "whatever the placeholder style says", which needs the
    // style chain resolved. Leaving it unset is better than guessing wrong.
    if (raw === 'phClr') return null;
    const value = theme.get(THEME_ALIAS[raw] ?? raw);
    if (value) return hexToRgb(value);
  }

  const sys = find(body, 'a:sysClr');
  if (sys) {
    const value = attr(sys.attrs, 'lastClr');
    if (value) return hexToRgb(value);
  }

  return null;
}

/** A solid fill, if this shape has one. `noFill` is a deliberate absence. */
function solidFill(spPr: string | null, theme: Theme): RGB | null {
  if (!spPr) return null;
  for (const child of children(spPr)) {
    if (child.name === 'a:noFill') return null;
    if (child.name === 'a:solidFill') return colorIn(child.inner, theme);
    if (child.name === 'a:gradFill') {
      // Approximate a gradient with its first stop rather than dropping it —
      // a coloured band is much closer than nothing.
      const stop = find(child.inner, 'a:gs');
      return stop ? colorIn(stop.inner, theme) : null;
    }
  }
  return null;
}

// ── geometry ────────────────────────────────────────────────────────────

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/**
 * Maps a child's coordinates through its group's transform.
 *
 * A group declares both where it sits on the slide (`off`/`ext`) and the
 * coordinate space its children were authored in (`chOff`/`chExt`). The two
 * are usually different sizes, so children get scaled as well as moved.
 */
interface Transform {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
}

const IDENTITY: Transform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

const apply = (transform: Transform, frame: Frame): Frame => ({
  x: transform.offsetX + frame.x * transform.scaleX,
  y: transform.offsetY + frame.y * transform.scaleY,
  width: frame.width * transform.scaleX,
  height: frame.height * transform.scaleY,
  rotation: frame.rotation,
  flipH: frame.flipH,
  flipV: frame.flipV,
});

/** Reads an `<a:xfrm>` (or `<p:xfrm>` on a graphic frame) into points. */
function readFrame(container: string): Frame | null {
  const xfrm =
    children(container).find((child) => child.name === 'a:xfrm' || child.name === 'p:xfrm') ??
    null;
  if (!xfrm) return null;

  const off = find(xfrm.inner, 'a:off');
  const ext = find(xfrm.inner, 'a:ext');
  if (!off || !ext) return null;

  return {
    x: toPoints(numAttr(off.attrs, 'x', 0)),
    y: toPoints(numAttr(off.attrs, 'y', 0)),
    width: toPoints(numAttr(ext.attrs, 'cx', 0)),
    height: toPoints(numAttr(ext.attrs, 'cy', 0)),
    rotation: toDegrees(numAttr(xfrm.attrs, 'rot', 0)),
    flipH: attr(xfrm.attrs, 'flipH') === '1',
    flipV: attr(xfrm.attrs, 'flipV') === '1',
  };
}

/** The group transform a `<p:grpSpPr>` sets up for its children. */
function groupTransform(grpSpPr: string, outer: Transform): Transform {
  const xfrm = find(grpSpPr, 'a:xfrm');
  if (!xfrm) return outer;

  const off = find(xfrm.inner, 'a:off');
  const ext = find(xfrm.inner, 'a:ext');
  const chOff = find(xfrm.inner, 'a:chOff');
  const chExt = find(xfrm.inner, 'a:chExt');
  if (!off || !ext || !chOff || !chExt) return outer;

  const childWidth = numAttr(chExt.attrs, 'cx', 0);
  const childHeight = numAttr(chExt.attrs, 'cy', 0);
  if (childWidth === 0 || childHeight === 0) return outer;

  const scaleX = numAttr(ext.attrs, 'cx', 0) / childWidth;
  const scaleY = numAttr(ext.attrs, 'cy', 0) / childHeight;

  // The child's own origin has to be subtracted before scaling, then the
  // group's slide position added back.
  const inner: Transform = {
    offsetX: toPoints(numAttr(off.attrs, 'x', 0)) - toPoints(numAttr(chOff.attrs, 'x', 0)) * scaleX,
    offsetY: toPoints(numAttr(off.attrs, 'y', 0)) - toPoints(numAttr(chOff.attrs, 'y', 0)) * scaleY,
    scaleX,
    scaleY,
  };

  // Compose with whatever transform the group itself is already under.
  return {
    offsetX: outer.offsetX + inner.offsetX * outer.scaleX,
    offsetY: outer.offsetY + inner.offsetY * outer.scaleY,
    scaleX: inner.scaleX * outer.scaleX,
    scaleY: inner.scaleY * outer.scaleY,
  };
}

// ── placeholders ────────────────────────────────────────────────────────

/**
 * `ctrTitle` on a slide can inherit from a `title` on the master, and
 * `subTitle` from `body`. Collapsing them to a family makes the lookup work.
 */
const family = (type: string): string => {
  if (type === 'ctrTitle' || type === 'title') return 'title';
  if (type === 'subTitle' || type === 'body' || type === '') return 'body';
  return type;
};

interface Placeholder {
  frame: Frame;
  /** Default run size in points, if the template states one. */
  size?: number;
}

/** Indexes every placeholder in a layout or master by type and by index. */
function readPlaceholders(xml: string): Map<string, Placeholder> {
  const out = new Map<string, Placeholder>();
  const tree = find(xml, 'p:spTree');
  if (!tree) return out;

  for (const shape of findAll(tree.inner, 'p:sp')) {
    const ph = find(shape.inner, 'p:ph');
    if (!ph) continue;

    const spPr = children(shape.inner).find((child) => child.name === 'p:spPr');
    const frame = spPr ? readFrame(spPr.inner) : null;
    if (!frame) continue;

    const type = family(attr(ph.attrs, 'type') ?? '');
    const idx = attr(ph.attrs, 'idx') ?? '';

    const defRPr = find(shape.inner, 'a:defRPr');
    const size = defRPr ? numAttr(defRPr.attrs, 'sz', 0) / 100 : 0;
    const entry: Placeholder = size > 0 ? { frame, size } : { frame };

    if (idx) out.set(`idx:${idx}`, entry);
    if (type) out.set(`type:${type}`, entry);
  }

  return out;
}

/** Default run sizes the master sets for titles and body text. */
function readTextStyles(masterXml: string): { title: number; body: number; other: number } {
  const read = (styleName: string, fallback: number): number => {
    const style = find(masterXml, styleName);
    if (!style) return fallback;
    const level = find(style.inner, 'a:lvl1pPr');
    const defRPr = level ? find(level.inner, 'a:defRPr') : null;
    const size = defRPr ? numAttr(defRPr.attrs, 'sz', 0) / 100 : 0;
    return size > 0 ? size : fallback;
  };

  return {
    title: read('p:titleStyle', 44),
    body: read('p:bodyStyle', 18),
    other: read('p:otherStyle', 18),
  };
}

// ── text ────────────────────────────────────────────────────────────────

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
  color: RGB | null;
}

interface Paragraph {
  /** A `<a:br/>` splits one paragraph into several hard lines. */
  lines: Run[][];
  align: 'l' | 'ctr' | 'r' | 'just';
  level: number;
  bullet: string | null;
  /** Left margin in points, from `marL`. */
  marginLeft: number;
  /** Space before the paragraph, in points. */
  spaceBefore: number;
  /** Line spacing as a multiplier. */
  lineSpacing: number;
}

function readParagraph(
  body: string,
  theme: Theme,
  defaultSize: number,
  defaultColor: RGB | null
): Paragraph {
  const props = find(body, 'a:pPr');
  const level = props ? numAttr(props.attrs, 'lvl', 0) : 0;

  const rawAlign = props ? attr(props.attrs, 'algn') : null;
  const align: Paragraph['align'] =
    rawAlign === 'ctr' || rawAlign === 'r' || rawAlign === 'just' ? rawAlign : 'l';

  let bullet: string | null = null;
  if (props) {
    const buChar = find(props.inner, 'a:buChar');
    const buAutoNum = find(props.inner, 'a:buAutoNum');
    const buNone = find(props.inner, 'a:buNone');
    if (!buNone) {
      if (buChar) bullet = unescapeXml(attr(buChar.attrs, 'char') ?? '\u2022');
      else if (buAutoNum) bullet = '\u2022'; // numbering needs list state; a mark is honest enough
    }
  }

  /**
   * PowerPoint's built-in list style indents level 1 by 342900 EMU and hangs
   * the bullet back out into that space, so the mark sits at the margin and
   * the text 27pt in. That default applies only to a bulleted paragraph — a
   * plain text box starts at the edge, and giving it the same indent would
   * shift every line of ordinary body text to the right.
   */
  const defaultMargin = bullet ? 342900 + level * 400050 : level * 400050;
  const marginLeft = props
    ? toPoints(numAttr(props.attrs, 'marL', defaultMargin))
    : toPoints(defaultMargin);

  let spaceBefore = 0;
  let lineSpacing = 1.2;
  if (props) {
    const before = find(props.inner, 'a:spcBef');
    if (before) {
      const pts = find(before.inner, 'a:spcPts');
      const pct = find(before.inner, 'a:spcPct');
      if (pts) spaceBefore = numAttr(pts.attrs, 'val', 0) / 100;
      else if (pct) spaceBefore = (numAttr(pct.attrs, 'val', 0) / 100000) * defaultSize;
    }
    const spacing = find(props.inner, 'a:lnSpc');
    if (spacing) {
      const pct = find(spacing.inner, 'a:spcPct');
      if (pct) lineSpacing = (numAttr(pct.attrs, 'val', 100000) / 100000) * 1.2;
    }
  }

  const lines: Run[][] = [[]];

  for (const child of children(body)) {
    if (child.name === 'a:br') {
      lines.push([]);
      continue;
    }

    // `<a:fld>` is a field — a slide number or date — and carries the value
    // PowerPoint last computed in its `<a:t>`, same as a formula cache.
    if (child.name !== 'a:r' && child.name !== 'a:fld') continue;

    const rPr = find(child.inner, 'a:rPr');
    const value = find(child.inner, 'a:t');
    if (!value) continue;

    const size = rPr ? numAttr(rPr.attrs, 'sz', 0) / 100 : 0;
    const color = rPr ? (colorIn(rPr.inner, theme) ?? defaultColor) : defaultColor;

    lines[lines.length - 1].push({
      text: unescapeXml(value.inner),
      bold: rPr ? attr(rPr.attrs, 'b') === '1' : false,
      italic: rPr ? attr(rPr.attrs, 'i') === '1' : false,
      size: size > 0 ? size : defaultSize,
      color,
    });
  }

  return { lines, align, level, bullet, marginLeft, spaceBefore, lineSpacing };
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

const pick = (fonts: Fonts, bold: boolean, italic: boolean): PDFFont =>
  bold && italic ? fonts.boldItalic : bold ? fonts.bold : italic ? fonts.italic : fonts.regular;

interface Piece {
  text: string;
  run: Run;
  font: PDFFont;
  width: number;
}

interface Line {
  pieces: Piece[];
  height: number;
  /** Only the first line of a bulleted paragraph shows its mark. */
  bullet: string | null;
  indent: number;
  align: Paragraph['align'];
  spaceBefore: number;
  spacing: number;
}

/** Breaks paragraphs into drawable lines inside `maxWidth`. */
function layout(
  paragraphs: Paragraph[],
  fonts: Fonts,
  painter: TextPainter,
  maxWidth: number,
  scale: number
): Line[] {
  const out: Line[] = [];

  for (const paragraph of paragraphs) {
    let firstOfParagraph = true;

    for (const runs of paragraph.lines) {
      const indent = paragraph.marginLeft;
      const available = Math.max(maxWidth - indent, 24);

      let pieces: Piece[] = [];
      let used = 0;
      let height = 0;
      let openedLine = false;

      const flush = (force: boolean) => {
        if (pieces.length === 0 && !force) return;
        out.push({
          pieces,
          height: height || 12 * scale,
          bullet: firstOfParagraph && !openedLine ? paragraph.bullet : null,
          indent,
          align: paragraph.align,
          spaceBefore: firstOfParagraph && !openedLine ? paragraph.spaceBefore : 0,
          spacing: paragraph.lineSpacing,
        });
        openedLine = true;
        pieces = [];
        used = 0;
        height = 0;
      };

      for (const run of runs) {
        const size = run.size * scale;
        const styled = { ...run, size };
        const font = pick(fonts, run.bold, run.italic);

        for (const word of styled.text.split(/(\s+)/)) {
          if (!word) continue;

          const width = painter.width(word, font, { size, bold: run.bold, italic: run.italic });

          if (used + width > available && pieces.length > 0) {
            flush(false);
            if (/^\s+$/.test(word)) continue;
          }

          // A single word wider than the box would loop forever above; let it
          // overhang rather than dropping it.
          pieces.push({ text: word, run: styled, font, width });
          used += width;
          height = Math.max(height, size);
        }
      }

      flush(runs.length === 0 && paragraph.lines.length > 1);
      if (pieces.length > 0) flush(true);
      firstOfParagraph = false;
    }
  }

  return out;
}

// ── drawing ─────────────────────────────────────────────────────────────

/** `<a:bodyPr>` insets, in points. These are the OOXML defaults. */
const INSET = { left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 };

interface DrawContext {
  page: PDFPage;
  slideHeight: number;
  fonts: Fonts;
  painter: TextPainter;
  theme: Theme;
}

async function drawTextBody(
  ctx: DrawContext,
  frame: Frame,
  txBody: string,
  defaultSize: number,
  defaultColor: RGB | null
): Promise<void> {
  const bodyPr = find(txBody, 'a:bodyPr');

  const left = bodyPr ? toPoints(numAttr(bodyPr.attrs, 'lIns', INSET.left * EMU)) : INSET.left;
  const right = bodyPr ? toPoints(numAttr(bodyPr.attrs, 'rIns', INSET.right * EMU)) : INSET.right;
  const top = bodyPr ? toPoints(numAttr(bodyPr.attrs, 'tIns', INSET.top * EMU)) : INSET.top;
  const anchor = bodyPr ? (attr(bodyPr.attrs, 'anchor') ?? 't') : 't';

  // A box PowerPoint shrank text to fit records the factor it used.
  const autofit = bodyPr ? find(bodyPr.inner, 'a:normAutofit') : null;
  const scale = autofit ? numAttr(autofit.attrs, 'fontScale', 100000) / 100000 : 1;

  const paragraphs = findAll(txBody, 'a:p').map((p) =>
    readParagraph(p.inner, ctx.theme, defaultSize, defaultColor)
  );
  if (paragraphs.length === 0) return;

  const boxWidth = Math.max(frame.width - left - right, 24);
  const lines = layout(paragraphs, ctx.fonts, ctx.painter, boxWidth, scale);
  if (lines.length === 0) return;

  const total = lines.reduce((sum, line) => sum + line.height * line.spacing + line.spaceBefore, 0);

  // PowerPoint measures down from the top of the slide; PDF measures up from
  // the bottom.
  const boxTop = ctx.slideHeight - frame.y - top;
  let cursor = boxTop;
  if (anchor === 'ctr') cursor = boxTop - Math.max((frame.height - top - total) / 2, 0);
  else if (anchor === 'b') cursor = boxTop - Math.max(frame.height - top - total, 0);

  for (const line of lines) {
    cursor -= line.spaceBefore;

    const width = line.pieces.reduce((sum, piece) => sum + piece.width, 0);
    let x = frame.x + left + line.indent;
    if (line.align === 'ctr') x = frame.x + left + Math.max((boxWidth - width) / 2, 0);
    else if (line.align === 'r') x = frame.x + left + Math.max(boxWidth - width, 0);

    const baseline = cursor - line.height;

    if (line.bullet) {
      const first = line.pieces[0];
      const size = first ? first.run.size : line.height;
      const font = first ? first.font : ctx.fonts.regular;
      const style = { size: size * 0.9, color: first?.run.color ?? undefined };
      const markWidth = ctx.painter.width(line.bullet, font, style);
      await ctx.painter.draw(
        ctx.page,
        line.bullet,
        Math.max(x - markWidth - 6, frame.x + left),
        baseline,
        font,
        style
      );
    }

    for (const piece of line.pieces) {
      if (piece.text.trim().length > 0) {
        await ctx.painter.draw(ctx.page, piece.text, x, baseline, piece.font, {
          size: piece.run.size,
          bold: piece.run.bold,
          italic: piece.run.italic,
          color: piece.run.color ?? undefined,
        });
      }
      x += piece.width;
    }

    cursor -= line.height * line.spacing;
  }
}

/**
 * Places a rotated rectangle.
 *
 * pdf-lib rotates about the point it is given, but PowerPoint rotates about
 * the shape's centre — and clockwise, where PDF turns anticlockwise. This works
 * out where the bottom-left corner has to start so the centre stays put.
 */
function rotatedOrigin(
  x: number,
  y: number,
  width: number,
  height: number,
  degreesClockwise: number
): { x: number; y: number } {
  const radians = (-degreesClockwise * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centreX = x + width / 2;
  const centreY = y + height / 2;
  const dx = -width / 2;
  const dy = -height / 2;

  return {
    x: centreX + dx * cos - dy * sin,
    y: centreY + dx * sin + dy * cos,
  };
}

async function drawTable(
  ctx: DrawContext,
  frame: Frame,
  tbl: string,
  defaultSize: number
): Promise<void> {
  const grid = find(tbl, 'a:tblGrid');
  const columns = grid
    ? findAll(grid.inner, 'a:gridCol').map((col) => toPoints(numAttr(col.attrs, 'w', 0)))
    : [];
  if (columns.length === 0) return;

  // Scale the declared grid to the frame, since the two can disagree.
  const declared = columns.reduce((sum, width) => sum + width, 0);
  const factor = declared > 0 ? frame.width / declared : 1;
  const widths = columns.map((width) => width * factor);

  const rows = findAll(tbl, 'a:tr');
  let top = ctx.slideHeight - frame.y;

  for (const row of rows) {
    const height = toPoints(numAttr(row.attrs, 'h', 0)) || defaultSize * 2;
    let x = frame.x;
    let column = 0;

    for (const cell of findAll(row.inner, 'a:tc')) {
      // A cell merged away still exists in the file, marked and empty.
      const merged =
        attr(cell.attrs, 'hMerge') === '1' || attr(cell.attrs, 'vMerge') === '1';
      const span = numAttr(cell.attrs, 'gridSpan', 1);
      const width = widths.slice(column, column + span).reduce((sum, w) => sum + w, 0);

      if (!merged && width > 0) {
        const fill = solidFill(find(cell.inner, 'a:tcPr')?.inner ?? null, ctx.theme);
        if (fill) {
          ctx.page.drawRectangle({ x, y: top - height, width, height, color: fill });
        }

        ctx.page.drawRectangle({
          x,
          y: top - height,
          width,
          height,
          borderColor: rgb(0.78, 0.78, 0.8),
          borderWidth: 0.5,
        });

        const txBody = find(cell.inner, 'a:txBody');
        if (txBody) {
          await drawTextBody(
            ctx,
            { x, y: ctx.slideHeight - top, width, height, rotation: 0, flipH: false, flipV: false },
            txBody.inner,
            defaultSize * 0.8,
            rgb(0.1, 0.1, 0.12)
          );
        }
      }

      x += width;
      column += span;
    }

    top -= height;
  }
}

interface Counters {
  images: number;
  skippedImages: number;
  tables: number;
  charts: number;
  rotatedText: number;
}

// ── the shape tree ──────────────────────────────────────────────────────

async function drawTree(
  ctx: DrawContext,
  tree: string,
  transform: Transform,
  placeholders: Array<Map<string, Placeholder>>,
  defaults: { title: number; body: number; other: number },
  rels: Map<string, string>,
  embed: (path: string) => Promise<PDFImage | null>,
  counters: Counters
): Promise<void> {
  for (const node of children(tree)) {
    if (node.name === 'p:grpSp') {
      const grpSpPr = children(node.inner).find((child) => child.name === 'p:grpSpPr');
      const inner = grpSpPr ? groupTransform(grpSpPr.inner, transform) : transform;
      await drawTree(ctx, node.inner, inner, placeholders, defaults, rels, embed, counters);
      continue;
    }

    if (node.name === 'p:sp') {
      const spPr = children(node.inner).find((child) => child.name === 'p:spPr');
      const ph = find(node.inner, 'p:ph');

      let frame = spPr ? readFrame(spPr.inner) : null;
      let defaultSize = defaults.other;

      if (ph) {
        const type = family(attr(ph.attrs, 'type') ?? '');
        const idx = attr(ph.attrs, 'idx') ?? '';

        // Layout first, then master; by index if the shape has one, since two
        // body placeholders on a layout differ only by index.
        for (const map of placeholders) {
          const match =
            (idx ? map.get(`idx:${idx}`) : undefined) ??
            (type ? map.get(`type:${type}`) : undefined);
          if (!match) continue;
          if (!frame) frame = match.frame;
          if (match.size) defaultSize = match.size;
          break;
        }

        if (defaultSize === defaults.other) {
          defaultSize = type === 'title' ? defaults.title : defaults.body;
        }
      }

      if (!frame) continue;
      const placed = apply(transform, frame);

      const fill = spPr ? solidFill(spPr.inner, ctx.theme) : null;
      const outline = spPr ? find(spPr.inner, 'a:ln') : null;
      const stroke = outline ? solidFill(outline.inner, ctx.theme) : null;

      if (fill || stroke) {
        ctx.page.drawRectangle({
          x: placed.x,
          y: ctx.slideHeight - placed.y - placed.height,
          width: placed.width,
          height: placed.height,
          ...(fill ? { color: fill } : {}),
          ...(stroke
            ? {
                borderColor: stroke,
                borderWidth: toPoints(numAttr(outline?.attrs ?? '', 'w', 9525)),
              }
            : {}),
        });
      }

      const txBody = children(node.inner).find((child) => child.name === 'p:txBody');
      if (txBody) {
        if (Math.abs(placed.rotation) > 0.5) counters.rotatedText += 1;
        await drawTextBody(ctx, placed, txBody.inner, defaultSize, null);
      }
      continue;
    }

    if (node.name === 'p:pic') {
      const spPr = children(node.inner).find((child) => child.name === 'p:spPr');
      const frame = spPr ? readFrame(spPr.inner) : null;
      if (!frame) continue;

      const placed = apply(transform, frame);
      const blip = find(node.inner, 'a:blip');
      const id = blip ? attr(blip.attrs, 'r:embed') : null;
      const target = id ? rels.get(id) : null;
      const image = target ? await embed(target) : null;

      if (!image) {
        counters.skippedImages += 1;
        continue;
      }

      const bottom = ctx.slideHeight - placed.y - placed.height;

      if (Math.abs(placed.rotation) > 0.5) {
        const origin = rotatedOrigin(placed.x, bottom, placed.width, placed.height, placed.rotation);
        ctx.page.drawImage(image, {
          x: origin.x,
          y: origin.y,
          width: placed.width,
          height: placed.height,
          rotate: degrees(-placed.rotation),
        });
      } else {
        ctx.page.drawImage(image, {
          x: placed.x,
          y: bottom,
          width: placed.width,
          height: placed.height,
        });
      }

      counters.images += 1;
      continue;
    }

    if (node.name === 'p:graphicFrame') {
      const frame = readFrame(node.inner);
      if (!frame) continue;
      const placed = apply(transform, frame);

      const table = find(node.inner, 'a:tbl');
      if (table) {
        await drawTable(ctx, placed, table.inner, defaults.body);
        counters.tables += 1;
        continue;
      }

      if (find(node.inner, 'c:chart') || /chart/i.test(node.inner)) counters.charts += 1;
    }
  }
}

// ── the package ─────────────────────────────────────────────────────────

export async function pptxToPdf(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a presentation.' };

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(file.bytes));
  } catch {
    return {
      ok: false,
      error:
        'That does not look like a .pptx. The older binary .ppt format is a different thing entirely — re-save it as .pptx first.',
    };
  }

  const presentation = decode(entries['ppt/presentation.xml']);
  if (!presentation) {
    return { ok: false, error: 'That file has no presentation inside it, so it is not a .pptx.' };
  }

  const sldSz = find(presentation, 'p:sldSz');
  const slideWidth = sldSz ? toPoints(numAttr(sldSz.attrs, 'cx', 9144000)) : 720;
  const slideHeight = sldSz ? toPoints(numAttr(sldSz.attrs, 'cy', 6858000)) : 540;

  // Presentation order comes from `<p:sldIdLst>` and its relationships, not
  // from the file names — a deck reordered in PowerPoint keeps its old names.
  const presentationRels = relationships(
    decode(entries['ppt/_rels/presentation.xml.rels']),
    'ppt'
  );

  const idList = find(presentation, 'p:sldIdLst');
  let slidePaths = idList
    ? findAll(idList.inner, 'p:sldId')
        .map((entry) => presentationRels.get(attr(entry.attrs, 'r:id') ?? ''))
        .filter((path): path is string => Boolean(path && entries[path]))
    : [];

  if (slidePaths.length === 0) {
    slidePaths = Object.keys(entries)
      .filter((key) => /^ppt\/slides\/slide\d+\.xml$/.test(key))
      .sort((a, b) => {
        const n = (key: string) => Number(/slide(\d+)\.xml$/.exec(key)?.[1] ?? 0);
        return n(a) - n(b);
      });
  }

  if (slidePaths.length === 0) {
    return { ok: false, error: 'This presentation has no slides in it.' };
  }

  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const painter = new TextPainter(doc);

  const embedded = new Map<string, PDFImage | null>();
  const embed = async (path: string): Promise<PDFImage | null> => {
    if (embedded.has(path)) return embedded.get(path) ?? null;

    const data = entries[path];
    let image: PDFImage | null = null;

    if (data) {
      try {
        if (/\.png$/i.test(path)) image = await doc.embedPng(data);
        else if (/\.jpe?g$/i.test(path)) image = await doc.embedJpg(data);
      } catch {
        image = null; // one damaged picture costs that picture only
      }
    }

    embedded.set(path, image);
    return image;
  };

  const counters: Counters = {
    images: 0,
    skippedImages: 0,
    tables: 0,
    charts: 0,
    rotatedText: 0,
  };
  let hidden = 0;

  for (const path of slidePaths) {
    const xml = decode(entries[path]);

    // A slide hidden in PowerPoint does not print, and should not convert —
    // it is content the author chose not to show.
    const root = find(xml, 'p:sld');
    if (root && attr(root.attrs, 'show') === '0') {
      hidden += 1;
      continue;
    }

    const rels = relationships(decode(entries[relsPathOf(path)]), dirOf(path));

    const layoutPath = [...rels.values()].find((target) => /slideLayouts\//.test(target));
    const layoutXml = layoutPath ? decode(entries[layoutPath]) : '';
    const layoutRels = layoutPath
      ? relationships(decode(entries[relsPathOf(layoutPath)]), dirOf(layoutPath))
      : new Map<string, string>();

    const masterPath = [...layoutRels.values()].find((target) => /slideMasters\//.test(target));
    const masterXml = masterPath ? decode(entries[masterPath]) : '';
    const masterRels = masterPath
      ? relationships(decode(entries[relsPathOf(masterPath)]), dirOf(masterPath))
      : new Map<string, string>();

    const themePath = [...masterRels.values()].find((target) => /theme\//.test(target));
    const theme = readTheme(themePath ? decode(entries[themePath]) : '');

    const placeholders = [readPlaceholders(layoutXml), readPlaceholders(masterXml)];
    const defaults = readTextStyles(masterXml);

    const page = doc.addPage([slideWidth, slideHeight]);

    // Background: the slide's own, else the layout's, else the master's, else
    // white — never transparent, which reads as grey in some viewers.
    const background =
      solidFill(find(xml, 'p:bg')?.inner ?? null, theme) ??
      solidFill(find(layoutXml, 'p:bg')?.inner ?? null, theme) ??
      solidFill(find(masterXml, 'p:bg')?.inner ?? null, theme) ??
      rgb(1, 1, 1);

    page.drawRectangle({ x: 0, y: 0, width: slideWidth, height: slideHeight, color: background });

    const tree = find(xml, 'p:spTree');
    if (!tree) continue;

    await drawTree(
      { page, slideHeight, fonts, painter, theme },
      tree.inner,
      IDENTITY,
      placeholders,
      defaults,
      rels,
      embed,
      counters
    );
  }

  if (doc.getPageCount() === 0) {
    return {
      ok: false,
      error: 'Every slide in this deck is hidden, so there was nothing to convert.',
    };
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  const pages = doc.getPageCount();

  const carried: string[] = [];
  if (counters.images > 0) carried.push(`${counters.images} image${counters.images === 1 ? '' : 's'}`);
  if (counters.tables > 0) carried.push(`${counters.tables} table${counters.tables === 1 ? '' : 's'}`);

  const dropped: string[] = [];
  if (counters.charts > 0) {
    dropped.push(`${counters.charts} chart${counters.charts === 1 ? '' : 's'}`);
  }
  if (findAll(presentation, 'p:custShowLst').length > 0) dropped.push('custom shows');
  if (counters.skippedImages > 0) {
    dropped.push(
      `${counters.skippedImages} image${counters.skippedImages === 1 ? '' : 's'} in a format PDF cannot embed`
    );
  }

  const notes = [
    `${pages} slide${pages === 1 ? '' : 's'} at ${Math.round(slideWidth)}×${Math.round(slideHeight)}pt, converted in this tab. The deck was never uploaded.`,
    `Positions, theme colours and template placeholders were all resolved from the file${carried.length > 0 ? `, and ${carried.join(' and ')} came across` : ''}.`,
  ];

  if (hidden > 0) {
    notes.push(
      `${hidden} hidden slide${hidden === 1 ? ' was' : 's were'} left out, the same as PowerPoint does when printing.`
    );
  }

  if (dropped.length > 0) {
    notes.push(`Not carried over: ${dropped.join(', ')}. Those are drawn geometry rather than text or pictures.`);
  }

  if (counters.rotatedText > 0) {
    notes.push(
      `${counters.rotatedText} rotated text box${counters.rotatedText === 1 ? ' was' : 'es were'} drawn upright.`
    );
  }

  const fallback = painter.note();
  if (fallback) notes.push(fallback);

  notes.push('Text is re-typeset in Helvetica, so a deck relying on a specific typeface will not match exactly.');

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages,
    durationMs: performance.now() - started,
    summary: `${pages} slide${pages === 1 ? '' : 's'}`,
    notes,
  };
}
