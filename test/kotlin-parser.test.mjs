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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-kotlin-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnKotlin(workspace, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'sample.kt'), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'kotlin-check',
    srcDir,
    outDir,
    sourceFiles: ['sample.kt'],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', 'file__sample.kt') };
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

test('kotlin declaration kinds become distinct folder nodes', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnKotlin(workspace, [
      'package com.example',
      '',
      'class Plain',
      'data class Point(val x: Int)',
      'enum class Mode(val code: String) { ON("o") }',
      'interface Store { fun load(): Point }',
      'object Registry { fun register(p: Point) { println(p) } }',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Plain'), entries.join('\n'));
    assert.ok(entries.includes('class__Point'), entries.join('\n'));
    assert.ok(entries.includes('enum__Mode'), entries.join('\n'));
    assert.ok(entries.includes('interface__Store'), entries.join('\n'));
    assert.ok(entries.includes('object__Registry'), entries.join('\n'));
    assert.ok(entries.includes('interface__Store/fn__load'), entries.join('\n'));
    assert.ok(entries.includes('object__Registry/fn__register'), entries.join('\n'));
  });
});

// The regression that motivated the Kotlin parser's own termination rule:
// `fun f() = expr` never opens a brace, so a Java-style matcher that waits for
// a balanced `{` keeps the symbol open and swallows every later declaration.
test('an expression-body function does not swallow the rest of the file', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnKotlin(workspace, [
      'fun first(): Int = 1',
      '',
      'fun second(',
      '    a: Int,',
      '    b: Int,',
      '): Int = a + b',
      '',
      'fun third(): Int {',
      '    return 3',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    for (const name of ['fn__first', 'fn__second', 'fn__third']) {
      assert.ok(entries.includes(name), `${name} missing from:\n${entries.join('\n')}`);
    }
    // `third` still had its body decomposed — the earlier symbols closing
    // early must not cost the last one its statements.
    assert.ok(entries.includes('fn__third/stmt_0__return'), entries.join('\n'));
  });
});

test('a bodyless class with a primary constructor closes at the header', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnKotlin(workspace, [
      'data class Region(val code: String, var label: String)',
      '',
      'fun after(): Int = 0',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Region/field__code'), entries.join('\n'));
    assert.ok(entries.includes('class__Region/field__label'), entries.join('\n'));
    assert.ok(entries.includes('fn__after'), entries.join('\n'));
  });
});

// Constructor injection is where a Spring/Kotlin service declares its real
// dependency edges, and none of it lives inside the class braces.
test('primary constructor properties are materialized with type and mutability', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnKotlin(workspace, [
      '@Component',
      'class RegionService(',
      '    private val repository: RegionRepository,',
      '    var attempts: Int = 0,',
      '    plain: Int,',
      ') {',
      '    fun run() {',
      '        repository.load()',
      '    }',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__RegionService/annotation__Component'), entries.join('\n'));
    assert.ok(entries.includes('class__RegionService/field__repository/type__RegionRepository'), entries.join('\n'));
    assert.ok(entries.includes('class__RegionService/field__repository/bound__constructor'), entries.join('\n'));
    assert.ok(entries.includes('class__RegionService/field__repository/mutability__val'), entries.join('\n'));
    assert.ok(entries.includes('class__RegionService/field__attempts/mutability__var'), entries.join('\n'));
    assert.ok(entries.includes('class__RegionService/fn__run'), entries.join('\n'));
    // `plain` is a constructor parameter, not a property — it must not appear.
    assert.ok(!entries.includes('class__RegionService/field__plain'), entries.join('\n'));
  });
});

// Two extensions with the same name on different receivers must not collapse
// into one folder, so the receiver stays part of the node name.
test('extension functions keep their receiver in the node name', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnKotlin(workspace, [
      'fun Region.toDto(): String = code',
      'fun Point.toDto(): String = "p"',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('fn__Region.toDto'), entries.join('\n'));
    assert.ok(entries.includes('fn__Point.toDto'), entries.join('\n'));
  });
});

test('kotlin function bodies are decomposed into control-flow nodes', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnKotlin(workspace, [
      'fun classify(x: Int): String {',
      '    if (x > 0) {',
      '        return "pos"',
      '    }',
      '    for (i in 0..x) {',
      '        println(i)',
      '    }',
      '    return "neg"',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.some((e) => e.startsWith('fn__classify/stmt_0__if')), entries.join('\n'));
    assert.ok(entries.some((e) => e.includes('stmt_1__for')), entries.join('\n'));
  });
});

// Kotlin was previously unmatched by every branch of processCStyle, so the run
// produced empty folders and — with no NAIVE_SYMBOL_SCANS entry — reported no
// gap at all. The audit has to be able to see this language now.
test('kotlin symbol coverage is audited rather than silently skipped', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result } = await runOnKotlin(workspace, [
      'class Holder {',
      '    fun alpha(): Int = 1',
      '    fun beta(): Int = 2',
      '}',
      '',
      'fun gamma(): Int = 3',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /심볼 커버리지:\s+3\/3 \(100\.0%\)/);
  });
});
