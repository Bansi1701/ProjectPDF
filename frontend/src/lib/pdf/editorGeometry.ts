export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type Manipulator = 'move' | 'rotate' | ResizeHandle | 'line-start' | 'line-end' | 'callout-anchor';

export const HANDLE_ORDER: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const GUIDE_STOPS = [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1];

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clampRect(rect: Rect, minSize = 0.01): Rect {
  const safeMinimum = Math.max(0.001, Math.min(1, minSize));
  const x = Math.max(0, Math.min(1 - safeMinimum, Number.isFinite(rect.x) ? rect.x : 0));
  const y = Math.max(0, Math.min(1 - safeMinimum, Number.isFinite(rect.y) ? rect.y : 0));
  const requestedWidth = Number.isFinite(rect.width) ? rect.width : safeMinimum;
  const requestedHeight = Number.isFinite(rect.height) ? rect.height : safeMinimum;
  const width = Math.max(safeMinimum, Math.min(1 - x, requestedWidth));
  const height = Math.max(safeMinimum, Math.min(1 - y, requestedHeight));
  return {
    x,
    y,
    width,
    height,
  };
}

export function clampRotatedRect(rect: Rect, rotation = 0, minSize = 0.01): Rect {
  const next = clampRect(rect, minSize);
  const radians = degreesToRadians(rotation);
  const halfWidth = (Math.abs(Math.cos(radians)) * next.width + Math.abs(Math.sin(radians)) * next.height) / 2;
  const halfHeight = (Math.abs(Math.sin(radians)) * next.width + Math.abs(Math.cos(radians)) * next.height) / 2;
  const center = rectCenter(next);
  const cx = Math.max(Math.min(halfWidth, 0.5), Math.min(1 - Math.min(halfWidth, 0.5), center.x));
  const cy = Math.max(Math.min(halfHeight, 0.5), Math.min(1 - Math.min(halfHeight, 0.5), center.y));
  return clampRect({ ...next, x: cx - next.width / 2, y: cy - next.height / 2 }, minSize);
}

export function normalizeRect(start: Point, end: Point, minSize = 0.01): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.max(minSize, Math.abs(end.x - start.x));
  const height = Math.max(minSize, Math.abs(end.y - start.y));
  return clampRect({ x, y, width, height }, minSize);
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  const width = Math.max(0.001, Math.min(1, Number.isFinite(rect.width) ? rect.width : 0.01));
  const height = Math.max(0.001, Math.min(1, Number.isFinite(rect.height) ? rect.height : 0.01));
  return {
    x: Math.max(0, Math.min(1 - width, rect.x + dx)),
    y: Math.max(0, Math.min(1 - height, rect.y + dy)),
    width,
    height,
  };
}

export function resizeRect(rect: Rect, handle: ResizeHandle, next: Point, minSize = 0.02): Rect {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  let x = left;
  let y = top;
  let width = rect.width;
  let height = rect.height;

  if (handle.includes('w')) {
    x = Math.min(next.x, right - minSize);
    width = right - x;
  }
  if (handle.includes('e')) {
    width = Math.max(minSize, next.x - x);
  }
  if (handle.includes('n')) {
    y = Math.min(next.y, bottom - minSize);
    height = bottom - y;
  }
  if (handle.includes('s')) {
    height = Math.max(minSize, next.y - y);
  }

  return clampRect({ x, y, width, height }, minSize);
}

export function resizeFromCenter(rect: Rect, scaleX: number, scaleY: number, minSize = 0.02): Rect {
  const center = rectCenter(rect);
  const width = Math.max(minSize, rect.width * scaleX);
  const height = Math.max(minSize, rect.height * scaleY);
  return clampRect({
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  }, minSize);
}

export function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function snapValue(value: number, guides: number[], threshold = 0.018, disabled = false): { value: number; guide: number | null } {
  if (disabled) return { value, guide: null };
  let best = value;
  let guide: number | null = null;
  let bestDistance = threshold;
  for (const candidate of guides) {
    const distance = Math.abs(candidate - value);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = candidate;
      guide = candidate;
    }
  }
  return { value: best, guide };
}

export function snapRect(rect: Rect, snapX: number[] = GUIDE_STOPS, snapY: number[] = GUIDE_STOPS, threshold = 0.018, disabled = false): { rect: Rect; guides: { x: number[]; y: number[] } } {
  const horizontal: number[] = [];
  const vertical: number[] = [];
  const left = snapValue(rect.x, snapX, threshold, disabled);
  if (left.guide !== null) vertical.push(left.guide);
  const top = snapValue(rect.y, snapY, threshold, disabled);
  if (top.guide !== null) horizontal.push(top.guide);
  const right = snapValue(rect.x + rect.width, snapX, threshold, disabled);
  if (right.guide !== null) vertical.push(right.guide);
  const bottom = snapValue(rect.y + rect.height, snapY, threshold, disabled);
  if (bottom.guide !== null) horizontal.push(bottom.guide);
  return {
    rect: clampRect({
      x: left.value,
      y: top.value,
      width: Math.max(0.02, right.value - left.value),
      height: Math.max(0.02, bottom.value - top.value),
    }),
    guides: { x: vertical, y: horizontal },
  };
}

/** Snap a moving rectangle without changing its width or height. */
export function snapTranslatedRect(rect: Rect, snapX: number[] = GUIDE_STOPS, snapY: number[] = GUIDE_STOPS, threshold = 0.018, disabled = false): { rect: Rect; guides: { x: number[]; y: number[] } } {
  if (disabled) return { rect: clampRect(rect), guides: { x: [], y: [] } };
  const center = rectCenter(rect);
  const xCandidates = [rect.x, center.x, rect.x + rect.width];
  const yCandidates = [rect.y, center.y, rect.y + rect.height];
  let bestX: { delta: number; guide: number } | null = null;
  let bestY: { delta: number; guide: number } | null = null;
  for (const value of xCandidates) {
    const snapped = snapValue(value, snapX, threshold);
    if (snapped.guide === null) continue;
    const candidate = { delta: snapped.value - value, guide: snapped.guide };
    if (!bestX || Math.abs(candidate.delta) < Math.abs(bestX.delta)) bestX = candidate;
  }
  for (const value of yCandidates) {
    const snapped = snapValue(value, snapY, threshold);
    if (snapped.guide === null) continue;
    const candidate = { delta: snapped.value - value, guide: snapped.guide };
    if (!bestY || Math.abs(candidate.delta) < Math.abs(bestY.delta)) bestY = candidate;
  }
  return {
    rect: translateRect(rect, bestX?.delta ?? 0, bestY?.delta ?? 0),
    guides: { x: bestX ? [bestX.guide] : [], y: bestY ? [bestY.guide] : [] },
  };
}

export function handleCenters(rect: Rect): Record<ResizeHandle, Point> {
  const { x, y, width, height } = rect;
  return {
    nw: { x, y },
    n: { x: x + width / 2, y },
    ne: { x: x + width, y },
    e: { x: x + width, y: y + height / 2 },
    se: { x: x + width, y: y + height },
    s: { x: x + width / 2, y: y + height },
    sw: { x, y: y + height },
    w: { x, y: y + height / 2 },
  };
}

export function rotatePoint(point: Point, center: Point, radians: number): Point {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
