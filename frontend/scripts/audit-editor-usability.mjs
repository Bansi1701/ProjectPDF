import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';
import { join } from 'node:path';

const base = process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4331';
const doc = await PDFDocument.create();
doc.addPage([520, 720]).drawText('Original document stays intact', { x: 32, y: 670, size: 16 });
doc.addPage([520, 720]).drawText('Second page', { x: 32, y: 670, size: 16 });
const fixture = Buffer.from(await doc.save());
const measureFont = await doc.embedFont(StandardFonts.Helvetica);
const browser = await chromium.launch({ headless: true });
const readMarks = page => page.locator('live-pdf-editor').evaluate(editor => editor.getEdits());
const openMenu = async (page, name) => page.locator(name === 'signature' ? '[data-editor-signature-trigger]' : `[data-editor-menu-trigger="${name}"]`).click();
const showOptions = async page => { if (!await page.locator('.editor__properties').evaluate(panel => panel.open)) await page.locator('.editor__properties > summary').click(); };
const place = async page => {
  const overlay = page.locator('[data-editor-overlay]');
  await overlay.scrollIntoViewIfNeeded();
  const b = await overlay.boundingBox();
  await overlay.click({ position: { x: b.width * .2, y: b.height * .25 } });
};
const drag = async page => {
  const overlay = page.locator('[data-editor-overlay]');
  await overlay.scrollIntoViewIfNeeded();
  const b = await overlay.boundingBox();
  await page.mouse.move(b.x + b.width * .25, b.y + b.height * .3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * .6, b.y + b.height * .45, { steps: 8 });
  await page.mouse.up();
};
try {
  for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 760 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/edit-pdf/`);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('[data-input]').setInputFiles({ name: 'editor-test.pdf', mimeType: 'application/pdf', buffer: fixture });
    await page.locator('[data-editor-loading]').waitFor({ state: 'hidden', timeout: 30000 });
    await page.locator('[data-editor-action="insert-text"]').first().click();
    await place(page);
    const input = page.locator('[data-editor-onpage-text]');
    assert.ok(await input.isVisible(), 'Place an empty box before typing');
    assert.equal(await input.inputValue(), '', 'A new text box is blank');
    assert.equal(await input.getAttribute('placeholder'), null, 'No sample text inside the box');
    await page.locator('[data-editor-inline-size]').fill('24');
    await page.locator('[data-editor-inline-size]').press('Tab');
    assert.ok(await input.isVisible(), 'A blank box must survive focusing and changing the font size');
    assert.equal(await page.locator('[data-editor-inline-size]').inputValue(), '24');
    const emptyFrame = page.locator('[data-editor-text-frame]');
    await emptyFrame.scrollIntoViewIfNeeded();
    const startWidth = (await emptyFrame.boundingBox()).width;
    const edge = await page.locator('[data-text-handle="e"]').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 25, edge.y + edge.height / 2, { steps: 6 }); await page.mouse.up();
    assert.ok((await emptyFrame.boundingBox()).width > startWidth, 'Resize a blank text box before typing');
    assert.equal(await input.inputValue(), '');
    assert.equal((await readMarks(page)).length, 0, 'Blank boxes are not exported');
    const startX = (await emptyFrame.boundingBox()).x;
    const mover = page.locator('[data-text-move]'); await mover.scrollIntoViewIfNeeded(); const moveBounds = await mover.boundingBox();
    await page.mouse.move(moveBounds.x + moveBounds.width / 2, moveBounds.y + moveBounds.height / 2); await page.mouse.down();
    await page.mouse.move(moveBounds.x + moveBounds.width / 2 + 15, moveBounds.y + moveBounds.height / 2 + 10, { steps: 5 }); await page.mouse.up();
    assert.ok((await emptyFrame.boundingBox()).x > startX, 'Move bar works before typing');
    await page.locator('[data-editor-inline-size]').fill('');
    assert.ok(await input.isVisible(), 'Clearing the size field must not delete the box');
    await page.locator('[data-editor-inline-size]').fill('24'); await page.locator('[data-editor-inline-size]').press('Tab');
    const text = 'First line\nSecond line wraps neatly across this text box.';
    await input.fill(text);
    assert.equal((await readMarks(page))[0].text, text);
    assert.ok(await input.isVisible(), 'Typing must not dismiss the on-page editor');
    await page.locator('[data-editor-text-done]').click();
    await page.locator('[data-editor-inline-size]').fill('19');
    await page.locator('[data-editor-inline-size]').press('Tab');
    await page.locator('[data-editor-inline-color]').evaluate(input => { input.value = '#1267b1'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    let mark = (await readMarks(page))[0];
    assert.equal(mark.size, 19); assert.equal(mark.color, '#1267b1');
    const previewWidth = await page.locator('text.editor-mark tspan').first().evaluate(span => span.getBoundingClientRect().width);
    const pageWidth = (await page.locator('[data-editor-overlay]').boundingBox()).width;
    assert.ok(Math.abs(previewWidth - measureFont.widthOfTextAtSize('First line', 19) / 520 * pageWidth) < 1, 'Preview uses the same glyph width as the PDF export');
    await page.locator('[data-editor-text-done]').click();
    await input.fill(`${text}\nEdit again`);
    await input.press('Escape');
    assert.equal((await readMarks(page))[0].text, text, 'Escape cancels the current text session');
    await showOptions(page);
    await page.locator('[data-editor-size]').fill(''); await page.locator('[data-editor-size]').press('Tab');
    await page.locator('[data-editor-w]').fill('40'); await page.locator('[data-editor-w]').press('Tab');
    assert.equal((await readMarks(page))[0].size, 19, 'An empty numeric field never shrinks text to an invisible size');
    assert.equal((await readMarks(page))[0].text, text, 'Object settings must preserve newlines in on-page text');
    await page.locator('[data-editor-duplicate]').click();
    assert.equal((await readMarks(page)).length, 2);
    await page.locator('[data-editor-undo]').click();
    assert.equal((await readMarks(page)).length, 1);
    await page.locator('[data-editor-redo]').click();
    assert.equal((await readMarks(page)).length, 2);
    await page.locator('[data-editor-undo]').click();
    for (const menu of ['comment', 'markup', 'draw', 'stamp', 'signature']) {
      await openMenu(page, menu);
      const panel = page.locator(menu === 'signature' ? '#editor-signature-panel' : `[data-editor-menu="${menu}"]`);
      const b = await panel.boundingBox();
      assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= width + 1 && b.y + b.height <= 901, `${menu} fits ${width}px`);
      if (process.env.EDITOR_SCREENSHOT_DIR && menu === 'draw') await page.screenshot({ path: join(process.env.EDITOR_SCREENSHOT_DIR, `editor-menu-${theme}-${width}.png`) });
      await panel.locator('button').first().focus();
      await page.keyboard.press('ArrowDown');
      assert.ok(await panel.evaluate(element => element.contains(document.activeElement)));
      await page.keyboard.press('Escape');
      assert.equal(await panel.isVisible(), false);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.locator('[data-run]').click();
    await page.locator('[data-result]').waitFor({ state: 'visible', timeout: 30000 });
    const bytes = await page.locator('[data-file-download]').first().evaluate(async a => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
    const exported = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true }).promise;
    assert.equal(exported.numPages, 2);
    const items = (await (await exported.getPage(1)).getTextContent()).items.filter(item => 'str' in item);
    const outputText = items.map(item => item.str).join(' ');
    assert.match(outputText, /Original document stays intact/);
    assert.match(outputText, /First line/);
    assert.match(outputText, /Second line/);
    assert.ok(items.some(item => item.str.includes('First line') && Math.abs(item.height - 19) < .1), 'Export preserves the selected font size');
    await exported.loadingTask.destroy();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS editor typing, multiline export, style changes, undo/redo and menus: ${theme} ${width}px`);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`${base}/edit-pdf/`);
  await page.locator('[data-input]').setInputFiles({ name: 'all-tools.pdf', mimeType: 'application/pdf', buffer: fixture });
  await page.locator('[data-editor-loading]').waitFor({ state: 'hidden', timeout: 30000 });
  const actions = {
    comment: ['comment', 'replace', 'text-comment', 'insert-text'],
    markup: ['highlight', 'underline', 'strike'],
    draw: ['ink', 'line', 'arrow', 'rectangle', 'circle', 'callout', 'polygon', 'cloud'],
    stamp: ['text', 'check', 'cross', 'dot', 'circle-stamp', 'crossout'],
  };
  for (const [menu, tools] of Object.entries(actions)) for (const action of tools) {
    await openMenu(page, menu);
    await page.locator(`[data-editor-menu="${menu}"] [data-editor-action="${action}"]`).click();
    const typing = ['comment', 'text-comment', 'insert-text', 'text'].includes(action);
    if (typing || menu === 'stamp') await place(page); else await drag(page);
    if (typing) { await page.locator('[data-editor-onpage-text]').fill(`Test ${action}`); await page.locator('[data-editor-text-done]').click(); }
    assert.equal((await readMarks(page)).length, 1, `${action} places one mark`);
    await showOptions(page);
    await page.locator('[data-editor-color]').evaluate(input => { input.value = '#1267b1'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal((await readMarks(page))[0].color, '#1267b1', `${action} can be recolored after placement`);
    await page.locator('[data-editor-duplicate]').click();
    assert.equal((await readMarks(page)).length, 2);
    await page.locator('[data-editor-delete]').first().click();
    await page.locator('[data-editor-undo]').click();
    assert.equal((await readMarks(page)).length, 2);
    // Reset the test fixture through the editor's normal file-open contract.
    await page.locator('[data-input]').setInputFiles({ name: 'all-tools.pdf', mimeType: 'application/pdf', buffer: fixture });
    await page.locator('[data-editor-loading]').waitFor({ state: 'hidden', timeout: 30000 });
    console.log(`PASS editor action ${action}: place, recolor, duplicate, delete and undo`);
  }
  const reset = async () => {
    await page.locator('[data-input]').setInputFiles({ name: 'all-tools.pdf', mimeType: 'application/pdf', buffer: fixture });
    await page.locator('[data-editor-loading]').waitFor({ state: 'hidden', timeout: 30000 });
  };
  await page.locator('[data-editor-tool="whiteout"]').click();
  await drag(page);
  assert.equal((await readMarks(page))[0].kind, 'whiteout');
  await reset();
  for (const kind of ['signature', 'initials', 'date', 'drawn', 'upload']) {
    await openMenu(page, 'signature');
    if (['signature', 'initials', 'date'].includes(kind)) {
      await page.locator('[data-editor-signature-text]').fill('Test Example');
      await page.locator(`[data-editor-signature-kind="${kind}"]`).click();
      await place(page);
    } else if (kind === 'drawn') {
      const pad = page.locator('[data-editor-signature-canvas]');
      await pad.scrollIntoViewIfNeeded();
      const b = await pad.boundingBox();
      await page.mouse.move(b.x + 20, b.y + 20); await page.mouse.down();
      await page.mouse.move(b.x + 80, b.y + 50, { steps: 8 });
      await page.mouse.move(b.x + 150, b.y + 20, { steps: 8 }); await page.mouse.up();
      await page.locator('[data-editor-signature-drawn]').click();
      await place(page);
    } else {
      // Synthetic mark only; never use a person's signature in a regression fixture.
      const data = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 80;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 240, 80);
        ctx.strokeStyle = '#111111'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(20, 50); ctx.lineTo(80, 20); ctx.lineTo(160, 50); ctx.stroke();
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await page.locator('[data-editor-signature-file]').setInputFiles({ name: 'synthetic-mark.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
      await page.waitForFunction(() => document.querySelector('[data-editor-overlay]').dataset.tool === 'signature');
      await place(page);
    }
    const mark = (await readMarks(page))[0];
    assert.ok(mark && mark.kind.startsWith('signature'), `${kind} places a signature`);
    if (kind === 'date') assert.equal(mark.signatureRole, 'date');
    await page.locator('[data-editor-signature-size-select]').selectOption('large');
    assert.ok((await readMarks(page))[0].width > mark.width, `${kind} has working size presets`);
    await page.locator('[data-editor-x]').fill('35'); await page.locator('[data-editor-x]').press('Tab');
    assert.ok(Math.abs((await readMarks(page))[0].x - .35) < .01);
    await page.locator('[data-editor-duplicate]').click();
    assert.equal((await readMarks(page)).length, 2);
    await reset();
    console.log(`PASS ${kind} signature: create, resize, reposition and duplicate`);
  }
  await page.locator('[data-editor-action="insert-text"]').first().click(); await place(page);
  await page.locator('[data-editor-onpage-text]').fill('Rotate and resize this box');
  await page.locator('[data-editor-text-done]').click();
  const before = (await readMarks(page))[0];
  const handle = page.locator('[data-text-handle="e"]');
  await handle.scrollIntoViewIfNeeded(); const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 70, h.y + h.height / 2, { steps: 6 }); await page.mouse.up();
  assert.ok((await readMarks(page))[0].width > before.width, 'Text resize handle changes box width');
  assert.equal((await readMarks(page))[0].size, before.size, 'Resizing a text box does not squash its font');
  await showOptions(page);
  await page.locator('[data-editor-rotation]').fill('45'); await page.locator('[data-editor-rotation]').press('Tab');
  assert.equal((await readMarks(page))[0].rotation, 45);
  assert.match(await page.locator('text.editor-mark').getAttribute('transform'), /^matrix\(/, 'Rotation accounts for portrait page proportions');
  await page.locator('[data-editor-text-done]').click();
  assert.match(await page.locator('[data-editor-onpage-text]').getAttribute('style'), /rotate\(45deg\)/);
  await page.locator('[data-editor-text-done]').click();
  const count = (await readMarks(page)).length;
  await page.locator('[data-editor-tool="pan"]').click(); await drag(page);
  assert.equal((await readMarks(page)).length, count, 'Panning does not create edits');
  await page.locator('[data-editor-zoom-reset]').click();
  assert.equal(await page.locator('[data-editor-zoom]').innerText(), '100%');
  console.log('PASS whiteout, box resize, rotation, pan and Fit');
} finally { await browser.close(); }
