import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-coverage-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnZig(workspace, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'sample.zig'), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'coverage-check',
    srcDir,
    outDir,
    sourceFiles: ['sample.zig'],
    perfData: {},
  }), 'utf8');

  return spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

// The audit must not depend on any particular parser gap existing, otherwise it
// starts failing the moment a parser bug gets fixed. These cases only assert
// that the audit reports, and that it stays quiet when there is nothing to say.

test('symbol coverage is reported for every run', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnZig(workspace, [
      'pub fn alpha() void {}',
      'inline fn beta() void {}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
  });
});

test('a fully covered run passes --strict-coverage', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnZig(workspace, 'pub fn onlyOne() void {}\n', ['--strict-coverage']);
    assert.equal(result.status, 0, result.stderr);
  });
});

// `fn` appearing in prose or inside a literal must not be counted as a symbol —
// a noisy audit gets ignored, and an ignored audit is the same as no audit.
test('commented-out and quoted declarations are not counted as missing symbols', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnZig(workspace, [
      '// fn commentedFn() void {}',
      '/* fn blockCommentFn() void {} */',
      'pub fn real() void {',
      '    const s = "fn quotedFn(";',
      '    _ = s;',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\/1 \(100\.0%\)/);
    for (const ghost of ['commentedFn', 'blockCommentFn', 'quotedFn']) {
      assert.ok(
        !result.stderr.includes(ghost),
        `${ghost} should not be reported as a missing symbol`,
      );
    }
  });
});
