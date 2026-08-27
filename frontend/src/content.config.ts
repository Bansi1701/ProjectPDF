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

export const collections = { tools };
