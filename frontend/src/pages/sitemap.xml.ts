/**
 * The sitemap, built from the same TOOLS array the grid and footer use.
 *
 * Hand-rolled rather than @astrojs/sitemap because the list already exists in
 * config/site.ts and a plugin would only rediscover it — and because a tool
 * that is still `building` should not be submitted to an index as though it
 * works.
 */
import type { APIRoute } from 'astro';
import { TOOLS } from '../config/site';

export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const url = (path: string) => new URL(`${base}/${path}`.replace(/\/{2,}/g, '/'), site).href;

  const pages = [
    { loc: url(''), priority: '1.0', changefreq: 'weekly' },
    ...TOOLS.filter((tool) => tool.status === 'live').map((tool) => ({
      loc: url(`${tool.slug}/`),
      priority: '0.8',
      changefreq: 'monthly',
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (page) =>
      `  <url>\n    <loc>${page.loc}</loc>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>`
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
