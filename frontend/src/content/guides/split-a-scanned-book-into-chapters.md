---
title: "Split a scanned book into chapters without uploading it"
description: "Seven ways to cut a long PDF into parts — bookmarks, chapter words, blank separator sheets, ranges, every N pages, equal parts, size targets — and which suits a scan."
summary: "Split by bookmarks when the PDF has an outline, by page-start words when it has a text layer, and by blank separator sheets or fixed page ranges when it is a raw scan. HatePDF finds the boundaries in your browser and lets you review each one before it writes the parts."
tools: ["split-pdf", "split-by", "ocr-pdf"]
keywords: ["split pdf into chapters", "split scanned pdf", "split pdf by bookmarks", "split pdf every n pages", "split pdf by size", "split pdf without uploading"]
updated: "2026-09-01"
faqs:
  - question: "The bookmark split produced one part. Why?"
    answer: "The PDF's bookmarks point somewhere the tool cannot use — often all to page 1, or to named destinations that no longer exist, which happens when a file is re-saved by software that does not maintain the outline. Split by page-start words or fixed ranges instead."
  - question: "Can I split a scan by chapter titles?"
    answer: "Only if the scan has a text layer. Run OCR PDF first; then the page-start-word mode can find pages whose first line begins with 'Chapter', 'Part' or whatever your book uses."
  - question: "Why isn't the size split exact?"
    answer: "Pages in a PDF share fonts and images, so a part's size depends on which pages travel together. HatePDF measures each candidate part rather than estimating, gets as close as it can, and tells you when a single page alone exceeds the target."
---

A scanned book is a single 400-page file, and nobody wants a 400-page file: not the reviewer who needs chapter six, not the e-reader that chokes on it, not the portal with a 10 MB limit. Splitting it well depends on one question — does the document know where its chapters are? — and the answer decides which of the methods below to use.

## First, find out what the PDF knows

Open the file in any viewer and check two things:

- **Does it have bookmarks** (an outline in the side panel)? A publisher's PDF usually does; a scan almost never does.
- **Can you select text?** If so, it has a text layer — either born-digital or OCR'd. If dragging across a paragraph selects nothing, it is a bare scan.

Bookmarks give you the easiest split. A text layer gives you a good one. A bare scan gives you the manual options, or a quick trip through [OCR PDF](/ocr-pdf/) to earn the better ones.

## The methods

[Split PDF](/split-pdf/) and [Split PDF by size or bookmark](/split-by/) between them cover every case. All of them run in your browser; the book is never uploaded.

### By bookmarks

Each top-level bookmark starts a new part, named after it. The cleanest result when the outline is real. The tool explains the rule before it runs and warns when bookmarks do not point at usable pages.

### By page-start words

Give it the word a chapter's first line begins with — *Chapter*, *Part*, *Section*, a case name — and every page whose text starts that way opens a new part. Needs a text layer. Excellent for OCR'd scans, where bookmarks never existed but the typography did.

### By blank separator sheets

Photocopy pilers and scanning services insert a blank page between documents. HatePDF renders each page at low resolution and detects the near-empty ones, splitting there. Works on bare scans with no text layer at all. Review the detected boundaries: a nearly blank final page of a chapter can look like a separator.

### By custom ranges

Type the page ranges yourself — `1-12, 13-40, 41-88`. The fallback that always works, and the right choice when you have a table of contents in front of you.

### Every N pages

A stack of scanned two-page forms becomes one file per form with *every 2 pages*. Arithmetic, no inspection of the content.

### Into N equal parts

Hand a manuscript to four reviewers. Also arithmetic.

### By target file size

For upload limits: parts that each stay under a size you choose, measured from the actual output. See the caveats in the FAQ — sizes are approximate by nature, and a single oversized page cannot be split further.

## Step by step for a scanned book

1. **Straighten and trim** with [Auto crop](/auto-crop/) if the scan has heavy borders; smaller pages split and compress better.
2. **OCR it** with [OCR PDF](/ocr-pdf/) if you want chapter detection by words, searchability in the parts, or both.
3. Open [Split PDF](/split-pdf/). Choose *page-start words* and enter the chapter word, or *blank separators* for a bare scan, or type the ranges from the table of contents.
4. **Review the boundaries** the tool proposes. Fix any it missed or invented.
5. Decide whether the groups should stay separate files or be combined into one extracted PDF of the chapters you care about.
6. Save. Parts download individually or as a ZIP.
7. Open two or three parts and check the first and last pages of each. Keep the original.

## Naming and order

Parts are numbered in document order and named from the source file plus the bookmark or range, so they sort correctly in a folder. If you rename them, keep a leading number; *06 Chapter Six.pdf* survives any file manager, *Chapter Six.pdf* ends up between *Chapter Seven* and *Chapter Ten*.
