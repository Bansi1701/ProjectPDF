import type { CollectionEntry } from 'astro:content';

import { NAVIGATION_GROUPS, type NavigationGroup, type NavigationTone } from '../config/navigation';
import type { Tool } from '../config/site';
import type { FaqItem } from './seo';

interface HelpProfile {
  audience: string;
  before: string[];
  tips: string[];
  terms: string[];
}

const PROFILES: Record<NavigationTone, HelpProfile> = {
  organize: {
    audience: 'people preparing reports, scanned packets, submissions, records, and documents whose page order matters',
    before: [
      'Keep the original file until the new document has been opened and checked.',
      'Use the visible page thumbnails to confirm page order, orientation, and the exact pages being changed.',
      'Remember that printed page labels can differ from the PDF page number shown by the browser.',
    ],
    tips: [
      'Zoom the thumbnail view when two pages look similar, especially in scanned document batches.',
      'For a very large document, test the intended settings on a small page group first.',
      'Check the output page count and file order in the result receipt before saving or sharing.',
    ],
    terms: ['organize PDF pages', 'PDF page management', 'rearrange PDF online'],
  },
  optimize: {
    audience: 'people preparing PDFs for upload limits, printing, email, filing, or long-term storage',
    before: [
      'Decide whether the priority is smaller size, cleaner page edges, compatibility, or visual quality.',
      'Keep the original because optimization can intentionally remove editable or unused document data.',
      'Open image-heavy or scanned pages at normal reading size so quality changes are easy to notice.',
    ],
    tips: [
      'Try the least destructive option first, then increase compression or cropping only when needed.',
      'Compare both the byte size and the visible page quality instead of trusting a promised percentage.',
      'Inspect thin text, diagrams, signatures, and photographs after processing because they reveal quality loss first.',
    ],
    terms: ['optimize PDF online', 'reduce PDF size', 'prepare PDF for upload'],
  },
  'to-pdf': {
    audience: 'people turning office files, images, spreadsheets, slides, or text into a dependable document for sharing',
    before: [
      'Save the editable source file separately; the PDF is a sharing copy rather than a replacement for the original.',
      'Confirm page size, orientation, formulas, fonts, and the final source content before conversion.',
      'Use a current browser with enough memory for image-heavy workbooks, presentations, or image collections.',
    ],
    tips: [
      'Review every generated page before saving, especially page breaks, tables, and unusually long text.',
      'Use the source application for final layout corrections, then convert the corrected source again.',
      'Open the finished PDF in a second viewer when it will be printed, filed, or submitted to a portal.',
    ],
    terms: ['convert to PDF online', 'create PDF in browser', 'make PDF without upload'],
  },
  'from-pdf': {
    audience: 'people reusing text, tables, page images, and embedded pictures from an existing PDF',
    before: [
      'Check whether the PDF has selectable text; image-only scans normally need OCR before text conversion.',
      'Choose only the pages you need when the tool offers page selection.',
      'Expect complex columns, decorative layouts, or unruled tables to need review in the exported file.',
    ],
    tips: [
      'Run OCR first when copied text is empty, incomplete, or visibly different from the page.',
      'Compare important numbers, headings, and table rows against the original PDF.',
      'Treat the exported document as an editable reconstruction, not the original authoring file.',
    ],
    terms: ['convert PDF online', 'export PDF content', 'extract from PDF'],
  },
  compose: {
    audience: 'people adding visible information, branding, numbering, print layouts, or reusable page content',
    before: [
      'Plan the pages, position, text, color, and size before applying a repeated change.',
      'Keep important text inside a safe margin so printers and page crops do not hide it.',
      'Work on a copy when the output will make comments, fields, or additions permanent.',
    ],
    tips: [
      'Use the page preview at a larger zoom for precise placement.',
      'Keep typography, spacing, color, and position consistent across repeated pages.',
      'Open the exported PDF and inspect the first, middle, and last affected pages.',
    ],
    terms: ['edit PDF online', 'compose PDF in browser', 'add content to PDF'],
  },
  review: {
    audience: 'people searching, comparing, recognizing, completing, or inspecting document information',
    before: [
      'Determine whether the document has a text layer or is an image-only scan.',
      'Keep the original available while checking extracted text, differences, fields, or metadata.',
      'Treat uncertain recognition and layout results as items to verify rather than final facts.',
    ],
    tips: [
      'Use OCR first when text search or extraction cannot see words that are visible on the page.',
      'Review warnings and confidence notes before relying on extracted or compared information.',
      'Check names, dates, totals, identifiers, and form answers against the page itself.',
    ],
    terms: ['review PDF online', 'inspect PDF in browser', 'search PDF privately'],
  },
  secure: {
    audience: 'people preparing private, signed, redacted, password-protected, or archival document copies',
    before: [
      'Work on a copy and keep the untouched original in a safe location.',
      'Confirm that you are authorized to remove protection, redact information, or sign the document.',
      'Understand whether the result is a visual mark, access control, permanent removal, or archival conversion.',
    ],
    tips: [
      'Open the result in another viewer and test the security or visual change before distributing it.',
      'Check metadata and searchable text as well as what is visibly shown on the page.',
      'For legal, compliance, or archival use, verify the output with the organization receiving the document.',
    ],
    terms: ['secure PDF online', 'private PDF tool', 'protect PDF without upload'],
  },
};

const LIMITATIONS: Partial<Record<string, string[]>> = {
  'compress-pdf': ['The amount saved depends on what the PDF contains. A file that is already compressed may become only slightly smaller.'],
  'crop-pdf': ['Cropping changes the visible page box; it does not securely erase hidden content outside that box. Use Redact when information must be removed.'],
  'edit-pdf': ['The editor places new text and objects on the page. It does not reflow an existing paragraph like a word processor.'],
  'extract-images': ['The tool can export pictures stored as PDF image objects. Artwork assembled from vectors, masks, or many small pieces may not exist as one extractable image.'],
  'ocr-pdf': ['OCR accuracy depends on language, resolution, contrast, page angle, handwriting, and scan quality. Important text must be checked against the page.'],
  'pdf-a': ['Creating a PDF/A candidate is different from certified conformance validation. Formal archival workflows should validate the result with an approved validator.'],
  'pdf-to-excel': ['Tables without clear rows or columns can be ambiguous. Verify totals and cell boundaries before using the spreadsheet.'],
  'pdf-to-word': ['The DOCX is reconstructed from page geometry; complex columns and decorative layouts may need editing.'],
  'powerpoint-to-pdf': ['Unusual effects, video, animation, and unsupported fonts cannot behave like the original presentation inside a static PDF.'],
  'repair-pdf': ['Repair can rebuild readable PDF structure, but it cannot recreate source bytes that are genuinely missing or destroyed.'],
  'redact-pdf': ['Every suggested or manually marked area must be reviewed. Keep the original until the saved copy has been searched and visually inspected.'],
  'sign-pdf': ['A drawn, typed, or uploaded signature is a visible signature mark. It is not a certificate-backed digital signature, timestamp, or identity verification.'],
  'split-by': ['File-size targets are measured from generated pieces, but a single page that exceeds the target cannot be split into less than one page.'],
  'split-pdf': ['Smart separators depend on the PDF text layer, bookmarks, or rendered blank-page detection. Review every detected boundary.'],
  'unlock-pdf': ['ProjectPDF can remove protection only when the document can be opened with the password or permissions you are authorized to use.'],
  'word-to-pdf': ['A browser converter cannot reproduce every Word layout feature. Review page breaks, fonts, headers, footers, and floating objects.'],
};

export function helpGroupFor(tool: Tool): NavigationGroup {
  return NAVIGATION_GROUPS.find((group) => group.tools.some((candidate) => candidate.slug === tool.slug))
    ?? NAVIGATION_GROUPS[0];
}

export function helpProfileFor(tool: Tool): HelpProfile {
  return PROFILES[helpGroupFor(tool).tone];
}

export function helpQuickAnswer(tool: Tool): string {
  return `${tool.searchName} is a browser-based ProjectPDF tool built for this task: ${tool.blurb} It runs on this device, creates a separate result, and does not require an account or document upload.`;
}

export function helpArticleDescription(tool: Tool): string {
  return `Learn what ${tool.searchName} does, when to use it, how to use it step by step, what to check, and answers to common questions.`;
}

export function helpKeywords(tool: Tool): string[] {
  const name = tool.searchName.toLocaleLowerCase();
  const profile = helpProfileFor(tool);
  return [...new Set([
    name,
    `how to ${name}`,
    `${name} online`,
    `free ${name}`,
    `private ${name}`,
    `${name} without upload`,
    `${name} without account`,
    `${name} in browser`,
    ...profile.terms,
    'ProjectPDF help',
  ])];
}

export function helpFaqs(
  tool: Tool,
  content: CollectionEntry<'tools'>['data'],
): FaqItem[] {
  return [
    {
      question: `What is ${tool.searchName} used for?`,
      answer: helpQuickAnswer(tool),
    },
    {
      question: `Can I use ${tool.searchName} on a phone or tablet?`,
      answer: `Yes. ${tool.searchName} works in a current mobile browser. Complex PDFs can need more memory, so keep the tab open, avoid switching apps during processing, and inspect the result before closing the page.`,
    },
    ...content.faqs,
  ];
}

export function helpLimitations(tool: Tool): string[] {
  return LIMITATIONS[tool.slug] ?? [
    'The result depends on the structure and quality of the source document, so visually inspect the exported file before relying on it.',
    'Browser memory varies by device. Very large or unusually complex PDFs may work better when processed in smaller groups.',
  ];
}
