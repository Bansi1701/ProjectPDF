import { TOOLS, type Tool } from './site';

export type NavigationTone =
  | 'organize'
  | 'optimize'
  | 'to-pdf'
  | 'from-pdf'
  | 'compose'
  | 'review'
  | 'secure';

export interface NavigationGroup {
  label: string;
  tone: NavigationTone;
  anchor: string;
  description: string;
  tools: Tool[];
}

interface NavigationGroupDefinition {
  label: string;
  tone: NavigationTone;
  anchor: string;
  description: string;
  slugs: string[];
}

const liveToolsBySlug = new Map(
  TOOLS.filter((tool) => tool.status === 'live').map((tool) => [tool.slug, tool]),
);

const groupDefinitions: NavigationGroupDefinition[] = [
  {
    label: 'Organize PDF',
    tone: 'organize',
    anchor: 'organize',
    description: 'Build the document in the page order you need.',
    slugs: [
      'merge-pdf',
      'split-pdf',
      'rotate-pdf',
      'organise-pdf',
      'extract-pages',
      'delete-pages',
      'split-by',
      'scan-pdf',
    ],
  },
  {
    label: 'Optimize PDF',
    tone: 'optimize',
    anchor: 'optimize',
    description: 'Reduce, repair, crop, and prepare the file.',
    slugs: ['compress-pdf', 'repair-pdf', 'grayscale-pdf', 'auto-crop', 'crop-pdf', 'flatten-pdf'],
  },
  {
    label: 'Convert to PDF',
    tone: 'to-pdf',
    anchor: 'convert',
    description: 'Turn everyday files into dependable PDFs.',
    slugs: ['jpg-to-pdf', 'word-to-pdf', 'excel-to-pdf', 'powerpoint-to-pdf', 'text-to-pdf'],
  },
  {
    label: 'Convert from PDF',
    tone: 'from-pdf',
    anchor: 'convert-from-pdf',
    description: 'Take text, tables, and images back out.',
    slugs: ['pdf-to-jpg', 'pdf-to-word', 'pdf-to-excel', 'pdf-to-markdown', 'extract-images'],
  },
  {
    label: 'Edit & compose',
    tone: 'compose',
    anchor: 'edit',
    description: 'Add, arrange, and make content permanent.',
    slugs: ['edit-pdf', 'watermark-pdf', 'page-numbers', 'impose-pdf', 'overlay-pdf', 'header-footer'],
  },
  {
    label: 'Review & data',
    tone: 'review',
    anchor: 'review',
    description: 'Read, compare, recognize, and inspect documents.',
    slugs: ['compare-pdf', 'ocr-pdf', 'pdf-forms', 'metadata-pdf'],
  },
  {
    label: 'Secure & archive',
    tone: 'secure',
    anchor: 'secure',
    description: 'Control access, remove secrets, sign, and archive.',
    slugs: ['protect-pdf', 'unlock-pdf', 'redact-pdf', 'sign-pdf', 'pdf-a'],
  },
];

const resolveTools = (definition: NavigationGroupDefinition): NavigationGroup => ({
  label: definition.label,
  tone: definition.tone,
  anchor: definition.anchor,
  description: definition.description,
  tools: definition.slugs
    .map((slug) => liveToolsBySlug.get(slug))
    .filter((tool): tool is Tool => Boolean(tool)),
});

/**
 * Header navigation uses a task-oriented taxonomy while still resolving every
 * item from the canonical TOOLS collection. Building or removing a tool in
 * site.ts therefore cannot accidentally expose an unfinished route here.
 */
export const NAVIGATION_GROUPS: NavigationGroup[] = groupDefinitions.map(resolveTools);

export const POPULAR_TOOL_SLUGS = ['merge-pdf', 'split-pdf', 'compress-pdf', 'edit-pdf', 'sign-pdf'] as const;

export const POPULAR_TOOLS = POPULAR_TOOL_SLUGS
  .map((slug) => liveToolsBySlug.get(slug))
  .filter((tool): tool is Tool => Boolean(tool));

export const QUICK_TOOLS = POPULAR_TOOLS.slice(0, 3);

export const LIVE_NAVIGATION_TOOL_COUNT = new Set(
  NAVIGATION_GROUPS.flatMap((group) => group.tools.map((tool) => tool.slug)),
).size;
