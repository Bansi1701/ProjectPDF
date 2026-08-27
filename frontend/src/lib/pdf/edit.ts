import { PDFDocument, degrees, rgb } from '@cantoo/pdf-lib';
import type { EditMark, InputFile, OpResult } from './types';

const baseName = (name: string) => name.replace(/\.pdf$/i, '');
const load = (file: InputFile) => PDFDocument.load(file.bytes, { updateMetadata: false });

function colour(value: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value);
  const hex = match?.[1] ?? '0f172a';
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255
  );
}

const clamp = (value: number | undefined, fallback = 0): number => {
  const safe = Number.isFinite(value) ? value! : fallback;
  return Math.max(0, Math.min(1, safe));
};

const positive = (value: number | undefined, fallback = 0): number => {
  const safe = Number.isFinite(value) ? value! : fallback;
  return Math.max(0, safe);
};

function pagePoint(pageWidth: number, pageHeight: number, x: number, y: number) {
  return { x: clamp(x) * pageWidth, y: pageHeight - clamp(y) * pageHeight };
}

function box(pageWidth: number, pageHeight: number, mark: { x: number; y: number; width: number; height: number }) {
  const x = clamp(mark.x);
  const y = clamp(mark.y);
  const width = Math.min(1 - x, positive(mark.width));
  const height = Math.min(1 - y, positive(mark.height));
  return { x: x * pageWidth, y: pageHeight - (y + height) * pageHeight, width: width * pageWidth, height: height * pageHeight };
}

function payloadBytes(value: ArrayBuffer | Uint8Array | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function drawSegment(
  page: ReturnType<PDFDocument['getPage']>,
  start: { x: number; y: number },
  end: { x: number; y: number },
  thickness: number,
  color: ReturnType<typeof rgb>,
  opacity: number | undefined
): void {
  page.drawLine({ start, end, thickness: Math.max(0.25, thickness), color, opacity });
}

function polygonPath(points: { x: number; y: number }[], width: number, height: number, close = true): string {
  const coordinates = points.map((point) => pagePoint(width, height, point.x, point.y));
  if (coordinates.length === 0) return '';
  const [first, ...rest] = coordinates;
  return `M ${first!.x} ${first!.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(' ')}${close ? ' Z' : ''}`;
}

function cloudPoints(x: number, y: number, width: number, height: number): { x: number; y: number }[] {
  // A small, deterministic scalloped outline. It stays a vector path and
  // does not require fonts, network assets, or a raster rendering step.
  const points: { x: number; y: number }[] = [];
  const segments = Math.max(3, Math.ceil((width + height) * 18));
  const perimeter = 2 * (width + height);
  for (let index = 0; index < segments; index += 1) {
    const distance = (index / segments) * perimeter;
    let px: number;
    let py: number;
    if (distance < width) {
      px = x + distance;
      py = y;
    } else if (distance < width + height) {
      px = x + width;
      py = y + distance - width;
    } else if (distance < (2 * width) + height) {
      px = x + width - (distance - width - height);
      py = y + height;
    } else {
      px = x;
      py = y + height - (distance - (2 * width) - height);
    }
    const phase = (index / segments) * Math.PI * 2;
    points.push({ x: px + Math.cos(phase) * 0.012, y: py + Math.sin(phase) * 0.012 });
  }
  return points;
}

/**
 * Applies the marks from the shared live workspace to the first PDF.
 *
 * This is separate from the `edit` operation because every compatible tool
 * can carry quick edits into its own operation: a highlighted PDF can be
 * compressed, protected, converted, or saved without a second upload.
 */
export async function applyEdits(files: InputFile[], edits: EditMark[]): Promise<InputFile[]> {
  const file = files[0];
  if (!file || edits.length === 0) return files;

  const doc = await load(file);
  const pages = doc.getPages();

  for (const mark of edits) {
    const page = pages[mark.page - 1];
    if (!page) continue;

    const { width, height } = page.getSize();

    if (mark.kind === 'text') {
      page.drawText(mark.text, {
        x: clamp(mark.x) * width,
        y: height - clamp(mark.y) * height - Math.max(1, mark.size),
        size: Math.max(1, mark.size),
        color: colour(mark.color),
      });
      continue;
    }

    if (mark.kind === 'replace-text' || mark.kind === 'replace') {
      const rect = box(width, height, mark);
      page.drawRectangle({ ...rect, color: colour(mark.backgroundColor ?? '#ffffff'), opacity: 1 });
      page.drawText(mark.text, {
        x: rect.x + Math.max(1, mark.strokeWidth ?? 0),
        y: rect.y + Math.max(1, mark.height * height - Math.max(1, mark.size)) - Math.max(1, mark.strokeWidth ?? 0),
        size: Math.max(1, mark.size),
        color: colour(mark.color),
        maxWidth: Math.max(1, rect.width - 2 * Math.max(1, mark.strokeWidth ?? 0)),
      });
      continue;
    }

    if (mark.kind === 'ink') {
      for (let index = 1; index < mark.points.length; index += 1) {
        const start = mark.points[index - 1]!;
        const end = mark.points[index]!;
        page.drawLine({
          start: pagePoint(width, height, start.x, start.y),
          end: pagePoint(width, height, end.x, end.y),
          thickness: Math.max(0.25, mark.strokeWidth),
          color: colour(mark.color),
          opacity: mark.opacity ?? 0.95,
        });
      }
      continue;
    }

    if (mark.kind === 'line' || mark.kind === 'arrow') {
      const start = mark.start ?? { x: mark.x1 ?? mark.x ?? 0, y: mark.y1 ?? mark.y ?? 0 };
      const end = mark.end ?? { x: mark.x2 ?? (mark.x ?? 0) + (mark.width ?? 0), y: mark.y2 ?? (mark.y ?? 0) + (mark.height ?? 0) };
      const startPdf = pagePoint(width, height, start.x, start.y);
      const endPdf = pagePoint(width, height, end.x, end.y);
      const stroke = Math.max(0.25, mark.strokeWidth);
      const ink = colour(mark.color);
      drawSegment(page, startPdf, endPdf, stroke, ink, mark.opacity ?? 1);
      if (mark.kind === 'arrow') {
        const angle = Math.atan2(endPdf.y - startPdf.y, endPdf.x - startPdf.x);
        const length = Math.max(7, stroke * 4);
        const spread = Math.PI / 7;
        drawSegment(page, endPdf, { x: endPdf.x - Math.cos(angle - spread) * length, y: endPdf.y - Math.sin(angle - spread) * length }, stroke, ink, mark.opacity ?? 1);
        drawSegment(page, endPdf, { x: endPdf.x - Math.cos(angle + spread) * length, y: endPdf.y - Math.sin(angle + spread) * length }, stroke, ink, mark.opacity ?? 1);
      }
      continue;
    }

    if (mark.kind === 'polygon' || mark.kind === 'cloud') {
      if (mark.points.length < 2) continue;
      const points = mark.kind === 'cloud'
        ? cloudPoints(
            Math.min(...mark.points.map((point) => clamp(point.x))),
            Math.min(...mark.points.map((point) => clamp(point.y))),
            Math.max(...mark.points.map((point) => clamp(point.x))) - Math.min(...mark.points.map((point) => clamp(point.x))),
            Math.max(...mark.points.map((point) => clamp(point.y))) - Math.min(...mark.points.map((point) => clamp(point.y)))
          )
        : mark.points;
      const path = polygonPath(points, width, height);
      if (path) page.drawSvgPath(path, {
        color: mark.fill ? colour(mark.fill) : undefined,
        opacity: mark.opacity ?? (mark.fill ? 0.2 : 1),
        borderColor: colour(mark.color),
        borderWidth: Math.max(0.25, mark.strokeWidth),
      });
      continue;
    }

    if (mark.kind === 'stamp') {
      const rect = box(width, height, mark);
      const stroke = Math.max(0.5, mark.strokeWidth ?? 2);
      const ink = colour(mark.color);
      const stamp = mark.stamp.toLowerCase();
      if (stamp === 'dot') {
        page.drawEllipse({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, xScale: rect.width / 2, yScale: rect.height / 2, color: ink, opacity: mark.opacity ?? 0.85 });
      } else if (stamp === 'circle') {
        page.drawEllipse({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, xScale: rect.width / 2, yScale: rect.height / 2, borderColor: ink, borderWidth: stroke, opacity: mark.opacity ?? 1 });
      } else if (stamp === 'check') {
        drawSegment(page, { x: rect.x + rect.width * 0.15, y: rect.y + rect.height * 0.5 }, { x: rect.x + rect.width * 0.42, y: rect.y + rect.height * 0.78 }, stroke, ink, mark.opacity ?? 1);
        drawSegment(page, { x: rect.x + rect.width * 0.42, y: rect.y + rect.height * 0.78 }, { x: rect.x + rect.width * 0.86, y: rect.y + rect.height * 0.2 }, stroke, ink, mark.opacity ?? 1);
      } else {
        drawSegment(page, { x: rect.x + rect.width * 0.16, y: rect.y + rect.height * 0.16 }, { x: rect.x + rect.width * 0.84, y: rect.y + rect.height * 0.84 }, stroke, ink, mark.opacity ?? 1);
        if (stamp === 'crossout' || stamp === 'cross-out') drawSegment(page, { x: rect.x + rect.width * 0.84, y: rect.y + rect.height * 0.16 }, { x: rect.x + rect.width * 0.16, y: rect.y + rect.height * 0.84 }, stroke, ink, mark.opacity ?? 1);
      }
      continue;
    }

    if (mark.kind === 'signature' || mark.kind === 'signature-text') {
      const rect = box(width, height, mark);
      const imageBytes = payloadBytes(mark.image ?? mark.bytes);
      if (imageBytes && imageBytes.byteLength > 0) {
        const mime = mark.mimeType ?? (imageBytes[0] === 0x89 ? 'image/png' : 'image/jpeg');
        const image = mime === 'image/png' ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
        page.drawImage(image, { ...rect, opacity: mark.opacity ?? 1 });
      } else if (mark.text?.trim()) {
        page.drawText(mark.text.trim(), {
          x: rect.x,
          y: rect.y + Math.max(1, rect.height - (mark.size ?? 18)),
          size: Math.max(1, mark.size ?? Math.min(24, rect.height * 0.65)),
          color: colour(mark.color ?? '#0f172a'),
          maxWidth: Math.max(1, rect.width),
          opacity: mark.opacity ?? 1,
        });
      }
      continue;
    }

    const rect = box(width, height, mark);

    if (mark.kind === 'highlight') {
      page.drawRectangle({
        ...rect,
        color: colour(mark.color),
        opacity: mark.opacity ?? 0.3,
      });
    } else if (mark.kind === 'whiteout') {
      page.drawRectangle({
        ...rect,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.78, 0.8, 0.84),
        borderWidth: 0.5,
      });
    } else if (mark.kind === 'underline' || mark.kind === 'strike' || mark.kind === 'strike-through' || mark.kind === 'strikethrough') {
      const y = mark.kind === 'underline' ? rect.y + Math.max(mark.strokeWidth, 1) : rect.y + rect.height * 0.52;
      drawSegment(page, { x: rect.x, y }, { x: rect.x + rect.width, y }, Math.max(0.25, mark.strokeWidth), colour(mark.color), mark.opacity ?? 1);
    } else if (mark.kind === 'circle') {
      page.drawEllipse({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        xScale: rect.width / 2,
        yScale: rect.height / 2,
        borderColor: colour(mark.color),
        borderWidth: Math.max(0.25, mark.strokeWidth),
        opacity: mark.opacity ?? 1,
      });
    } else if (mark.kind === 'callout') {
      page.drawRectangle({ ...rect, color: colour(mark.fill ?? '#ffffff'), opacity: mark.opacity ?? 0.92, borderColor: colour(mark.color), borderWidth: Math.max(0.25, mark.strokeWidth), rx: Math.min(8, rect.width / 5), ry: Math.min(8, rect.height / 5) });
      const anchor = mark.anchor ?? { x: mark.x + mark.width / 2, y: mark.y + mark.height + 0.06 };
      drawSegment(page, { x: rect.x + rect.width / 2, y: rect.y }, pagePoint(width, height, anchor.x, anchor.y), Math.max(0.25, mark.strokeWidth), colour(mark.color), mark.opacity ?? 1);
      if (mark.text?.trim()) page.drawText(mark.text.trim(), { x: rect.x + 4, y: rect.y + rect.height - Math.max(12, rect.height * 0.35), size: Math.max(6, Math.min(18, rect.height * 0.3)), color: colour(mark.color), maxWidth: Math.max(1, rect.width - 8), opacity: mark.opacity ?? 1 });
    } else {
      page.drawRectangle({
        ...rect,
        borderColor: colour(mark.color),
        borderWidth: mark.strokeWidth,
        color: 'fill' in mark && mark.fill ? colour(mark.fill) : undefined,
        opacity: mark.opacity ?? 1,
      });
    }
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return [{ name: file.name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, ...files.slice(1)];
}

export async function editDocument(files: InputFile[], edits: EditMark[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to edit.' };
  if (edits.length === 0) return { ok: false, error: 'Add at least one edit to the page.' };

  const started = performance.now();
  const changed = await applyEdits(files, edits);
  const output = new Uint8Array(changed[0]!.bytes);
  const pageCount = (await load(file)).getPageCount();

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-edited.pdf`, bytes: output }],
    bytesIn: file.bytes.byteLength,
    bytesOut: output.byteLength,
    pages: pageCount,
    durationMs: performance.now() - started,
    summary: `Applied ${edits.length} page edit${edits.length === 1 ? '' : 's'}`,
  };
}

export async function addText(files: InputFile[], text: string, targetPage: number): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to edit.' };
  if (!text.trim()) return { ok: false, error: 'Enter the text you want to add.' };
  const started = performance.now();
  const doc = await load(file);
  if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > doc.getPageCount()) {
    return { ok: false, error: `Choose a page from 1 to ${doc.getPageCount()}.` };
  }
  doc.getPage(targetPage - 1).drawText(text.trim(), { x: 36, y: 36, size: 16, color: rgb(0.12, 0.18, 0.28) });
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { ok: true, files: [{ name: `${baseName(file.name)}-edited.pdf`, bytes }], bytesIn: file.bytes.byteLength, bytesOut: bytes.length, pages: doc.getPageCount(), durationMs: performance.now() - started, summary: `Added text to page ${targetPage}` };
}

export async function watermark(files: InputFile[], text: string): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to watermark.' };
  if (!text.trim()) return { ok: false, error: 'Enter watermark text.' };
  const started = performance.now();
  const doc = await load(file);
  doc.getPages().forEach((page) => {
    const { width, height } = page.getSize();
    page.drawText(text.trim(), { x: width * 0.14, y: height * 0.42, size: Math.min(width, height) / 10, rotate: degrees(-35), opacity: 0.22, color: rgb(0.72, 0.12, 0.14) });
  });
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { ok: true, files: [{ name: `${baseName(file.name)}-watermarked.pdf`, bytes }], bytesIn: file.bytes.byteLength, bytesOut: bytes.length, pages: doc.getPageCount(), durationMs: performance.now() - started, summary: `Watermarked ${doc.getPageCount()} pages` };
}

export async function pageNumbers(files: InputFile[], start: number, prefix: string): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to number.' };
  if (!Number.isInteger(start) || start < 1) return { ok: false, error: 'Starting number must be 1 or higher.' };
  const started = performance.now();
  const doc = await load(file);
  doc.getPages().forEach((page, index) => {
    const { width } = page.getSize();
    page.drawText(`${prefix}${start + index}`, { x: Math.max(24, width - 76), y: 24, size: 11, color: rgb(0.18, 0.18, 0.18) });
  });
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { ok: true, files: [{ name: `${baseName(file.name)}-numbered.pdf`, bytes }], bytesIn: file.bytes.byteLength, bytesOut: bytes.length, pages: doc.getPageCount(), durationMs: performance.now() - started, summary: `Numbered ${doc.getPageCount()} pages` };
}

export async function compare(files: InputFile[]): Promise<OpResult> {
  if (files.length !== 2) return { ok: false, error: 'Choose exactly two PDFs to compare.' };
  const started = performance.now();
  const [first, second] = await Promise.all(files.map(load));
  const a = new Uint8Array(files[0].bytes);
  const b = new Uint8Array(files[1].bytes);
  const identical = a.length === b.length && a.every((value, index) => value === b[index]);
  return {
    ok: true, files: [], bytesIn: a.length + b.length, bytesOut: 0,
    pages: first.getPageCount() + second.getPageCount(), durationMs: performance.now() - started,
    summary: identical ? 'Files are exactly identical' : 'Files are different',
    notes: [`First PDF: ${first.getPageCount()} pages`, `Second PDF: ${second.getPageCount()} pages`, 'Comparison checks page count and byte-for-byte file identity.'],
  };
}
