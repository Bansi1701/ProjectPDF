/**
 * Copies engine wasm into public/ so it is served from our own origin.
 *
 * Self-hosting is not incidental: a privacy-first tool that fetches its engine
 * from a third-party CDN leaks which tool you opened, and adds a supply-chain
 * dependency to a binary we execute. Copying at build time also keeps the
 * version pinned to the one in package-lock.json.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// harfbuzzjs restricts its `exports` map, so resolve through node_modules
// directly rather than require.resolve.
const assets = [
  ['node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm', 'public/wasm/harfbuzz-subset.wasm'],
];

for (const [from, to] of assets) {
  const source = resolve(process.cwd(), from);
  if (!existsSync(source)) {
    console.error(`missing ${from} — run npm install`);
    process.exit(1);
  }
  const target = resolve(process.cwd(), to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`copied ${to}`);
}
