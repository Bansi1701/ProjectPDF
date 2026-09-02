---
title: "OCR a scanned contract on your own computer"
description: "Turn a scanned PDF into a searchable document without sending it to an OCR service: what affects accuracy, the steps, what to check afterwards, and honest limits."
summary: "OCR adds an invisible text layer to a scanned page so it can be searched and copied. On HatePDF the recognition engine runs in your browser, so the scan never leaves your device. Accuracy depends on resolution, contrast and skew; verify names, dates and totals against the page before relying on them."
tools: ["ocr-pdf", "auto-crop", "redact-pdf"]
keywords: ["ocr scanned pdf", "make scanned pdf searchable", "ocr pdf offline", "ocr without uploading", "searchable pdf from scan", "ocr accuracy tips"]
updated: "2026-09-01"
faqs:
  - question: "Does OCR change how the page looks?"
    answer: "No. The scanned image stays exactly as it was. OCR adds an invisible layer of text positioned over the words in the picture, which is what lets you search and select them. Print it and it looks identical."
  - question: "Which languages does HatePDF's OCR recognise?"
    answer: "English. The engine's language data is served from HatePDF's own servers when you run the tool, and only English is included today. Documents in other languages will be recognised poorly."
  - question: "How long does it take?"
    answer: "Roughly a second per page on a laptop and several seconds per page on a phone, after a one-time download of the engine for the session. The first page is the slowest. Keep the tab in the foreground on mobile so the browser does not pause the work."
---

A scanned contract is a photograph of a contract. You can read it, but your computer cannot: no search, no copy-and-paste, no way to find the indemnity clause across forty pages except by eye. OCR — optical character recognition — fixes that by reading the picture and adding the words as an invisible layer over the page.

The catch is that the documents people scan are exactly the ones they should not upload. Contracts, IDs, medical records, signed statements. Most OCR happens on someone else's server. This guide does it on yours.

## What OCR produces

Running OCR on a scanned PDF gives you two things:

- **A searchable PDF.** The page image is untouched; an invisible text layer sits on top of it, aligned with the printed words. Search, selection and copy work as they would in a born-digital document.
- **A plain-text file.** The recognised words on their own, useful for pasting into a contract-review tool or a spreadsheet.

Nothing is "converted". The scan remains the scan; the text is an addition.

## What decides accuracy

OCR is statistics, and its confidence rises and falls with the input:

- **Resolution.** 300 DPI is the working standard. A 150 DPI scan or a phone photo at arm's length loses the small letters first — the serifs on an *l* and *i*, the difference between *5* and *S*.
- **Contrast and cleanliness.** Grey text on grey paper, coffee rings, and the shadow of a fold all cost characters.
- **Skew.** A page scanned at an angle confuses line detection. Straighten it first.
- **Typeface.** Clean printed text recognises well. Stylised fonts less so. Handwriting, honestly, is a gamble.
- **Language.** HatePDF's engine recognises English. Other languages will come out garbled.

You cannot fix a bad scan with a better algorithm. Rescanning at 300 DPI, flat, in good light, is worth more than any setting.

## Step by step

1. **Trim and straighten first.** Open the scan in [Auto crop](/auto-crop/) to remove scanner borders and uneven margins. Clean edges help the engine find the text block.
2. Open [OCR PDF](/ocr-pdf/) and choose the trimmed file. The recognition engine is downloaded from HatePDF's own servers at this point — it is program code, not your document going the other way.
3. Run the tool. Progress and a **confidence figure** are shown as it works; a low figure on a page is a hint to look closely at that page later.
4. Save the searchable PDF, and the text file if you want it.
5. **Verify before you rely on it.** Search the result for a clause you know is there. Compare every number, date, party name and defined term you will act on against the page image. OCR errors cluster in exactly those places: *0* and *O*, *1* and *l*, decimal points, currency symbols.

## What to do next

The searchable PDF is the input to everything else:

- Need to remove personal information before sharing? [Redact PDF](/redact-pdf/) can now find the words — and it will run its own local OCR if you skip this step.
- Filing or producing the document? Add Bates numbers with [Header, footer & Bates](/header-footer/).
- Sending it on? [Protect PDF](/protect-pdf/) encrypts it on the same device.

A ready-made sequence for this — trim, recognise, number, protect — exists as the [Prepare a scanned contract for filing](/how-to/prepare-scanned-contract-for-filing/) workflow, which carries the file from one tool to the next without re-selecting it.

## Honest limits

- **Tables** are recognised as text, not as cells. For a spreadsheet, run the result through [PDF to Excel](/pdf-to-excel/) and expect to check the columns.
- **Handwritten annotations** are usually missed or misread. If a handwritten date matters, read it yourself.
- **Very long documents** take time, and a phone has less memory than a laptop. Split a 400-page scan into parts first.
- **The text layer is only as good as the scan.** A confidence figure of 90% on a legal document means one word in ten may be wrong. That is why step 5 is not optional.
