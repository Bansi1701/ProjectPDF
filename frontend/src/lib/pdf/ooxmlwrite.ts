/**
 * Writing OOXML — the mirror of ooxml.ts, which reads it.
 *
 * Going the other way (PDF → Word, PDF → Excel) is a different kind of hard.
 * Reading a malformed part costs you one wrong paragraph; writing one costs
 * you the whole file, because Word and Excel do not repair quietly — they
 * throw up a dialog that says the document is corrupt, and the user concludes
 * the tool is broken. Almost every one of those dialogs comes from something
 * dull: a `w:u` emitted before `w:sz`, a `w:tc` with no `w:p` inside it, a
 * stray 0x0B that came out of a PDF's text layer.
 *
 * So the point of this module is that no caller ever writes OOXML by hand.
 * Callers describe a document — paragraphs, runs, a grid table, a sheet of
 * typed cells — and the element order, the unit conversions and the character
 * sanitising happen here, once, in the place they can be got right.
 *
 * The models are deliberately small. They express what a PDF can honestly
 * give back: text with bold, italic and a size; a paragraph's alignment and
 * heading level; page geometry; page breaks; a plain grid of cells. Anything
 * richer — styles, numbering, floats, charts — would be a promise the
 * converter cannot keep.
 *
 * **Every measurement in these models is in POINTS**, the same unit
 * `readGeometry` in docx.ts produces and the same unit pdf-lib works in, so a
 * converter can pass geometry straight through. The conversion to Word's
 * twips (1/20 pt) and half-points happens at the writer boundary below and
 * nowhere else.
 */
import { strToU8, zipSync } from 'fflate';

// ── characters ──────────────────────────────────────────────────────────

/**
 * XML 1.0 §2.2 restricts which code points may appear in a document at all,
 * and a numeric character reference is not a way round it: `&#11;` is a second
 * parse error, not an escape for the first. These have to be dropped rather
 * than encoded, and one of them anywhere in the package is enough for Word to
 * refuse the whole file.
 *
 * Tab, LF and CR are the only control characters that survive. C1 controls
 * (U+007F–U+009F) are legal in XML 1.0 and are left alone.
 *
 * Lone surrogates are deliberately absent: without the `u` flag a
 * `[\uD800-\uDFFF]` class matches the halves of legitimate surrogate pairs and
 * would destroy every emoji and CJK-extension character. fflate's `strToU8`
 * already replaces an orphan with U+FFFD, which is a legal character.
 */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Legal XML, but it renders as a zero-width no-break space in the middle of a word. */
const BOM = /\uFEFF/g;

/**
 * Escapes text content, stripping what cannot be escaped.
 *
 * `&` goes first or the other replacements get double-escaped. `>` only has to
 * be escaped inside the sequence `]]>`, but `]]>` in text is a hard parse
 * error, so escaping it unconditionally makes the case disappear.
 *
 * Line endings are normalised because a raw CR is silently folded to LF by the
 * parser — `\r\n` in a `<w:t>` would come back as one break, not none and not
 * two, and that inconsistency is worse than picking one.
 */
export const escapeXml = (value: string): string =>
  value
    .replace(ILLEGAL_XML, '')
    .replace(BOM, '')
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Escapes an attribute value.
 *
 * Attribute-value normalisation turns a raw newline or tab into a space, so
 * anything that must survive has to be written as a character reference.
 */
export const escapeAttr = (value: string): string =>
  escapeXml(value).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

// ── units ───────────────────────────────────────────────────────────────

/**
 * Points → twips (a twentieth of a point), Word's unit for page size,
 * margins and table widths.
 *
 * The rounding is not cosmetic: `w:w` and friends are schema-typed as
 * integers, and a fractional one is a validation failure that triggers the
 * repair dialog.
 */
export const ptToTwips = (points: number): number => Math.round(points * 20);

/**
 * Points → half-points, which is what `w:sz` means. 11 pt is `22`, not `11`
 * and not `24`. Integer for the same reason as above.
 */
export const ptToHalfPoints = (points: number): number => Math.round(points * 2);

/** A4 and US Letter, portrait, in points — the two sizes a converter actually meets. */
export const A4_PORTRAIT = { width: 595.28, height: 841.89 } as const;
export const LETTER_PORTRAIT = { width: 612, height: 792 } as const;

/**
 * A fixed timestamp for every ZIP entry.
 *
 * DOS timestamps only span 1980–2107 so one has to be chosen anyway, and
 * pinning it makes the output byte-reproducible — which also means nothing
 * about the user's clock or machine ends up inside a file they may share.
 */
const ZIP_MTIME = new Date(Date.UTC(2001, 0, 1));

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Office packages contain no directory entries, so the keys must be flat paths. */
/**
 * Parts are XML unless they are bytes.
 *
 * Media parts have to skip both the XML declaration and the deflate: a PNG with
 * `<?xml ...?>` in front of it is not a PNG, and re-compressing an already
 * entropy-coded image costs time to make the file very slightly larger.
 */
const zipParts = (parts: Record<string, string | Uint8Array>): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([path, part]) =>
        typeof part === 'string'
          ? [path, [strToU8(`${DECLARATION}${part}`), { level: 6 }] as const]
          : [path, [part, { level: 0 }] as const]
      )
    ),
    { mtime: ZIP_MTIME }
  );

// ── the .docx model ─────────────────────────────────────────────────────

/** A stretch of text sharing one appearance. */
export interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Points. Omit to inherit the document default. */
  size?: number;
}

export type DocxAlign = 'left' | 'center' | 'right' | 'justify';

export interface DocxParagraph {
  type: 'paragraph';
  runs: DocxRun[];
  /**
   * 1–6 select Word's built-in Heading styles; 0 or omitted is body text.
   * These are real heading styles, so they populate the Navigation Pane and
   * survive a later export back to PDF as bookmarks.
   */
  heading?: number;
  align?: DocxAlign;
  /** Start this paragraph at the top of a fresh page. */
  pageBreakBefore?: boolean;
}

/** A table cell holds one paragraph's worth of runs — all a PDF grid can offer. */
export interface DocxTableCell {
  runs: DocxRun[];
}

export interface DocxTable {
  type: 'table';
  /** Ragged rows are padded with empty cells so the grid stays rectangular. */
  rows: DocxTableCell[][];
  /** Repeat the first row at the top of every page it continues onto. */
  headerRow?: boolean;
  /**
   * Relative column widths — any scale, they are normalised against the
   * usable page width. Defaults to equal columns.
   */
  columnWeights?: number[];
}

/**
 * A picture, sized in points and placed in the flow where it sat on the page.
 *
 * Inline rather than anchored: an anchored drawing needs its own wrap geometry
 * and behaves differently in every reader, while an inline drawing in a
 * paragraph of its own lands in reading order and survives editing. A PDF's
 * exact float is not recoverable anyway — what is recoverable is that the
 * picture came between these two paragraphs, and that is what this keeps.
 */
export interface DocxImage {
  type: 'image';
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  /** Points, as the picture was drawn on the PDF page. */
  width: number;
  height: number;
  align?: DocxAlign;
  /** Read by a screen reader, and shown if the picture will not load. */
  alt?: string;
}

export type DocxBlock = DocxParagraph | DocxTable | DocxImage;

/** Points to English Metric Units, the unit DrawingML measures in. */
export const ptToEmu = (points: number): number => Math.round(points * 12700);

/** Page geometry in points, matching the shape `readGeometry` in docx.ts returns. */
export interface DocxPage {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface DocxDocument {
  blocks: DocxBlock[];
  /** Defaults to A4 with one-inch margins. */
  page?: DocxPage;
  /** Body font name and size in points. Defaults to Calibri 11. */
  font?: string;
  size?: number;
}

const DEFAULT_PAGE: DocxPage = {
  width: A4_PORTRAIT.width,
  height: A4_PORTRAIT.height,
  margin: { top: 72, right: 72, bottom: 72, left: 72 },
};

/** Matches the scale docx.ts renders headings at, so a round trip looks the same. */
const HEADING_SIZE: readonly number[] = [22, 17, 14, 12.5, 11.5, 11];

/* DrawingML namespaces. Declared on w:document rather than per element, so a
   document with two hundred pictures does not repeat them two hundred times. */
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

// ── .docx writing ───────────────────────────────────────────────────────

/**
 * The inside of a `<w:r>`.
 *
 * A literal `\n` or `\t` inside `<w:t>` renders as a single space, and `\f` —
 * which docx.ts uses internally as its page-break marker — is not even a legal
 * XML character. All three have to become elements before any text reaches
 * `<w:t>`, which is why the run is split rather than escaped whole.
 */
function runContent(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n');
  let out = '';

  for (const piece of normalised.split(/(\f|\n|\t)/)) {
    if (piece === '') continue;
    if (piece === '\f') out += '<w:br w:type="page"/>';
    else if (piece === '\n') out += '<w:br/>';
    else if (piece === '\t') out += '<w:tab/>';
    // xml:space needs no declaration — the `xml:` prefix is bound by the XML
    // spec itself — and without it Word eats leading and trailing spaces, so
    // adjacent runs weld together.
    else out += `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`;
  }

  return out;
}

/**
 * One run.
 *
 * `EG_RPrBase` is a schema *sequence*, not a bag: `b`, `i`, then `sz`, then
 * `szCs`. Emitting them in any other order is the single most common cause of
 * Word's repair prompt. `szCs` is paired with `sz` because without it a
 * CJK or Arabic run renders at the default size while its Latin neighbours
 * scale.
 */
function runXml(run: DocxRun): string {
  const content = runContent(run.text);
  if (!content) return '';

  let props = '';
  if (run.bold) props += '<w:b/>';
  if (run.italic) props += '<w:i/>';
  if (typeof run.size === 'number' && Number.isFinite(run.size) && run.size > 0) {
    const half = ptToHalfPoints(run.size);
    props += `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
  }

  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${content}</w:r>`;
}

const JC: Record<DocxAlign, string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  // Word's name for justified is "both", as in "both edges".
  justify: 'both',
};

/**
 * One paragraph.
 *
 * `CT_PPr`'s sequence puts `pStyle` first, then `pageBreakBefore`, then `jc`.
 * `extra` carries table-cell tweaks that have to slot into the same order.
 */
function paragraphXml(para: DocxParagraph, extra = ''): string {
  let props = '';

  const heading = Math.round(para.heading ?? 0);
  if (heading >= 1 && heading <= 6) props += `<w:pStyle w:val="Heading${heading}"/>`;
  if (para.pageBreakBefore) props += '<w:pageBreakBefore/>';
  props += extra;
  if (para.align && para.align !== 'left') props += `<w:jc w:val="${JC[para.align]}"/>`;

  const runs = para.runs.map(runXml).join('');
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`;
}

const CELL_BORDER = 'w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"';

/**
 * Splits the usable width across columns so the parts sum to the whole.
 *
 * The last column absorbs the rounding remainder deliberately: Word wants the
 * `gridCol` widths to add up to `tblW` exactly, and dividing 9026 by three and
 * rounding each part does not.
 */
function columnWidths(count: number, usable: number, weights?: number[]): number[] {
  const clean =
    weights && weights.length === count
      ? weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 1))
      : new Array<number>(count).fill(1);

  const total = clean.reduce((sum, weight) => sum + weight, 0);
  const out: number[] = [];
  let used = 0;

  for (let i = 0; i < count - 1; i += 1) {
    const width = Math.max(1, Math.round((usable * clean[i]) / total));
    out.push(width);
    used += width;
  }
  out.push(Math.max(1, usable - used));

  return out;
}

function tableXml(table: DocxTable, usable: number): string {
  const columns = table.rows.reduce((most, row) => Math.max(most, row.length), 0);
  // A table with no cells is not a table; emitting <w:tbl> with no <w:tr>
  // would be a schema violation on its own.
  if (columns === 0) return '<w:p/>';

  const widths = columnWidths(columns, Math.max(columns, usable), table.columnWeights);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  // `w:gridCol` is only legal inside `w:tblGrid`, and CT_Tbl's sequence is
  // tblPr, then tblGrid, then the rows. Emitting the columns bare validates
  // nowhere and makes Word offer to repair the file — the exact failure this
  // module exists to avoid. Our own reader scans for gridCol at any depth, so a
  // round-trip through it cannot catch this; only the schema can.
  const grid =
    `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;

  // `w:tblPr` order: tblW, tblBorders, tblLayout, tblCellMar. `fixed` layout is
  // what makes Word honour these widths instead of autofitting over them.
  const props =
    `<w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/>` +
    `<w:tblBorders><w:top ${CELL_BORDER}/><w:left ${CELL_BORDER}/><w:bottom ${CELL_BORDER}/>` +
    `<w:right ${CELL_BORDER}/><w:insideH ${CELL_BORDER}/><w:insideV ${CELL_BORDER}/></w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:top w:w="43" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
    '<w:bottom w:w="43" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>';

  let rows = '';
  table.rows.forEach((row, rowIndex) => {
    const header = Boolean(table.headerRow) && rowIndex === 0;
    let cells = '';

    for (let column = 0; column < columns; column += 1) {
      const runs = row[column]?.runs ?? [];
      // `w:tcPr` order: tcW, then shd.
      const cellProps =
        `<w:tcPr><w:tcW w:w="${widths[column]}" w:type="dxa"/>` +
        (header ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>' : '') +
        '</w:tcPr>';

      // Every w:tc must contain at least one w:p. A cell holding only its
      // tcPr is the most reliable way to make Word declare a file unreadable.
      const paragraph = paragraphXml(
        { type: 'paragraph', runs: header ? runs.map((run) => ({ ...run, bold: true })) : runs },
        '<w:spacing w:after="0"/>'
      );

      cells += `<w:tc>${cellProps}${paragraph}</w:tc>`;
    }

    rows += `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
  });

  // A `w:tbl` may never be the last block in the body, and two adjacent
  // tables get merged into one. Both problems go away by always following a
  // table with an empty paragraph.
  return `<w:tbl>${props}${grid}${rows}</w:tbl><w:p/>`;
}

function sectPrXml(page: DocxPage): string {
  const width = ptToTwips(page.width);
  const height = ptToTwips(page.height);
  // Landscape needs the swapped dimensions *and* the attribute; the attribute
  // alone does nothing, and the swap alone prints on a portrait sheet.
  const orient = width > height ? ' w:orient="landscape"' : '';

  // `w:sectPr` order: pgSz before pgMar.
  return (
    `<w:sectPr><w:pgSz w:w="${width}" w:h="${height}"${orient}/>` +
    `<w:pgMar w:top="${ptToTwips(page.margin.top)}" w:right="${ptToTwips(page.margin.right)}" ` +
    `w:bottom="${ptToTwips(page.margin.bottom)}" w:left="${ptToTwips(page.margin.left)}" ` +
    'w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/>' +
    '<w:docGrid w:linePitch="360"/></w:sectPr>'
  );
}

/**
 * The styles part.
 *
 * A heading style latches onto Word's built-in via `<w:name w:val="heading 1"/>`
 * — lowercase, with a space — and not via its `w:styleId`. Get that wrong and
 * everything still renders, but the paragraph is not a heading as far as Word
 * is concerned: no Navigation Pane entry, no bookmark on a later PDF export,
 * and no error anywhere to tell you.
 *
 * `w:style` children are a sequence too: name, basedOn, next, uiPriority,
 * qFormat, then pPr, then rPr.
 */
function stylesXml(font: string, size: number): string {
  const body = ptToHalfPoints(size);
  const name = escapeAttr(font);

  let headings = '';
  for (let level = 1; level <= 6; level += 1) {
    const half = ptToHalfPoints(HEADING_SIZE[level - 1]);
    headings +=
      `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
      `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
      '<w:uiPriority w:val="9"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="120"/>' +
      // outlineLvl is 0-based and is what actually drives outline and TOC level.
      `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr></w:style>`;
  }

  return (
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}"/>` +
    `<w:sz w:val="${body}"/><w:szCs w:val="${body}"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr>' +
    '</w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont">' +
    '<w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
    '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>' +
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/>' +
    '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    headings +
    '</w:styles>'
  );
}

/**
 * Builds a .docx package.
 *
 * Five parts, which is the smallest set that still gets headings: the styles
 * part is located by *relationship*, not by filename, so shipping it without
 * `word/_rels/document.xml.rels` pointing at it fails silently — headings just
 * come out looking like body text and nothing complains.
 *
 * Deliberately absent: `docProps/core.xml` and `app.xml`. Nothing needs them,
 * and a part in the ZIP without a matching content type is an OPC violation
 * that *does* trigger the repair dialog — so the cheapest way not to get that
 * wrong is not to ship them.
 */
export function buildDocx(document: DocxDocument): Uint8Array {
  const page = document.page ?? DEFAULT_PAGE;
  const font = document.font ?? 'Calibri';
  const size = document.size ?? 11;

  const usable = ptToTwips(page.width - page.margin.left - page.margin.right);

  // Pictures become parts, so they are collected before the body is written.
  const media: { name: string; bytes: Uint8Array; mime: string }[] = [];
  const imageXml = (block: DocxImage): string => {
    const id = media.length + 1;
    const extension = block.mime === 'image/jpeg' ? 'jpeg' : 'png';
    media.push({ name: `image${id}.${extension}`, bytes: block.bytes, mime: block.mime });
    const relationship = `rIdImg${id}`;
    // Never wider than the text column: a picture drawn edge to edge on an A4
    // page is wider than A4 minus margins, and Word does not shrink it.
    const maxWidth = page.width - page.margin.left - page.margin.right;
    const scale = block.width > maxWidth ? maxWidth / block.width : 1;
    const cx = ptToEmu(block.width * scale);
    const cy = ptToEmu(block.height * scale);
    const alt = escapeAttr(block.alt ?? 'Picture from the PDF');
    return (
      `<w:p>${block.align && block.align !== 'left' ? `<w:pPr><w:jc w:val="${JC[block.align]}"/></w:pPr>` : ''}<w:r><w:drawing>` +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="${A_NS}"><a:graphicData uri="${PIC_NS}">` +
      `<pic:pic xmlns:pic="${PIC_NS}">` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    );
  };

  let body = '';
  for (const block of document.blocks) {
    body +=
      block.type === 'table'
        ? tableXml(block, usable)
        : block.type === 'image'
          ? imageXml(block)
          : paragraphXml(block);
  }
  // Word wants at least one block, and `w:sectPr` must be the last child of
  // `w:body` exactly once.
  if (!body) body = '<w:p/>';

  const documentXml =
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ` xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"><w:body>` +
    body +
    sectPrXml(page) +
    '</w:body></w:document>';

  return zipParts({
    // Convention, not a requirement — OPC has no mimetype entry and no
    // ordering rule; that trick belongs to ODF. But streaming readers prefer
    // finding the content types first.
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      // A part in the ZIP with no matching content type is the OPC violation
      // that triggers Word's repair dialog, so these track what was written.
      (media.some((m) => m.name.endsWith('.png')) ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      (media.some((m) => m.name.endsWith('.jpeg')) ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/_rels/document.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      media
        .map(
          (item, index) =>
            `<Relationship Id="rIdImg${index + 1}" Type="${R_NS}/image" Target="media/${item.name}"/>`
        )
        .join('') +
      '</Relationships>',
    'word/document.xml': documentXml,
    'word/styles.xml': stylesXml(font, size),
    ...Object.fromEntries(media.map((item) => [`word/media/${item.name}`, item.bytes])),
  });
}

// ── the .xlsx model ─────────────────────────────────────────────────────

/**
 * The number formats worth offering.
 *
 * All six map to Excel's built-in format ids, which means no `<numFmts>` part
 * of our own and no chance of tripping the rule that a custom id must be 164
 * or higher. They are also the ids numfmt.ts already recognises when reading,
 * so a workbook we write reads back the way it was written.
 */
export type XlsxNumberFormat = 'general' | 'integer' | 'thousands' | 'decimal' | 'percent' | 'date';

const NUMBER_FORMAT_ID: Record<XlsxNumberFormat, number> = {
  general: 0,
  integer: 1, // 0
  thousands: 3, // #,##0
  decimal: 4, // #,##0.00
  percent: 9, // 0%
  date: 14, // locale short date
};

/** `null` is an empty cell. A number is written as a number; everything else as text. */
export type XlsxCellValue = string | number | null;

export interface XlsxCell {
  value: XlsxCellValue;
  /** Bold on a light grey fill with a rule under it — for a header row. */
  header?: boolean;
  /** Numbers only; ignored on text. Dates are a serial number plus `'date'`. */
  format?: XlsxNumberFormat;
}

export interface XlsxSheet {
  /** Sanitised on the way in — Excel's rules on sheet names are strict and unforgiving. */
  name: string;
  /** Row 0 is the top row. Ragged rows are fine; trailing empties cost nothing. */
  rows: XlsxCell[][];
  /** Per-column widths in Excel's character units. Omit a column to leave it default. */
  columnWidths?: number[];
  /** Keep the first row visible while the rest scrolls. */
  freezeHeader?: boolean;
  landscape?: boolean;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
/** Excel's per-cell character limit; longer text is truncated rather than rejected. */
const MAX_CELL_TEXT = 32_767;

/** Zero-based column index → Excel's letters. 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let out = '';
  let value = index;
  while (value >= 0) {
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26) - 1;
  }
  return out;
}

/**
 * A JavaScript date → Excel's serial number, for use with the `'date'` format.
 *
 * The epoch is 1899-12-30, not the 1900-01-01 you would expect: Excel
 * reproduces Lotus 1-2-3's belief that 1900 was a leap year, and the epoch is
 * shifted back a day to absorb it.
 */
export function dateToSerial(date: Date): number {
  const epoch = Date.UTC(1899, 11, 30);
  const local = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((local - epoch) / 86_400_000);
}

/**
 * Excel rejects a workbook outright over a bad sheet name, so names are
 * repaired here rather than trusted: 1–31 characters, none of `: \ / ? * [ ]`,
 * no leading or trailing apostrophe, unique case-insensitively.
 *
 * `taken` carries the names already issued and gains this one, so the caller
 * passes the same set through a whole workbook.
 */
export function sanitizeSheetName(name: string, taken: Set<string>): string {
  let clean = name
    .replace(ILLEGAL_XML, '')
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();

  if (!clean) clean = 'Sheet';

  let candidate = clean;
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) {
    const tail = ` (${suffix})`;
    candidate = `${clean.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }

  taken.add(candidate.toLowerCase());
  return candidate;
}

// ── .xlsx writing ───────────────────────────────────────────────────────

/**
 * Cell text is written inline rather than through `xl/sharedStrings.xml`.
 *
 * Shared strings save bytes when text repeats, but they add a part, a pair of
 * `count`/`uniqueCount` totals to keep in step, and a cross-part invariant —
 * an index one past the end of the table is a repair prompt. Inline strings
 * have no invariant to break: the text sits in the cell that owns it. For the
 * few thousand cells a PDF table yields, that trade is the right way round,
 * and spreadsheet.ts reads `t="inlineStr"` already.
 */
function cellXml(reference: string, cell: XlsxCell, style: number): string {
  const attrs = `r="${reference}"${style ? ` s="${style}"` : ''}`;
  const value = cell.value;

  if (value === null || value === undefined || value === '') {
    // Worth keeping when it carries a style — an empty header cell should
    // still be part of the shaded band.
    return style ? `<c ${attrs}/>` : '';
  }

  if (typeof value === 'number') {
    // String(NaN) is "NaN" and String(1/0) is "Infinity"; both are illegal
    // inside <v> and both make Excel offer to repair the file. Surfacing the
    // error the way Excel itself would is more honest than dropping the cell.
    if (!Number.isFinite(value)) return `<c ${attrs} t="e"><v>#NUM!</v></c>`;
    return `<c ${attrs}><v>${value}</v></c>`;
  }

  const text = escapeXml(value.slice(0, MAX_CELL_TEXT));
  // An inline string lives in <is><t>, never in <v>.
  return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/**
 * The cell-format table.
 *
 * `cellXfs` is what a cell's `s=` indexes into, and an index past its end is a
 * repair prompt — so the entries are collected from the cells that actually
 * exist rather than guessed at. Index 0 is reserved for plain body text
 * because Excel treats it as the default.
 */
class StyleTable {
  private readonly index = new Map<string, number>([['0|0', 0]]);
  private readonly entries: Array<{ header: boolean; numFmtId: number }> = [
    { header: false, numFmtId: 0 },
  ];

  idFor(cell: XlsxCell): number {
    const header = Boolean(cell.header);
    // A format only means anything on a number; text ignores it.
    const numFmtId =
      typeof cell.value === 'number' ? NUMBER_FORMAT_ID[cell.format ?? 'general'] : 0;

    const key = `${header ? 1 : 0}|${numFmtId}`;
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;

    const id = this.entries.length;
    this.entries.push({ header, numFmtId });
    this.index.set(key, id);
    return id;
  }

  xml(): string {
    const xfs = this.entries
      .map((entry) => {
        const applyFormat = entry.numFmtId ? ' applyNumberFormat="1"' : '';
        const base = `numFmtId="${entry.numFmtId}" fontId="${entry.header ? 1 : 0}" fillId="${
          entry.header ? 2 : 0
        }" borderId="${entry.header ? 1 : 0}" xfId="0"${applyFormat}`;
        return entry.header
          ? `<xf ${base} applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">` +
              '<alignment vertical="center" wrapText="1"/></xf>'
          : `<xf ${base}/>`;
      })
      .join('');

    // The top-level collections are a strict sequence: numFmts, fonts, fills,
    // borders, cellStyleXfs, cellXfs, cellStyles, dxfs, tableStyles. There is
    // no numFmts here because every format used is a built-in id.
    //
    // `fills` must have at least two entries with index 0 `none` and index 1
    // `gray125`; Excel hardcodes that and renders every fill wrong without it.
    // Colours are rgb="AARRGGBB" — alpha first — which is what keeps the
    // theme part unnecessary.
    return (
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>' +
      '</fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.entries.length}">${xfs}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/>' +
      '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>'
    );
  }
}

function sheetXml(sheet: XlsxSheet, styles: StyleTable, first: boolean): string {
  let data = '';
  let maxColumn = 0;
  let maxRow = 0;

  // Rows and cells must both come out in strictly ascending order and each
  // cell reference must name its own row. Walking the arrays in index order is
  // what guarantees that; nothing here may sort or skip backwards.
  sheet.rows.forEach((row, rowIndex) => {
    let cells = '';

    row.forEach((cell, columnIndex) => {
      if (columnIndex >= MAX_COLUMNS) return;
      const xml = cellXml(`${columnName(columnIndex)}${rowIndex + 1}`, cell, styles.idFor(cell));
      if (!xml) return;
      cells += xml;
      if (columnIndex + 1 > maxColumn) maxColumn = columnIndex + 1;
    });

    // Rows need not be contiguous, so an empty one is simply left out.
    if (!cells) return;
    data += `<row r="${rowIndex + 1}">${cells}</row>`;
    maxRow = rowIndex + 1;
  });

  const dimension = maxRow > 0 ? `A1:${columnName(maxColumn - 1)}${maxRow}` : 'A1';

  const pane = sheet.freezeHeader
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    : '';

  let cols = '';
  (sheet.columnWidths ?? []).forEach((width, index) => {
    if (!Number.isFinite(width) || width <= 0 || index >= MAX_COLUMNS) return;
    const rounded = Math.round(width * 100) / 100;
    cols += `<col min="${index + 1}" max="${index + 1}" width="${rounded}" customWidth="1"/>`;
  });

  // `CT_Worksheet` is a strict sequence: dimension, sheetViews, sheetFormatPr,
  // cols, sheetData, then pageMargins before pageSetup. Out of order repairs.
  return (
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews><sheetView${first ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${data}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    `<pageSetup orientation="${sheet.landscape ? 'landscape' : 'portrait'}"/>` +
    '</worksheet>'
  );
}

/**
 * Builds a .xlsx package.
 *
 * Sheets are addressed only by `r:id`, so `xl/_rels/workbook.xml.rels` is not
 * optional the way it looks — without it Excel cannot find a single worksheet.
 * There is no theme part because every colour here is written as
 * `rgb="AARRGGBB"` rather than referring to a theme slot.
 *
 * Throws when a sheet is larger than Excel's grid; the message is written to
 * be shown to a user.
 */
export function buildXlsx(workbook: XlsxWorkbook): Uint8Array {
  const sheets = workbook.sheets.length > 0 ? workbook.sheets : [{ name: 'Sheet1', rows: [] }];

  for (const sheet of sheets) {
    if (sheet.rows.length > MAX_ROWS) {
      throw new Error(
        `A spreadsheet cannot hold more than ${MAX_ROWS.toLocaleString('en')} rows, and this one ` +
          `needs ${sheet.rows.length.toLocaleString('en')}. Split the source into smaller documents.`
      );
    }
    for (const row of sheet.rows) {
      if (row.length > MAX_COLUMNS) {
        throw new Error(
          `A spreadsheet cannot hold more than ${MAX_COLUMNS.toLocaleString('en')} columns, and ` +
            'this one needs more. The source has a wider table than Excel can represent.'
        );
      }
    }
  }

  const styles = new StyleTable();
  const taken = new Set<string>();
  const names = sheets.map((sheet) => sanitizeSheetName(sheet.name, taken));

  const parts: Record<string, string> = {};
  let overrides = '';
  let sheetEntries = '';
  let workbookRels = '';

  sheets.forEach((sheet, index) => {
    const number = index + 1;
    const path = `xl/worksheets/sheet${number}.xml`;

    parts[path] = sheetXml(sheet, styles, index === 0);
    overrides +=
      `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    sheetEntries += `<sheet name="${escapeAttr(names[index])}" sheetId="${number}" r:id="rId${number}"/>`;
    workbookRels +=
      `<Relationship Id="rId${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>`;
  });

  // Styles takes the next free id after the sheets have claimed rId1..rIdN.
  const stylesId = `rId${sheets.length + 1}`;

  return zipParts({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      overrides +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    // SpreadsheetML elements are unprefixed — the opposite of WordprocessingML
    // — but `xmlns:r` still has to be declared or `r:id` is an undeclared
    // prefix and the file will not parse at all.
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr/>' +
      `<sheets>${sheetEntries}</sheets>` +
      '</workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      workbookRels +
      `<Relationship Id="${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
    ...parts,
    'xl/styles.xml': styles.xml(),
  });
}
