import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../dist/_astro/', import.meta.url));
const files = readdirSync(assets)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, bytes: statSync(fileURLToPath(new URL(`../dist/_astro/${name}`, import.meta.url))).size }));

if (files.length === 0) throw new Error('Bundle audit found no JavaScript output.');

const ownEntries = files.filter(
  ({ name }) => /^worker-[^.]+\.js$/.test(name) || name.includes('.astro_astro_type_script_')
);
const oversizedOwn = ownEntries.filter(({ bytes }) => bytes > 100 * 1024);
const oversizedAny = files.filter(({ bytes }) => bytes > 1300 * 1024);

if (oversizedOwn.length || oversizedAny.length) {
  const format = (items) => items.map(({ name, bytes }) => `${name} (${Math.round(bytes / 1024)} KiB)`).join(', ');
  throw new Error([
    oversizedOwn.length ? `First-party entry bundles above 100 KiB: ${format(oversizedOwn)}` : '',
    oversizedAny.length ? `Bundles above the 1.3 MiB ceiling: ${format(oversizedAny)}` : '',
  ].filter(Boolean).join('\n'));
}

const worker = ownEntries.find(({ name }) => /^worker-[^.]+\.js$/.test(name));
console.log(
  `Bundle audit: ${files.length} JavaScript chunks; worker entry ${worker ? `${Math.round(worker.bytes / 1024)} KiB` : 'not emitted'}; first-party entries stay below 100 KiB.`
);
