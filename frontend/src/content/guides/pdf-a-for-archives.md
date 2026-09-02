---
title: "PDF/A for archives: what conformance requires and why fonts matter"
description: "What the PDF/A archival standard demands, why many converters produce files that fail validation, how to fix the usual font problem, and how to check a result."
summary: "PDF/A is a PDF that carries everything needed to display it identically for decades: every font embedded, no encryption, no scripts, colours defined, metadata in XMP. A converter that cannot embed a font has no honest way to produce PDF/A, which is why HatePDF refuses such files instead of labelling them conformant."
tools: ["pdf-a", "metadata-pdf", "flatten-pdf"]
keywords: ["convert pdf to pdf/a", "what is pdf/a", "pdf/a conformance", "pdf/a fonts not embedded", "pdf/a validation verapdf", "archival pdf"]
updated: "2026-09-01"
faqs:
  - question: "My converter produced a PDF/A but the archive rejected it. Why?"
    answer: "Because writing 'PDF/A' into a file's metadata is easy and meeting the standard is not. The most common failure is a font that is referenced but not embedded — the file claims conformance while depending on a font the future reader may not have. Validate with veraPDF to see exactly which rule failed."
  - question: "Which PDF/A level do I need?"
    answer: "Ask the archive. Level B ('basic') is the usual requirement and guarantees the visual appearance; level A ('accessible') also requires tagged structure and is much harder to reach from an existing PDF. Most institutional and legal archives accept PDF/A-1b or PDF/A-2b."
  - question: "Can a scanned document be PDF/A?"
    answer: "Yes — scans are often the easiest case, because the page is one image and there may be no fonts at all. Add OCR text if the archive wants searchability, and make sure the image's colour space is declared."
---

An archive has one requirement that ordinary documents never face: the file must look the same in 2056 as it does today, on software that has not been written yet, with no help from the machine that created it. PDF/A is the profile of PDF designed for that, and its rules all come from that single requirement.

## What PDF/A demands

PDF/A (ISO 19005) is not a different format. It is a PDF with the risky parts removed and the necessary parts made mandatory:

- **Every font embedded.** A normal PDF may reference "Helvetica" and expect the reader to supply it. An archival PDF cannot depend on a font existing in the future, so the glyphs must be inside the file.
- **No encryption.** A password nobody remembers is a document nobody can open.
- **No JavaScript, no external links to content, no multimedia.** Nothing that requires an environment to run.
- **Colours defined.** Device-dependent colour ("whatever this printer thinks red is") must be replaced or accompanied by an ICC profile so red is red.
- **Metadata in XMP**, with the conformance level declared, so a future system can identify the file.
- **Transparency and layers restricted or forbidden** depending on the level.

Two levels matter in practice: **B** (basic) guarantees visual appearance and is what most archives, courts and registries require; **A** (accessible) adds tagged logical structure for assistive technology and is rarely achievable from an existing file without re-authoring.

## Why converters lie

Declaring conformance is a metadata field. Any tool can write it. Meeting the rules is real work, and the hardest rule — embedding fonts — cannot be done at all if the tool does not have the font.

That is the common case. A document that uses the standard "base 14" fonts (Helvetica, Times, Courier and friends) usually does not embed them, because every reader is required to have them. A converter that meets such a file has two choices: obtain and embed the fonts, or write "PDF/A" into the metadata anyway and hand back a file that will fail the archive's validator. Many choose the second. The result is worse than not converting, because it looks done.

[Convert PDF to PDF/A](/pdf-a/) takes the other path. It checks whether every font the document uses is embedded, and if any is not, it **refuses** and tells you which — rather than producing a file that claims something untrue.

## Fixing the font problem

If the tool refuses because fonts are not embedded, the fix is upstream, in the application that made the PDF:

- **Word, LibreOffice, Google Docs**: export to PDF with *embed fonts* enabled (LibreOffice: File → Export as PDF → General → *Archive (PDF/A)*; Word: Options → Save → *Embed fonts in the file* before saving as PDF).
- **Print to PDF** drivers usually embed everything by default; check the driver's font settings.
- **Scans** have no fonts unless OCR added them; the OCR text layer's font must be embedded by the OCR tool.

Re-export, then convert. If you no longer have the source and the fonts are not embedded, no honest tool can make the file PDF/A without the fonts.

## Step by step

1. Prepare the document: [Flatten PDF](/flatten-pdf/) any forms and comments, since annotations are restricted, and [Unlock PDF](/unlock-pdf/) if it is encrypted.
2. Open [Convert PDF to PDF/A](/pdf-a/) and choose the file. If it reports unembedded fonts, go back to the source and re-export with fonts embedded.
3. Save the result. The tool produces an **archival candidate** — a file that meets the requirements it can check and declares its conformance in XMP.
4. **Validate.** Conformance checking is a separate job from conversion. The reference validator is [veraPDF](https://verapdf.org/), an open-source Java tool; run the file through it at the level your archive requires and keep the report with the document.
5. Set descriptive metadata with [Edit PDF metadata](/metadata-pdf/) — title, author, subject — because the archive will index on it.

## Why validation stays outside the browser

A complete PDF/A validator checks hundreds of rules across the whole file, and the only implementation the archival community trusts is veraPDF, which is Java. HatePDF can convert honestly and refuse dishonestly, but it does not claim to validate. Treat the veraPDF report as the deliverable; the PDF is the thing it describes.
