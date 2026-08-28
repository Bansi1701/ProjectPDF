import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const frontendDirectory = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = await mkdtemp(join(frontendDirectory, '.operation-smoke-'));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

try {
  await writeFile(join(outputDirectory, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
  execFileSync(
    process.execPath,
    [
      compiler,
      '--outDir', outputDirectory,
      '--rootDir', frontendDirectory,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'es2022',
      '--lib', 'ES2022,DOM,WebWorker',
      '--esModuleInterop',
      '--skipLibCheck',
      '--pretty', 'false',
      '--noCheck',
      'tests/smoke-operations.ts',
    ],
    { cwd: frontendDirectory, stdio: 'inherit' }
  );
  await import(pathToFileURL(join(outputDirectory, 'tests', 'smoke-operations.js')).href);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
