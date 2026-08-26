/**
 * Metadata — what a PDF says about itself, and how to change it.
 *
 * Almost nobody knows what their documents are carrying. A PDF exported from
 * Word names the machine's registered owner. One exported from InDesign names
 * the operator and the workstation. A scan names the model of the scanner. None
 * of it is visible on any page, all of it is one right-click away, and it is
 * routinely the thing that identifies the sender of a document that was meant to
 * be anonymous.
 *
 * So this tool reads first and edits second, because the reading is the part
 * people have never been shown.
 *
 * There are two places the answers live, and that is the whole difficulty:
 *
 *   1. The **document information dictionary** — the trailer's /Info, holding
 *      Title, Author, Subject, Keywords, Creator, Producer, CreationDate and
 *      ModDate. This is what a viewer's Properties panel shows, and it is what
 *      every "remove metadata" feature clears.
 *
 *   2. The **XMP packet** — an RDF/XML document parked in the catalog's
 *      /Metadata stream, and sometimes on individual pages and images too.
 *      Adobe's tools write the author's name into both places and then read it
 *      back from XMP in preference to /Info.
 *
 * Which means clearing /Info alone produces a file whose Properties panel is
 * blank and whose XMP still says who made it, when, and with which serial-
 * numbered copy of which application. That file looks clean and is not, and
 * that gap is exactly what this module exists to close and to show.
 *
 * The other trap is pdf-lib's, and lossless.ts already paid for it: pdf-lib
 * does not garbage-collect. Deleting a dictionary entry unlinks the reference
 * and leaves the object sitting in the output, fully recoverable by anyone who
 * opens the file in a text editor. Every removal here deletes the entry AND the
 * object, and then the result is re-opened and searched to prove it.
 *
 * What this deliberately does not touch: annotations, form-field values,
 * embedded file attachments and digital signatures can all carry names, and all
 * of them are content rather than metadata. They are named in the report so
 * nobody assumes otherwise, but removing them belongs to other tools.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

import type { InputFile, OpFailure, OpResult } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

// ─────────────────────────────────────────────────────────────────────────────
// PDF date strings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A PDF date is `D:YYYYMMDDHHmmSSOHH'mm'` — ISO 32000-1, 7.9.4.
 *
 * Everything after the year is optional, the `D:` prefix is required by the
 * spec and omitted by plenty of producers anyway, and the trailing apostrophe
 * after the minutes was mandatory in PDF 1.7 and dropped in PDF 2.0, so both
 * forms are in circulation. The offset marker can be `+`, `-` or `Z`.
 *
 * A date read out of a real file is therefore matched leniently and written
 * back strictly.
 */
const PDF_DATE =
  /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z|[+-])(\d{2})?'?(\d{2})?'?)?/;

/** An `<input type="datetime-local">` value, or anything close enough to one. */
const ISO_DATE =
  /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/;

/** A wall-clock reading, plus the zone it was read in — if the file said. */
export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Minutes east of UTC. Null means the document did not record a zone. */
  offsetMinutes: number | null;
}

export interface PdfDate {
  /** Exactly the characters stored in the file, so nothing is hidden. */
  raw: string;
  /** Null when the string is not a PDF date at all — some producers write junk. */
  parts: DateParts | null;
  /**
   * ISO 8601. Carries an offset only when the document recorded one; otherwise
   * it is a floating local time, which is genuinely all the file knows.
   */
  iso: string | null;
  /** For reading aloud, in the document's own zone rather than the reader's. */
  display: string | null;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function validParts(parts: DateParts): boolean {
  if (parts.year < 1 || parts.year > 9999) return false;
  if (parts.month < 1 || parts.month > 12) return false;
  // The generous upper bound is intentional: rejecting 31 February would mean
  // refusing to *show* a date that is genuinely in someone's file.
  if (parts.day < 1 || parts.day > 31) return false;
  if (parts.hour > 23 || parts.minute > 59) return false;
  // 60 is a leap second, and a few producers do emit it.
  return parts.second <= 60;
}

function formatOffset(offsetMinutes: number | null, separator: string): string {
  if (offsetMinutes === null) return '';
  if (offsetMinutes === 0) return separator === ':' ? 'Z' : 'Z';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const total = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(total / 60))}${separator}${pad(total % 60)}`;
}

function describe(parts: DateParts): string {
  const clock = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  const month = MONTHS[parts.month - 1] ?? pad(parts.month);
  const stamp = `${parts.day} ${month} ${parts.year}, ${clock}`;

  // Deliberately not converted into the reader's time zone. The question this
  // tool answers is "what does my file say", and shifting the clock to wherever
  // the browser happens to be would answer a different one.
  if (parts.offsetMinutes === null) return `${stamp} (no time zone recorded)`;
  if (parts.offsetMinutes === 0) return `${stamp} UTC`;

  const sign = parts.offsetMinutes < 0 ? '-' : '+';
  const total = Math.abs(parts.offsetMinutes);
  return `${stamp} UTC${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function toIso(parts: DateParts): string {
  const stamp =
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return stamp + formatOffset(parts.offsetMinutes, ':');
}

/** Reads a stored PDF date string. Never throws — an unreadable date is data too. */
export function parsePdfDate(raw: string): PdfDate {
  const match = PDF_DATE.exec(raw);
  if (!match) return { raw, parts: null, iso: null, display: null };

  const [, year, month, day, hour, minute, second, marker, offsetHours, offsetMinutes] = match;

  let offset: number | null = null;
  if (marker === 'Z') {
    offset = 0;
  } else if (marker === '+' || marker === '-') {
    const magnitude = Number(offsetHours ?? '0') * 60 + Number(offsetMinutes ?? '0');
    offset = marker === '-' ? -magnitude : magnitude;
  }

  const parts: DateParts = {
    year: Number(year),
    // A bare `D:2024` means the first instant of 2024; the spec says the
    // omitted fields default to their lowest value, not to "unknown".
    month: Number(month ?? '1'),
    day: Number(day ?? '1'),
    hour: Number(hour ?? '0'),
    minute: Number(minute ?? '0'),
    second: Number(second ?? '0'),
    offsetMinutes: offset,
  };

  if (!validParts(parts)) return { raw, parts: null, iso: null, display: null };

  return { raw, parts, iso: toIso(parts), display: describe(parts) };
}

/**
 * Accepts what a date input produces, or a PDF date string pasted back in.
 * Returns null rather than guessing, so a typo becomes a message and not a
 * silently wrong timestamp in someone's file.
 */
export function parseDateInput(input: string): DateParts | null {
  const text = input.trim();
  if (!text) return null;

  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute, second, zone] = iso;

    let offset: number | null = null;
    if (zone === 'Z') {
      offset = 0;
    } else if (zone) {
      const sign = zone.startsWith('-') ? -1 : 1;
      const digits = zone.slice(1).replace(':', '');
      offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }

    const parts: DateParts = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour ?? '0'),
      minute: Number(minute ?? '0'),
      second: Number(second ?? '0'),
      offsetMinutes: offset,
    };
    return validParts(parts) ? parts : null;
  }

  return parsePdfDate(text).parts;
}

/**
 * Writes the strict form: `D:YYYYMMDDHHmmSS` with the offset only when there
 * is one to write.
 *
 * pdf-lib's own `setCreationDate` goes through `PDFString.fromDate`, which
 * converts to UTC and appends `Z`. That is well-formed and it throws away what
 * the document said — a file created at 09:00 in Berlin comes back claiming
 * 07:00, which is the same instant and a different fact. Dates are therefore
 * written into /Info by hand here.
 *
 * When the caller gives no offset none is written. A PDF date is allowed to
 * omit it, and inventing one from `getTimezoneOffset()` would stamp the user's
 * time zone into a file they are editing precisely to make it say less.
 */
export function formatPdfDate(parts: DateParts): string {
  const stamp =
    `D:${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}` +
    `${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;

  if (parts.offsetMinutes === null) return stamp;
  if (parts.offsetMinutes === 0) return `${stamp}Z`;

  const sign = parts.offsetMinutes < 0 ? '-' : '+';
  const total = Math.abs(parts.offsetMinutes);
  return `${stamp}${sign}${pad(Math.floor(total / 60))}'${pad(total % 60)}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

/** The eight the spec names, plus /Trapped. Anything else in /Info is custom. */
const STANDARD_INFO_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
] as const;

/** One name/value pair out of the XMP packet, prefix included. */
export interface XmpField {
  /** Qualified name as written, e.g. `dc:creator`. */
  field: string;
  value: string;
}

export interface XmpReport {
  present: boolean;
  /** Size of the packet as stored, decompressed. */
  bytes: number;
  /** Namespace URIs declared in the packet — the schemas in play. */
  schemas: { prefix: string; uri: string }[];
  fields: XmpField[];
  /**
   * The point of the whole exercise: fields the XMP still answers that /Info
   * does not. On a document whose properties were "cleared", this is the list
   * of things that survived.
   */
  outlivesInfo: XmpField[];
  /** The packet itself, truncated, for anyone who wants to read it. */
  preview: string;
  /** True when `preview` is shorter than the real packet. */
  truncated: boolean;
}

export interface MetadataReport {
  pages: number;
  /** '' when the entry is absent — an absent Title and an empty one look alike. */
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: PdfDate | null;
  modDate: PdfDate | null;
  /** /Info entries outside the standard set. Word writes /Company here. */
  custom: { key: string; value: string }[];
  /** True when the trailer has no /Info at all, as opposed to an empty one. */
  infoDictAbsent: boolean;
  xmp: XmpReport;
  /** XMP packets hanging off pages, images and fonts rather than the catalog. */
  extraPackets: number;
  /**
   * First element of the trailer /ID, hex. It is meant to stay constant for the
   * life of a document, which makes it a reliable way to prove two files came
   * from the same original.
   */
  fileId: string | null;
  /** Pages or the catalog carrying /PieceInfo — private authoring-tool data. */
  pieceInfoObjects: number;
  /** Things that can carry a name but are content, not metadata. */
  alsoPresent: string[];
  notes: string[];
}

export type MetadataReadResult = ({ ok: true } & MetadataReport) | OpFailure;

function readFailure(error: unknown): OpFailure {
  const message = (error as Error).message;
  return {
    ok: false,
    error: message.toLowerCase().includes('encrypt')
      ? 'This PDF is password-protected. Unlock it first, then come back.'
      : `This file could not be read as a PDF: ${message}`,
  };
}

const load = (bytes: ArrayBuffer | Uint8Array): Promise<PDFDocument> =>
  // Never `updateMetadata: true`. The default stamps a fresh ModDate and
  // Producer on save, which on a metadata tool would mean the act of looking
  // changed the answer.
  PDFDocument.load(bytes, { updateMetadata: false });

function infoDict(doc: PDFDocument): PDFDict | undefined {
  return doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
}

/** /Info values are PDFDocEncoded or UTF-16 strings; both know how to decode. */
function textOf(dict: PDFDict | undefined, key: string): string {
  if (!dict) return '';
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFName) return value.decodeText();
  return '';
}

function dateOf(dict: PDFDict | undefined, key: string): PdfDate | null {
  const raw = textOf(dict, key);
  return raw ? parsePdfDate(raw) : null;
}

/** Decoded bytes of a stream, filters applied. Undefined when it will not decode. */
function streamBytes(stream: PDFStream): Uint8Array | undefined {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    return stream.getContents();
  } catch {
    return undefined;
  }
}

/**
 * XMP is UTF-8 in practice and permitted to be UTF-16; the packet header's
 * `begin` attribute carries a byte-order mark that says which.
 */
function decodeXmp(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return XML_ENTITIES[body] ?? whole;
  });
}

/** Prefixes that describe the XML rather than the document. */
const STRUCTURAL_PREFIXES = new Set(['rdf', 'x', 'xml', 'xmlns']);

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Pulls name/value pairs out of an XMP packet with regular expressions.
 *
 * This is not an RDF parser and does not pretend to be one. XMP allows the same
 * property to be written as a child element, as an attribute on
 * `rdf:Description`, or as a language alternative wrapped in `rdf:Alt` — three
 * spellings of one fact, and different producers pick differently, so all three
 * are matched. Deeply structured values (`xmpMM:History`, `xmpTPg:Fonts`) are
 * left as their inner attributes rather than reconstructed.
 *
 * A real parser would be better and would cost a dependency and a lot of code
 * to answer a question that is, in the end, "does this file still have my name
 * in it". A missed field would understate the report, so the report says so.
 */
export function extractXmpFields(packet: string): {
  fields: XmpField[];
  schemas: { prefix: string; uri: string }[];
} {
  const found = new Map<string, string>();
  const schemas = new Map<string, string>();

  // Attribute values are quoted with either mark: Adobe writes `"`, ExifTool
  // writes `'`, and a pattern that assumes double quotes finds nothing at all
  // in half the files people actually own.
  for (const match of packet.matchAll(/xmlns:([\w.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    const [, prefix, , uri] = match;
    if (prefix && uri) schemas.set(prefix, uri);
  }

  const remember = (field: string, value: string): void => {
    const clean = collapse(unescapeXml(value));
    if (!clean) return;
    const existing = found.get(field);
    if (existing === undefined) found.set(field, clean);
    else if (!existing.includes(clean)) found.set(field, `${existing}, ${clean}`);
  };

  /**
   * Element form, walked one opening tag at a time.
   *
   * The obvious pattern — match `<p:n ...>body</p:n>` globally — is wrong on
   * every real packet, and quietly so. The first thing it matches is the
   * outermost `<x:xmpmeta>`, whose body is the entire document; the scan
   * position lands past the closing tag and every property inside is never
   * looked at. It reports a packet with zero fields, which reads exactly like a
   * clean file. So the cursor is advanced past the opening tag only, and the
   * closing tag is found by search — nested elements are then visited too.
   */
  const OPEN_TAG = /<([\w.-]+):([\w.-]+)((?:\s[^>]*?)?)(\/?)>/g;
  let tag: RegExpExecArray | null;

  while ((tag = OPEN_TAG.exec(packet)) !== null) {
    const [, prefix, local, , selfClosing] = tag;
    if (!prefix || !local) continue;
    // A self-closing element has no body; its attributes are swept below.
    if (selfClosing === '/') continue;
    if (STRUCTURAL_PREFIXES.has(prefix)) continue;

    const closing = `</${prefix}:${local}>`;
    const start = tag.index + tag[0].length;
    const end = packet.indexOf(closing, start);
    if (end === -1) continue;

    const field = `${prefix}:${local}`;
    const body = packet.slice(start, end);

    if (body.includes('<rdf:li')) {
      for (const item of body.matchAll(/<rdf:li(?:\s[^>]*?)?>([\s\S]*?)<\/rdf:li>/g)) {
        remember(field, item[1] ?? '');
      }
      continue;
    }

    // Anything else containing markup is a structure, not a value; its own
    // attributes get picked up by the sweep below.
    if (body.includes('<')) continue;
    remember(field, body);
  }

  // Attribute form. Also catches stEvt:softwareAgent inside a history entry and
  // stRef:documentID inside a derived-from block, which are the two structured
  // values most worth surfacing.
  for (const match of packet.matchAll(/(?:^|[\s<])([\w.-]+):([\w.-]+)\s*=\s*(["'])([\s\S]*?)\3/g)) {
    const [, prefix, local, , value] = match;
    if (!prefix || !local || value === undefined) continue;
    if (STRUCTURAL_PREFIXES.has(prefix)) continue;
    remember(`${prefix}:${local}`, value);
  }

  return {
    fields: [...found].map(([field, value]) => ({ field, value })),
    schemas: [...schemas].map(([prefix, uri]) => ({ prefix, uri })),
  };
}

/**
 * XMP property ↔ /Info entry, for the fields that genuinely mean the same
 * thing. Used only to work out what XMP is still saying after /Info went quiet.
 */
const XMP_TO_INFO: Record<string, keyof MetadataReport> = {
  'dc:title': 'title',
  'dc:creator': 'author',
  'dc:description': 'subject',
  'dc:subject': 'keywords',
  'pdf:Keywords': 'keywords',
  'xmp:CreatorTool': 'creator',
  'pdf:Producer': 'producer',
};

const XMP_PREVIEW_LIMIT = 8000;

/**
 * Ceiling on how much of a packet is scanned.
 *
 * Finding each element's closing tag is a search, so a pathological packet is
 * quadratic. Real ones are a few kilobytes; a megabyte is already far past
 * anything legitimate, and the alternative to a cap is a locked-up worker.
 */
const XMP_PARSE_LIMIT = 1_000_000;

const EMPTY_XMP: XmpReport = {
  present: false,
  bytes: 0,
  schemas: [],
  fields: [],
  outlivesInfo: [],
  preview: '',
  truncated: false,
};

/** True for the dictionaries an XMP packet lives in. */
const isMetadataStream = (obj: unknown): obj is PDFStream =>
  obj instanceof PDFStream && obj.dict.lookup(PDFName.of('Type')) === PDFName.of('Metadata');

/** How many XMP packets the document still holds, wherever they are attached. */
function countPackets(doc: PDFDocument): number {
  let total = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (holdsXmp(obj)) total += 1;
  }
  return total;
}

/** Image filters. A stream carrying one of these is pixels, never a packet. */
const PIXEL_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);

/** Largest stream worth inflating on the chance it is XMP. Real packets are kilobytes. */
const SNIFF_LIMIT = 1_000_000;

/**
 * Could this stream be an XMP packet that forgot to say so?
 *
 * The sniff exists for packets with no `/Type /Metadata` to identify them, and
 * it costs an inflate. Doing that to every stream in the file means inflating
 * every image in a scanned document to discover it is a JPEG — so the cheap
 * dictionary checks come first, and only what survives them is decoded.
 */
function mightBeXmp(stream: PDFStream): boolean {
  const dict = stream.dict;

  if (dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) return false;

  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName && PIXEL_FILTERS.has(filter.decodeText())) return false;
  if (filter instanceof PDFArray) {
    for (let i = 0; i < filter.size(); i += 1) {
      const entry = filter.lookup(i);
      if (entry instanceof PDFName && PIXEL_FILTERS.has(entry.decodeText())) return false;
    }
  }

  const length = dict.lookup(PDFName.of('Length'));
  if (length instanceof PDFNumber && length.asNumber() > SNIFF_LIMIT) return false;

  const bytes = streamBytes(stream);
  if (!bytes || bytes.length === 0 || bytes.length > SNIFF_LIMIT) return false;

  const head = decodeXmp(bytes.subarray(0, Math.min(bytes.length, 4096)));
  return head.includes('xpacket') || head.includes('xmpmeta') || head.includes('<rdf:RDF');
}

/** True for anything that holds a packet, however it is labelled. */
const holdsXmp = (obj: unknown): boolean =>
  isMetadataStream(obj) || (obj instanceof PDFStream && mightBeXmp(obj));

/**
 * A leftover /Info dictionary — one the trailer no longer points at, left over
 * from an earlier edit by some other tool. pdf-lib writes every object it holds,
 * referenced or not, so an orphan like this is copied faithfully into the output
 * and stays readable in a text editor.
 *
 * Identified conservatively: no /Type, /Subtype or /S to say it is something
 * else, and at least two of the fields only an /Info dictionary carries
 * together. One key alone is too weak a signal to justify deleting an object
 * whose purpose we have not established.
 *
 * Used both to sweep and to verify, so the two can never disagree about what
 * counts as gone.
 */
function looksLikeInfoDict(obj: unknown): obj is PDFDict {
  if (!(obj instanceof PDFDict)) return false;
  if (obj instanceof PDFStream) return false;
  for (const key of ['Type', 'Subtype', 'S', 'Kids', 'Contents', 'Length']) {
    if (obj.has(PDFName.of(key))) return false;
  }

  const matched = STANDARD_INFO_KEYS.filter((key) => obj.has(PDFName.of(key))).length;
  return matched >= 2;
}

/** Reads everything, changes nothing. */
export async function readMetadata(files: InputFile[]): Promise<MetadataReadResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to inspect.' };

  let doc: PDFDocument;
  try {
    doc = await load(file.bytes);
  } catch (error) {
    return readFailure(error);
  }

  const info = infoDict(doc);
  const standard = new Set<string>(STANDARD_INFO_KEYS);

  const custom: { key: string; value: string }[] = [];
  if (info) {
    for (const [name] of info.entries()) {
      const key = name.decodeText();
      if (standard.has(key)) continue;
      const value = textOf(info, key);
      if (value) custom.push({ key, value });
    }
  }

  // --- XMP, wherever it is hiding ----------------------------------------
  const catalogMetadata = doc.catalog.lookup(PDFName.of('Metadata'));
  let xmp: XmpReport = EMPTY_XMP;

  if (catalogMetadata instanceof PDFStream) {
    const bytes = streamBytes(catalogMetadata);
    if (bytes && bytes.length > 0) {
      const packet = decodeXmp(bytes);
      const { fields, schemas } = extractXmpFields(packet.slice(0, XMP_PARSE_LIMIT));
      xmp = {
        present: true,
        bytes: bytes.length,
        schemas,
        fields,
        outlivesInfo: [],
        preview: packet.slice(0, XMP_PREVIEW_LIMIT),
        truncated: packet.length > XMP_PREVIEW_LIMIT,
      };
    }
  }

  // Packets attached to something other than the catalog. Photoshop puts one on
  // every placed image, and those survive a catalog-only strip.
  let extraPackets = 0;
  let pieceInfoObjects = 0;

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj === catalogMetadata) continue;
    if (holdsXmp(obj)) extraPackets += 1;
    // The catalog is an indirect object like any other, so it is counted here
    // and must not be counted again afterwards.
    if (obj instanceof PDFDict && obj.has(PDFName.of('PieceInfo'))) pieceInfoObjects += 1;
  }

  const report: MetadataReport = {
    pages: doc.getPageCount(),
    title: textOf(info, 'Title'),
    author: textOf(info, 'Author'),
    subject: textOf(info, 'Subject'),
    keywords: textOf(info, 'Keywords'),
    creator: textOf(info, 'Creator'),
    producer: textOf(info, 'Producer'),
    creationDate: dateOf(info, 'CreationDate'),
    modDate: dateOf(info, 'ModDate'),
    custom,
    infoDictAbsent: info === undefined,
    xmp,
    extraPackets,
    fileId: fileIdOf(doc),
    pieceInfoObjects,
    alsoPresent: [],
    notes: [],
  };

  // The comparison the tool exists for. Done after the report is assembled
  // because it reads /Info values back out of it.
  report.xmp = {
    ...xmp,
    outlivesInfo: xmp.fields.filter((entry) => {
      const key = XMP_TO_INFO[entry.field];
      if (!key) return false;
      const counterpart = report[key];
      return typeof counterpart === 'string' && counterpart.trim() === '';
    }),
  };

  report.alsoPresent = describeOtherCarriers(doc);
  report.notes = describeReport(report);

  return { ok: true, ...report };
}

function fileIdOf(doc: PDFDocument): string | null {
  const id = doc.context.lookupMaybe(doc.context.trailerInfo.ID, PDFArray);
  if (!id || id.size() === 0) return null;
  const first = id.get(0);
  // asString(), not decodeText(): this is a hash, not language, and showing the
  // hex is the only form anyone can compare against another copy.
  if (first instanceof PDFHexString || first instanceof PDFString) return first.asString();
  return null;
}

/** Names the places a document can keep a name that this tool will not touch. */
function describeOtherCarriers(doc: PDFDocument): string[] {
  const present: string[] = [];
  const catalog = doc.catalog;

  const names = doc.context.lookupMaybe(catalog.get(PDFName.of('Names')), PDFDict);
  if (names?.has(PDFName.of('EmbeddedFiles'))) present.push('file attachments');
  if (names?.has(PDFName.of('JavaScript'))) present.push('JavaScript actions');

  const acroForm = doc.context.lookupMaybe(catalog.get(PDFName.of('AcroForm')), PDFDict);
  if (acroForm) {
    present.push(
      acroForm.has(PDFName.of('SigFlags')) ? 'a form with signature fields' : 'form fields'
    );
  }

  let annotated = false;
  for (const page of doc.getPages()) {
    if (page.node.has(PDFName.of('Annots'))) {
      annotated = true;
      break;
    }
  }
  if (annotated) present.push('annotations or comments');

  return present;
}

/** The report in words. Written to be read by someone who did not ask for jargon. */
function describeReport(report: MetadataReport): string[] {
  const notes: string[] = [];

  const named = (
    [
      ['Author', report.author],
      ['Creator', report.creator],
      ['Producer', report.producer],
    ] as const
  ).filter(([, value]) => value.trim() !== '');

  if (named.length > 0) {
    notes.push(
      `The document properties name ${named.map(([label, value]) => `${label} “${value}”`).join(', ')}. None of this appears on any page.`
    );
  } else if (report.infoDictAbsent) {
    notes.push('There is no document information dictionary at all — nothing to clear there.');
  } else {
    notes.push('The document properties are empty or name nobody.');
  }

  if (report.custom.length > 0) {
    notes.push(
      `Also in the properties, outside the standard fields: ${report.custom.map((entry) => entry.key).join(', ')}. Word writes Company here; other tools write worse.`
    );
  }

  if (report.xmp.present) {
    const schemas = report.xmp.schemas.map((entry) => entry.prefix).join(', ');
    notes.push(
      `An XMP packet of ${report.xmp.bytes.toLocaleString()} bytes is attached to the document, carrying ${report.xmp.fields.length} field${report.xmp.fields.length === 1 ? '' : 's'}${schemas ? ` across ${schemas}` : ''}.`
    );

    if (report.xmp.outlivesInfo.length > 0) {
      notes.push(
        `${report.xmp.outlivesInfo.length} of those answer${report.xmp.outlivesInfo.length === 1 ? 's' : ''} a question the document properties left blank — ${report.xmp.outlivesInfo.map((entry) => entry.field).join(', ')}. This is what survives a tool that only clears the properties panel.`
      );
    }
  } else {
    notes.push('No XMP packet is attached to the document.');
  }

  if (report.extraPackets > 0) {
    notes.push(
      `${report.extraPackets} further metadata packet${report.extraPackets === 1 ? ' is' : 's are'} attached to individual pages or images rather than to the document. Image editors leave these behind, and a catalog-only clean misses them.`
    );
  }

  if (report.pieceInfoObjects > 0) {
    notes.push(
      `${report.pieceInfoObjects} object${report.pieceInfoObjects === 1 ? '' : 's'} carr${report.pieceInfoObjects === 1 ? 'ies' : 'y'} private authoring-tool data (/PieceInfo). Nothing displays it and there is no way to know what is in it.`
    );
  }

  if (report.fileId) {
    notes.push(
      'The file carries a permanent identifier in its trailer. It is meant to stay the same across every revision, which makes it a way to prove that two copies came from one original.'
    );
  }

  if (report.alsoPresent.length > 0) {
    notes.push(
      `This document also contains ${report.alsoPresent.join(', ')}. Those can carry names too, and they are content rather than metadata — clearing metadata does not touch them.`
    );
  }

  notes.push(
    'The XMP packet is read with pattern matching rather than a full RDF parser, so an unusually structured packet could hold a field this list does not show. What is listed is really there; the list may be short.'
  );

  return notes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fields to set. An omitted key is left alone; an empty string clears the
 * entry, which is the distinction a form needs and `undefined` alone cannot
 * express.
 */
export interface MetadataFields {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO 8601, a `datetime-local` value, or a raw `D:...` string. '' clears. */
  creationDate?: string;
  modDate?: string;
}

export interface MetadataChanges {
  /**
   * Remove everything rather than set anything: the whole /Info dictionary, the
   * XMP packet and every other packet in the file, /PieceInfo, and the trailer
   * identifier. `fields` is ignored when this is true.
   */
  strip?: boolean;
  fields?: MetadataFields;
  /**
   * Keep the XMP packet when setting fields. Off by default, and the default is
   * the honest one — see `writeMetadata`.
   */
  keepXmp?: boolean;
}

/**
 * Deletes a dictionary entry AND the object behind it.
 *
 * The lesson lossless.ts records: pdf-lib does not garbage-collect, so removing
 * the reference leaves the XMP packet in the output — unreachable from the
 * catalog, plainly visible in a text editor, and still an answer to "who wrote
 * this". Deleting the entry alone is the difference between removing something
 * and appearing to.
 *
 * Only safe for keys whose target is never shared, which /Metadata and
 * /PieceInfo are not.
 */
function purgeEntry(
  doc: PDFDocument,
  dict: PDFDict,
  key: string
): { hit: boolean; ref: PDFRef | null } {
  const name = PDFName.of(key);
  if (!dict.has(name)) return { hit: false, ref: null };

  const target = dict.get(name);
  dict.delete(name);
  if (target instanceof PDFRef) {
    doc.context.delete(target);
    return { hit: true, ref: target };
  }
  return { hit: true, ref: null };
}

/**
 * Counts each object once however many times we reach it.
 *
 * The sweep walks a snapshot of the indirect objects, so a stream unlinked and
 * deleted before the walk begins is still in that list and gets counted a
 * second time — which turned one XMP packet into "2 XMP packets removed" in the
 * receipt. Overstating a removal is the same class of bug as understating one.
 */
class RemovalTally {
  private readonly seen = new Set<string>();

  count = 0;

  add(ref: unknown): void {
    const key = ref instanceof PDFRef ? ref.toString() : null;
    if (key !== null) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.count += 1;
  }
}

interface StripTally {
  infoCleared: boolean;
  packets: number;
  pieceInfo: number;
  fileIdReplaced: boolean;
}

/** A fresh trailer identifier, so the stripped copy is not traceable to the original. */
function newFileId(): PDFHexString {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return PDFHexString.fromBytes(bytes);
}

function stripEverything(doc: PDFDocument): StripTally {
  const packets = new RemovalTally();
  const pieceInfo = new RemovalTally();

  // --- the information dictionary ----------------------------------------
  const infoRef = doc.context.trailerInfo.Info;
  const info = infoDict(doc);
  let infoCleared = false;

  if (info) {
    // Emptied as well as unlinked: if some other reference to this dictionary
    // exists anywhere in the file, the values must not survive through it.
    for (const [name] of [...info.entries()]) info.delete(name);
    infoCleared = true;
  }
  doc.context.trailerInfo.Info = undefined;
  if (infoRef instanceof PDFRef) doc.context.delete(infoRef);

  // --- every metadata packet, not just the catalog's ----------------------
  // A snapshot, because objects are being deleted as we walk.
  const objects = doc.context.enumerateIndirectObjects();

  const purge = (dict: PDFDict): void => {
    // Unlink first, then delete the target. The other order leaves the parent
    // pointing at an object that no longer exists.
    const metadata = purgeEntry(doc, dict, 'Metadata');
    if (metadata.hit) packets.add(metadata.ref);

    const piece = purgeEntry(doc, dict, 'PieceInfo');
    if (piece.hit) pieceInfo.add(piece.ref);

    dict.delete(PDFName.of('LastModified'));
  };

  purge(doc.catalog);

  for (const [ref, obj] of objects) {
    if (obj instanceof PDFStream) purge(obj.dict);
    else if (obj instanceof PDFDict) purge(obj);

    // Orphans: a packet nothing points at any more, left by an earlier edit in
    // some other tool. Unreachable from the catalog, still in the file, still
    // readable by anyone who looks — pdf-lib writes out every object it holds.
    if (holdsXmp(obj)) {
      doc.context.delete(ref);
      packets.add(ref);
    } else if (looksLikeInfoDict(obj) && ref !== infoRef) {
      doc.context.delete(ref);
    }
  }

  let fileIdReplaced = false;
  if (doc.context.trailerInfo.ID) {
    const id = newFileId();
    doc.context.trailerInfo.ID = doc.context.obj([id, id]);
    fileIdReplaced = true;
  }

  return { infoCleared, packets: packets.count, pieceInfo: pieceInfo.count, fileIdReplaced };
}

export interface StripVerdict {
  clean: boolean;
  /** Present only on a failure, phrased to be dropped into a sentence. */
  reason?: string;
}

/**
 * Re-opens the output and proves the removal.
 *
 * Asserting a strip worked is not the same as checking, and the failure mode is
 * a user who believes a document is anonymous when it is not. Both halves
 * matter: the object model must be empty, and the bytes must not contain a
 * packet that the object model simply cannot reach.
 *
 * Exported so it can be pointed at any file, including one cleaned by something
 * else — which is the only way to find out whether that something else actually
 * removed anything.
 */
export async function verifyStripped(bytes: Uint8Array): Promise<StripVerdict> {
  // More than one revision means the removed data is still recoverable from the
  // previous one. A full rewrite produces exactly one.
  const text = new TextDecoder('latin1').decode(bytes);
  const revisions = (text.match(/%%EOF/g) ?? []).length;
  if (revisions !== 1) {
    return { clean: false, reason: `the result contains ${revisions} revisions` };
  }

  // Markup, not prose: `<?xpacket` and `<x:xmpmeta` are the packet's own
  // delimiters. Matching the bare word "xmpmeta" would fail a document that
  // merely talks about XMP, which is a false alarm on a tool whose alarm means
  // "we would not give you the file".
  if (text.includes('<?xpacket') || text.includes('<x:xmpmeta')) {
    return { clean: false, reason: 'an XMP packet is still present in the file bytes' };
  }

  let doc: PDFDocument;
  try {
    doc = await load(bytes);
  } catch (error) {
    return { clean: false, reason: `the result could not be re-opened (${(error as Error).message})` };
  }

  const info = infoDict(doc);
  if (info && info.entries().length > 0) {
    return { clean: false, reason: 'the document information dictionary still has entries' };
  }

  if (doc.catalog.has(PDFName.of('Metadata'))) {
    return { clean: false, reason: 'the catalog still points at a metadata stream' };
  }

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (isMetadataStream(obj)) {
      return { clean: false, reason: 'a metadata stream survived in the file' };
    }
    if (obj instanceof PDFStream && mightBeXmp(obj)) {
      return { clean: false, reason: 'a compressed XMP packet survived in the file' };
    }
    if (looksLikeInfoDict(obj)) {
      return { clean: false, reason: 'an orphaned information dictionary survived in the file' };
    }
  }

  return { clean: true };
}

/** Writes an /Info entry, or removes it when the value is empty. */
function setInfo(doc: PDFDocument, dict: PDFDict, key: string, value: string): void {
  if (value === '') {
    dict.delete(PDFName.of(key));
    return;
  }
  // Always hex, never a literal string, for two reasons that both matter.
  //
  // `PDFHexString.fromText` writes UTF-16BE with a byte-order mark, which is
  // the only way a PDF string can hold a name that is not Latin-1 — and plenty
  // of real authors are not.
  //
  // And `PDFString.of` performs no escaping whatsoever: it wraps the value in
  // parentheses and copies it in. A title containing an unbalanced `)` — "Q3 (draft)"
  // is fine, "Notes) and more" is not — would end the string early and corrupt
  // the file. Hex has no delimiter to collide with.
  dict.set(PDFName.of(key), PDFHexString.fromText(value));
}

/** Ensures there is an /Info dictionary to write into, registered as an object. */
function ensureInfoDict(doc: PDFDocument): PDFDict {
  const existing = infoDict(doc);
  if (existing) return existing;

  const dict = doc.context.obj({});
  doc.context.trailerInfo.Info = doc.context.register(dict);
  return dict;
}

/**
 * Sets or strips the metadata and hands back a new file.
 *
 * On `strip`, the result is verified before it is returned: if anything
 * survived, the user gets an error and their original, never a file that is
 * quietly less clean than it claims.
 *
 * On a field edit, the XMP packet is removed unless `keepXmp` says otherwise.
 * That is not tidiness. Adobe's readers prefer XMP to /Info, so setting Author
 * in /Info while `dc:creator` still names the previous author produces a
 * document that says two different things and shows the old one — a change that
 * looks applied and is not.
 */
export async function writeMetadata(
  files: InputFile[],
  changes: MetadataChanges
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  const started = performance.now();
  const bytesIn = file.bytes.byteLength;

  let doc: PDFDocument;
  try {
    doc = await load(file.bytes);
  } catch (error) {
    return readFailure(error);
  }

  const pages = doc.getPageCount();
  const notes: string[] = [];
  let summary: string;
  let suffix: string;

  const fields = changes.fields ?? {};

  // Declared out here because the read-back check at the bottom needs the same
  // list the write used — two lists would eventually disagree, and the one that
  // drifted would be the one doing the checking.
  const textFields = [
    ['Title', fields.title],
    ['Author', fields.author],
    ['Subject', fields.subject],
    ['Keywords', fields.keywords],
    ['Creator', fields.creator],
    ['Producer', fields.producer],
  ] as const;

  if (changes.strip) {
    const tally = stripEverything(doc);
    suffix = 'no-metadata';
    summary = 'Metadata removed';

    notes.push(
      tally.infoCleared
        ? 'The document information dictionary is gone — not emptied, removed, along with the object that held it.'
        : 'There was no document information dictionary to remove.'
    );
    notes.push(
      tally.packets > 0
        ? `${tally.packets} XMP packet${tally.packets === 1 ? '' : 's'} removed, including any attached to pages or images rather than to the document.`
        : 'No XMP packet was attached to this file.'
    );
    if (tally.pieceInfo > 0) {
      notes.push(
        `${tally.pieceInfo} block${tally.pieceInfo === 1 ? '' : 's'} of private authoring-tool data (/PieceInfo) removed.`
      );
    }
    if (tally.fileIdReplaced) {
      notes.push(
        'The trailer identifier was replaced with a fresh random one, so this copy can no longer be matched to the original by its file id.'
      );
    }
  } else {
    const info = ensureInfoDict(doc);
    const applied: string[] = [];

    for (const [key, value] of textFields) {
      if (value === undefined) continue;
      setInfo(doc, info, key, value.trim());
      applied.push(key);
    }

    for (const [key, value] of [
      ['CreationDate', fields.creationDate],
      ['ModDate', fields.modDate],
    ] as const) {
      if (value === undefined) continue;

      if (value.trim() === '') {
        info.delete(PDFName.of(key));
        applied.push(key);
        continue;
      }

      const parts = parseDateInput(value);
      if (!parts) {
        return {
          ok: false,
          error: `That ${key === 'ModDate' ? 'modified' : 'created'} date could not be read. Use a form like 2024-08-17 14:30, or paste the PDF form: D:20240817143000+01'00'.`,
        };
      }

      // Written by hand rather than through setCreationDate, so the zone the
      // caller gave — or deliberately did not give — is the one stored.
      info.set(PDFName.of(key), PDFString.of(formatPdfDate(parts)));
      applied.push(key);

      if (parts.offsetMinutes === null) {
        notes.push(
          `${key === 'ModDate' ? 'Modified' : 'Created'} date was written without a time zone, because none was given. That is legal PDF and it keeps your time zone out of the file.`
        );
      }
    }

    if (applied.length === 0) {
      return { ok: false, error: 'Nothing to change. Edit a field first, or choose to remove everything.' };
    }

    if (!changes.keepXmp) {
      if (purgeEntry(doc, doc.catalog, 'Metadata').hit) {
        notes.push(
          "The document's XMP packet was removed. Adobe readers trust XMP over the properties panel, so leaving the old packet in place would have kept the old values on display next to the new ones."
        );
        notes.push(
          'If this document was PDF/A, removing XMP ends that conformance — PDF/A requires the packet. Re-run the PDF/A tool afterwards if you need it back.'
        );
      }

      // Only the document's own packet is removed here. The ones hanging off
      // pages and images describe that content rather than the document, and
      // deleting them behind the user's back on a rename of the Title field
      // would be a bigger change than they asked for. Saying so beats a note
      // that claims more than was done.
      const remaining = countPackets(doc);
      if (remaining > 0) {
        notes.push(
          `${remaining} metadata packet${remaining === 1 ? '' : 's'} attached to individual pages or images ${remaining === 1 ? 'was' : 'were'} left alone — those describe that content, not the document. Choosing to remove everything clears them too.`
        );
      }
    } else if (doc.catalog.has(PDFName.of('Metadata'))) {
      notes.push(
        'The XMP packet was kept, as asked. It still holds its own copies of these fields, and Adobe readers show those in preference to the ones just set.'
      );
    }

    suffix = 'metadata';
    summary = `Updated ${applied.length} field${applied.length === 1 ? '' : 's'}`;
  }

  let bytes: Uint8Array;
  try {
    // A full rewrite, never an incremental update. An incremental save appends
    // and keeps the previous revision, so everything just removed would still
    // be in the file — the appearance of a strip rather than a strip.
    bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 2000 });
  } catch (error) {
    return { ok: false, error: `Could not write the document: ${(error as Error).message}` };
  }

  if (changes.strip) {
    const verdict = await verifyStripped(bytes);
    if (!verdict.clean) {
      return {
        ok: false,
        error: `Verification failed — ${verdict.reason}, so the file was not returned. Your original is untouched. Please report this.`,
      };
    }
    notes.push(
      'Verified: the result was re-opened and searched, in its object structure and in its raw bytes, for an information dictionary, an XMP packet or a leftover copy of either. There are none. If there had been, you would have got an error instead of a file.'
    );
    notes.push(
      'What this does not remove: text on the pages, form values, annotations, attachments and signatures. Names hide in those too, and they are content — see Redact if something needs to be gone from a page.'
    );
  } else {
    // Cheap, and it turns "we set the field" into "the field reads back".
    try {
      const check = await load(bytes);
      const written = infoDict(check);

      for (const [key, value] of textFields) {
        if (value === undefined) continue;
        if (textOf(written, key) !== value.trim()) {
          return {
            ok: false,
            error:
              'The new details did not read back from the saved file, so it was not returned. Your original is untouched. Please report this.',
          };
        }
      }
    } catch {
      return {
        ok: false,
        error: 'The edited file could not be re-opened for checking, so it was not returned. Your original is untouched.',
      };
    }
  }

  notes.push('Everything happened in this tab. Nothing was uploaded.');

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-${suffix}.pdf`, bytes }],
    bytesIn,
    bytesOut: bytes.length,
    pages,
    durationMs: performance.now() - started,
    summary,
    notes,
  };
}
