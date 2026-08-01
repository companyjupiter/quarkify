import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { discoverSourceFiles } from '../skills/analyze/scripts/analyze.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analyzeScript = path.join(repoRoot, 'skills', 'analyze', 'scripts', 'analyze.mjs');

async function withTempWorkspace(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quarkify-plugin-test-'));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('plugin manifests expose the shared analyze skill', () => {
  const codex = JSON.parse(readFileSync(path.join(repoRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const claude = JSON.parse(readFileSync(path.join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  const codexMarketplace = JSON.parse(readFileSync(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  const claudeMarketplace = JSON.parse(readFileSync(path.join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));

  assert.equal(codex.name, 'quarkify');
  assert.equal(claude.name, 'quarkify');
  assert.equal(codex.skills, './skills/');
  assert.equal(claude.skills, './skills/');
  assert.equal(codexMarketplace.plugins[0].source.path, './');
  assert.equal(claudeMarketplace.plugins[0].source, './');
});

test('source discovery ignores dependencies and generated output', async () => {
  await withTempWorkspace(async (root) => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'dependency'), { recursive: true });
    await mkdir(path.join(root, '.quarkify', 'output'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.js'), 'export const app = true;\n');
    await writeFile(path.join(root, 'README.md'), '# ignored\n');
    await writeFile(path.join(root, 'node_modules', 'dependency', 'index.js'), 'ignored();\n');
    await writeFile(path.join(root, '.quarkify', 'output', 'old.ts'), 'ignored();\n');

    const files = await discoverSourceFiles(root);

    assert.deepEqual(files, ['src/app.js']);
  });
});

test('plugin analyzes a repository without a user configuration file', async () => {
  await withTempWorkspace(async (root) => {
    const projectRoot = path.join(root, 'project with spaces');
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src', 'app.js'), 'export function start() { return true; }\n');

    const result = spawnSync(process.execPath, [analyzeScript, projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const resultLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('QUARKIFY_RESULT '));
    assert.ok(resultLine, result.stdout);
    const analysis = JSON.parse(resultLine.slice('QUARKIFY_RESULT '.length));
    assert.equal(analysis.sourceFiles, 1);
    assert.deepEqual(analysis.extensions, { '.js': 1 });
    assert.equal(analysis.outputDir, path.join(await realpath(projectRoot), '.quarkify', 'output'));
    assert.equal(readFileSync(path.join(projectRoot, '.quarkify', '.gitignore'), 'utf8'), '*\n');
    assert.equal(readFileSync(analysis.guide, 'utf8').length > 0, true);
    assert.equal(readFileSync(analysis.viewer, 'utf8').length > 0, true);
  });
});
