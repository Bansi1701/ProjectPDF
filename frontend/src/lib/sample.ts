/**
 * A sample document, built in the browser.
 *
 * Someone who has just landed has no reason to hand a real file to a site they
 * have not tried, and "choose a file" is where most of them leave. So the demo
 * document is generated here rather than downloaded: nothing is fetched, the
 * zero-bytes claim on the homepage stays literally true, and the person can
 * watch the Network tab stay empty while they do it.
 *
 * It is built to actually exercise the tools rather than just fill pages —
 * ruled tables for PDF to Excel, a raster image for Extract images and
 * Compress, headings and emphasis for PDF to Word.
 */
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';

const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const RULE = rgb(0.79, 0.83, 0.88);
const ACCENT = rgb(0.88, 0.11, 0.28);

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 64;

/** A small chart, so the document contains a real raster image. */
function chartPng(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 420;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 720, 420);

  const bars = [148, 196, 172, 240, 288, 264, 332, 380];
  const width = 56;
  const gap = 30;
  bars.forEach((value, i) => {
    const x = 70 + i * (width + gap);
    const height = value * 0.82;
    ctx.fillStyle = i === bars.length - 1 ? '#e11d48' : '#cbd5e1';
    ctx.fillRect(x, 360 - height, width, height);
    ctx.fillStyle = '#64748b';
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Q${(i % 4) + 1}`, x + width / 2, 385);
  });

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(56, 360.5);
  ctx.lineTo(690, 360.5);
  ctx.stroke();

  return canvas.toDataURL('image/png');
}

const LOREM = [
  'This document was generated inside your browser a moment ago. No copy of it was',
  'downloaded, and no request was made to fetch it — open the Network tab and try',
  'again if you would like to watch that happen, or rather, not happen.',
  '',
  'It exists so you can try any tool on this site without going to find a file of your',
  'own first. Merge it, split it, sign it, convert it to Word, pull the chart out of it,',
  'or protect it with a password. Whatever you do, the work happens on this device.',
];

const ROWS: [string, string, string, string][] = [
  ['Region', 'Units', 'Revenue', 'Change'],
  ['North', '1,284', '£184,220', '+12.4%'],
  ['South', '968', '£139,510', '+4.1%'],
  ['East', '1,533', '£221,890', '+18.7%'],
  ['West', '742', '£106,340', '−2.8%'],
  ['Central', '1,109', '£158,770', '+7.2%'],
  ['Overseas', '486', '£ 71,455', '+21.3%'],
  ['Total', '6,122', '£882,185', '+10.9%'],
];

export async function sampleDocument(): Promise<File> {
  const doc = await PDFDocument.create();
  doc.setTitle('Sample document');
  doc.setAuthor('HatePDF');
  doc.setSubject('A demonstration file, generated in the browser');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  // ── 1. Cover ──────────────────────────────────────────────────────────────
  const cover = doc.addPage(A4);
  cover.drawText('Sample', { x: MARGIN, y: 620, size: 64, font: bold, color: INK });
  cover.drawText('document', { x: MARGIN, y: 552, size: 64, font: bold, color: ACCENT });
  cover.drawRectangle({ x: MARGIN, y: 520, width: 120, height: 3, color: ACCENT });
  cover.drawText('Made in your browser, for trying things out', {
    x: MARGIN, y: 480, size: 14, font: italic, color: MUTED,
  });
  cover.drawText('Five pages · text, a table, and a picture', {
    x: MARGIN, y: 456, size: 12, font: regular, color: MUTED,
  });

  // ── 2. Prose ──────────────────────────────────────────────────────────────
  const prose = doc.addPage(A4);
  prose.drawText('About this file', { x: MARGIN, y: 760, size: 26, font: bold, color: INK });
  LOREM.forEach((line, i) => {
    if (!line) return;
    prose.drawText(line, { x: MARGIN, y: 710 - i * 20, size: 11.5, font: regular, color: INK });
  });
  prose.drawText('What it is good for', { x: MARGIN, y: 540, size: 16, font: bold, color: INK });
  [
    'The table on page three has ruling lines, which is what PDF to Excel looks for.',
    'The chart on page four is a real embedded image, so Extract images will find it.',
    'The headings here are set in a bold font, so PDF to Word keeps them as headings.',
  ].forEach((line, i) => {
    prose.drawText('•', { x: MARGIN, y: 508 - i * 20, size: 11.5, font: regular, color: ACCENT });
    prose.drawText(line, { x: MARGIN + 14, y: 508 - i * 20, size: 11.5, font: regular, color: INK });
  });

  // ── 3. A ruled table ──────────────────────────────────────────────────────
  const table = doc.addPage(A4);
  table.drawText('Results by region', { x: MARGIN, y: 760, size: 26, font: bold, color: INK });

  const columns = [MARGIN, MARGIN + 150, MARGIN + 250, MARGIN + 370, MARGIN + 467];
  const rowHeight = 30;
  const top = 700;

  ROWS.forEach((row, r) => {
    const y = top - r * rowHeight;
    // Horizontal rule above every row, and one under the last.
    table.drawLine({
      start: { x: columns[0], y: y + 18 },
      end: { x: columns[4], y: y + 18 },
      thickness: r === 0 || r === 1 || r === ROWS.length - 1 ? 1 : 0.5,
      color: r === 0 || r === ROWS.length - 1 ? INK : RULE,
    });
    row.forEach((cell, c) => {
      table.drawText(cell, {
        x: columns[c] + 8,
        y,
        size: 11,
        font: r === 0 || r === ROWS.length - 1 ? bold : regular,
        color: INK,
      });
    });
  });

  table.drawLine({
    start: { x: columns[0], y: top - (ROWS.length - 1) * rowHeight - 12 },
    end: { x: columns[4], y: top - (ROWS.length - 1) * rowHeight - 12 },
    thickness: 1,
    color: INK,
  });

  // Vertical rules, so the grid is unambiguous to a table detector.
  columns.forEach((x) => {
    table.drawLine({
      start: { x, y: top + 18 },
      end: { x, y: top - (ROWS.length - 1) * rowHeight - 12 },
      thickness: 0.5,
      color: RULE,
    });
  });

  // ── 4. A picture ──────────────────────────────────────────────────────────
  const figure = doc.addPage(A4);
  figure.drawText('Quarterly units', { x: MARGIN, y: 760, size: 26, font: bold, color: INK });
  const dataUrl = chartPng();
  if (dataUrl) {
    const png = await doc.embedPng(dataUrl);
    const width = A4[0] - MARGIN * 2;
    figure.drawImage(png, {
      x: MARGIN,
      y: 460,
      width,
      height: (width * png.height) / png.width,
    });
  }
  figure.drawText('Figure 1 — a real raster image, not vector shapes.', {
    x: MARGIN, y: 430, size: 10.5, font: italic, color: MUTED,
  });

  // ── 5. Signature block ────────────────────────────────────────────────────
  const last = doc.addPage(A4);
  last.drawText('Approval', { x: MARGIN, y: 760, size: 26, font: bold, color: INK });
  last.drawText('Nothing here is binding. It is a place to try the signing tool.', {
    x: MARGIN, y: 720, size: 11.5, font: regular, color: INK,
  });
  last.drawLine({
    start: { x: MARGIN, y: 600 }, end: { x: MARGIN + 220, y: 600 }, thickness: 1, color: INK,
  });
  last.drawText('Signature', { x: MARGIN, y: 582, size: 10, font: regular, color: MUTED });
  last.drawLine({
    start: { x: MARGIN + 260, y: 600 }, end: { x: MARGIN + 420, y: 600 }, thickness: 1, color: INK,
  });
  last.drawText('Date', { x: MARGIN + 260, y: 582, size: 10, font: regular, color: MUTED });

  const bytes = await doc.save();
  return new File([bytes as BlobPart], 'sample-document.pdf', { type: 'application/pdf' });
}
