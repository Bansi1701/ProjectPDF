---
title: "How to redact a PDF properly (a black box is not redaction)"
description: "Why a black rectangle over text leaves it readable, the three places information hides in a PDF, and a redaction workflow that removes it — in your browser."
summary: "True redaction deletes the text and graphics from the page's content, not just covers them. A black rectangle drawn in an ordinary editor leaves the words underneath selectable, searchable and copyable; a proper redaction tool removes them and then verifies the page has no extractable text left."
tools: ["redact-pdf", "metadata-pdf", "ocr-pdf"]
keywords: ["how to redact a pdf", "redact pdf properly", "black box redaction fail", "remove text from pdf permanently", "redact pdf without uploading", "pdf redaction checklist"]
updated: "2026-09-01"
faqs:
  - question: "Why can people still copy the text under my black box?"
    answer: "Because the box was drawn on top of the page, not into it. A PDF page is a list of drawing instructions; adding a filled rectangle appends one more instruction, and the text instructions before it are untouched. Anyone who selects the region, searches the file, or removes the rectangle gets the original words."
  - question: "Is redacting a scanned PDF different?"
    answer: "A scan is a picture, so the text you see is pixels, and any searchable text layer added by OCR is a second copy. Redaction has to remove both: the pixels under the mark and the hidden text. HatePDF runs OCR locally so it can find the words in a scan, then removes the marked content and checks the page for leftover text."
  - question: "Does redaction remove the document's metadata too?"
    answer: "No — metadata lives outside the pages. After redacting, open the file in the Metadata tool and clear the author, title, subject and keywords, and remove any bookmarks or attachments that repeat what you redacted."
---

The most expensive redaction failures in recent memory — court filings, government releases, corporate disclosures — had the same cause. Someone drew a black rectangle over the sensitive text and shipped the file. The words were still there, one click away, and a reporter or an opposing lawyer found them in minutes.

Understanding *why* that happens is the whole skill. Once you know where a PDF keeps its words, redacting properly is a short checklist.

## A PDF page is a script, not a picture

Every page in a PDF is a list of drawing instructions: *set this font, move here, draw these characters, move there, fill this rectangle*. A viewer runs the list top to bottom and paints what it says.

When you use a drawing tool to cover text, the editor appends one more instruction — *fill a black rectangle here* — to the end of the list. The instruction that drew the text is still in the list, still executed, just painted over. That is why:

- **Select-all and copy** returns the hidden text: the selection follows the text instructions, not the pixels.
- **Search** finds the hidden words.
- **Any editor** can delete the rectangle and reveal the page exactly as it was.
- **Screen readers and AI tools** read the text straight out of the file.

Real redaction *edits the list*: it removes the text instructions (and any graphics) inside the marked area, then adds the box so a reader can see something was removed. After that, there is nothing underneath to find.

## The three places information hides

Redaction is only complete when all three are handled.

### 1. Page content

The text and graphics on the page itself — the part described above. This is where the redaction tool does its work.

### 2. The text layer of scans

A scanned document is a picture of a page. If it has ever been run through OCR — by a scanner, an office tool, or a previous "make searchable" step — it also carries an invisible text layer that mirrors the picture. Covering the pixels while leaving that layer intact is the scan version of the black-box mistake. Proper redaction must remove the marked pixels *and* the hidden text under them.

### 3. Everything outside the pages

Metadata (author, title, subject, keywords, creator, dates), bookmarks that quote headings, comments and sticky notes, form-field values, and attached files. None of these are on the page, so no page tool touches them. They need a separate pass.

## How HatePDF redacts

The [Redact PDF](/redact-pdf/) tool works on all of this, on your device:

- **Search** for a name, an account number or an exact phrase, and every occurrence across the document is marked.
- **Scanned pages** are handled by running OCR locally, so words in a picture of a page can be found and marked like any other text.
- **Draw** additional boxes over anything the search cannot express — a signature, a photo, a handwritten note.
- **Review** every red box before saving. Nothing is removed until you confirm.
- **Removal, not covering.** The text and graphics beneath each marked area are deleted from the page content, and the marked region is painted over.
- **Verification.** After saving, the tool checks that each redacted page contains no extractable text where the marks were.

The document never leaves your browser. For redaction that matters more than for any other job: uploading a file to redact it means the unredacted version has already been shared once.

## Step by step

1. **Work on a copy.** Keep the untouched original somewhere safe and separate; you will not be able to un-redact.
2. Open [Redact PDF](/redact-pdf/) and choose the copy.
3. Search for each term. Use exact phrases for names and full numbers for identifiers so partial matches do not slip through. Add boxes by hand for images and handwriting.
4. Read every red box. Confirm the ones that are right; reject any false match (a common word inside a longer one, for instance).
5. Save the redacted file.
6. **Test it.** Open the result, press select-all and paste into a text editor; search for one of the terms you removed. Both should come up empty.
7. Open the result in the [Metadata](/metadata-pdf/) tool. Clear or replace the author, title, subject and keywords, and check for bookmarks or attachments that mention what you removed.
8. If the document contained comments or form fields, run [Flatten](/flatten-pdf/) *before* redacting next time, or check them now.

## When redaction is the wrong tool

- **You need the text gone but the layout kept for editing** — redaction is permanent and visible; use an editor on the source document instead.
- **The information is in an image you need to keep** — a photograph with a licence plate, say. Redaction removes the region; if you need the rest of the image intact, edit the image first, then rebuild the PDF.
- **Someone must be able to reverse it** — nobody can. That is the point.

## The checklist, for the wall

> Search, do not eyeball. Review every box. Save. Select-all and search the result. Clear the metadata. Keep the original elsewhere. Only then send it.
