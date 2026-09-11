---
title: "Export PDF pages as images at the right resolution"
description: "How DPI decides the size and sharpness of an exported page, when to choose JPG over PNG, and why extracting a PDF's pictures is a different job."
summary: "Exporting renders a page to pixels at a resolution you choose: 150 DPI for screens, 300 for print, 72 for a thumbnail. PNG for text and line art, JPG for photographs. If you want the photos already inside the PDF, that is Extract images instead."
tools: ["pdf-to-jpg", "extract-images", "compress-pdf"]
keywords: ["pdf to jpg", "pdf to image", "export pdf page as png", "pdf to jpg high resolution", "convert pdf page to image", "pdf to jpg without upload"]
updated: "2026-09-11"
faqs:
  - question: "What DPI should I choose?"
    answer: "150 DPI for anything read on a screen, 300 DPI for printing or for feeding into OCR, and 72 DPI for a thumbnail or a preview. Higher is not automatically better: a page at 600 DPI is four times the pixels of 300 and looks identical on a monitor, while taking four times the memory to produce."
  - question: "JPG or PNG?"
    answer: "PNG for pages that are mostly text, diagrams or line art — it is lossless, so edges stay crisp and there is no ringing around letters. JPG for pages dominated by photographs, where it produces a far smaller file at a quality difference you will not see. A text page saved as JPG shows halos around the characters."
  - question: "Why are my exported pages blurry?"
    answer: "Almost always too low a DPI for how the image is being used — a 72 DPI export looks fine in a browser and soft the moment it is printed or zoomed. If the source page is itself a scan, the export cannot exceed the scan's own resolution; rendering a 150 DPI scan at 600 DPI just enlarges its pixels."
---

Turning PDF pages into images looks like one task but is really two, and picking the wrong one is the most common reason people are unhappy with the result.

**Rendering** draws a page — text, lines, images, all of it — into a fresh grid of pixels at a resolution you pick. You get a picture of the page as it appears.

**Extracting** pulls out the photographs already stored inside the PDF, at whatever resolution they were embedded with, without re-rendering anything.

If you want the page, render it: [PDF to JPG](/pdf-to-jpg/). If you want the photo that is *on* the page, extract it: [Extract images from PDF](/extract-images/). Rendering a page to get a photo out of it degrades the photo twice — once by rasterising it into the page grid, once by compressing the output.

## DPI is the whole decision

A PDF page has a size in inches, not in pixels. DPI — dots per inch — is what converts one to the other.

An A4 page is 8.27 inches wide. So:

| DPI | Pixel width of an A4 page | Sensible for |
| --- | --- | --- |
| 72 | ~595 px | Thumbnails, contact sheets |
| 150 | ~1,240 px | Screen reading, email, web |
| 300 | ~2,480 px | Printing, OCR input |
| 600 | ~4,960 px | Archival capture, fine line art |

Two things follow. **Higher is not free** — pixel count grows with the square of DPI, so 600 DPI is four times the memory of 300, and a long document at 600 DPI will exhaust a phone browser. And **you cannot exceed the source**: if the page is a 150 DPI scan, rendering at 600 does not recover detail that was never captured. It produces a larger file of the same blur.

## Choosing the format

**PNG** is lossless. Every pixel survives exactly, which matters for text and line art — JPEG compression produces faint halos around high-contrast edges, and a page of black text on white is nothing but high-contrast edges. Choose PNG for documents, diagrams, screenshots and anything destined for OCR.

**JPG** is lossy and dramatically smaller on photographic content, where the discarded detail is genuinely invisible. Choose it for pages that are mostly photographs, and for any case where file size matters more than perfect fidelity.

A rough rule: if you would describe the page as a *document*, use PNG. If you would describe it as a *picture*, use JPG.

## Step by step

1. Decide what the images are for, and pick the DPI from the table above before you start.
2. Open [PDF to JPG](/pdf-to-jpg/) and choose the file. Pages are rendered in your browser; nothing is uploaded.
3. Set the resolution and format.
4. Run it, then **open one full-size image and look at the smallest text you actually need**. That is the only real test — a thumbnail always looks fine.
5. If the set is larger than you expected, re-export at a lower DPI rather than compressing the images afterwards. Rendering once at the right size beats rendering big and squeezing.

## Related jobs, done properly

- **Feeding OCR**: render at 300 DPI as PNG. [OCR PDF](/ocr-pdf/) already does this internally, so you only need it if you are exporting for another tool.
- **The pictures inside the document**: [Extract images from PDF](/extract-images/) returns them at their own resolution, not screenshots of the page.
- **Shrinking the PDF instead**: if the goal was a smaller file rather than images, [Compress PDF](/compress-pdf/) keeps the document a document — text stays selectable, which converting to images destroys.

That last point is worth stating plainly: converting a PDF to images to make it smaller throws away every searchable word on every page. It is occasionally what you want — flattening a document so nothing can be copied — but it is rarely the right answer to "this file is too big".
