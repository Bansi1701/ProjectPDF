import type { PDFDocument } from '@cantoo/pdf-lib';

/**
 * Preserve descriptive document-information fields when page operations must
 * create a new PDF shell. `copyPages` intentionally copies page dictionaries,
 * not the document's /Info dictionary. Producer and modification date belong
 * to the newly produced file and are intentionally left to the writer.
 *
 * Each field is isolated because malformed optional metadata must never make
 * otherwise valid pages impossible to organise.
 */
export function preserveDocumentMetadata(source: PDFDocument, target: PDFDocument): void {
  const copy = <T>(read: () => T | undefined, write: (value: T) => void): void => {
    try {
      const value = read();
      if (value !== undefined) write(value);
    } catch {
      // Preserve every readable field and ignore only the malformed one.
    }
  };

  copy(() => source.getTitle(), (value) => target.setTitle(value));
  copy(() => source.getAuthor(), (value) => target.setAuthor(value));
  copy(() => source.getSubject(), (value) => target.setSubject(value));
  // pdf-lib accepts an array but stores it as one space-separated string. A
  // single element therefore preserves the source string verbatim.
  copy(() => source.getKeywords(), (value) => target.setKeywords([value]));
  copy(() => source.getCreator(), (value) => target.setCreator(value));
  copy(() => source.getCreationDate(), (value) => target.setCreationDate(value));
}
