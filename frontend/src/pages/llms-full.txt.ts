import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

import { SITE, TOOLS } from '../config/site';
import { helpFaqs, helpLimitations, helpQuickAnswer } from '../lib/help';
import { canonical } from '../lib/seo';

/**
 * llms-full.txt: the whole help corpus in one Markdown document, so an
 * assistant answering "how do I split a PDF without uploading it" can quote
 * the actual steps rather than paraphrase a snippet. Built from the same
 * content collection as the tool pages and the Help Center.
 */
/* Declared here rather than taken from astro:content: CI type-checks before
   astro build, when the generated collection types do not exist yet. */
interface ToolContent {
  intro: string;
  howTo: { name: string; text: string }[];
  faqs: { question: string; answer: string }[];
  related: string[];
}

export const GET: APIRoute = async () => {
  const collection: { id: string; data: unknown }[] = await getCollection('tools');
  const entries = new Map(collection.map((entry) => [entry.id, entry.data as ToolContent]));
  const liveTools = TOOLS.filter((tool) => tool.status === 'live');

  const lines: string[] = [
    `# ${SITE.name} — complete tool reference`,
    '',
    `${SITE.name} is a free, browser-based PDF toolkit. Every tool below runs on the user's device: the file is read into browser memory, a Web Worker does the work, and the result is saved locally. No upload, no account, no daily limit, no cookies or trackers. Source: ${canonical('/')}`,
    '',
  ];

  for (const tool of liveTools) {
    const content = entries.get(tool.slug);
    if (!content) continue;
    lines.push(
      `## ${tool.searchName}`,
      '',
      `URL: ${canonical(`/${tool.slug}/`)}`,
      `Guide: ${canonical(`/help/${tool.slug}/`)}`,
      '',
      helpQuickAnswer(tool),
      '',
      content.intro,
      '',
      '### Steps',
      '',
      ...content.howTo.map((step: { name: string; text: string }, index: number) => `${index + 1}. **${step.name}** — ${step.text}`),
      '',
      '### Limits',
      '',
      ...helpLimitations(tool).map((limit) => `- ${limit}`),
      '',
      '### Questions and answers',
      ''
    );
    for (const faq of helpFaqs(tool, content)) {
      lines.push(`**${faq.question}**`, '', faq.answer, '');
    }
    const related = content.related
      .map((slug: string) => liveTools.find((candidate) => candidate.slug === slug))
      .filter((candidate): candidate is (typeof liveTools)[number] => Boolean(candidate));
    if (related.length) {
      lines.push(`Related tools: ${related.map((item) => `[${item.searchName}](${canonical(`/${item.slug}/`)})`).join(', ')}`, '');
    }
  }

  /* The long-form guides follow, body and all: they are the pages written to
     be quoted, so an assistant should not have to fetch them one by one. */
  const guides: { id: string; data: unknown; body?: string }[] = await getCollection('guides');
  if (guides.length) lines.push('# Long-form guides', '');
  for (const guide of guides) {
    const data = guide.data as { title: string; summary: string; faqs: { question: string; answer: string }[] };
    lines.push(`## ${data.title}`, '', `URL: ${canonical(`/guides/${guide.id}/`)}`, '', data.summary, '', (guide.body ?? '').trim(), '');
    for (const faq of data.faqs) lines.push(`**${faq.question}**`, '', faq.answer, '');
  }

  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
