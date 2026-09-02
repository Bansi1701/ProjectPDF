---
title: "Shrink a PDF under a 2 MB, 5 MB or 10 MB upload limit"
description: "What makes a PDF large, the lossless step to try first, when to lower image resolution and by how much, and how to split as a last resort — without uploading."
summary: "A PDF's size is nearly always its images. Start lossless — rewrite the structure and drop unused objects — then reduce image resolution to 150 DPI for screen reading or 110 DPI for the smallest file, and split the document if the limit still cannot be met. HatePDF reports the real byte change."
tools: ["compress-pdf", "flatten-pdf", "split-by"]
keywords: ["compress pdf under 2mb", "reduce pdf size for upload", "shrink pdf file size", "compress pdf without losing quality", "pdf too large to upload", "compress pdf offline"]
updated: "2026-09-01"
faqs:
  - question: "Why did compression barely change the size?"
    answer: "Because the file was already compressed. Images inside PDFs are usually JPEGs, and a JPEG cannot be squeezed further without lowering its quality. If the lossless step reports a small change, the remaining size is image data and only a lower resolution or quality will reduce it."
  - question: "Will compressing make the text blurry?"
    answer: "Not if the text is text. Lowering image resolution affects pictures and scans; typed text in a born-digital PDF is stored as characters and stays perfectly sharp at any setting. A scanned page is one big picture, so there resolution does affect the text."
  - question: "The portal says 2 MB but my 2.0 MB file is rejected. Why?"
    answer: "Portals often measure in binary megabytes (2 MiB = 2,097,152 bytes) or in decimal ones (2,000,000 bytes), and rarely say which. Aim comfortably under the limit — 1.8 MB for a 2 MB rule — and you avoid the ambiguity."
---

Every portal has a number. 2 MB for the visa application, 5 MB for the job board, 10 MB for the court e-filing system. And every scanned bundle is just over it. Shrinking the file is straightforward once you know what is taking up the room — and it is nearly always the same thing.

## What makes a PDF big

In rough order of how often each is the culprit:

1. **Images.** Scans, photographs, logos placed at print resolution on a document that will only ever be read on a screen. A single full-page scan at 600 DPI can be several megabytes on its own.
2. **Embedded fonts.** Necessary, but sometimes the whole font is embedded when a subset would do, and sometimes the same font is embedded once per page.
3. **Leftovers.** Editors that save incrementally append new versions of objects without removing old ones; a file edited ten times can carry ten copies of a page.
4. **Unused objects.** Resources that nothing references — an image deleted from the page but not from the file.

Text itself is tiny. A hundred pages of plain typed text is a few hundred kilobytes.

## Step one: lossless

[Compress PDF](/compress-pdf/) starts with the changes that cannot hurt anything: it rewrites the file's structure, removes unused and duplicated objects, and repacks the streams. Text, images and fonts come out exactly as they went in.

The tool then reports the **real byte change** — the file was this big, it is now this big — instead of promising a percentage before it has looked. Sometimes the honest answer is that a file already compressed by its creator cannot be made smaller losslessly, and it says so rather than handing you a copy that is not smaller.

If the lossless step gets you under the limit, stop. You have lost nothing.

## Step two: lower the image resolution

If the file is still too large, what remains is image data, and the only way to reduce it is to store less of it. Compress PDF offers two presets for images beyond the lossless default:

- **Balanced — 150 DPI.** Comfortable for reading on any screen and acceptable for office printing. Text in a scan stays legible; photographs lose detail you would need to zoom to notice. For most portals this is the right choice.
- **Smallest — 110 DPI.** For hard limits. Scanned text remains readable at normal size; fine print and small diagrams start to soften. Use it when the alternative is not being able to submit at all.

Two things to know before you choose:

- **Typed text is never affected.** In a born-digital PDF the text is characters, not pixels; only the pictures are resampled. A report with three photographs and forty pages of text shrinks dramatically with no visible change to the words.
- **A scan is one big picture.** There, resolution *is* the text. Check the result at normal reading size before you rely on it, especially signatures and stamps.

## Step three: flatten first

A filled form or an annotated draft carries its fields and comments as separate objects, each with its own appearance and often its own fonts. [Flatten PDF](/flatten-pdf/) bakes them into the page, which removes the duplication and frequently makes the compression step more effective. The [Shrink a PDF under a portal's upload limit](/how-to/shrink-pdf-under-upload-limit/) workflow does exactly this sequence — flatten, then compress — handing the file from one tool to the next.

## Step four: split

Some limits cannot be met by one file: a 300-page scanned bundle will not become 2 MB at any legible resolution. [Split PDF by size or bookmark](/split-by/) divides the document into parts that each fit under a target size, measured from the actual output rather than estimated. Two caveats it will tell you about: a single page can never be made smaller than one page, and a size split can only be approximate because pages share fonts and images.

## Step by step

1. Note the limit, and aim 10% under it.
2. Open [Compress PDF](/compress-pdf/), choose the file, run the lossless pass. Read the reported change.
3. Still over? Run again with **Balanced**. Open the result and look at a photograph and a signature at normal size.
4. Still over? **Smallest**. Check fine print.
5. Still over? Flatten first if the document has forms or comments, then repeat; otherwise split by size.
6. Keep the original. The compressed copy is for the portal; the original is for your records.

## What not to do

Do not "print to PDF" a PDF to shrink it — it rasterises the text and often makes the file larger. Do not convert pages to JPEG and back for the same reason. And do not upload a document to a website to compress it if it contains anything you would not email to a stranger; every step above runs in your browser.
