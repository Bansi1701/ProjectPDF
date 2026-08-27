export type ToolCategory = 'Organise' | 'Convert' | 'Edit' | 'Secure';

/** Where the work happens. This is the product's whole argument, so it is data. */
export type RunsWhere = 'local' | 'server';

/** Honest build state. Never show a tool as ready before it is. */
export type ToolStatus = 'live' | 'building' | 'planned';

export interface Tool {
  slug: string;
  name: string;
  category: ToolCategory;
  blurb: string;
  runsWhere: RunsWhere;
  status: ToolStatus;
}

export const SITE = {
  name: 'ProjectPDF',
  tagline: 'Your file never leaves this page.',
  description:
    'PDF tools that run entirely in your browser. Nothing is uploaded, so there is nothing for us to store or leak.',
} as const;

export const CATEGORIES: ToolCategory[] = ['Organise', 'Convert', 'Edit', 'Secure'];

/**
 * One object per tool. Adding a tool here puts it in the homepage grid, the
 * footer columns and (later) the sitemap — there is no second list to update.
 */
export const TOOLS: Tool[] = [
  // --- Organise ---
  { slug: 'merge-pdf', name: 'Merge', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Combine files and reorder pages before you export.' },
  { slug: 'split-pdf', name: 'Split', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Cut one document into many, at the pages you choose.' },
  { slug: 'rotate-pdf', name: 'Rotate', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Fix sideways scans. Lossless — only the page dictionary changes.' },
  { slug: 'organise-pdf', name: 'Reorder', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Drag pages into the order you actually wanted.' },
  { slug: 'extract-pages', name: 'Extract pages', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Pull a range out into its own file.' },
  { slug: 'delete-pages', name: 'Delete pages', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Remove pages and save what is left.' },

  // --- Convert ---
  { slug: 'split-by', name: 'Split by size or bookmark', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Every N pages, into equal parts, at a size, or at each chapter.' },
  { slug: 'scan-pdf', name: 'Scan to PDF', category: 'Organise', runsWhere: 'local', status: 'live', blurb: 'Photograph pages. Straightened and sharpened on your device.' },
  { slug: 'compress-pdf', name: 'Compress', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Smaller file, checked against the original before you get it.' },
  { slug: 'jpg-to-pdf', name: 'Images to PDF', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'JPG, PNG or WebP into one document. JPG and PNG are not re-encoded.' },
  { slug: 'pdf-to-jpg', name: 'PDF to image', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Export pages as JPG or PNG at the DPI you pick.' },
  { slug: 'pdf-to-markdown', name: 'PDF to Markdown', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'For documents that already have a text layer.' },
  { slug: 'word-to-pdf', name: 'Word to PDF', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Text, headings and lists from a .docx — in your browser.' },
  { slug: 'url-to-pdf', name: 'Web page to PDF', category: 'Convert', runsWhere: 'server', status: 'building', blurb: 'A public URL is not your private file, so we fetch it.' },
  { slug: 'pdf-to-word', name: 'PDF to Word', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'An editable .docx, rebuilt from the page in your browser.' },
  { slug: 'pdf-to-excel', name: 'PDF to Excel', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Tables into cells — and an honest word about what it found.' },
  { slug: 'excel-to-pdf', name: 'Excel to PDF', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Formula results, currency and dates exactly as the sheet shows them.' },
  { slug: 'powerpoint-to-pdf', name: 'PowerPoint to PDF', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'One page per slide — template layouts, theme colours and tables.' },

  // --- Edit ---
  { slug: 'text-to-pdf', name: 'Text, CSV or Markdown to PDF', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Plain text, a spreadsheet export, or Markdown — typeset here.' },
  { slug: 'extract-images', name: 'Extract images', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'The original pictures at their own resolution, not screenshots.' },
  { slug: 'edit-pdf', name: 'Edit', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Text, shapes, highlights and images on the page.' },
  { slug: 'watermark-pdf', name: 'Watermark', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Text or a logo — placed, tiled, angled, on the pages you pick.' },
  { slug: 'page-numbers', name: 'Page numbers', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Numbering that matches the page labels people cite.' },
  { slug: 'grayscale-pdf', name: 'Greyscale', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Drop the colour without flattening the text into pixels.' },
  { slug: 'auto-crop', name: 'Trim margins', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Finds the content and crops to it — for scans with huge margins.' },
  { slug: 'crop-pdf', name: 'Crop', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Trim the margins. Lossless — only the page box changes.' },
  { slug: 'flatten-pdf', name: 'Flatten', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Make forms and comments permanent so nothing stays editable.' },
  { slug: 'impose-pdf', name: 'N-up & booklet', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Several pages to a sheet, a foldable booklet, or a poster.' },
  { slug: 'overlay-pdf', name: 'Overlay', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Lay one PDF over another — letterhead, a draft mark, a stamp.' },
  { slug: 'header-footer', name: 'Header, footer & Bates', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Running heads, and the numbering discovery workflows need.' },
  { slug: 'metadata-pdf', name: 'Metadata', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'See what your file is carrying, then change or remove it.' },
  { slug: 'compare-pdf', name: 'Compare', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'What changed between two drafts, in words not pixels.' },
  { slug: 'ocr-pdf', name: 'OCR', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Make a scan searchable. Small jobs stay on your machine.' },
  { slug: 'pdf-forms', name: 'Forms', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Fill in a form and save it, or bake the answers in for good.' },

  // --- Secure ---
  { slug: 'protect-pdf', name: 'Protect', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'AES-256 password and permissions, set in your browser.' },
  { slug: 'unlock-pdf', name: 'Unlock', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Remove protection you are authorised to remove.' },
  { slug: 'redact-pdf', name: 'Redact', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Deletes the content underneath, not just a black box over it.' },
  { slug: 'repair-pdf', name: 'Repair', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Rebuild a file that will not open.' },
  { slug: 'sign-pdf', name: 'Sign', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Draw, type or place a signature on the page.' },
  { slug: 'pdf-a', name: 'PDF/A', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Archival conversion. Refused when the fonts are not embedded.' },
];

/** Things we are honest about not doing in the browser, and why. */
/**
 * What genuinely cannot happen in the browser, and why.
 *
 * This is the list the homepage prints, so it has to track reality. Several
 * entries have already moved off it — OCR, Word, Excel, PowerPoint and PDF/A
 * conversion all run locally now — and leaving a stale claim here would be
 * lying in the one section whose whole point is not to.
 *
 * Excel and PowerPoint were on this list, on the grounds that they "need a
 * real layout engine". That was wrong. A spreadsheet is already laid out —
 * column widths, row heights and every formula's cached result are stored in
 * the file — and a slide has no flow layout at all, only absolutely positioned
 * shapes. Both turned out to be easier than the Word converter that was
 * already running locally.
 */
export const SERVER_ONLY_REASONS = [
  {
    what: 'Web page to PDF',
    why: 'A browser is not allowed to fetch another site — the rules that stop other sites reading your data stop us reading theirs. No file of yours is involved, so we fetch the page ourselves.',
  },
  {
    what: 'PDF/A validation',
    why: 'We can convert to PDF/A here, and refuse when a document cannot honestly claim it. Proving conformance is different: the only complete validator is veraPDF, which is Java.',
  },
  {
    what: 'Certified digital signatures',
    why: 'Signing a document so tampering is detectable needs a timestamp authority and a revocation check. Those are network calls by definition. The visual signature tool here is a different thing, and says so.',
  },
  {
    what: 'Table extraction from unruled layouts',
    why: 'Pulling a table out of a page that has no ruling lines takes a layout model far too large to send to a tab.',
  },
] as const;

export const toolsByCategory = (category: ToolCategory): Tool[] =>
  TOOLS.filter((tool) => tool.category === category);
