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
  tools: Tool[];
}

interface NavigationGroupDefinition {
  label: string;
  tone: NavigationTone;
  slugs: string[];
}

const liveToolsBySlug = new Map(
  TOOLS.filter((tool) => tool.status === 'live').map((tool) => [tool.slug, tool]),
);

const groupDefinitions: NavigationGroupDefinition[] = [
  {
    label: 'Organize PDF',
    tone: 'organize',
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
    slugs: ['compress-pdf', 'repair-pdf', 'grayscale-pdf', 'auto-crop', 'crop-pdf', 'flatten-pdf'],
  },
  {
    label: 'Convert to PDF',
    tone: 'to-pdf',
    slugs: ['jpg-to-pdf', 'word-to-pdf', 'excel-to-pdf', 'powerpoint-to-pdf', 'text-to-pdf'],
  },
  {
    label: 'Convert from PDF',
    tone: 'from-pdf',
    slugs: ['pdf-to-jpg', 'pdf-to-word', 'pdf-to-excel', 'pdf-to-markdown', 'extract-images'],
  },
  {
    label: 'Edit & compose',
    tone: 'compose',
    slugs: ['edit-pdf', 'watermark-pdf', 'page-numbers', 'impose-pdf', 'overlay-pdf', 'header-footer'],
  },
  {
    label: 'Review & data',
    tone: 'review',
    slugs: ['compare-pdf', 'ocr-pdf', 'pdf-forms', 'metadata-pdf'],
  },
  {
    label: 'Secure & archive',
    tone: 'secure',
    slugs: ['protect-pdf', 'unlock-pdf', 'redact-pdf', 'sign-pdf', 'pdf-a'],
  },
];

const resolveTools = (definition: NavigationGroupDefinition): NavigationGroup => ({
  label: definition.label,
  tone: definition.tone,
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

export const CONVERSION_GROUPS = NAVIGATION_GROUPS.filter(
  (group) => group.tone === 'to-pdf' || group.tone === 'from-pdf',
);

export const POPULAR_TOOL_SLUGS = ['merge-pdf', 'split-pdf', 'compress-pdf', 'edit-pdf', 'sign-pdf'] as const;

export const POPULAR_TOOLS = POPULAR_TOOL_SLUGS
  .map((slug) => liveToolsBySlug.get(slug))
  .filter((tool): tool is Tool => Boolean(tool));

export const QUICK_TOOLS = POPULAR_TOOLS.slice(0, 3);

export const LIVE_NAVIGATION_TOOL_COUNT = new Set(
  NAVIGATION_GROUPS.flatMap((group) => group.tools.map((tool) => tool.slug)),
).size;
