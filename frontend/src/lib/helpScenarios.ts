/** Original task-based reference content, separate from the in-tool quick steps.
 * Keep examples aligned with the browser operation, not a competitor's promises.
 * Missing coverage intentionally fails the static build for a newly live tool.
 */
export interface HelpScenario {
  example: string;
  input: string;
  action: string;
  result: string;
  caution: string;
  troubleshooting: string;
}

type ScenarioFields = [string, string, string, string, string, string];
function scenario(...[example, input, action, result, caution, troubleshooting]: ScenarioFields): HelpScenario {
  return { example, input, action, result, caution, troubleshooting };
}

export const HELP_SCENARIOS: Record<string, HelpScenario> = {
  'merge-pdf': scenario(
    'Assemble a job application: cover letter, résumé, then portfolio.',
    'Start with a one-page cover letter, a two-page résumé and a four-page portfolio, each saved as a PDF.',
    'Choose the three files. Review the visible page grid and put the cover first, the résumé next and the portfolio last before running Merge.',
    'Expect one seven-page PDF. Open the result and check pages 1, 2, 4 and 7 to confirm the document boundaries and final page.',
    'Combining pages is not the same as combining interactive forms. Check form fields, links and bookmarks in the saved copy before submitting it.',
    'If an input is rejected, open it in a PDF viewer first. An image renamed with a .pdf extension is still an image: convert it with Images to PDF before merging.'),
  'split-pdf': scenario(
    'Send two chapters separately without including the rest of a report.',
    'Use a six-page PDF with chapter one on pages 1–3 and chapter two on pages 4–6.',
    'Enter the page groups 1-3, 4-6, or place a cut after page 3 in the visible grid. Review the groups before running Split.',
    'Expect two PDFs with three pages each. Open both and check that the second result begins with original page 4.',
    'A comma separates outputs. Pages omitted from every group will not appear in any result, but remain in your original file.',
    'For every-N-pages, approximate file size, bookmarks, blank pages or page-start text, use Split by size or bookmark instead of entering every group by hand.'),
  'rotate-pdf': scenario(
    'Correct a sideways page in an otherwise upright scanned agreement.',
    'Choose the mixed-orientation PDF and identify the sideways page in the preview.',
    'Turn that page until its text is upright. Use the all-pages control only when every page needs the same turn.',
    'The saved PDF retains its page content and changes page rotation. Check both the corrected page and an originally upright page.',
    'Landscape paper does not always mean incorrect rotation. Read the text direction rather than judging the thumbnail shape alone.',
    'If a page turns the wrong way, turn it again in the preview before exporting. Do not apply a global rotation just to fix one page.'),
  'organise-pdf': scenario(
    'Move an appendix ahead of the signature page.',
    'Open a five-page PDF with the signature on page 4 and the appendix on page 5.',
    'Move the fifth thumbnail before the fourth using the page grid. Review the final sequence before exporting.',
    'Expect five pages in the order 1, 2, 3, 5, 4. The last page should now be the signature page.',
    'Page sequence changes, but printed page numbers inside the original content do not automatically change with it.',
    'If the order is confusing, compare the original page numbers shown in the grid. Add new page numbers separately only after the sequence is final.'),
  'extract-pages': scenario(
    'Send only two relevant invoice pages from a larger statement.',
    'Choose a statement with the required invoices on pages 2 and 5.',
    'Select pages 2 and 5 in the page grid and confirm that the other pages are not selected.',
    'Expect a new two-page PDF containing those invoice pages. Compare its first and second pages with the originals.',
    'Extraction selects whole pages. It does not hide or redact information elsewhere on a selected page.',
    'If the action is unavailable, select at least one page. For private details within a selected invoice, use Redact on the extracted copy and verify it.'),
  'delete-pages': scenario(
    'Remove a blank separator from a scanned packet.',
    'Choose a four-page PDF whose third page is blank.',
    'Mark page 3 for deletion and review its removed state in the grid. Leave the three wanted pages unmarked.',
    'Expect a three-page PDF, with original page 4 following original page 2.',
    'Keep at least one page. Deleting a page is not secure removal of repeated information that may also appear on other pages.',
    'If all pages are marked and the tool cannot proceed, unmark a page. If the blank page contains a faint stamp, inspect it at a larger preview size first.'),
  'split-by': scenario(
    'Divide a 60-page training handbook into six smaller packets.',
    'Choose the handbook PDF and confirm it contains 60 pages.',
    'Select Every N pages and enter 10. Review the selected mode before creating the pieces.',
    'Expect six PDFs of ten pages each. With 63 source pages, the last piece would contain the remaining three pages.',
    'File-size splitting is approximate: a single oversized page cannot be split into less than one page. Bookmark and text modes depend on document structure.',
    'If page-start text finds no boundaries, check that the phrases start the relevant pages and that the PDF has a text layer. OCR an image-only scan first.'),
  'scan-pdf': scenario(
    'Create a filing copy from four photographed contract pages.',
    'Capture the pages with the camera or choose four page photos. Use even lighting and include all page edges.',
    'Review the order and corners of each photo. Choose colour, grey or text treatment, and request searchable text only if needed.',
    'Expect one four-page PDF. Inspect signatures, small print and every cropped edge before filing.',
    'Black-and-white treatment may lose coloured annotations. OCR results need proofreading; a cleaned scan does not guarantee accurate recognition.',
    'For a clipped corner, reopen the page review and adjust its four corners or choose the whole frame. Rebuild and compare against the original photo.'),
  'compress-pdf': scenario(
    'Reduce a scanned application for a portal with a strict upload limit.',
    'Keep the original scan and note its size and the portal limit before choosing the file.',
    'Try lossless processing first. Consider a stronger image preset only after comparing the first result and its reported size.',
    'Expect a separate PDF with a measured size change, not a guaranteed percentage reduction. Open small text and signatures at reading size.',
    'Already-compressed PDFs may not shrink. Stronger image compression can reduce detail that cannot be recovered from the compressed copy.',
    'If the result is still above the limit, split into acceptable pieces if the portal allows it, or start from smaller source images. Avoid repeatedly compressing the same result.'),
  'jpg-to-pdf': scenario(
    'Turn three receipt photos into one expense attachment.',
    'Choose three JPG, PNG or WebP images in receipt order.',
    'Select Fit to retain each image shape, or A4/Letter for fixed paper. Review orientation and image order before conversion.',
    'Expect one PDF with three image pages. Zoom in to check dates, tax and totals before sending it.',
    'Fixed-size paper can introduce margins. Making a photo into a PDF does not recognise its text or improve a blurred original.',
    'If a phone photo is an unsupported format, export it as JPG or PNG first. For perspective correction and searchable scans, use Scan to PDF.'),
  'pdf-to-jpg': scenario(
    'Export page 3 of a proposal for use in a presentation.',
    'Choose the proposal PDF. This tool exports page images; for only page 3, first create a one-page PDF with Extract pages.',
    'Choose PNG for crisp graphics or JPG for a smaller photographic image, then select 72, 150 or 300 DPI.',
    'Expect a named image for each input page. Pick the image you need and check its dimensions and readability at the intended slide size.',
    'Large pages may be rendered at a capped DPI to respect browser memory limits. An image export no longer has selectable PDF text.',
    'If the image is soft, try a higher DPI. If rendering is refused or memory runs low, lower DPI or export fewer pages at once.'),
  'pdf-to-markdown': scenario(
    'Reuse a text-based meeting memo as editable Markdown notes.',
    'Choose a PDF where a viewer can select the memo text.',
    'Convert, then review the generated headings, lists, links and reading order in a text editor.',
    'Expect a Markdown file containing extracted text structure, not a copy of the printed page layout.',
    'Multiple columns, unusual spacing and decorative headings can lead to an incorrect reading order.',
    'If output is empty, the memo may consist of scanned images. Run OCR first and proofread the recognised text before converting again.'),
  'word-to-pdf': scenario(
    'Create a browser-generated copy of a simple DOCX proposal.',
    'Choose a DOCX with ordinary headings, paragraphs, lists and a small table.',
    'Convert and inspect page breaks, table rows and paragraph spacing in the PDF.',
    'Expect a reconstructed PDF suitable for reviewing straightforward content; keep the DOCX as the editable source.',
    'Floating objects, advanced Word features and unavailable fonts can differ from the original application.',
    'If exact Word pagination is essential, export with the original word processor. For a simpler browser conversion, simplify the source layout and retry.'),
  'pdf-to-word': scenario(
    'Recover editable text from a letter whose source document is missing.',
    'Choose a text-based PDF and review the available conversion mode.',
    'Convert and open the DOCX in a word processor. Check paragraphs, page breaks and any tables before editing.',
    'Expect a rebuilt editable DOCX, not the original authoring file.',
    'Decorative layouts and multi-column pages may need manual correction. Do not assume identical layout or unchanged values.',
    'If text is absent or incomplete, test whether it is selectable in the source. OCR a scanned copy first, then check recognised names and numbers.'),
  'pdf-to-excel': scenario(
    'Extract a ruled invoice table for reconciliation.',
    'Choose a PDF whose item rows, column headings and totals are clearly separated.',
    'Convert to XLSX and compare the resulting rows and columns against the page before calculating anything.',
    'Expect cells for detected table structure. Verify item count, decimal places and the final total.',
    'Merged cells, borderless tables and irregular spacing are ambiguous; conversion is not an accounting validation.',
    'If columns merge or totals shift, correct the spreadsheet against the original or use a cleaner source. Never rely on a total without checking the component rows.'),
  'excel-to-pdf': scenario(
    'Share a workbook report as a fixed reading copy.',
    'Choose an XLSX workbook saved after its formulas were recalculated in Excel.',
    'Convert and inspect wide tables, page breaks, currency, dates and the totals in the PDF.',
    'Expect a PDF based on stored cell values and supported formatting.',
    'The browser uses cached formula results; it does not recalculate the workbook or prove that the formulas are correct.',
    'For missing or stale formula values, open, recalculate and save the workbook in Excel before converting again.'),
  'powerpoint-to-pdf': scenario(
    'Send a slide deck as a printable reading copy.',
    'Choose a PPTX presentation and retain the original for presenting.',
    'Convert and check slide order, tables, pictures and text in each PDF page.',
    'Expect static pages based on the slides rather than an interactive presentation.',
    'Video, animation, special effects and unsupported fonts cannot be assumed to match PowerPoint playback.',
    'For a critical layout mismatch, simplify the slide or export directly from PowerPoint. Inspect the repaired page alongside the original slide.'),
  'text-to-pdf': scenario(
    'Typeset a CSV price list without changing its product codes.',
    'Choose a CSV containing codes such as 00123 and confirm the detected input kind.',
    'Select A4 or Letter and convert. Check the first row, leading zeros and column headings in the result.',
    'Expect a paginated PDF with CSV/TSV values treated as text rather than automatically converted to dates or numbers.',
    'TXT, CSV, TSV and Markdown have different structures. Markdown support is focused rather than a complete CommonMark implementation.',
    'If columns are wrong, check the input kind and delimiter. For broken characters, save the source with a suitable text encoding and retry.'),
  'extract-images': scenario(
    'Recover embedded product photos from a brochure you are authorised to reuse.',
    'Choose the brochure PDF. The current tool applies its own small-image filtering rather than offering a size control.',
    'Extract its images and inspect the dimensions and contents of each output.',
    'Expect individual image resources where supported; stored JPEGs can be copied without a page screenshot.',
    'Vector drawings, masks and a picture assembled from many pieces may not exist as one extractable photo. Ownership of the PDF does not automatically grant image reuse rights.',
    'If no images are recovered, the resources may be unsupported, very small or not embedded images. Use PDF to image for a page rendering instead.'),
  'edit-pdf': scenario(
    'Add a review note and highlight without altering the source draft.',
    'Choose a PDF and open the page containing the passage to discuss.',
    'Place a text note and highlight. Select each added object to move or resize it, then export after checking alignment.',
    'Expect a separate PDF with the added objects. Reopen it to check that the note is legible and does not cover important wording.',
    'Placed overlays do not reflow existing paragraphs like a word processor. Covering words with a shape does not securely remove them.',
    'For an original wording change, edit the source or convert a suitable PDF to Word. For confidential content, use Redact instead of covering it with a drawing.'),
  'watermark-pdf': scenario(
    'Mark a review copy as DRAFT without obscuring its text.',
    'Choose the draft PDF. The current Watermark tool applies text to every page.',
    'Enter DRAFT in Watermark text and create the result. The mark is drawn diagonally at a preset low opacity.',
    'Expect a marked copy. Open a light page and a dark image page separately to check whether the mark and body text are readable.',
    'A watermark communicates status; it does not prevent copying or establish ownership.',
    'If the preset is unsuitable for your pages, keep the unmarked original and use Edit for manually placed objects. This Watermark view does not expose opacity, angle or logo controls.'),
  'page-numbers': scenario(
    'Add a simple sequence to a ten-page handout.',
    'Choose a ten-page PDF that should be numbered on every page.',
    'Set Start at to 1 and optionally enter Page followed by a space as the prefix. Create and open the result.',
    'Expect labels 1–10 in the bottom-right corner of the ten pages, with your prefix if supplied.',
    'Source page position and printed page labels are different. Existing printed numbers are not automatically erased.',
    'This view does not offer a page range or position selector. To leave covers untouched, extract the body, number that copy, then merge the untouched covers back before it.'),
  'grayscale-pdf': scenario(
    'Prepare a colour report for a greyscale print run.',
    'Choose the report and keep its colour version for comparison.',
    'Run Grayscale, then inspect charts, photos and the operation notes.',
    'Expect supported colour content converted to grey while text and vector content are retained where possible.',
    'Some images may be decoded and re-encoded, changing size or quality. Unsupported image content can remain unchanged.',
    'If two chart series become indistinguishable, add labels or patterns in the source. Check the conversion notes for content that was not converted.'),
  'auto-crop': scenario(
    'Trim large white margins from a scanned booklet.',
    'Choose the scan and inspect faint notes near its edges.',
    'Run Trim margins and inspect the saved pages. The current tool uses its default uniform crop treatment, not an exposed per-page mode selector.',
    'Expect tighter visible page boxes without the crop operation re-encoding the existing page content.',
    'Dust and isolated marks can affect ink detection. Cropping hides outside content; it does not delete that content.',
    'If margins remain large, inspect edge marks and try the separate Crop tool for a manual boundary. Check faint notes and pages with different sizes before relying on the result.'),
  'crop-pdf': scenario(
    'Remove excess margins from a landscape handout.',
    'Choose the PDF and identify a safe crop that retains captions and page numbers.',
    'Set the visible crop box, choose the affected pages and review rotated pages before exporting.',
    'Expect a new visible page boundary with existing text, images and fonts retained.',
    'Cropped-out material can still exist in the file. Use Redact when information must be removed rather than hidden.',
    'If no pages change, check the page selection. For clipped labels, enlarge the box and inspect pages with different sizes or rotations individually.'),
  'flatten-pdf': scenario(
    'Make completed form answers part of a reading copy.',
    'Choose a filled ordinary AcroForm and retain the editable original.',
    'Select the supported field, annotation or layer options, export, then reopen the result in a viewer.',
    'Expect supported appearances painted into the page and their interactive fields removed. Check every answer, not just whether fields can be clicked.',
    'Flattening is not redaction or a security guarantee. Missing or stale field appearances can lose or misrepresent answers; links can remain clickable.',
    'If an answer is absent, return to the original and check its appearance in a compatible form editor. XFA forms require a compatible application rather than this flattening workflow.'),
  'impose-pdf': scenario(
    'Print an eight-page handout with two source pages per sheet.',
    'Choose the eight-page PDF and decide between ordinary N-up and folded booklet printing.',
    'For the handout, select 2-up and inspect sheet order. Use booklet mode only when you intend to fold and print the required sides.',
    'Expect source pages arranged into new sheets. Print one test sheet to confirm scale and orientation.',
    'Booklet order differs from reading order. Form fields, comments, links and bookmarks may not retain a meaningful place after imposition.',
    'If the reverse side is upside down, check printer duplex orientation using a test sheet before printing the whole document.'),
  'overlay-pdf': scenario(
    'Apply a one-page letterhead to a multi-page document.',
    'Choose the base document first and the letterhead second, preferably with matching paper sizes.',
    'Choose Over or Under the document, then Actual size, Fit inside page, Cover page or Stretch to page. Create and inspect the result.',
    'Expect a separate combined copy. Check that the letterhead has not obscured body text or footers.',
    'An opaque overlay background can hide the base page. Matching paper sizes does not guarantee matching margins.',
    'If alignment is wrong, check the two page sizes and Fit setting. There is no page matching selector in this view. Use a letterhead source with clear space for the base text.'),
  'header-footer': scenario(
    'Add a Bates identifier to a document production copy.',
    'Choose the PDF and decide the text and Bates prefix for this document.',
    'Enter Header and Footer text, using {page} and {pages} where needed. Enter a Bates prefix only when you need discovery numbering, then create the result.',
    'Expect repeated text in the default positions. Compare the first and last page labels to your production list.',
    'Adding identifiers does not certify evidence, prevent alterations or guarantee that a numbering scheme meets a recipient’s requirements.',
    'If tokens print literally, check their spelling. This view does not expose page-range, starting-sequence or position selectors; confirm its defaults meet your needs and inspect for overlap with existing text.'),
  'metadata-pdf': scenario(
    'Remove outdated author details from a sharing copy.',
    'Choose the PDF and inspect its descriptive properties.',
    'Clear or replace the relevant fields, export, then reopen the result and inspect its properties again.',
    'Expect the requested metadata changes in a separate PDF.',
    'Names can also occur in page text, pictures, annotations or other structures. Metadata cleanup is not complete anonymisation.',
    'If a name is still visible on a page, edit the source or use an appropriate redaction workflow. Do not assume that clearing Author removes every personal reference.'),
  'compare-pdf': scenario(
    'Find wording changes between two contract drafts.',
    'Choose the older and newer text-based PDFs in the correct order.',
    'Run comparison and review each reported text change alongside both originals.',
    'Expect a text-oriented comparison, not proof that every visual element is unchanged.',
    'A changed picture or layout can be important even when extracted wording is identical. Scans may have no usable text layer.',
    'If changes appear missing, test text selection and OCR image-only drafts where needed. Review layout, images and signatures visually as a separate check.'),
  'ocr-pdf': scenario(
    'Make a photographed typed memo searchable.',
    'Choose a legible English-language scan. The current OCR release recognises English only.',
    'Run OCR and inspect the recognised words against the page image, including names and numeric values.',
    'Expect a new PDF with a text layer when recognition succeeds. Search for a known phrase to check the result.',
    'Skew, blur, handwriting and language mismatch affect accuracy. Searchability does not imply transcription accuracy.',
    'For poor recognition, start with a sharper, straighter English scan. Use a compatible recognition service for other languages, and verify important values against the image.'),
  'pdf-forms': scenario(
    'Complete an ordinary fillable form and keep an editable copy.',
    'Choose an AcroForm with visible text fields, boxes or other supported controls.',
    'Fill the fields, export an editable copy, and use flattening only if the recipient needs a non-interactive reading copy.',
    'Expect a filled PDF that displays the entered values when reopened. Check all pages and selected options.',
    'XFA forms and unsupported field features may need the application specified by the form issuer.',
    'If fields are absent or the tool reports an unsupported form, retain the original and open it in a compatible form editor. Do not flatten a blank or incomplete form.'),
  'protect-pdf': scenario(
    'Create a password-protected copy for an authorised recipient.',
    'Choose the PDF and prepare a strong password that you can share through a separate suitable channel.',
    'Set the password and supported permissions, export, close the result and reopen it with that password.',
    'Expect an encrypted PDF copy. Test access before deleting any unprotected original you still need.',
    'Reader permissions are not a substitute for controlling recipients. Losing the password may make the protected copy inaccessible.',
    'If opening fails, check the exact password and keyboard layout. Return to the original to create a new protected copy rather than assuming a recovery method exists.'),
  'unlock-pdf': scenario(
    'Remove a password from your own document for an approved workflow.',
    'Choose a protected PDF you are authorised to modify and have its valid password ready.',
    'Enter the password, export the unprotected copy and reopen it to confirm the intended access.',
    'Expect an unprotected result only when the source can be opened with the supplied credentials.',
    'This is not a password-cracking service or permission to remove another person’s controls.',
    'If the password is missing or rejected, contact the document owner or administrator. Renaming the file or retrying without credentials does not bypass encryption.'),
  'redact-pdf': scenario(
    'Remove an account number from a statement copy before sharing.',
    'Choose the statement and identify every place the number occurs, including images and repeated headers.',
    'Draw a redaction area for every occurrence using the manual page controls, review all marks, export and inspect the tool’s result notes.',
    'Expect a new redacted copy. Reopen it, search for the removed value and visually inspect the affected areas and any additional occurrences.',
    'A black rectangle in an ordinary editor is not redaction. No single search proves removal of every duplicate, image or alternate representation.',
    'For a scanned number that search misses, mark the visible area and inspect the exported page. Keep the original securely and do not share a result until all intended occurrences are checked.'),
  'repair-pdf': scenario(
    'Recover readable pages from a PDF with damaged structure.',
    'Choose a file that a viewer reports as damaged, and preserve an untouched copy.',
    'Run Repair, inspect reported page count and notes, then reopen the result in another PDF viewer.',
    'Expect a rebuilt PDF when readable page contents can be recovered.',
    'Repair cannot recreate missing bytes. Bookmarks, form fields and attachments do not survive this page-recovery workflow.',
    'If pages or content are missing, stop using the result as a complete record. Obtain another source copy or seek recovery while retaining the damaged original.'),
  'sign-pdf': scenario(
    'Place a visible signature mark on a form.',
    'Choose the PDF and identify the signature area before drawing, typing or importing your own mark.',
    'Position and resize the mark so it fits the line. Review it at reading size before exporting.',
    'Expect a PDF with a visible signature mark. Reopen it to check placement and any date you added.',
    'A placed mark is not a certificate-backed digital signature, identity verification or trusted timestamp.',
    'If the mark is distorted, preserve its proportions while resizing. If the recipient requires verified digital signing, use a signing service that meets those requirements.'),
  'pdf-a': scenario(
    'Prepare a PDF for an archive that requests PDF/A.',
    'Choose a PDF with embedded fonts and obtain the archive’s required conformance profile.',
    'Convert, inspect the output and validate it with the recipient’s accepted PDF/A validator.',
    'Expect an archival candidate when required resources can be embedded, not a universal certification.',
    'An archive may require a different profile or additional rules. Successful creation alone does not establish conformance for every repository.',
    'If conversion refuses unembedded fonts or missing resources, recreate the PDF from its source with those resources embedded and validate the new candidate.')
};

export function helpScenarioFor(slug: string): HelpScenario {
  const value = HELP_SCENARIOS[slug];
  if (!value || Object.values(value).some((field) => field.trim().length < 30)) {
    throw new Error(`Missing substantive worked example for live tool: ${slug}`);
  }
  return value;
}
