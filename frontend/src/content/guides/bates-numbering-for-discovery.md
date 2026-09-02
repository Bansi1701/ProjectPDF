---
title: "Bates numbering for discovery, done on your own machine"
description: "What Bates numbers are, the rules they follow, how to keep a sequence continuous across batches, and how to stamp them in your browser without uploading."
summary: "Bates numbers are unique, sequential labels stamped on every page of a document production, with a prefix, zero-padding and no gaps or restarts across batches. HatePDF applies them locally, with a start value so the next batch continues where the last one stopped."
tools: ["header-footer", "ocr-pdf", "protect-pdf"]
keywords: ["bates numbering", "bates stamp pdf", "add bates numbers to pdf", "bates numbering online free", "bates numbers without uploading", "document production numbering"]
updated: "2026-09-01"
faqs:
  - question: "Bates numbers or page numbers?"
    answer: "Different things. Page numbers restart with each document and describe position within it. Bates numbers run across an entire production — every page of every document, in order, never restarting — and identify a page uniquely for the rest of the case. A page can carry both."
  - question: "How do I continue numbering in a second batch?"
    answer: "Note the last number of the previous batch and enter the next one as the start value. If batch one ended at ACME-000482, batch two starts at ACME-000483. Keep a log of ranges per batch; opposing counsel will ask."
  - question: "Can I use a non-English prefix?"
    answer: "Stick to Latin letters, digits and basic punctuation. The stamp is set in a standard PDF font whose encoding covers those; characters outside it — Japanese, Arabic, some accented letters — come out as question marks."
---

Every page produced in litigation gets a name it will keep for the life of the case: *ACME-000417*. When a deposition refers to it, a brief cites it, or a judge asks for it, that label is how everyone finds the same page. That is Bates numbering, and it has rules that ordinary page numbering does not.

## The rules

- **Unique.** No two pages in a production share a number. Ever.
- **Sequential and continuous.** Numbers increase by one, page by page, through every document in the production — and through every *batch*. The second production picks up exactly where the first stopped.
- **Prefixed.** A short code identifies the producing party or the matter: *ACME*, *DEF*, *SMITH-*. Agreed with the other side before anything is stamped.
- **Zero-padded.** *ACME-000417*, not *ACME-417*, so numbers sort correctly as text and the format never changes as the count grows. Six digits is conventional.
- **On every page.** Including cover sheets, blanks and the backs of two-sided scans if they were produced.
- **Legible and out of the way.** Usually the bottom-right corner, small, in a margin the content does not use.

Break continuity — restart at 1 for a new batch, skip a range, produce a duplicate — and the production is challenged. The rules exist because the labels are evidence.

## Doing it on your own machine

Discovery documents are, by definition, the ones with the highest stakes for confidentiality: privileged communications, personal data, trade secrets. Uploading them to a stamping website means a third party holds an unredacted copy of a production, however briefly.

[Header, footer & Bates numbers](/header-footer/) applies the stamps inside your browser. The document is read into memory, the labels are drawn into each page's content, and the result is saved locally — nothing is transmitted.

## What the tool gives you

- **Tokens** for the running number and the page number, so a footer can read *ACME-{bates}* and a header *Page {page} of {pages}* at the same time.
- **A start value**, which is how continuity across batches works.
- **Prefix and padding** to match the agreed format.
- **Page ranges**, so a privilege log or a cover sheet that must not be stamped can be excluded, and so a stamp never lands on an excluded page by accident.
- **Position and size** for the running heads and the label.

Two constraints worth knowing: the stamp is set in a standard font whose encoding covers Latin text, so prefixes should use plain letters and digits; and the stamp is placed relative to the visible page area, so on a scan whose page box starts off the corner the margin is measured from where the page actually shows.

## Step by step for a scanned production

1. **Prepare the scans.** [Auto crop](/auto-crop/) removes scanner borders so the stamp lands in a clean margin.
2. **OCR** with [OCR PDF](/ocr-pdf/) if the production must be searchable — most protocols require it.
3. Open [Header, footer & Bates numbers](/header-footer/). Set the prefix, the padding width, and the **start value** (1 for the first batch; the previous last number plus one for any later batch).
4. Choose the position — bottom right is conventional — and a page range if any pages are excluded.
5. Preview the first, a middle and the last page. Confirm the number sequence reads correctly and does not overlap content.
6. Save. **Record the range** — first and last number, and the batch — in your production log.
7. [Protect PDF](/protect-pdf/) if the production is delivered encrypted, or [Flatten](/flatten-pdf/) first if it carries annotations.

The [Prepare a scanned contract for filing](/how-to/prepare-scanned-contract-for-filing/) workflow runs this sequence — trim, recognise, number, protect — passing the file between tools without re-selecting it.

## Checks before you produce

- First page, last page: does the number match the log?
- Any page where the stamp collides with content? Move it, do not shrink it below legibility.
- Excluded pages actually unstamped?
- Total pages equals last number minus first number plus one? If not, something was skipped or doubled.
