import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

import { NAVIGATION_GROUPS } from '../config/navigation';
import { RECIPES } from '../config/recipes';
import { SITE, TOOLS } from '../config/site';
import { canonical } from '../lib/seo';

/**
 * The llms.txt convention: a Markdown index a language model or agent can read
 * in one request. The large crawlers still read HTML; coding agents, browsing
 * agents and a growing set of assistants read this first. Facts here must match
 * the pages — they are generated from the same config, so they cannot drift.
 */
const liveTools = TOOLS.filter((tool) => tool.status === 'live');

interface GuideData {
  title: string;
  description: string;
  updated: string;
}

export const GET: APIRoute = async () => {
  const guides: { id: string; data: unknown }[] = await getCollection('guides');
  const longForm = guides
    .map((entry) => ({ id: entry.id, data: entry.data as GuideData }))
    .sort((a, b) => (a.data.updated < b.data.updated ? 1 : -1));

  const lines: string[] = [
    `# ${SITE.name}`,
    '',
    `> ${SITE.name} is a free PDF toolkit that runs entirely in the web browser. Documents are processed on the user's own device; nothing is uploaded, no account is needed, and there are no daily limits. ${liveTools.length} tools are live.`,
    '',
    '## Key facts',
    '',
    `- Website: ${canonical('/')}`,
    '- Price: free, no account, no file-size or daily quota',
    '- Where files are processed: in the browser tab, on the device (a Web Worker runs each operation)',
    '- What leaves the device: nothing from the document — the completion receipt reports 0 document bytes sent',
    '- Cookies and trackers: none; no analytics or advertising scripts',
    '- Only server-side feature: Web page to PDF (a public URL is rendered remotely; it is not yet live)',
    `- Source repository: https://github.com/Bansi1701/ProjectPDF`,
    '',
  ];

  for (const group of NAVIGATION_GROUPS) {
    lines.push(`## ${group.label}`, '', group.description, '');
    for (const tool of group.tools) {
      lines.push(`- [${tool.searchName}](${canonical(`/${tool.slug}/`)}): ${tool.blurb}`);
    }
    lines.push('');
  }

  lines.push('## Long-form guides', '');
  for (const guide of longForm) {
    lines.push(`- [${guide.data.title}](${canonical(`/guides/${guide.id}/`)}): ${guide.data.description}`);
  }
  lines.push('');

  lines.push('## Tool guides', '');
  for (const tool of liveTools) {
    lines.push(`- [How to use ${tool.searchName}](${canonical(`/help/${tool.slug}/`)}): steps, limits and FAQs`);
  }
  lines.push('');

  lines.push('## Multi-step workflows', '');
  for (const recipe of RECIPES) {
    lines.push(`- [${recipe.title}](${canonical(`/how-to/${recipe.slug}/`)}): ${recipe.outcome}`);
  }
  lines.push('');

  lines.push(
    '## Comparisons',
    '',
    `- [Compared with upload-based PDF sites](${canonical('/alternatives/')}): where files go on iLovePDF, Smallpdf and Adobe online versus in the browser`,
    `- [iLovePDF alternative](${canonical('/ilovepdf-alternative/')}): tool-by-tool mapping and when iLovePDF is the better choice`,
    `- [Smallpdf alternative](${canonical('/smallpdf-alternative/')}): tool-by-tool mapping and when Smallpdf is the better choice`,
    `- [Adobe Acrobat online alternative](${canonical('/adobe-acrobat-online-alternative/')}): tool-by-tool mapping and when Acrobat is the better choice`,
    '',
    '## About',
    '',
    `- [About ${SITE.name}](${canonical('/about/')}): what the project is and is not`,
    `- [Privacy policy](${canonical('/privacy/')}): what stays on the device and what the host can see`,
    `- [Full text for language models](${canonical('/llms-full.txt')}): every tool's description, steps and FAQs plus the long-form guides in one file`,
    `- [Guides feed](${canonical('/guides/feed.xml')}): Atom feed of new long-form guides`,
    ''
  );

  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
