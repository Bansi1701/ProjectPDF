import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';

export const FORM_COPY_ERROR = 'This PDF has interactive or unsupported form fields. This operation cannot safely preserve them. Use Flatten first, inspect every visible answer in that saved copy, then choose the flattened PDF here. Keep the editable original. Password-protected or XFA forms may need a compatible form application first.';

/** copyPages copies widgets but not the catalog's field tree. Never silently
 * emit orphaned form widgets. Inspect without getForm(), which creates a form.
 */
export function pageCopySafetyError(document: PDFDocument): string | undefined {
  try {
    const reference = document.catalog.get(PDFName.of('AcroForm'));
    if (reference) {
      const form = document.context.lookup(reference);
      if (!(form instanceof PDFDict) || form.has(PDFName.of('XFA'))) return FORM_COPY_ERROR;
      const fieldsRef = form.get(PDFName.of('Fields'));
      if (fieldsRef) {
        const fields = document.context.lookup(fieldsRef);
        if (!(fields instanceof PDFArray) || fields.size() > 0) return FORM_COPY_ERROR;
      }
    }
    // Malformed documents may already have widgets without an AcroForm tree.
    for (const page of document.getPages()) {
      const annotations = page.node.Annots();
      if (!annotations) continue;
      for (const entry of annotations.asArray()) {
        const annotation = document.context.lookup(entry);
        if (annotation instanceof PDFDict && annotation.get(PDFName.of('Subtype'))?.toString() === '/Widget') return FORM_COPY_ERROR;
      }
    }
    return undefined;
  } catch {
    return FORM_COPY_ERROR;
  }
}
