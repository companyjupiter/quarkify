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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-audit-strip-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnSource(workspace, fileName, source, extraArgs = ['--strict-coverage']) {
  const srcDir = path.join(workspace, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, fileName), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'audit-strip-check',
    srcDir,
    outDir: path.join(workspace, 'out'),
    sourceFiles: [fileName],
    perfData: {},
  }), 'utf8');

  return spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

// The audit only fails in one direction (declared but not built), so a
// declaration it never counts is a declaration it can never report. These
// assert the exact expected count: a count that is too low is the bug.

test('a comment opener inside a string does not hide later declarations', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnSource(workspace, 'sample.js', [
      "const accept = 'image/*';",
      'function first() { return 1; }',
      'function second() { return 2; }',
      '/** The old block-comment pass resumed after the end of this comment. */',
      'function third() { return 3; }',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3\/3 \(100\.0%\)/);
  });
});

// Only the expected count is asserted here. A declaration after other code on
// the same line is one the JS matcher does not read (it is anchored at line
// start), so once the audit sees `paint` it may rightly report it — the bug
// was that `#` made the audit blind to it.
test('`#` is not a comment in JavaScript', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnSource(workspace, 'sample.js', [
      'const color = "#fff"; function paint() { return color; }',
      'function other() { return 0; }',
      '',
    ].join('\n'), []);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\d\/2 \(/);
  });
});

test('real comments and string bodies are still not counted', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnSource(workspace, 'sample.js', [
      '// function lineGhost() {}',
      '/* function blockGhost() {} */',
      "const s = 'function quotedGhost() {}';",
      'const t = `',
      '  function templateGhost() {}',
      '`;',
      'function real() { return s + t; }',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\/1 \(100\.0%\)/);
  });
});

// A docstring is a string, so a `def` written inside one is text. It was
// counted before because only single-line quotes were stripped.
test('Zig multiline string lines are text', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnSource(workspace, 'gen.zig', [
      'const template =',
      '    \\\\pub fn generated(a: u32) u32 {',
      '    \\\\    return a; /* not a comment in Zig',
      ';',
      '',
      'pub fn real() void {}',
      '',
      'pub fn after() void {}',
      '',
    ].join('\n'));

    // Before: `generated` was expected (a false gap that failed the run), and
    // the `/*` in the string line hid `real` and `after` from the audit.
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
  });
});

test('a def inside a Python triple-quoted string is not counted', async () => {
  await withTempWorkspace(async (workspace) => {
    const result = await runOnSource(workspace, 'sample.py', [
      'USAGE = """',
      'def not_a_function():',
      '"""',
      '',
      'def real():',
      '    return 1',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\/1 \(100\.0%\)/);
  });
});
