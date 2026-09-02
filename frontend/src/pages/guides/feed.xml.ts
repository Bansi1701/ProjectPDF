import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

import { SITE } from '../../config/site';
import { canonical } from '../../lib/seo';

interface GuideData {
  title: string;
  description: string;
  updated: string;
}

const escape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Atom feed of the long-form guides — aggregators and a few assistants still read one. */
export const GET: APIRoute = async () => {
  const collection: { id: string; data: unknown }[] = await getCollection('guides');
  const guides = collection
    .map((entry) => ({ id: entry.id, data: entry.data as GuideData }))
    .sort((a, b) => (a.data.updated < b.data.updated ? 1 : -1));
  const newest = guides[0]?.data.updated ?? '2026-09-01';

  const entries = guides
    .map(
      (guide) => `  <entry>
    <title>${escape(guide.data.title)}</title>
    <link href="${canonical(`/guides/${guide.id}/`)}"/>
    <id>${canonical(`/guides/${guide.id}/`)}</id>
    <updated>${guide.data.updated}T00:00:00Z</updated>
    <summary>${escape(guide.data.description)}</summary>
  </entry>`
    )
    .join('\n');

  const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escape(SITE.name)} guides</title>
  <subtitle>${escape('Long-form guides to PDF tasks done in the browser, without uploading.')}</subtitle>
  <link href="${canonical('/guides/feed.xml')}" rel="self"/>
  <link href="${canonical('/guides/')}"/>
  <id>${canonical('/guides/')}</id>
  <updated>${newest}T00:00:00Z</updated>
  <author><name>${escape(SITE.name)}</name></author>
${entries}
</feed>
`;

  return new Response(feed, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
};
