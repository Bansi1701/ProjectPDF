import { readFile } from 'node:fs/promises';

const toolSource = await readFile(new URL('../src/config/site.ts', import.meta.url), 'utf8');
const iconSource = await readFile(new URL('../src/components/ToolIcon.astro', import.meta.url), 'utf8');
const navigationSource = await readFile(new URL('../src/config/navigation.ts', import.meta.url), 'utf8');

const liveSlugs = toolSource
  .split(/\r?\n/)
  .filter((line) => line.includes("status: 'live'"))
  .map((line) => line.match(/slug:\s*'([^']+)'/)?.[1])
  .filter(Boolean);

const markBlock = iconSource.match(/const marks:[\s\S]*?=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
const iconEntries = [...markBlock.matchAll(/^\s*'([^']+)'\s*:\s*'([^']+)'/gm)]
  .map((match) => ({ slug: match[1], drawing: match[2].replace(/\s+/g, ' ').trim() }));
const iconSlugs = iconEntries.map((entry) => entry.slug);

const navigationBlock = navigationSource.match(/const groupDefinitions[\s\S]*?=\s*\[([\s\S]*?)\n\];/)?.[1] ?? '';
const navigationSlugs = [...navigationBlock.matchAll(/'([a-z0-9-]+)'/g)]
  .map((match) => match[1])
  .filter((slug) => liveSlugs.includes(slug));

const difference = (left, right) => left.filter((item) => !right.includes(item));
const duplicateValues = (values) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];

const problems = [];
const missingIcons = difference(liveSlugs, iconSlugs);
const unknownIcons = difference(iconSlugs, liveSlugs);
const missingFromNavigation = difference(liveSlugs, navigationSlugs);
const repeatedNavigation = duplicateValues(navigationSlugs);
const duplicateDrawings = duplicateValues(iconEntries.map((entry) => entry.drawing))
  .map((drawing) => iconEntries.filter((entry) => entry.drawing === drawing).map((entry) => entry.slug));

if (missingIcons.length) problems.push(`Live tools without an icon: ${missingIcons.join(', ')}`);
if (unknownIcons.length) problems.push(`Icons without a live tool: ${unknownIcons.join(', ')}`);
if (missingFromNavigation.length) problems.push(`Live tools missing from navigation: ${missingFromNavigation.join(', ')}`);
if (repeatedNavigation.length) problems.push(`Tools repeated in navigation: ${repeatedNavigation.join(', ')}`);
if (duplicateDrawings.length) problems.push(`Icons reuse the same drawing: ${duplicateDrawings.map((group) => group.join(' / ')).join(', ')}`);

if (!iconSource.includes('aria-hidden="true"') || !iconSource.includes('focusable="false"')) {
  problems.push('Tool icons must remain decorative so their adjacent text label is the accessible name.');
}

if (problems.length) {
  console.error(`Icon audit failed:\n- ${problems.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Icon audit passed: ${liveSlugs.length} live tools, ${iconSlugs.length} unique drawings, one navigation entry each.`);
}
