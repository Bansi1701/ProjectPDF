// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages serves a project site from /<repo>/, so every absolute asset
// path needs that prefix. Use import.meta.env.BASE_URL in components rather
// than hardcoding "/" — it stays correct when this moves to a real domain.
export default defineConfig({
  output: 'static',
  site: 'https://bansi1701.github.io',
  base: '/ProjectPDF',
  trailingSlash: 'ignore',
});
