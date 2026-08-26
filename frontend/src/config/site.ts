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
  { slug: 'compress-pdf', name: 'Compress', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Smaller file, checked against the original before you get it.' },
  { slug: 'jpg-to-pdf', name: 'Images to PDF', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'JPG, PNG or WebP into one document. JPG and PNG are not re-encoded.' },
  { slug: 'pdf-to-jpg', name: 'PDF to image', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'Export pages as JPG or PNG at the DPI you pick.' },
  { slug: 'pdf-to-markdown', name: 'PDF to Markdown', category: 'Convert', runsWhere: 'local', status: 'live', blurb: 'For documents that already have a text layer.' },
  { slug: 'word-to-pdf', name: 'Office to PDF', category: 'Convert', runsWhere: 'server', status: 'planned', blurb: 'Word, Excel and PowerPoint. This one needs our server.' },
  { slug: 'url-to-pdf', name: 'Web page to PDF', category: 'Convert', runsWhere: 'server', status: 'planned', blurb: 'A public URL is not your private file, so we fetch it.' },

  // --- Edit ---
  { slug: 'edit-pdf', name: 'Edit', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Text, shapes, highlights and images on the page.' },
  { slug: 'watermark-pdf', name: 'Watermark', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Stamp text or an image across every page.' },
  { slug: 'page-numbers', name: 'Page numbers', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Numbering that matches the page labels people cite.' },
  { slug: 'compare-pdf', name: 'Compare', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'What changed between two drafts, in words not pixels.' },
  { slug: 'ocr-pdf', name: 'OCR', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Make a scan searchable. Small jobs stay on your machine.' },
  { slug: 'pdf-forms', name: 'Forms', category: 'Edit', runsWhere: 'local', status: 'live', blurb: 'Fill a form, or build the fields yourself.' },

  // --- Secure ---
  { slug: 'protect-pdf', name: 'Protect', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'AES-256 password and permissions, set in your browser.' },
  { slug: 'unlock-pdf', name: 'Unlock', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Remove protection you are authorised to remove.' },
  { slug: 'redact-pdf', name: 'Redact', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Deletes the content underneath, not just a black box over it.' },
  { slug: 'repair-pdf', name: 'Repair', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Rebuild a file that will not open.' },
  { slug: 'sign-pdf', name: 'Sign', category: 'Secure', runsWhere: 'local', status: 'live', blurb: 'Draw, type or place a signature on the page.' },
  { slug: 'pdf-a', name: 'PDF/A', category: 'Secure', runsWhere: 'server', status: 'live', blurb: 'Archival conversion and validation.' },
];

/** Things we are honest about not doing in the browser, and why. */
export const SERVER_ONLY_REASONS = [
  { what: 'Word, Excel and PowerPoint conversion', why: 'LibreOffice compiled to WebAssembly is about 52 MB. We are not making your phone download that.' },
  { what: 'Web page to PDF', why: 'A browser cannot fetch a third-party page, or any of its images and fonts. There is also no file of yours involved.' },
  { what: 'Table extraction from unruled layouts', why: 'The layout models that do this well are far too large to ship to a tab.' },
  { what: 'PDF/A validation', why: 'The only complete validator is written in Java. Nobody has built a browser one.' },
  { what: 'OCR over hundreds of pages', why: 'A few pages are fine locally. A 300-page scan will exhaust a phone.' },
  { what: 'Certified digital signatures', why: 'Timestamp authorities and revocation checks are network calls by definition.' },
] as const;

export const toolsByCategory = (category: ToolCategory): Tool[] =>
  TOOLS.filter((tool) => tool.category === category);
