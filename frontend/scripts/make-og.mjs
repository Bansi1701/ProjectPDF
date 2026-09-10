/**
 * Refresh the legacy sharing-image URL from the built home card.
 * Run after npm run build. The Astro OG route is the single design source,
 * so old shared links retain the same brand without another renderer or font CDN.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../dist/og/home.png', import.meta.url));
const output = fileURLToPath(new URL('../public/brand/og.png', import.meta.url));
if (!existsSync(source)) throw new Error('Build the site before refreshing the legacy sharing image.');
copyFileSync(source, output);
copyFileSync(source, fileURLToPath(new URL('../dist/brand/og.png', import.meta.url)));
console.log('Legacy sharing image refreshed from the current home card.');
