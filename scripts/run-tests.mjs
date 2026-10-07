import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTests(path);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const testFiles = collectTests(resolve('tests')).sort((a, b) => a.localeCompare(b));
if (testFiles.length === 0) {
  process.stderr.write('No TypeScript test files found under tests.\n');
  process.exit(2);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles.map((path) => path.split(sep).join('/'))], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
