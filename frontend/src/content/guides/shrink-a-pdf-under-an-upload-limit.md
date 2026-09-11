---
title: "Shrink a PDF under a 2 MB, 5 MB or 10 MB upload limit"
description: "Set a PDF size target while preserving document content. Understand safe compression, realistic limits and alternatives when a file is still too large."
summary: "Set an upload limit in KB or MB. Filozy combines safe repacking with verified font compaction and reports whether the limit was reached. Some files cannot shrink enough without a quality trade-off."
tools: ["compress-pdf", "flatten-pdf", "split-by"]
keywords: ["compress pdf under 2mb", "reduce pdf size for upload", "shrink pdf file size", "compress pdf without losing quality", "pdf too large to upload", "compress pdf offline"]
updated: "2026-09-10"
faqs:
  - question: "Why did compression barely change the size?"
    answer: "The file may already be efficiently stored. Safe repacking cannot guarantee a reduction: Filozy keeps fonts, images and document content rather than removing information to force a smaller file."
  - question: "Will compressing make the text blurry?"
    answer: "This compressor does not rasterize pages or reduce image resolution. Supported fonts can be compacted only when glyph shapes and spacing match and every page passes a pixel and text-position comparison. Failed or unavailable verification falls back to safe repacking or the unchanged original."
  - question: "Can I force a PDF below 2 MB?"
    answer: "You can enter a 2 MB target, but it is a limit to check, not a promise. When safe compression cannot reach it, Filozy reports that clearly. Ask the recipient about a larger limit or separate parts."
---

An upload limit should not cost you missing words or unreadable pages. Start with a copy of the original and check the recipient's maximum size. This guide uses decimal units: 1 KB is 1,000 bytes and 1 MB is 1,000,000 bytes. Portals may use different units or apply their limits to an entire batch.

## Step one: set your size target

Open [Compress PDF](/compress-pdf/), choose one PDF and enter a limit such as **2 MB** or **500 KB**. Leave the field blank if you only want safe compression without a particular ceiling. The original stays on your device.

## What safe compression changes

The compressor rewrites the storage structure using compressed object containers and checks original document objects and streams against the reopened result. It may also compact supported embedded TrueType fonts while preserving every glyph ID, outline and spacing. That stronger pass requires an all-page rendered-pixel and text-position comparison. It does not reduce image quality, flatten forms, remove attachments or strip metadata.

Extractable text and a correct page count alone cannot prove that a PDF still looks right: damaged font data can leave text selectable while letters disappear. Filozy does not renumber glyphs or rewrite page text. Font optimization is skipped for interactive forms, unsupported fonts, documents over 80 pages, oversized rendering surfaces, or browsers without the required local renderer. It also falls back if any verification fails. Always check the downloaded copy in your usual viewer.

## Step two: read the actual result

- **Target met:** the result is at or below your chosen byte limit.
- **Target not reached:** the safest available output is still larger than the limit. Its content was not sacrificed to force the size.
- **Original preserved:** repacking did not save space, a preservation check failed, or the document requires protection from rewriting. The downloaded bytes are unchanged.

If the original already meets the target, no rewrite is needed. Signed documents, signature fields and XFA forms are returned unchanged because a rewrite may invalidate their integrity. Password-protected PDFs require an authorized unlocked copy.

## Step three: review before sending

Open the result in your usual PDF viewer. Compare every page, including small print, tables, symbols, signatures and any form fields. Check the exact reported size rather than relying on a rounded filename or a promised percentage. Keep the original until the recipient accepts the file.

## If the file is still too large

Ask whether the recipient allows multiple parts. [Advanced Split](/split-by/) can separate a document, but splitting is a different operation and may not suit signed documents or interactive forms. Review its restrictions before proceeding.

If a final, non-editable form is specifically required, [Flatten PDF](/flatten-pdf/) is a separate, deliberate choice. Flattening changes interactivity and is not part of preservation-first compression; it is not guaranteed to save space.

You can also return to the source document and export a smaller copy. Lower image resolution can reduce size, but changes quality and may damage small text in scans. Filozy's preservation-first compressor does not make that decision for you. Never repeatedly compress a damaged result in an attempt to recover missing content; return to the original.
