/**
 * Intent landing pages, keyed by the tool they belong to.
 *
 * Each one targets a distinct search intent the tool page itself does not
 * ("merge pdf" versus "merge pdf without uploading"). They were orphaned:
 * present in the sitemap but with no internal link pointing at them, so they
 * received no link equity and were crawled least of any page on the site —
 * the opposite of what a long-tail page needs. The tool page now links to its
 * own, which is also the link a reader would want.
 */
export interface IntentPage {
  slug: string;
  label: string;
}

export const INTENT_PAGES: Record<string, IntentPage> = {
  'merge-pdf': { slug: 'merge-pdf-without-uploading', label: 'Merge PDF files without uploading them' },
  'split-pdf': { slug: 'split-pdf-without-uploading', label: 'Split a PDF without uploading it' },
  'compress-pdf': { slug: 'compress-pdf-offline', label: 'Compress a PDF offline in your browser' },
  'pdf-to-word': { slug: 'pdf-to-word-offline', label: 'Convert PDF to Word without uploading the file' },
  'ocr-pdf': { slug: 'ocr-pdf-without-uploading', label: 'OCR a scanned PDF without uploading it' },
  'protect-pdf': { slug: 'protect-pdf-without-uploading', label: 'Password-protect a PDF without uploading it' },
  'sign-pdf': { slug: 'sign-pdf-without-uploading', label: 'Sign a PDF without uploading it' },
  'redact-pdf': { slug: 'redact-pdf-securely-offline', label: 'Redact a PDF securely without sending it anywhere' },
};

export const intentPageFor = (toolSlug: string): IntentPage | undefined => INTENT_PAGES[toolSlug];
