import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(filePath, config) {
  await writeFile(filePath, `export default ${config};\n`, 'utf8');
}

function runQuarkify(configPath) {
  return spawnSync(process.execPath, [cliPath, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('package metadata points at the real CLI entrypoint', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(pkg.main, 'quarkify.mjs');
  assert.equal(pkg.bin?.quarkify, './quarkify.mjs');
  assert.ok(existsSync(path.join(repoRoot, pkg.main)));
});

test('CLI materializes quark output, mirrors, axons, and guide artifacts', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const configPath = path.join(tmp, 'config.mjs');

    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'sample.js'), 'export function sampleThing() { return 1; }\n', 'utf8');
    await writeConfig(configPath, `{
      name: 'cli-smoke-test',
      srcDir: ${JSON.stringify(srcDir)},
      outDir: ${JSON.stringify(outDir)},
      sourceFiles: ['sample.js'],
      perfData: {},
      guessRole() { return 'general'; },
    }`);

    const result = runQuarkify(configPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(await readdir(path.join(outDir, 'quark')), ['file__sample.js']);
    assert.ok(existsSync(path.join(outDir, '_mirror', 'by_kind', 'fn')));
    assert.ok(existsSync(path.join(outDir, '_axon')));
    assert.ok(existsSync(path.join(outDir, 'index.html')));
    assert.ok(existsSync(path.join(outDir, 'ai_context_guide.txt')));
  });
});

test('leading double-star globs match root and nested files', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const configPath = path.join(tmp, 'config.mjs');

    await mkdir(path.join(srcDir, 'nested'), { recursive: true });
    await writeFile(path.join(srcDir, 'Root.java'), 'public class Root {}\n', 'utf8');
    await writeFile(path.join(srcDir, 'nested', 'Child.java'), 'public class Child {}\n', 'utf8');
    await writeConfig(configPath, `{
      name: 'glob-regression',
      srcDir: ${JSON.stringify(srcDir)},
      outDir: ${JSON.stringify(outDir)},
      sourceFiles: ['**/*.java'],
      perfData: {},
      guessRole() { return 'general'; },
    }`);

    const result = runQuarkify(configPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const fileFolders = await readdir(path.join(outDir, 'quark'));
    assert.equal(fileFolders.length, 2);
    assert.ok(fileFolders.some((name) => name.includes('Root.java')));
    assert.ok(fileFolders.some((name) => name.includes('Child.java')));
  });
});

test('segment globs support nested double-star and single-star patterns', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const configPath = path.join(tmp, 'config.mjs');

    await mkdir(path.join(srcDir, 'src', 'main'), { recursive: true });
    await mkdir(path.join(srcDir, 'scratch'), { recursive: true });
    await writeFile(path.join(srcDir, 'src', 'Top.java'), 'public class Top {}\n', 'utf8');
    await writeFile(path.join(srcDir, 'src', 'main', 'Deep.java'), 'public class Deep {}\n', 'utf8');
    await writeFile(path.join(srcDir, 'scratch', 'Scratch.java'), 'public class Scratch {}\n', 'utf8');
    await writeFile(path.join(srcDir, 'scratch', 'Ignored.txt'), 'ignore me\n', 'utf8');
    await writeConfig(configPath, `{
      name: 'segment-glob-regression',
      srcDir: ${JSON.stringify(srcDir)},
      outDir: ${JSON.stringify(outDir)},
      sourceFiles: ['src/**/*.java', 'scratch/*.java'],
      perfData: {},
      guessRole() { return 'general'; },
    }`);

    const result = runQuarkify(configPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const fileFolders = await readdir(path.join(outDir, 'quark'));
    assert.equal(fileFolders.length, 3);
    assert.ok(fileFolders.some((name) => name.includes('Top.java')));
    assert.ok(fileFolders.some((name) => name.includes('Deep.java')));
    assert.ok(fileFolders.some((name) => name.includes('Scratch.java')));
  });
});
