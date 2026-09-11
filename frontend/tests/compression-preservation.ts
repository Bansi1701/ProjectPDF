import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { compress } from '../src/lib/pdf/compress';
import { snapshotDocument, matchesSnapshot } from '../src/lib/pdf/compressionSafety';
import type { OpResult, OpSuccess } from '../src/lib/pdf/types';

function result(value: OpResult): OpSuccess {
  if (!value.ok || !('files' in value)) throw new Error('Compression failed');
  return value;
}
const input = (bytes: Uint8Array) => [{ name: 'fixture.pdf', bytes: Uint8Array.from(bytes).buffer }];

export async function testCompression() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Preserve metadata');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 595]);
  page.drawText('Keep every word and 0123456789', { x: 30, y: 540, font });
  const field = doc.getForm().createTextField('reference');
  field.setText('ABC-123');
  field.addToPage(page, { x: 30, y: 440, width: 200, height: 30 });
  await doc.attach(new TextEncoder().encode('Keep this attachment'), 'note.txt');
  const bytes = await doc.save({ useObjectStreams: false });
  const original = await PDFDocument.load(bytes, { updateMetadata: false });
  const snapshot = snapshotDocument(original);
  const compressed = result(await compress(input(bytes)));
  assert.equal(compressed.unchanged, false, 'A compressible fixture must actually shrink');
  const reopened = await PDFDocument.load(compressed.files[0].bytes, { updateMetadata: false });
  assert.ok(matchesSnapshot(snapshot, reopened));
  assert.equal(reopened.getTitle(), 'Preserve metadata');
  assert.equal(reopened.getForm().getTextField('reference').getText(), 'ABC-123');
  reopened.getPage(0).setRotation(degrees(90));
  assert.equal(matchesSnapshot(snapshot, reopened), false, 'Same-page-count changes must fail validation');
  const tooSmall = result(await compress(input(bytes), 'lossless', 1));
  assert.equal(tooSmall.targetMet, false);
  assert.match(tooSmall.summary, /Target not reached/);
  const met = result(await compress(input(bytes), 'lossless', bytes.length));
  assert.equal(met.targetMet, true);
  assert.ok(met.bytesOut < bytes.length, 'Still optimize when the input already meets the optional limit');
  assert.ok(matchesSnapshot(snapshot, await PDFDocument.load(met.files[0].bytes, { updateMetadata: false })));
  for (const level of ['maximum', 'balanced', 'minimal'] as const) {
    const safe = result(await compress(input(bytes), 'lossless', undefined, level));
    assert.ok(matchesSnapshot(snapshot, await PDFDocument.load(safe.files[0].bytes, { updateMetadata: false })));
    assert.match(safe.notes![0].toLowerCase(), new RegExp(`${level} compression`));
  }
  assert.equal((await compress(input(bytes), 'lossless', undefined, 'invalid' as never)).ok, false);
  assert.equal((await compress(input(bytes), 'lossless', NaN)).ok, false);
  assert.equal((await compress(input(bytes), 'lossless', -1)).ok, false);
  for (const preset of ['balanced', 'smallest'] as const) {
    const safe = result(await compress(input(bytes), preset));
    assert.ok(matchesSnapshot(snapshot, await PDFDocument.load(safe.files[0].bytes, { updateMetadata: false })));
  }
  doc.catalog.set(PDFName.of('ByteRange'), doc.context.obj([0, 1, 2, 3]));
  const signed = await doc.save({ useObjectStreams: false });
  assert.deepEqual(result(await compress(input(signed))).files[0].bytes, signed);
  doc.catalog.delete(PDFName.of('ByteRange'));
  doc.catalog.set(PDFName.of('XFA'), doc.context.obj('unsupported form'));
  const xfa = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  assert.deepEqual(result(await compress(input(xfa))).files[0].bytes, xfa);

  // Optional private regression input: never check user documents into Git.
  if (process.env.COMPRESSION_INPUT && process.env.COMPRESSION_OUTPUT) {
    const privateBytes = new Uint8Array(await readFile(process.env.COMPRESSION_INPUT));
    const actual = result(await compress(input(privateBytes)));
    await writeFile(process.env.COMPRESSION_OUTPUT, actual.files[0].bytes);
    console.log(JSON.stringify({ compressionRegression: true, input: actual.bytesIn, output: actual.bytesOut, pages: actual.pages, unchanged: actual.unchanged, explanation: actual.explanation }));
  }
}
