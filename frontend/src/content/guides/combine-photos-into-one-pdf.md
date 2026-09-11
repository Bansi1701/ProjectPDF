---
title: "Combine photos into one PDF without losing quality"
description: "Why most image-to-PDF tools quietly re-compress your photos, how page size is decided, and how to build a clean multi-page PDF from JPGs on your own device."
summary: "Most image-to-PDF converters decode your photo and re-encode it, losing quality for nothing. A JPEG is already compressed in a form PDF understands, so it can be carried in untouched — and pages are sized at 96 DPI so a phone photo becomes a sensible page, not a poster."
tools: ["jpg-to-pdf", "compress-pdf", "merge-pdf"]
keywords: ["jpg to pdf", "combine photos into pdf", "images to pdf without losing quality", "photo to pdf converter", "jpg to pdf without upload", "multiple images one pdf"]
updated: "2026-09-11"
faqs:
  - question: "Will converting my photos to PDF make them blurry?"
    answer: "It should not, and on Filozy it does not: JPG and PNG data is carried into the document without re-encoding wherever the format permits, so the pixels in the PDF are the pixels from your file. Blurriness after conversion usually means the tool decoded and re-compressed the image, which throws away detail every time."
  - question: "Why did my photo come out as a huge page?"
    answer: "Because a pixel is not a unit of length. A tool that treats 1200 pixels as 1200 points produces a page over 40 cm wide. Filozy reads images at 96 DPI, the standard screen resolution, so a 1200-pixel-wide photo becomes roughly a 32 cm page and is clamped to something printable."
  - question: "Can I mix JPG, PNG and screenshots in one PDF?"
    answer: "Yes. JPG, PNG and WebP can all go into the same document, one image per page, in the order you arrange them. Only JPG and PNG can be carried through without re-encoding; WebP has to be converted because PDF has no native WebP support."
---

Turning a folder of photos into a single PDF sounds like the most trivial conversion there is. It is also where quality quietly disappears, because the obvious way to implement it is the wrong one.

## The re-encoding tax

A JPEG is not a picture. It is a compressed description of a picture, and the compression is lossy — some detail was discarded when the file was made, and it is gone.

Now consider what most converters do: decode the JPEG into raw pixels, draw those pixels onto a PDF page, and compress the result as a new JPEG. That second compression throws away detail *again*, on an image that has already paid the price once. Do it twice more — convert, edit, re-export — and the artefacts become visible: mushy edges, blocky skies, halos around text in a screenshot.

None of it is necessary. **PDF's native image compression is DCT, which is JPEG.** A JPEG's compressed bytes can be dropped into a PDF exactly as they are, and every reader will display them correctly. The image in the document is then bit-for-bit the image on your disk.

[JPG to PDF](/jpg-to-pdf/) does this: JPG and PNG data is carried into the document without re-encoding wherever the format permits. What you put in is what comes out.

## The other thing tools get wrong: page size

A pixel has no physical size. A 1200×800 photo is 1200 pixels wide — but how wide is that on paper? It depends entirely on the resolution you decide to print it at.

PDF measures in **points**, where 72 points make an inch. A converter that naively treats one pixel as one point turns that 1200-pixel photo into a page 16.7 inches — about 42 cm — across. Open it and every page is enormous; print it and nothing fits.

The right answer is to pick a resolution. Filozy reads images at **96 DPI**, the long-standing screen standard, so 1200 pixels becomes 12.5 inches — roughly 32 cm — and the result is clamped to something a printer will accept. A phone photo lands close to a normal page instead of a poster.

## Step by step

1. **Put the images in order first.** Renaming them `01-…`, `02-…` makes any file picker hand them over in the sequence you want, which saves reordering later.
2. Open [JPG to PDF](/jpg-to-pdf/) and select them all at once. They are read in your browser; nothing is uploaded.
3. **Check the order** in the thumbnails and drag any page that landed in the wrong place.
4. Save the PDF.
5. If the file is larger than you need — a stack of phone photos easily runs to 30 MB — pass it to [Compress PDF](/compress-pdf/) rather than shrinking the images beforehand. That way you keep the originals untouched and decide the quality trade-off once, with the real byte count in front of you.

## When a photo is a document

Photographing paperwork is not quite the same job. A photo of a page has perspective distortion, uneven lighting and a background — and converting it directly gives you a PDF of a photo of a document, not a document.

[Scan to PDF](/scan-pdf/) is built for that case: it straightens the page, corrects the lighting and crops to the sheet, all on the device. Then, if you need the text to be searchable, run [OCR PDF](/ocr-pdf/) over the result.

## What to check in the finished file

- **Orientation.** Phone photos carry an EXIF rotation flag. Open the PDF and confirm nothing arrived sideways.
- **Page order**, especially if the images came from more than one folder.
- **File size**, before you email it. A ten-photo PDF at full resolution can exceed most attachment limits.
- **Legibility**, if any page is a photographed document — read the smallest text you actually need at normal zoom, not zoomed in.
