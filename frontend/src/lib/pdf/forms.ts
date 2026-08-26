/**
 * PDF forms: read the fields, fill them, optionally flatten.
 *
 * Two things make this harder than it looks.
 *
 * A filled field shows nothing until its APPEARANCE STREAM is regenerated.
 * The value lives in the field dictionary; what a reader draws is a separate
 * cached stream. Set one without the other and the document is correct and
 * blank — Acrobat regenerates on open and hides the bug, while most other
 * viewers, and every print pipeline, do not.
 *
 * And XFA is not AcroForm. An XFA document keeps its real form in an XML
 * stream the page never references, so a filled AcroForm field is ignored
 * entirely. There is no permissive browser implementation, so those are
 * refused rather than half-handled.
 */
import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
} from '@cantoo/pdf-lib';

import type { FormField, InputFile, OpResult, ProbeSuccess } from './types';

const baseName = (name: string): string => name.replace(/\.pdf$/i, '');

function isXfa(doc: PDFDocument): boolean {
  const acro = doc.catalog.get(PDFName.of('AcroForm'));
  const dict = acro ? doc.context.lookupMaybe(acro, PDFDict) : undefined;
  return dict?.has(PDFName.of('XFA')) ?? false;
}

/** Reads the field list without changing anything. */
export async function probeForm(files: InputFile[]): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message.toLowerCase().includes('encrypt')
        ? 'This PDF is password-protected. Unlock it first.'
        : `This file could not be read as a PDF: ${message}`,
    };
  }

  if (isXfa(doc)) {
    return {
      ok: false,
      error:
        'This is an XFA form. Its fields live in an XML layer that nothing in a browser can fill, and writing to the ordinary fields would be ignored. Adobe Acrobat is the only reliable option for these.',
    };
  }

  const form = doc.getForm();
  const fields: FormField[] = [];

  // Type is checked with `instanceof`, never `constructor.name`: the bundler
  // mangles class names, so a name comparison passes in dev and classifies
  // every field as unsupported in the built site.
  for (const field of form.getFields()) {
    const name = field.getName();

    if (field instanceof PDFTextField) {
      const text = field;
      fields.push({
        name,
        type: 'text',
        value: text.getText() ?? '',
        readOnly: text.isReadOnly(),
        multiline: text.isMultiline(),
      });
      continue;
    }

    if (field instanceof PDFCheckBox) {
      const box = field;
      fields.push({ name, type: 'checkbox', value: box.isChecked() ? 'on' : '', readOnly: box.isReadOnly() });
      continue;
    }

    if (field instanceof PDFDropdown) {
      const dropdown = field;
      fields.push({
        name,
        type: 'dropdown',
        value: dropdown.getSelected()[0] ?? '',
        options: dropdown.getOptions(),
        readOnly: dropdown.isReadOnly(),
      });
      continue;
    }

    if (field instanceof PDFRadioGroup) {
      const radio = field;
      fields.push({
        name,
        type: 'radio',
        value: radio.getSelected() ?? '',
        options: radio.getOptions(),
        readOnly: radio.isReadOnly(),
      });
      continue;
    }

    if (field instanceof PDFOptionList) {
      const list = field;
      fields.push({
        name,
        type: 'dropdown',
        value: list.getSelected()[0] ?? '',
        options: list.getOptions(),
        readOnly: list.isReadOnly(),
      });
      continue;
    }

    // Signature and button fields are listed so the count is honest, but
    // nothing here can fill them.
    fields.push({ name, type: 'unsupported', value: '', readOnly: true });
  }

  return { ok: true, probe: true, pages: doc.getPageCount(), maxDpi: 0, fields } satisfies ProbeSuccess;
}

export async function fillForm(
  files: InputFile[],
  values: Record<string, string>,
  flatten: boolean
): Promise<OpResult> {
  const file = files[0];
  if (!file) return { ok: false, error: 'Choose a PDF.' };

  const started = performance.now();

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (error) {
    return { ok: false, error: `This file could not be read as a PDF: ${(error as Error).message}` };
  }

  if (isXfa(doc)) {
    return { ok: false, error: 'This is an XFA form and cannot be filled here.' };
  }

  const form = doc.getForm();
  let filled = 0;
  const skipped: string[] = [];

  for (const [name, value] of Object.entries(values)) {
    let field;
    try {
      field = form.getField(name);
    } catch {
      skipped.push(name);
      continue;
    }

    try {
      if (field instanceof PDFTextField) {
        field.setText(value);
      } else if (field instanceof PDFCheckBox) {
        if (value) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown) {
        if (value) field.select(value);
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(value);
      } else if (field instanceof PDFOptionList) {
        if (value) field.select(value);
      } else {
        skipped.push(name);
        continue;
      }
      filled += 1;
    } catch (error) {
      skipped.push(`${name} (${(error as Error).message})`);
    }
  }

  // The step that decides whether any of this is visible. Without it the
  // values are in the file and the page renders empty in most viewers.
  try {
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(helvetica);
  } catch {
    // A document whose fields specify a font we cannot embed still keeps its
    // values; NeedAppearances below asks the reader to draw them.
    const acro = doc.catalog.get(PDFName.of('AcroForm'));
    const dict = acro ? doc.context.lookupMaybe(acro, PDFDict) : undefined;
    dict?.set(PDFName.of('NeedAppearances'), doc.context.obj(true));
  }

  if (flatten) form.flatten();

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  const notes: string[] = [];
  if (flatten) {
    notes.push('Flattened: the values are now part of the page and the fields are gone. Nobody can edit them, including you.');
  } else {
    notes.push('The fields are still fields — the document can be edited again later.');
  }
  if (skipped.length > 0) {
    notes.push(`Left alone: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}.`);
  }

  return {
    ok: true,
    files: [{ name: `${baseName(file.name)}-filled.pdf`, bytes }],
    bytesIn: file.bytes.byteLength,
    bytesOut: bytes.length,
    pages: doc.getPageCount(),
    durationMs: performance.now() - started,
    summary: `Filled ${filled} field${filled === 1 ? '' : 's'}`,
    notes,
  };
}
