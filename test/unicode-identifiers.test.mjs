import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

// These assertions deliberately never spell out how a non-ASCII name is
// rendered in a folder name: safeName() currently flattens it to `_`, and that
// is expected to change to keeping the characters. What must hold either way
// is the *shape* — a def becomes fn__…, not stmt_N__expr — and that the
// coverage audit sees the name and finds it in the tree.

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-unicode-ident-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnSource(workspace, fileName, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, fileName), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'unicode-ident-check',
    srcDir,
    outDir,
    sourceFiles: [fileName],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', `file__${fileName}`) };
}

async function listRelativeEntries(root) {
  const found = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(rel);
      await walk(path.join(dir, entry.name), rel);
    }
  };
  await walk(root, '');
  return found;
}

const has = (entries, pattern) => entries.some((e) => pattern.test(e));

// ─── Python ───

test('python: non-ASCII def and class become fn__/class__ folders, not stmt_N__expr', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnSource(workspace, 'sample.py', [
      'class 사람:',
      '    def 이름(self):',
      '        return 인사()',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.ok(!has(entries, /^stmt_\d+__expr$/), listing);
    assert.ok(has(entries, /^class__[^/]+$/), listing);
    assert.ok(has(entries, /^class__[^/]+\/fn__[^/]+$/), listing);
    // emitBlockNode's call scan must see `인사(` as a call too.
    assert.ok(has(entries, /^class__[^/]+\/fn__[^/]+\/stmt_0__return\/call__[^/]+$/), listing);
  });
});

// `[\p{L}\p{N}_]` would read `नमस्ते` as `नमस` (it stops at the virama, a
// combining mark), and the audit — which captures the full name — would then
// report the def as missing. Python's own rule is XID_Start/XID_Continue.
// The def is alone in its file on purpose: while safeName() flattens non-ASCII
// to `_`, any other name of the same length would satisfy the audit for it.
test('python: names with combining marks are read whole, and the audit agrees', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result } = await runOnSource(workspace, 'sample.py', [
      'def नमस्ते():',
      '    return 1',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\/1 \(100\.0%\)/);
  });
});

test('python: accented and async non-ASCII defs are counted and found', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result } = await runOnSource(workspace, 'sample.py', [
      'def café(x):',
      '    return x',
      '',
      'async def 비동기_작업():',
      '    return 2',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
  });
});

// The scan must not share the parser's identifier alphabet — that is how an
// ASCII-only parser and an ASCII-only scan agreed to ignore `def 인사():`. A
// name no identifier rule accepts is the stable way to show the scan reports
// what the parser cannot read instead of skipping it.
test('python: a def the parser cannot read is reported, not skipped', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result } = await runOnSource(workspace, 'sample.py', [
      'def 인사():',
      '    return 1',
      '',
      'def 1st_pass():',
      '    return 2',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.notEqual(result.status, 0, 'strict coverage should fail on an unreadable def');
    assert.match(result.stdout, /1\/2 \(50\.0%\)/);
    assert.ok(result.stderr.includes('1st_pass'), result.stderr);
  });
});

// ─── Ruby ───

test('ruby: non-ASCII class and method names become class__/fn__ folders', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnSource(workspace, 'sample.rb', [
      'class Greeter',
      '  def 인사?',
      '    true',
      '  end',
      '',
      '  def café',
      '    1',
      '  end',
      'end',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.ok(!has(entries, /^class__Greeter\/stmt_\d+__expr$/), listing);
    // The `?` suffix encoding still applies to a non-ASCII predicate.
    assert.ok(has(entries, /^class__Greeter\/fn__[^/]+__q$/), listing);
    assert.equal(entries.filter((e) => /^class__Greeter\/fn__[^/]+$/.test(e)).length, 2, listing);
  });
});

// JavaScript's `\b` is ASCII-only, so `/^end\b/` matched `end값 = 1` and closed
// the method early, and `/^if\b/` matched `if문 = true` and opened a block that
// swallowed the method's real `end`. Either one shifts every later node.
test('ruby: keywords followed by non-ASCII letters are identifiers, not block delimiters', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnSource(workspace, 'sample.rb', [
      'class Calc',
      '  def total',
      '    end값 = 1',
      '  end',
      '',
      '  def mean',
      '    if문 = true',
      '  end',
      '',
      '  def last',
      '    2',
      '  end',
      'end',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    for (const method of ['total', 'mean', 'last']) {
      assert.ok(entries.includes(`class__Calc/fn__${method}`), listing);
    }
    for (const method of ['total', 'mean']) {
      const children = entries.filter((e) => e.startsWith(`class__Calc/fn__${method}/`) && e.split('/').length === 3);
      assert.equal(children.length, 1, listing);
      assert.match(children[0], /\/var__[^/]+$/, listing);
    }
    assert.ok(!has(entries, /__if(\/|$)/), listing);
  });
});

// ─── JavaScript ───

test('js: non-ASCII function and class names become fn__/class__ folders', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnSource(workspace, 'sample.js', [
      'function 인사() {',
      '  return 1;',
      '}',
      '',
      'class 사람 {',
      '}',
      '',
      'function $helper() {',
      '  return 2;',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.ok(has(entries, /^class__[^/]+$/), listing);
    assert.equal(entries.filter((e) => /^fn__[^/]+$/.test(e)).length, 2, listing);
    // `$` was in the audit's alphabet but not the parser's, so this was a gap.
    assert.ok(entries.includes('fn__$helper'), listing);
  });
});
