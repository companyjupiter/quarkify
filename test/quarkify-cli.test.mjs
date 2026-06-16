import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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

test('generated HTML viewer does not load remote scripts by default', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const configPath = path.join(tmp, 'config.mjs');

    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'sample.js'), 'export function sampleThing() { return 1; }\n', 'utf8');
    await writeConfig(configPath, `{
      name: 'offline-html-test',
      srcDir: ${JSON.stringify(srcDir)},
      outDir: ${JSON.stringify(outDir)},
      sourceFiles: ['sample.js'],
      perfData: {},
      guessRole() { return 'general'; },
    }`);

    const result = runQuarkify(configPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const html = await import('node:fs/promises').then(({ readFile }) => readFile(path.join(outDir, 'index.html'), 'utf8'));
    assert.doesNotMatch(html, new RegExp(String.raw`<script\s+src=["']https?://`, 'i'));
    assert.doesNotMatch(html, /cdn\.tailwindcss\.com|d3js\.org/i);
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

test('outDir cannot be the same directory as srcDir', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const configPath = path.join(tmp, 'config.mjs');

    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'sample.js'), 'export function sampleThing() { return 1; }\n', 'utf8');
    await writeConfig(configPath, `{
      name: 'unsafe-output-regression',
      srcDir: ${JSON.stringify(srcDir)},
      outDir: ${JSON.stringify(srcDir)},
      sourceFiles: ['sample.js'],
      perfData: {},
      guessRole() { return 'general'; },
    }`);

    const result = runQuarkify(configPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /unsafe output directory/i);
  });
});

test('outDir must be empty or marked as Quarkify output', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'existing');
    const configPath = path.join(tmp, 'config.mjs');

    await mkdir(srcDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(srcDir, 'sample.js'), 'export function sampleThing() { return 1; }\n', 'utf8');
    await writeFile(path.join(outDir, 'keep.txt'), 'do not delete\n', 'utf8');
    await writeConfig(configPath, `{
      name: 'marked-output-regression',
      srcDir: ${JSON.stringify(srcDir)},
      outDir: ${JSON.stringify(outDir)},
      sourceFiles: ['sample.js'],
      perfData: {},
      guessRole() { return 'general'; },
    }`);

    const result = runQuarkify(configPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr || result.stdout, /not marked/i);
  });
});
