export interface RecipeStep {
  slug: string;
  name: string;
  instruction: string;
}

export interface Recipe {
  slug: string;
  eyebrow: string;
  title: string;
  summary: string;
  outcome: string;
  steps: readonly RecipeStep[];
}

/**
 * Job-shaped workflows, rather than generic lists of tools.
 *
 * The slugs are also the handoff contract: PdfTool reads the recipe and step
 * from the URL, then carries both to the next tool with the PDF. Keep every
 * intermediate step limited to an operation that returns one PDF.
 */
export const RECIPES = [
  {
    slug: 'prepare-scanned-contract-for-filing',
    eyebrow: 'Four-step filing workflow',
    title: 'Prepare a scanned contract for filing',
    summary:
      'Clean the page edges, make the scan searchable, add a filing number, and protect the finished document without choosing the file four times.',
    outcome: 'A searchable, numbered, password-protected filing copy.',
    steps: [
      { slug: 'auto-crop', name: 'Trim margins', instruction: 'Remove scanner borders and uneven empty space.' },
      { slug: 'ocr-pdf', name: 'Recognize text', instruction: 'Add a searchable text layer to the scan.' },
      { slug: 'header-footer', name: 'Add a Bates number', instruction: 'Apply a stable filing reference to every page.' },
      { slug: 'protect-pdf', name: 'Protect', instruction: 'Set the password and permissions for the filing copy.' },
    ],
  },
  {
    slug: 'shrink-pdf-under-upload-limit',
    eyebrow: 'Two-step upload workflow',
    title: "Shrink a PDF under a portal's upload limit",
    summary:
      'Make editable layers permanent first, then repack the document. The result is easier for strict portals to accept and carries less unused PDF structure.',
    outcome: 'A flattened, compact PDF ready for a size-limited upload form.',
    steps: [
      { slug: 'flatten-pdf', name: 'Flatten', instruction: 'Bake forms and comments into the pages.' },
      { slug: 'compress-pdf', name: 'Compress', instruction: 'Remove unused structure and repack the PDF.' },
    ],
  },
  {
    slug: 'redact-bank-statement-before-sending',
    eyebrow: 'Three-step sharing workflow',
    title: 'Redact a bank statement before sending it',
    summary:
      'Permanently remove account details, clear identifying document properties, and lock the copy you intend to share.',
    outcome: 'A redacted, metadata-cleaned, password-protected statement.',
    steps: [
      { slug: 'redact-pdf', name: 'Redact', instruction: 'Remove sensitive text and graphics beneath each marked area.' },
      { slug: 'metadata-pdf', name: 'Clear metadata', instruction: 'Remove author, software, and hidden document properties.' },
      { slug: 'protect-pdf', name: 'Protect', instruction: 'Add a password before sharing the finished copy.' },
    ],
  },
  {
    slug: 'make-print-ready-booklet',
    eyebrow: 'Two-step print workflow',
    title: 'Make a print-ready booklet',
    summary:
      'Tighten inconsistent scan margins, then impose the pages in booklet order so they fold into the right reading sequence.',
    outcome: 'A booklet-imposed PDF ready for duplex printing and folding.',
    steps: [
      { slug: 'auto-crop', name: 'Trim margins', instruction: 'Normalize excess white space before imposition.' },
      { slug: 'impose-pdf', name: 'Build booklet', instruction: 'Arrange pages into printer spreads in folding order.' },
    ],
  },
] as const satisfies readonly Recipe[];

export function recipeBySlug(slug: string): Recipe | undefined {
  return RECIPES.find((recipe) => recipe.slug === slug);
}
