import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import { parsePageSet } from './pageset';
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

const MIN_BOX_FRACTION = 0.0125;
const MIN_STROKE = 0.25;
const MIN_TEXT_SIZE = 1;

const safeStroke = (value: number | undefined, fallback = 1): number => Math.max(MIN_STROKE, positive(value, fallback));
const safeSize = (value: number | undefined, fallback = 16): number => Math.max(MIN_TEXT_SIZE, positive(value, fallback));
const safeDimension = (value: number | undefined, fallback = MIN_BOX_FRACTION): number =>
  Math.max(MIN_BOX_FRACTION, positive(value, fallback));
const safeOpacity = (value: number | undefined, fallback = 1): number => clamp(value, fallback);
const normalizeRotation = (value: number | undefined): number => {
  const safe = Number.isFinite(value) ? value! : 0;
  const normalized = ((safe % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
};

function pagePoint(pageWidth: number, pageHeight: number, x: number, y: number) {
  return { x: clamp(x) * pageWidth, y: pageHeight - clamp(y) * pageHeight };
}

function box(pageWidth: number, pageHeight: number, mark: { x: number; y: number; width: number; height: number }) {
  const x = Math.min(1 - MIN_BOX_FRACTION, clamp(mark.x));
  const y = Math.min(1 - MIN_BOX_FRACTION, clamp(mark.y));
  const width = Math.max(MIN_BOX_FRACTION, Math.min(1 - x, safeDimension(mark.width)));
  const height = Math.max(MIN_BOX_FRACTION, Math.min(1 - y, safeDimension(mark.height)));
  return { x: x * pageWidth, y: pageHeight - (y + height) * pageHeight, width: width * pageWidth, height: height * pageHeight };
}

function payloadBytes(value: ArrayBuffer | Uint8Array | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function centerOf(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function centeredRotatedOrigin(
  center: { x: number; y: number },
  localWidth: number,
  localHeight: number,
  rotation: number
) {
  if (!rotation) return { x: center.x - localWidth / 2, y: center.y - localHeight / 2 };
  const radians = (rotation * Math.PI) / 180;
  const offsetX = (localWidth / 2) * Math.cos(radians) - (localHeight / 2) * Math.sin(radians);
  const offsetY = (localWidth / 2) * Math.sin(radians) + (localHeight / 2) * Math.cos(radians);
  return { x: center.x - offsetX, y: center.y - offsetY };
}

function rotatePoint(point: { x: number; y: number }, center: { x: number; y: number }, rotation: number) {
  if (!rotation) return point;
  const radians = (rotation * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + (dx * cos - dy * sin),
    y: center.y + (dx * sin + dy * cos),
  };
}

function absolutePath(points: { x: number; y: number }[], close = true): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(' ')}${close ? ' Z' : ''}`;
}

function rotatePoints(points: { x: number; y: number }[], center: { x: number; y: number }, rotation: number) {
  return rotation ? points.map((point) => rotatePoint(point, center, rotation)) : points;
}

function rectCorners(rect: { x: number; y: number; width: number; height: number }) {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function rotatedBoxPath(rect: { x: number; y: number; width: number; height: number }, rotation: number) {
  return absolutePath(rotatePoints(rectCorners(rect), centerOf(rect), rotation));
}

function pointBounds(points: { x: number; y: number }[]) {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y)),
    width: Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
    height: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)),
  };
}

function applyAspectRatio(
  rect: { x: number; y: number; width: number; height: number },
  aspectRatio?: number,
  lockAspectRatio?: boolean
) {
  const ratio = Number.isFinite(aspectRatio) ? aspectRatio! : undefined;
  if (!lockAspectRatio || !ratio || ratio <= 0) return rect;
  const current = rect.width / Math.max(rect.height, 1e-6);
  if (!Number.isFinite(current) || current === 0 || Math.abs(current - ratio) < 1e-6) return rect;
  if (current > ratio) {
    const width = rect.height * ratio;
    return { ...rect, x: rect.x + (rect.width - width) / 2, width };
  }
  const height = rect.width / ratio;
  return { ...rect, y: rect.y + (rect.height - height) / 2, height };
}

function estimateTextBox(text: string, size: number) {
  const lines = text.split(/\r?\n/);
  const width = Math.max(size, ...lines.map((line) => Math.max(size * 1.25, line.length * size * 0.58)));
  const height = Math.max(size * 1.2, lines.length * size * 1.15);
  return { width, height };
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
    const rotation = normalizeRotation(mark.rotation);

    if (mark.kind === 'text') {
      const size = safeSize(mark.size, 16);
      const position = { x: clamp(mark.x) * width, y: height - clamp(mark.y) * height };
      const textBox = estimateTextBox(mark.text, size);
      const hasEditorBounds = Number.isFinite(mark.width) && Number.isFinite(mark.height);
      const editorRect = hasEditorBounds
        ? box(width, height, { x: mark.x, y: mark.y, width: mark.width!, height: mark.height! })
        : null;
      const localWidth = editorRect?.width ?? textBox.width;
      const localHeight = Math.min(editorRect?.height ?? textBox.height, Math.max(size, textBox.height));
      const center = editorRect
        ? centerOf(editorRect)
        : { x: position.x + localWidth / 2, y: position.y - localHeight / 2 };
      const origin = centeredRotatedOrigin(center, localWidth, localHeight, rotation);
      page.drawText(mark.text, {
        x: rotation || editorRect ? origin.x : position.x,
        y: rotation || editorRect ? origin.y : position.y - size,
        size,
        color: colour(mark.color),
        rotate: rotation ? degrees(rotation) : undefined,
        maxWidth: Math.max(1, localWidth),
        opacity: safeOpacity(mark.opacity, 1),
      });
      continue;
    }

    if (mark.kind === 'replace-text' || mark.kind === 'replace') {
      const rect = applyAspectRatio(box(width, height, mark), mark.aspectRatio, mark.lockAspectRatio);
      const fill = colour(mark.backgroundColor ?? '#ffffff');
      const ink = colour(mark.color);
      const stroke = safeStroke(mark.strokeWidth, 1);
      const size = safeSize(mark.size, 16);
      const textBox = estimateTextBox(mark.text, size);
      const center = centerOf(rect);
      const textWidth = Math.min(textBox.width, Math.max(1, rect.width - 2 * stroke));
      const textOrigin = centeredRotatedOrigin(center, textWidth, size, rotation);
      if (rotation) {
        page.drawSvgPath(rotatedBoxPath(rect, rotation), {
          color: fill,
          opacity: 1,
          borderColor: ink,
          borderWidth: stroke,
        });
      } else {
        page.drawRectangle({ ...rect, color: fill, opacity: 1 });
      }
      page.drawText(mark.text, {
        x: rotation ? textOrigin.x : rect.x + stroke,
        y: rotation ? textOrigin.y : rect.y + Math.max(1, rect.height - size - stroke),
        size,
        color: ink,
        maxWidth: Math.max(1, rect.width - 2 * stroke),
        rotate: rotation ? degrees(rotation) : undefined,
        opacity: 1,
      });
      continue;
    }

    if (mark.kind === 'ink') {
      const stroke = safeStroke(mark.strokeWidth, 1);
      const points = mark.points.map((point) => pagePoint(width, height, point.x, point.y));
      const center = centerOf(pointBounds(points));
      const transformed = rotatePoints(points, center, rotation);
      for (let index = 1; index < transformed.length; index += 1) {
        const start = transformed[index - 1]!;
        const end = transformed[index]!;
        page.drawLine({
          start,
          end,
          thickness: stroke,
          color: colour(mark.color),
          opacity: safeOpacity(mark.opacity, 0.95),
        });
      }
      continue;
    }

    if (mark.kind === 'line' || mark.kind === 'arrow') {
      const start = mark.start ?? { x: mark.x1 ?? mark.x ?? 0, y: mark.y1 ?? mark.y ?? 0 };
      const end = mark.end ?? { x: mark.x2 ?? (mark.x ?? 0) + (mark.width ?? 0), y: mark.y2 ?? (mark.y ?? 0) + (mark.height ?? 0) };
      const startPdf = pagePoint(width, height, start.x, start.y);
      const endPdf = pagePoint(width, height, end.x, end.y);
      const bounds = pointBounds([startPdf, endPdf]);
      const center = centerOf(bounds);
      const rotated = rotatePoints([startPdf, endPdf], center, rotation);
      const [rotatedStart, rotatedEnd] = rotated as [typeof startPdf, typeof endPdf];
      const stroke = safeStroke(mark.strokeWidth, 1);
      const ink = colour(mark.color);
      drawSegment(page, rotatedStart, rotatedEnd, stroke, ink, safeOpacity(mark.opacity, 1));
      if (mark.kind === 'arrow') {
        const angle = Math.atan2(rotatedEnd.y - rotatedStart.y, rotatedEnd.x - rotatedStart.x);
        const length = Math.max(7, stroke * 4);
        const spread = Math.PI / 7;
        drawSegment(page, rotatedEnd, { x: rotatedEnd.x - Math.cos(angle - spread) * length, y: rotatedEnd.y - Math.sin(angle - spread) * length }, stroke, ink, safeOpacity(mark.opacity, 1));
        drawSegment(page, rotatedEnd, { x: rotatedEnd.x - Math.cos(angle + spread) * length, y: rotatedEnd.y - Math.sin(angle + spread) * length }, stroke, ink, safeOpacity(mark.opacity, 1));
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
          ).map((point) => pagePoint(width, height, point.x, point.y))
        : mark.points.map((point) => pagePoint(width, height, point.x, point.y));
      const center = centerOf(pointBounds(points));
      const transformed = rotatePoints(points, center, rotation);
      const path = absolutePath(transformed);
      if (path) page.drawSvgPath(path, {
        color: mark.fill ? colour(mark.fill) : undefined,
        opacity: safeOpacity(mark.opacity, mark.fill ? 0.2 : 1),
        borderColor: colour(mark.color),
        borderWidth: safeStroke(mark.strokeWidth, 1),
      });
      continue;
    }

    if (mark.kind === 'stamp') {
      const rect = applyAspectRatio(box(width, height, mark), mark.aspectRatio, mark.lockAspectRatio);
      const stroke = Math.max(0.5, safeStroke(mark.strokeWidth, 2));
      const ink = colour(mark.color);
      const stamp = mark.stamp.toLowerCase();
      if (stamp === 'dot') {
        page.drawEllipse({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, xScale: rect.width / 2, yScale: rect.height / 2, rotate: rotation ? degrees(rotation) : undefined, color: ink, opacity: safeOpacity(mark.opacity, 0.85) });
      } else if (stamp === 'circle') {
        page.drawEllipse({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, xScale: rect.width / 2, yScale: rect.height / 2, rotate: rotation ? degrees(rotation) : undefined, borderColor: ink, borderWidth: stroke, opacity: safeOpacity(mark.opacity, 1) });
      } else if (stamp === 'check') {
        const points = [
          { x: rect.x + rect.width * 0.15, y: rect.y + rect.height * 0.5 },
          { x: rect.x + rect.width * 0.42, y: rect.y + rect.height * 0.78 },
          { x: rect.x + rect.width * 0.86, y: rect.y + rect.height * 0.2 },
        ];
        const transformed = rotatePoints(points, centerOf(rect), rotation);
        drawSegment(page, transformed[0]!, transformed[1]!, stroke, ink, safeOpacity(mark.opacity, 1));
        drawSegment(page, transformed[1]!, transformed[2]!, stroke, ink, safeOpacity(mark.opacity, 1));
      } else {
        const points = [
          { x: rect.x + rect.width * 0.16, y: rect.y + rect.height * 0.16 },
          { x: rect.x + rect.width * 0.84, y: rect.y + rect.height * 0.84 },
          { x: rect.x + rect.width * 0.84, y: rect.y + rect.height * 0.16 },
          { x: rect.x + rect.width * 0.16, y: rect.y + rect.height * 0.84 },
        ];
        const transformed = rotatePoints(points, centerOf(rect), rotation);
        drawSegment(page, transformed[0]!, transformed[1]!, stroke, ink, safeOpacity(mark.opacity, 1));
        if (stamp === 'crossout' || stamp === 'cross-out') drawSegment(page, transformed[2]!, transformed[3]!, stroke, ink, safeOpacity(mark.opacity, 1));
      }
      continue;
    }

    if (mark.kind === 'signature' || mark.kind === 'signature-text') {
      const rect = applyAspectRatio(box(width, height, mark), mark.aspectRatio, mark.lockAspectRatio);
      const imageBytes = payloadBytes(mark.image ?? mark.bytes);
      const center = centerOf(rect);
      if (imageBytes && imageBytes.byteLength > 0) {
        const mime = mark.mimeType ?? (imageBytes[0] === 0x89 ? 'image/png' : 'image/jpeg');
        const image = mime === 'image/png' ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
        const origin = centeredRotatedOrigin(center, rect.width, rect.height, rotation);
        page.drawImage(image, { ...rect, ...origin, opacity: safeOpacity(mark.opacity, 1), rotate: rotation ? degrees(rotation) : undefined });
      } else if (mark.text?.trim()) {
        const requestedSize = safeSize(mark.size, 18);
        const naturalBox = estimateTextBox(mark.text.trim(), requestedSize);
        const size = Math.max(6, requestedSize * Math.min(1, (rect.width * 0.92) / Math.max(1, naturalBox.width)));
        const textBox = estimateTextBox(mark.text.trim(), size);
        const textWidth = Math.min(textBox.width, Math.max(1, rect.width));
        const origin = centeredRotatedOrigin(center, textWidth, size, rotation);
        page.drawText(mark.text.trim(), {
          x: rotation ? origin.x : rect.x,
          y: rotation ? origin.y : rect.y + Math.max(1, rect.height - size),
          size,
          color: colour(mark.color ?? '#0f172a'),
          maxWidth: Math.max(1, rect.width),
          opacity: safeOpacity(mark.opacity, 1),
          rotate: rotation ? degrees(rotation) : undefined,
        });
      }
      continue;
    }

    const rect = applyAspectRatio(box(width, height, {
      x: 'x' in mark ? mark.x ?? 0 : 0,
      y: 'y' in mark ? mark.y ?? 0 : 0,
      width: 'width' in mark ? mark.width ?? MIN_BOX_FRACTION : MIN_BOX_FRACTION,
      height: 'height' in mark ? mark.height ?? MIN_BOX_FRACTION : MIN_BOX_FRACTION,
    }), mark.aspectRatio, mark.lockAspectRatio);
    const center = centerOf(rect);

    if (mark.kind === 'highlight') {
      if (rotation) {
        page.drawSvgPath(rotatedBoxPath(rect, rotation), {
          color: colour(mark.color),
          opacity: safeOpacity(mark.opacity, 0.3),
          borderColor: colour(mark.color ?? '#0f172a'),
          borderWidth: 0,
        });
      } else {
        page.drawRectangle({
          ...rect,
          color: colour(mark.color),
          opacity: safeOpacity(mark.opacity, 0.3),
        });
      }
    } else if (mark.kind === 'whiteout') {
      if (rotation) {
        page.drawSvgPath(rotatedBoxPath(rect, rotation), {
          color: rgb(1, 1, 1),
          opacity: 1,
          borderColor: rgb(0.78, 0.8, 0.84),
          borderWidth: 0.5,
        });
      } else {
        page.drawRectangle({
          ...rect,
          color: rgb(1, 1, 1),
          borderColor: rgb(0.78, 0.8, 0.84),
          borderWidth: 0.5,
        });
      }
    } else if (mark.kind === 'underline' || mark.kind === 'strike' || mark.kind === 'strike-through' || mark.kind === 'strikethrough') {
      const y = mark.kind === 'underline' ? rect.y + Math.max(safeStroke(mark.strokeWidth, 1), 1) : rect.y + rect.height * 0.52;
      const start = { x: rect.x, y };
      const end = { x: rect.x + rect.width, y };
      const transformed = rotatePoints([start, end], center, rotation);
      drawSegment(page, transformed[0]!, transformed[1]!, safeStroke(mark.strokeWidth, 1), colour(mark.color), safeOpacity(mark.opacity, 1));
    } else if (mark.kind === 'circle') {
      page.drawEllipse({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        xScale: rect.width / 2,
        yScale: rect.height / 2,
        rotate: rotation ? degrees(rotation) : undefined,
        borderColor: colour(mark.color),
        borderWidth: safeStroke(mark.strokeWidth, 1),
        opacity: safeOpacity(mark.opacity, 1),
      });
    } else if (mark.kind === 'callout') {
      const fill = colour(mark.fill ?? '#ffffff');
      const stroke = safeStroke(mark.strokeWidth, 1);
      const path = rotatedBoxPath(rect, rotation);
      page.drawSvgPath(path, {
        color: fill,
        opacity: safeOpacity(mark.opacity, 0.92),
        borderColor: colour(mark.color),
        borderWidth: stroke,
      });
      const anchor = mark.anchor ?? { x: mark.x + mark.width / 2, y: mark.y + mark.height + 0.06 };
      const topCenter = rotatePoint({ x: center.x, y: rect.y }, center, rotation);
      const rotatedAnchor = rotatePoint(pagePoint(width, height, anchor.x, anchor.y), center, rotation);
      drawSegment(page, topCenter, rotatedAnchor, stroke, colour(mark.color), safeOpacity(mark.opacity, 1));
      if (mark.text?.trim()) {
        const size = Math.max(6, Math.min(18, rect.height * 0.3));
        const textBox = estimateTextBox(mark.text.trim(), size);
        const textWidth = Math.min(textBox.width, Math.max(1, rect.width - 8));
        const origin = centeredRotatedOrigin(center, textWidth, size, rotation);
        page.drawText(mark.text.trim(), {
          x: origin.x,
          y: origin.y,
          size,
          color: colour(mark.color),
          maxWidth: Math.max(1, rect.width - 8),
          opacity: safeOpacity(mark.opacity, 1),
          rotate: rotation ? degrees(rotation) : undefined,
        });
      }
    } else {
      if (rotation) {
        page.drawSvgPath(rotatedBoxPath(rect, rotation), {
          color: 'fill' in mark && mark.fill ? colour(mark.fill) : undefined,
          opacity: safeOpacity(mark.opacity, 1),
          borderColor: colour(mark.color ?? '#0f172a'),
          borderWidth: safeStroke(mark.strokeWidth, 1),
        });
      } else {
        page.drawRectangle({
          ...rect,
          borderColor: colour(mark.color ?? '#0f172a'),
          borderWidth: safeStroke(mark.strokeWidth, 1),
          color: 'fill' in mark && mark.fill ? colour(mark.fill) : undefined,
          opacity: safeOpacity(mark.opacity, 1),
        });
      }
    }
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return [{ name: file.name, bytes: Uint8Array.from(bytes).buffer }, ...files.slice(1)];
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

/**
 * Page numbering.
 *
 * The format is a token string rather than a prefix box, matching the header
 * and footer tool — people who have used one should not have to learn a second
 * grammar for the same idea. "Page 3 of 12" is the numbering most documents
 * actually want, and a prefix alone could not express it.
 */
export interface PageNumberOptions {
  /** The number printed on the first numbered page. */
  start: number;
  /** Tokens: {page} and {pages}. */
  format: string;
  position: 'bottom-left' | 'bottom' | 'bottom-right' | 'top-left' | 'top' | 'top-right';
  size: number;
  /** Which pages get a number. Empty means all of them. */
  pages: string;
  /** Leave the cover bare, which is what a title page usually wants. */
  skipFirst: boolean;
}

const NUMBER_DEFAULTS: PageNumberOptions = {
  start: 1,
  format: '{page}',
  position: 'bottom-right',
  size: 11,
  pages: '',
  skipFirst: false,
};

export async function pageNumbers(
  files: InputFile[],
  options: Partial<PageNumberOptions>
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF to number.' };

  const settings: PageNumberOptions = { ...NUMBER_DEFAULTS, ...options };
  if (!Number.isInteger(settings.start) || settings.start < 1) {
    return { ok: false, error: 'The starting number has to be 1 or higher.' };
  }

  const started = performance.now();
  const doc = await load(file);
  const count = doc.getPageCount();

  const chosen = parsePageSet(settings.pages, count).pages
    .filter((number) => !(settings.skipFirst && number === 1));

  if (chosen.length === 0) {
    return {
      ok: false,
      error: settings.skipFirst && count === 1
        ? 'This document is one page, and you asked to leave the first page bare.'
        : `That page selection matches nothing. This document has ${count} pages.`,
    };
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = Math.min(48, Math.max(6, settings.size));
  const margin = Math.max(18, size * 2);
  const total = chosen.length;

  chosen.forEach((number, index) => {
    const page = doc.getPage(number - 1);
    const { width, height } = page.getSize();
    // The printed number counts the numbered pages, so "3 of 12" stays true
    // when a cover is skipped or a range is numbered.
    const label = settings.format
      .replace(/\{page\}/g, String(settings.start + index))
      .replace(/\{pages\}/g, String(settings.start + total - 1));

    const textWidth = font.widthOfTextAtSize(label, size);
    const bottom = settings.position.startsWith('bottom');
    const y = bottom ? margin - size * 0.3 : height - margin;
    const x = settings.position.endsWith('left')
      ? margin
      : settings.position.endsWith('right')
        ? width - margin - textWidth
        : (width - textWidth) / 2;

    page.drawText(label, { x, y, size, font, color: rgb(0.18, 0.18, 0.18) });
  });

  const notes: string[] = [];
  if (settings.skipFirst) notes.push('The first page is left bare, so a cover stays clean.');
  if (chosen.length < count) {
    notes.push(`${chosen.length} of ${count} pages were numbered. The rest are untouched.`);
  }

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-numbered.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages: count,
    durationMs: performance.now() - started,
    summary: `Numbered ${chosen.length} page${chosen.length === 1 ? '' : 's'}`,
    notes,
  };
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
