import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lockPath = fileURLToPath(new URL('../package-lock.json', import.meta.url));
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const queries = [];

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/') || !entry?.version) continue;
  const name = path.replace(/^.*node_modules\//, '');
  queries.push({ package: { ecosystem: 'npm', name }, version: entry.version });
}

const findings = [];
for (let offset = 0; offset < queries.length; offset += 1000) {
  const response = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries: queries.slice(offset, offset + 1000) }),
  });
  if (!response.ok) throw new Error(`OSV audit failed with HTTP ${response.status}.`);
  const body = await response.json();
  body.results.forEach((result, index) => {
    for (const vulnerability of result.vulns ?? []) {
      findings.push({
        dependency: queries[offset + index].package.name,
        version: queries[offset + index].version,
        id: vulnerability.id,
        summary: vulnerability.summary ?? 'No summary supplied',
      });
    }
  });
}

if (findings.length) {
  for (const finding of findings) {
    console.error(`${finding.id}: ${finding.dependency}@${finding.version} — ${finding.summary}`);
  }
  throw new Error(`${findings.length} known dependency vulnerabilit${findings.length === 1 ? 'y' : 'ies'} found by OSV.`);
}

console.log(`Dependency audit: ${queries.length} installed npm packages checked against OSV; no known vulnerabilities found.`);
