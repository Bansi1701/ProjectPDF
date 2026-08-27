import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface NetworkRequestAudit {
  source: string;
  line: number;
  kind: 'fetch' | 'XMLHttpRequest';
  destination: string;
  trigger: string;
  data: string;
  availability: string;
}

interface Rule extends Omit<NetworkRequestAudit, 'line' | 'kind'> {
  needle: string;
}

const RULES: readonly Rule[] = [
  {
    source: 'components/PdfTool.astro',
    needle: '/api/v1/convert/url-to-pdf',
    destination: 'Same-origin /api/v1/convert/url-to-pdf endpoint',
    trigger: 'Only after a person enters a public URL and runs Web page to PDF.',
    data: 'The public web address entered by the person; no local document bytes.',
    availability: 'Dormant: the Web page to PDF interface is visibly marked as not finished.',
  },
  {
    source: 'lib/pdf/hb.ts',
    needle: '/wasm/harfbuzz-subset.wasm',
    destination: 'Same-origin /wasm/harfbuzz-subset.wasm application asset',
    trigger: 'Only when a chosen operation needs to subset an embedded font.',
    data: 'No personal data. This downloads program code; the PDF remains in browser memory.',
    availability: 'Live, on demand after a file action; never fetched on initial page load.',
  },
] as const;

/* Astro bundles server-side modules before rendering static pages, so
   import.meta.url points at dist during generation. The build always runs at
   the frontend package root; anchoring to cwd keeps the audit on source. */
const SOURCE_ROOT = join(process.cwd(), 'src');
const SCANNED_EXTENSIONS = new Set(['.astro', '.js', '.mjs', '.ts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!SCANNED_EXTENSIONS.has(extname(entry.name))) return [];
    if (entry.name === 'networkAudit.ts') return [];
    return [path];
  });
}

function callSites() {
  return sourceFiles(SOURCE_ROOT).flatMap((path) => {
    const source = relative(SOURCE_ROOT, path).replaceAll('\\', '/');
    return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((text, index) => {
      const found: { source: string; line: number; text: string; kind: NetworkRequestAudit['kind'] }[] = [];
      if (/\bfetch\s*\(/.test(text)) found.push({ source, line: index + 1, text, kind: 'fetch' });
      if (/\b(?:new\s+XMLHttpRequest|XMLHttpRequest\s*\()/.test(text)) {
        found.push({ source, line: index + 1, text, kind: 'XMLHttpRequest' });
      }
      return found;
    });
  });
}

/**
 * Build-time enforcement for the privacy promise.
 *
 * A new fetch/XHR call cannot quietly land: it breaks the privacy page build
 * until its destination, trigger, and transmitted data are documented here.
 */
export function auditedNetworkRequests(): NetworkRequestAudit[] {
  const calls = callSites();
  const audits = calls.map((call) => {
    const rule = RULES.find((candidate) => candidate.source === call.source && call.text.includes(candidate.needle));
    if (!rule) {
      throw new Error(`Undocumented network request at ${call.source}:${call.line}`);
    }
    return {
      source: call.source,
      line: call.line,
      kind: call.kind,
      destination: rule.destination,
      trigger: rule.trigger,
      data: rule.data,
      availability: rule.availability,
    };
  });

  const missingRules = RULES.filter(
    (rule) => !calls.some((call) => call.source === rule.source && call.text.includes(rule.needle))
  );
  if (missingRules.length > 0) {
    throw new Error(`Stale network audit rules: ${missingRules.map((rule) => `${rule.source}:${rule.needle}`).join(', ')}`);
  }

  return audits;
}
