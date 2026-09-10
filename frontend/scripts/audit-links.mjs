import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const outputRoot = "dist";
const deployment = new URL(`${(process.env.SITE_ORIGIN || 'https://bansi1701.github.io/ProjectPDF').replace(/\/+$/, '')}/`);
const basePath = deployment.pathname;
const htmlFiles = [];

function collectHtml(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) collectHtml(filePath);
    else if (entry.name.endsWith(".html")) htmlFiles.push(filePath);
  }
}

if (!existsSync(outputRoot)) {
  console.error("Link audit requires a completed production build in dist/.");
  process.exit(1);
}

collectHtml(outputRoot);

const brokenLinks = [];
const hrefPattern = /href=["']([^"']+)["']/g;

for (const htmlFile of htmlFiles) {
  const html = readFileSync(htmlFile, "utf8");
  const pageUrl = new URL(relative(outputRoot, htmlFile).replaceAll('\\', '/').replace(/index\.html$/, ''), deployment);
  for (const match of html.matchAll(hrefPattern)) {
    const href = match[1];
    if (href.startsWith('#')) continue;
    const target = new URL(href.replaceAll('&amp;', '&'), pageUrl);
    if (target.origin !== deployment.origin) continue;
    if (!target.pathname.startsWith(basePath)) {
      brokenLinks.push(`${htmlFile} -> ${href} (outside the deployment base)`);
      continue;
    }

    const relativeTarget = decodeURIComponent(target.pathname.slice(basePath.length));
    if (!relativeTarget) continue;

    const cleanTarget = relativeTarget.replace(/\/$/, "");
    const candidate = cleanTarget.includes(".")
      ? join(outputRoot, cleanTarget)
      : join(outputRoot, cleanTarget, "index.html");

    if (!existsSync(candidate)) brokenLinks.push(`${htmlFile} -> ${href}`);
  }
}

if (brokenLinks.length > 0) {
  console.error(`Link audit failed: ${brokenLinks.length} broken internal link(s).`);
  console.error(brokenLinks.join("\n"));
  process.exit(1);
}

console.log(`Link audit passed: ${htmlFiles.length} HTML pages with no broken internal routes.`);
