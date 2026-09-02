import type { APIRoute } from 'astro';

import { SITE_ORIGIN } from '../lib/seo';

/**
 * Every page is public, static and free of tracking, so there is nothing to
 * shield from crawlers — and being found and quoted accurately is the point.
 * Search, retrieval and user-triggered AI agents are named explicitly so the
 * intent survives any future default that treats unnamed agents as excluded.
 */
const AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Googlebot',
  'Bingbot',
  'Applebot',
  'Applebot-Extended',
  'Amazonbot',
  'Meta-ExternalAgent',
  'Meta-ExternalFetcher',
  'DuckAssistBot',
  'YouBot',
  'CCBot',
  'cohere-ai',
  'MistralAI-User',
  'Bytespider',
];

export const GET: APIRoute = () =>
  new Response(
    [
      '# HatePDF welcomes search engines and AI assistants alike.',
      '# Every page here is public, static and tracker-free.',
      '',
      'User-agent: *',
      'Allow: /',
      '',
      ...AI_AGENTS.flatMap((agent) => [`User-agent: ${agent}`, 'Allow: /', '']),
      `Sitemap: ${SITE_ORIGIN}/sitemap-index.xml`,
      '',
      '# Machine-readable overview for language models:',
      `# ${SITE_ORIGIN}/llms.txt`,
      `# ${SITE_ORIGIN}/llms-full.txt`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
