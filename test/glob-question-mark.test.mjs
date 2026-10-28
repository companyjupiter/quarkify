import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-glob-qmark-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runQuarkify(configPath) {
  return spawnSync(process.execPath, [cliPath, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('a ? in a sourceFiles glob matches exactly one character', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const configPath = path.join(tmp, 'config.json');

    await mkdir(path.join(srcDir, 'lib'), { recursive: true });
    await writeFile(path.join(srcDir, 'lib', 'part1.js'), 'export function partOne() { return 1; }\n', 'utf8');
    await writeFile(path.join(srcDir, 'lib', 'part2.js'), 'export function partTwo() { return 2; }\n', 'utf8');
    await writeFile(path.join(srcDir, 'lib', 'part10.js'), 'export function partTen() { return 10; }\n', 'utf8');
    await writeFile(path.join(srcDir, 'lib', 'part.js'), 'export function part() { return 0; }\n', 'utf8');
    await writeFile(configPath, JSON.stringify({
      name: 'glob-question-mark',
      srcDir,
      outDir,
      sourceFiles: ['lib/part?.js'],
    }), 'utf8');

    const result = runQuarkify(configPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const fileFolders = await readdir(path.join(outDir, 'quark'));
    assert.equal(fileFolders.length, 2, fileFolders.join(', '));
    assert.ok(fileFolders.some((name) => name.includes('part1.js')));
    assert.ok(fileFolders.some((name) => name.includes('part2.js')));
  });
});

test('a ? matches one character even outside the BMP', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    const configPath = path.join(tmp, 'config.json');

    await mkdir(path.join(srcDir, 'lib'), { recursive: true });
    // U+20000 is one character but two UTF-16 code units.
    await writeFile(path.join(srcDir, 'lib', 'part\u{20000}.js'), 'export function partWide() { return 1; }\n', 'utf8');
    await writeFile(path.join(srcDir, 'lib', 'partAB.js'), 'export function partTwoChars() { return 2; }\n', 'utf8');
    await writeFile(configPath, JSON.stringify({
      name: 'glob-question-mark-astral',
      srcDir,
      outDir,
      sourceFiles: ['lib/part?.js'],
    }), 'utf8');

    const result = runQuarkify(configPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /총 1개 파일 매칭됨/);
    assert.match(result.stdout, /분해 중: lib[\\/]part\u{20000}\.js/u);
  });
});
