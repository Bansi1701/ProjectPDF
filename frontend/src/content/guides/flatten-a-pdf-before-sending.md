---
title: "Flatten a PDF before sending: forms, comments and signatures"
description: "What flattening does to form fields, comments and signature marks, why it prevents accidental edits, what it does not do, and when not to flatten."
summary: "Flattening converts a PDF's form fields, comments and other annotations into ordinary page content, so what you see becomes permanent and every reader shows it the same way. It is not redaction, not encryption, and not reversible — keep the editable original."
tools: ["flatten-pdf", "pdf-forms", "protect-pdf"]
keywords: ["flatten pdf", "flatten pdf form", "make pdf fields uneditable", "flatten pdf annotations", "flatten pdf before sending", "flatten pdf without uploading"]
updated: "2026-09-01"
faqs:
  - question: "Is flattening the same as redacting?"
    answer: "No. Flattening makes annotations and field values part of the page; the information is still there and fully readable. Redaction removes information. If a comment contains something the recipient must not see, delete or redact it — flattening will bake it in."
  - question: "Can a flattened form be filled again?"
    answer: "Not as a form. The fields no longer exist; their values are drawn on the page like any other text. If the recipient needs to fill it, send the unflattened version, or flatten only after everyone has finished."
  - question: "Does flattening reduce the file size?"
    answer: "Often, yes. Fields and annotations carry their own appearance streams and sometimes their own fonts. Once they are drawn into the page those duplicates go, which is why flattening before compressing is a standard step."
---

A filled-in form arrives and the answers are missing. A reviewed contract opens with the comments in different places. A signed PDF turns out to have a signature that anyone can drag to a different page. Each of these is the same problem: the parts of the document that were *added* — fields, comments, stamps, signature marks — are not part of the page. They float above it, and every reader is free to display them differently or not at all.

Flattening ends the argument. It takes everything that floats and paints it into the page.

## What flattening changes

A PDF page has two kinds of content:

- **Page content**: the text, lines and images drawn by the page's own instructions. Every reader draws these the same way.
- **Annotations**: objects attached to the page — form fields, comments, highlights, stamps, sticky notes, file attachments, and the marks that sign-and-fill tools add. Each has its own appearance and its own rules for when it is shown, printed or editable.

[Flatten PDF](/flatten-pdf/) does two things:

1. **Form fields become the picture they were drawing.** The value in each field is painted into the page as text, and the field itself is deleted. The answer is still there; it is just no longer a field.
2. **Annotations are painted into the page.** Comments, highlights, stamps and signature marks become ordinary content, positioned exactly where they were.

The tool checks its own work: a flatten that quietly left one field behind would defeat the purpose, so the result is verified to contain none.

## Why you would want that

- **Nothing can be edited by accident.** A recipient cannot retype a field, move a signature or delete a stamp without an editor that rewrites page content.
- **Every reader shows the same page.** Mobile viewers, browser viewers and print drivers all handle annotations inconsistently; page content they all get right.
- **Printing is reliable.** Some readers skip annotations when printing; flattened content prints.
- **The file is usually smaller**, and it compresses better afterwards.

## What flattening does not do

- **It does not hide anything.** Every comment and field value is now permanently visible. Read them before you flatten.
- **It is not security.** Flattened content can be edited with a PDF editor like any other page content. For access control use [Protect PDF](/protect-pdf/); to remove information use [Redact PDF](/redact-pdf/).
- **It is not reversible.** Fields cannot be reconstituted from the picture of their values.
- **It is not a certified signature.** A flattened signature mark shows agreement the way ink does; it does not cryptographically bind anyone.

## When not to flatten

- The recipient still has to fill the form. Send the live version and flatten the returned copy.
- You need the field data back later — an export to a spreadsheet, say. Extract it first.
- The comments are the deliverable, as in a review round where the author needs to click each one.

## Step by step

1. Finish all fills, signatures and comments. Flattening is the last edit.
2. Read every comment and field value; delete anything that should not ship.
3. Open [Flatten PDF](/flatten-pdf/) and choose the file. It is processed in your browser.
4. Save the flattened copy under a new name and keep the original.
5. Open the result in a second viewer and check the pages where fields and marks were.
6. Then, in order if needed: [Compress PDF](/compress-pdf/) to meet a size limit, [Protect PDF](/protect-pdf/) to encrypt.

Forms specifically: [Fill PDF forms](/pdf-forms/) can fill the fields and flatten the answers in one pass when you already know the form is final.
