import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

import { crop } from '../src/lib/pdf/crop';
import { editDocument, pageNumbers } from '../src/lib/pdf/edit';
import { fillForm, probeForm } from '../src/lib/pdf/forms';
import { flattenPdf } from '../src/lib/pdf/flatten';
import { headerFooter } from '../src/lib/pdf/headerfooter';
import { impose } from '../src/lib/pdf/impose';
import { readMetadata, writeMetadata } from '../src/lib/pdf/metadata';
import { deletePages, extract, merge, reorder, rotate, split } from '../src/lib/pdf/organise';
import { overlay } from '../src/lib/pdf/overlay';
import { compose } from '../src/lib/pdf/pageplan';
import { repair } from '../src/lib/pdf/archive';
import { protect, unlock } from '../src/lib/pdf/security';
import { signPdf } from '../src/lib/pdf/sign';
import { textDocToPdf } from '../src/lib/pdf/textdoc';
import type { InputFile, OpResult, OpSuccess } from '../src/lib/pdf/types';
import { watermark } from '../src/lib/pdf/watermark';

const checks: string[] = [];

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function input(name: string, bytes: Uint8Array): InputFile {
  return { name, bytes: bufferOf(bytes) };
}

function pass(name: string): void {
  checks.push(name);
  process.stdout.write(`✓ ${name}\n`);
}

function success(result: OpResult, operation: string): OpSuccess {
  if (!result.ok) throw new Error(`${operation} failed: ${result.error}`);
  assert.equal('files' in result, true, `${operation} did not produce a file`);
  const output = result as OpSuccess;
  assert.ok(output.files.length > 0, `${operation} produced an empty output list`);
  assert.ok(output.files.every((file) => file.bytes.length > 8), `${operation} produced an empty file`);
  return output;
}

async function pageCount(bytes: Uint8Array, password?: string): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: !password, password });
  return doc.getPageCount();
}

async function makePdf(name: string, widths: number[], form = false): Promise<InputFile> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle(`${name} title`);
  doc.setAuthor('ProjectPDF smoke test');
  widths.forEach((width, index) => {
    const page = doc.addPage([width, 720]);
    page.drawText(`${name} page ${index + 1}`, { x: 42, y: 660, size: 18, font });
  });
  if (form) {
    const field = doc.getForm().createTextField('ClientName');
    field.setText('Before');
    field.addToPage(doc.getPage(0), { x: 42, y: 590, width: 180, height: 28, font });
  }
  return input(`${name}.pdf`, await doc.save({ useObjectStreams: true, addDefaultPage: false }));
}

async function main(): Promise<void> {
const alpha = await makePdf('alpha', [500, 510, 520]);
const beta = await makePdf('beta', [600, 610]);
const formPdf = await makePdf('form', [540], true);
const signaturePng = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR42mNk+M/wn4GBgYGJAQoAHgQCAcf3O7sAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0)
);

{
  const out = success(await merge([alpha, beta]), 'merge');
  assert.equal(await pageCount(out.files[0].bytes), 5);
  pass('merge preserves every page');
}

{
  const out = success(await split([alpha], '1-2,3'), 'split');
  assert.deepEqual(await Promise.all(out.files.map((file) => pageCount(file.bytes))), [2, 1]);
  pass('split creates the requested groups');
}

{
  const out = success(await rotate([alpha], 90, '2'), 'rotate');
  const doc = await PDFDocument.load(out.files[0].bytes);
  assert.deepEqual(doc.getPages().map((page) => page.getRotation().angle), [0, 90, 0]);
  pass('rotate changes only selected pages');
}

{
  const out = success(await reorder([alpha], [2, 0, 1]), 'reorder');
  const doc = await PDFDocument.load(out.files[0].bytes);
  assert.deepEqual(doc.getPages().map((page) => Math.round(page.getWidth())), [520, 500, 510]);
  pass('reorder follows the visual page order');
}

{
  const extracted = success(await extract([alpha], '2-3'), 'extract');
  const deleted = success(await deletePages([alpha], '2'), 'delete');
  assert.equal(await pageCount(extracted.files[0].bytes), 2);
  assert.equal(await pageCount(deleted.files[0].bytes), 2);
  pass('extract and delete keep the correct page counts');
}

{
  const out = success(
    await compose(
      [alpha, beta],
      [
        { file: 1, page: 2, rotate: 90 },
        { file: 0, page: 1, rotate: 0 },
        { file: 0, page: 3, rotate: 0 },
      ],
      [2],
      'plan'
    ),
    'compose'
  );
  assert.deepEqual(await Promise.all(out.files.map((file) => pageCount(file.bytes))), [2, 1]);
  pass('shared page plan composes, rotates, and cuts');
}

{
  const out = success(
    await editDocument([alpha], [
      { id: 'text-1', kind: 'text', page: 1, x: 0.1, y: 0.15, text: 'Reviewed', size: 18, color: '#0f172a' },
      { id: 'box-1', kind: 'rectangle', page: 2, x: 0.2, y: 0.2, width: 0.3, height: 0.2, color: '#e11d48', strokeWidth: 2 },
    ]),
    'edit'
  );
  assert.equal(await pageCount(out.files[0].bytes), 3);
  pass('edit applies independent marks to pages');
}

{
  const mark = success(await watermark([alpha], { text: 'DRAFT', kind: 'text' }), 'watermark');
  const numbered = success(await pageNumbers([alpha], { start: 7, format: 'Page {page} of {pages}' }), 'page numbers');
  const headed = success(
    await headerFooter([alpha], { header: { left: 'ProjectPDF', right: '{page}/{pages}' }, bates: { prefix: 'TEST-' } }),
    'header/footer'
  );
  assert.equal(await pageCount(mark.files[0].bytes), 3);
  assert.equal(await pageCount(numbered.files[0].bytes), 3);
  assert.equal(await pageCount(headed.files[0].bytes), 3);
  pass('watermark, page numbers, headers and Bates produce valid PDFs');
}

{
  const out = success(await overlay([alpha, beta], { mode: 'repeat', fit: 'contain', opacity: 0.25 }), 'overlay');
  assert.equal(await pageCount(out.files[0].bytes), 3);
  pass('overlay repeats a stamp without changing page count');
}

{
  const probe = await probeForm([formPdf]);
  assert.equal(probe.ok, true);
  assert.equal('fields' in probe && probe.fields?.[0]?.name, 'ClientName');
  const filled = success(await fillForm([formPdf], { ClientName: 'After' }, false), 'fill form');
  const reopened = await PDFDocument.load(filled.files[0].bytes);
  assert.equal(reopened.getForm().getTextField('ClientName').getText(), 'After');
  const flattened = success(await flattenPdf([formPdf], { fields: true, annotations: true, layers: true }), 'flatten');
  const flatDoc = await PDFDocument.load(flattened.files[0].bytes);
  assert.equal(flatDoc.getForm().getFields().length, 0);
  pass('forms probe, fill and flatten round-trip');
}

{
  const signed = success(await signPdf([alpha], bufferOf(signaturePng), 2, 'bottom-right', 120), 'sign');
  assert.equal(await pageCount(signed.files[0].bytes), 3);
  pass('visual signature is placed on the selected page');
}

{
  const permissions = { printing: false, copying: false, modifying: false, annotating: false };
  const protectedPdf = success(await protect([alpha], 'Correct-Horse-42!', '', permissions), 'protect');
  const unlocked = success(await unlock([input('protected.pdf', protectedPdf.files[0].bytes)], 'Correct-Horse-42!'), 'unlock');
  assert.equal(await pageCount(unlocked.files[0].bytes), 3);
  pass('protect and unlock round-trip with the user password');
}

{
  const cropped = success(await crop([alpha], { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, [1]), 'crop');
  const doc = await PDFDocument.load(cropped.files[0].bytes);
  assert.ok(doc.getPage(0).getWidth() < 500);
  assert.equal(Math.round(doc.getPage(1).getWidth()), 510);
  pass('crop changes only selected page boxes');
}

{
  const nup = success(await impose([alpha], { kind: 'n-up', perSheet: 2, sheet: 'letter' }), 'n-up');
  assert.equal(await pageCount(nup.files[0].bytes), 2);
  pass('N-up produces the expected sheets');
}

{
  const textPdf = success(
    await textDocToPdf([input('notes.md', new TextEncoder().encode('# Test\n\n- private\n- fast'))], { kind: 'markdown' }),
    'text to PDF'
  );
  assert.ok((await pageCount(textPdf.files[0].bytes)) >= 1);
  pass('text inputs convert into readable PDFs');
}

{
  const changed = success(await writeMetadata([alpha], { fields: { title: 'Audited title', author: 'QA' } }), 'metadata write');
  const report = await readMetadata([input('changed.pdf', changed.files[0].bytes)]);
  assert.equal(report.ok, true);
  assert.equal(report.ok && report.title, 'Audited title');
  pass('metadata write is confirmed by a fresh read');
}

{
  const rebuilt = success(await repair([alpha]), 'repair');
  assert.equal(await pageCount(rebuilt.files[0].bytes), 3);
  pass('repair output reopens successfully');
}

assert.equal(checks.length, 17);
process.stdout.write(`Operation smoke: ${checks.length} groups passed.\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
