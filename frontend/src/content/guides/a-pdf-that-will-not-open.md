---
title: "A PDF that will not open: what is broken and what can be fixed"
description: "The three things that usually go wrong inside a damaged PDF, how to tell a repairable file from a truly lost one, and what a repair tool can and cannot put back."
summary: "Most unopenable PDFs are structurally damaged rather than destroyed: the index at the end of the file is wrong, or the file was truncated mid-transfer. Repair rebuilds that index by scanning for the objects themselves. It cannot invent bytes that never arrived."
tools: ["repair-pdf", "metadata-pdf", "merge-pdf"]
keywords: ["repair pdf", "pdf will not open", "corrupted pdf fix", "damaged pdf recovery", "pdf file damaged error", "repair pdf without upload"]
updated: "2026-09-11"
faqs:
  - question: "Can a repair tool recover a file that was only half downloaded?"
    answer: "It can recover the half that arrived. A PDF is read from an index at the end of the file, so a truncated download loses both the index and the final pages. Rebuilding the index recovers every complete object that made it; the pages that never downloaded cannot be reconstructed because their bytes do not exist."
  - question: "Why does my PDF open in one reader and not another?"
    answer: "Because readers differ in how much malformation they tolerate. Chrome's viewer and Acrobat both quietly rebuild the index when it is wrong, while stricter readers and many libraries refuse. A file that opens in one and not another is usually structurally damaged but content-intact — the best case for repair."
  - question: "Does repairing change the pages?"
    answer: "No. Repair rewrites the file's structure — the index, the object table, the trailer — and leaves the page content as found. Text stays text, images stay images. What changes is how the file is assembled, not what it draws."
---

"The file is damaged and could not be repaired." It is one of the more alarming messages a document can produce, and it is usually more pessimistic than the situation deserves. Most PDFs that refuse to open are not destroyed. They have lost their table of contents.

## How a PDF is read, and why that matters

A PDF is not read from the beginning. It is read from the **end**.

The last thing in the file is a pointer to the **cross-reference table** — an index listing every object in the document and the exact byte offset where each one starts. A reader jumps to the end, finds the index, and uses it to locate the page it needs. This is why a 900-page PDF opens instantly: nothing reads the whole file.

It is also the weakness. If those byte offsets are wrong, the reader looks for page 4 at a position where page 4 is not, and gives up. The pages are all still in the file, perfectly intact. The map to them is wrong.

## The three common failures

**The index is stale.** A program edited the file and appended new objects without correctly updating the offsets. Everything is present; the directory lies. This is the most common case and the most completely recoverable.

**The file is truncated.** A download stopped, an upload timed out, a drive filled up. The beginning is fine, the end — including the index — never arrived. Recoverable up to the cut, and no further.

**The bytes are scrambled.** Transferred as text rather than binary, damaged by failing storage, or partially overwritten. Individual objects are corrupt, not merely mislocated. This is the case where content genuinely is lost.

## What repair actually does

[Repair PDF](/repair-pdf/) ignores the broken index entirely. It scans the file from the start looking for the objects themselves — each one is self-identifying — records where each really begins, and writes a new file with a correct index built from what it found.

That is why it works so well on the first two failures and cannot help with the third. It relocates what exists; it does not reconstruct what does not. As the tool says: it rebuilds readable structure, but it cannot recreate bytes that are genuinely missing or destroyed.

## Step by step

1. **Work on a copy.** Whatever is wrong, do not experiment on your only version.
2. **Check the size first.** A file that should be 4 MB and is 400 KB was truncated, and you should expect to lose the later pages. Matching size suggests a structural problem, which repairs well.
3. **Try a second reader** before anything else. If Chrome opens it and your usual reader does not, the file is malformed but intact — you may be able to simply re-save it from the reader that works.
4. Open [Repair PDF](/repair-pdf/) and choose the file. It runs in your browser, which matters here: a file you cannot open is one you also cannot check before sending somewhere.
5. **Open the result and count the pages.** Compare against what you expect. Repair is honest about partial recovery, so fewer pages means those objects were not in the file.
6. Read the first and last recovered pages properly. Structure can be rebuilt around content that is itself damaged.

## If pages are missing

- **Check for an older copy** — an email attachment, a sync folder's version history, a backup. Recovering the original always beats repairing a damaged one.
- **Rebuild from parts.** If you have overlapping partial copies, repair each and use [Merge PDF](/merge-pdf/) to assemble a complete document from the pieces that survived.
- **Check the metadata** with [Edit PDF metadata](/metadata-pdf/) — the producing application and creation date can point you at where an intact original still lives.

## Avoiding the next one

Truncation is the failure you can prevent. Verify file sizes after a transfer, avoid editing a PDF directly on a network drive or USB stick, and keep the source document — the Word file, the export, the scan — because regenerating a PDF is always cleaner than repairing one.
