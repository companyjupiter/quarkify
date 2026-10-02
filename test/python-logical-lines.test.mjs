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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-py-lines-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnPython(workspace, source) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'sample.py'), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'python-lines-check',
    srcDir,
    outDir,
    sourceFiles: ['sample.py'],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', 'file__sample.py') };
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

const topLevel = (entries) => entries.filter((e) => !e.includes('/') && !e.startsWith('python_version__'));

// These cases all kept a fn__ folder, so the coverage audit passed. What broke
// was where the body went — under a `):`, `"""` or `2` line at column 0.

test('a black-style multi-line signature keeps its body', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnPython(workspace, [
      'def build(',
      '    name,',
      '    size,',
      '):',
      '    label = "(# not a comment"',
      '    total = compute(name)',
      '    return total',
      '',
      '',
      'def after():',
      '    return 2',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.deepEqual(topLevel(entries).sort(), ['fn__after', 'fn__build'], listing);
    assert.ok(entries.includes('fn__build/var__label'), listing);
    assert.ok(entries.includes('fn__build/var__total/call__compute'), listing);
    assert.ok(entries.includes('fn__build/stmt_2__return'), listing);
  });
});

test('a triple-quoted string with text at column 0 stays inside its function', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnPython(workspace, [
      'def query():',
      '    sql = """',
      'SELECT *',
      'FROM t',
      '"""',
      '    return run(sql)',
      '',
      '',
      'def later():',
      '    return 1',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.deepEqual(topLevel(entries).sort(), ['fn__later', 'fn__query'], listing);
    assert.ok(entries.includes('fn__query/var__sql'), listing);
    assert.ok(entries.includes('fn__query/stmt_1__return/call__run'), listing);
  });
});

test('a backslash continuation at column 0 does not end the block', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnPython(workspace, [
      'def total():',
      '    value = 1 + \\',
      '2',
      '    return value',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.deepEqual(topLevel(entries), ['fn__total'], listing);
    assert.ok(entries.includes('fn__total/stmt_1__return'), listing);
  });
});

test('a multi-line decorator is attached to its function', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnPython(workspace, [
      '@app.route(',
      '    "/items",',
      '    methods=["GET"],',
      ')',
      'def items():',
      '    return list_items()',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.ok(entries.includes('fn__items/decorator__app.route'), listing);
    assert.ok(entries.some((e) => e.startsWith('fn__items/decorator__app.route/arg__methods___')), listing);
  });
});

// A plain string can continue onto the next physical line with an escaped
// newline. If the joiner forgot it was inside the string there, the `(` would
// open a bracket that never closes and swallow the rest of the file.
test('a plain string continued by an escaped newline keeps its brackets out of the count', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnPython(workspace, [
      'def first():',
      '    text = "hello\\',
      '(world"',
      '    return text',
      '',
      'def after():',
      '    return 1',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const listing = entries.join('\n');
    assert.deepEqual(topLevel(entries).sort(), ['fn__after', 'fn__first'], listing);
    assert.ok(entries.includes('fn__first/stmt_1__return'), listing);
  });
});
