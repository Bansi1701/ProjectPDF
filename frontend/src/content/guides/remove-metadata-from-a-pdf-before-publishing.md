---
title: "Remove metadata from a PDF before publishing it"
description: "What a PDF's metadata reveals — author, software, template history, dates — where it hides in two separate places, and how to inspect and clear it on your device."
summary: "A PDF carries descriptive metadata in two places: the Info dictionary and an XMP packet, and they can disagree. Before publishing, inspect both, replace the author and title with what you want the world to see, and remove the rest. HatePDF shows the current values and rewrites them in your browser."
tools: ["metadata-pdf", "redact-pdf", "flatten-pdf"]
keywords: ["remove pdf metadata", "pdf metadata author name", "clean pdf before publishing", "pdf xmp metadata", "edit pdf metadata online", "anonymise pdf"]
updated: "2026-09-01"
faqs:
  - question: "I cleared the author field but a tool still shows a name. Where is it?"
    answer: "In the other place. PDFs keep metadata in the Info dictionary and in an XMP packet, and many editors update only one. Readers often prefer XMP. Clear both — HatePDF reads both and lets you replace or remove the values it finds."
  - question: "Does the filename count as metadata?"
    answer: "Not inside the file, but it travels with it and is often more revealing than anything in the header: 'Draft3_JSmith_FINAL_reviewed.pdf'. Rename before you publish."
  - question: "Can metadata removal make a document anonymous?"
    answer: "It removes the labels, not the fingerprints. The text itself, fonts, image details and the way the document is built can still point to a source. For genuine anonymity, treat metadata as one step and content review as the other."
---

The page says nothing. The file says who wrote it, on which machine, with which template, when it was started, and when it was last edited at 2 a.m. Journalists, opposing lawyers and curious readers check. Before a document goes public, the labels should say only what you intend.

## What is in there

A PDF's descriptive metadata includes:

- **Title, Subject, Keywords** — usually left as whatever the source application defaulted to, which is often the first line of an old draft.
- **Author** — the name in the software's licence or account, not necessarily the person who should be credited.
- **Creator and Producer** — the application that made the document and the library that wrote the PDF. They reveal software, versions, and sometimes a corporate template name.
- **Creation and modification dates** — including time zones, which reveal where a document was made.

And it lives in **two places**:

1. The **Info dictionary**, a small set of key–value pairs that every PDF has had since the beginning.
2. The **XMP packet**, an XML document embedded in the file, which carries the same fields and can carry many more — document history, template identifiers, the identifier of the original file a PDF was derived from.

They are supposed to agree. Frequently they do not, because the tool that edited one did not know about the other. A document whose Info dictionary is blank can still announce its author in XMP, and modern readers often show XMP first.

## What is not metadata, but leaks anyway

- **Bookmarks** that quote internal headings.
- **Comments and sticky notes**, including their author fields.
- **Form-field values** and hidden fields.
- **Attached files.**
- **Text under a black box** — see [How to redact a PDF properly](/guides/redact-a-pdf-properly/).
- **The filename.**

Metadata cleaning handles the first category; the rest need their own step.

## Inspecting and clearing it on your device

[Edit PDF metadata](/metadata-pdf/) reads both the Info dictionary and the XMP packet and shows you the current values before anything changes — because the point is to know what the file says, not to blindly blank it. Replace the title and author with what you want readers to see; remove the rest. The file is rewritten in your browser; it is never uploaded, which matters when the reason you are cleaning it is that it is not yet public.

## Step by step

1. **Rename the file** to something neutral.
2. If the document has comments or form fields, [Flatten PDF](/flatten-pdf/) — after deleting any comments that should not ship, since flattening preserves them visibly.
3. If any *content* must go, [Redact PDF](/redact-pdf/) it now. Redaction leaves metadata alone, so this order avoids re-cleaning.
4. Open [Edit PDF metadata](/metadata-pdf/) and read the current values. Note anything surprising.
5. Set Title and Author to what you intend. Clear Subject and Keywords unless they are deliberate. Remove Creator and Producer if the software should not be identified.
6. Save the cleaned copy.
7. Open the result in a different viewer and check its document properties. Then check the bookmarks panel and the attachments panel.

## Limits

Metadata cleaning rewrites the descriptive fields. It does not alter the pixels of embedded images — a photograph's own embedded camera data, if the source application preserved it inside the image stream, is a separate matter — and it cannot change the fonts, layout and phrasing that make a document recognisable. Clean the labels, then read the document as a stranger would.
