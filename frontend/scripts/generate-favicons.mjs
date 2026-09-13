import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

// Package the approved logo, not a new drawing. A white tile preserves contrast
// in light/dark search results. Crop only the original transparent outer margin.
const publicDir = new URL('../public/', import.meta.url);
const logo = await readFile(new URL('brand/pdfcraft-fold-mark.png', publicDir));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="1040" viewBox="110 70 1040 1040"><rect x="110" y="70" width="1040" height="1040" fill="white"/><image x="0" y="0" width="1280" height="1280" href="data:image/png;base64,${logo.toString('base64')}"/></svg>`;
const png = size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
await writeFile(new URL('favicon.png', publicDir), png(96));
await writeFile(new URL('apple-touch-icon.png', publicDir), png(180));

// ICO directory with lossless PNG entries. No additional image dependency.
const sizes = [16, 32, 48, 96];
const images = sizes.map(png);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((bytes, index) => {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = sizes[index];
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += bytes.length;
});
await writeFile(new URL('favicon.ico', publicDir), Buffer.concat([header, ...images]));
console.log('Generated branded 96px search icon, Apple icon and multi-size ICO.');
