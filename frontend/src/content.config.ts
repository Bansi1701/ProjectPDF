import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const instruction = z.object({
  name: z.string().min(3),
  text: z.string().min(20),
});

const faq = z.object({
  question: z.string().min(8),
  answer: z.string().min(30),
});

const tools = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/tools' }),
  schema: z.object({
    intro: z.string().min(180),
    howTo: z.array(instruction).min(3).max(5),
    faqs: z.array(faq).min(4).max(6),
    related: z.array(z.string()).length(5),
  }),
});

/**
 * Long-form guides: one real task each, written to be quoted. The title and
 * description limits mirror scripts/audit-seo.mjs so a guide cannot pass the
 * content check and then fail the build.
 */
const guides = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/guides' }),
  schema: z.object({
    title: z.string().min(20).max(80),
    description: z.string().min(80).max(170),
    /** One sentence an assistant can lift verbatim as the answer. */
    summary: z.string().min(60).max(320),
    /** Slugs of the tools the guide is about; the first is the primary. */
    tools: z.array(z.string()).min(1).max(4),
    keywords: z.array(z.string()).min(3).max(10),
    updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    faqs: z.array(faq).min(2).max(5),
  }),
});

export const collections = { tools, guides };
