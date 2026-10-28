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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-split-args-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOn(workspace, fileName, source) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, fileName), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'split-args-check',
    srcDir,
    outDir,
    sourceFiles: [fileName],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return path.join(outDir, 'quark', `file__${fileName}`);
}

async function argFolders(dir) {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('arg__'))
    .map((entry) => entry.name)
    .sort();
}

test('a comma inside a decorator string argument does not split the argument', async () => {
  await withTempWorkspace(async (tmp) => {
    const fileQuark = await runOn(tmp, 'sample.py', [
      'import pytest',
      '',
      '@pytest.mark.parametrize("a,b", [(1, 2)])',
      'def test_pair(a, b):',
      '    return a + b',
      '',
    ].join('\n'));

    const args = await argFolders(path.join(fileQuark, 'fn__test_pair', 'decorator__pytest.mark.parametrize'));
    assert.equal(args.length, 2, args.join('\n'));
    assert.ok(args[0].startsWith('arg__0___'), args.join('\n'));
    assert.ok(args[1].startsWith('arg__1___'), args.join('\n'));
  });
});

test('a Java annotation array literal stays one argument', async () => {
  await withTempWorkspace(async (tmp) => {
    const fileQuark = await runOn(tmp, 'Sample.java', [
      'public class Sample {',
      '    @SuppressWarnings({"unchecked", "rawtypes"})',
      '    public void run() {',
      '    }',
      '}',
      '',
    ].join('\n'));

    const args = await argFolders(path.join(fileQuark, 'class__Sample', 'fn__run', 'annotation__SuppressWarnings'));
    assert.equal(args.length, 1, args.join('\n'));
  });
});

test('a comparison in a decorator argument is not a bracket', async () => {
  await withTempWorkspace(async (tmp) => {
    const fileQuark = await runOn(tmp, 'sample.py', [
      'import sys',
      'import pytest',
      '',
      '@pytest.mark.skipif(sys.version_info > (3, 8), reason="old only")',
      'def test_old():',
      '    return 1',
      '',
      '@pytest.mark.skipif(sys.version_info < (3, 8), reason="new only")',
      'def test_new():',
      '    return 2',
      '',
    ].join('\n'));

    for (const fn of ['fn__test_old', 'fn__test_new']) {
      const args = await argFolders(path.join(fileQuark, fn, 'decorator__pytest.mark.skipif'));
      assert.equal(args.length, 2, `${fn}: ${args.join(', ')}`);
      assert.ok(args[0].startsWith('arg__0___sys.version_info'), `${fn}: ${args.join(', ')}`);
      assert.ok(args[1].startsWith('arg__reason___'), `${fn}: ${args.join(', ')}`);
    }
  });
});

test('template arguments in a kernel parameter list still group their commas', async () => {
  await withTempWorkspace(async (tmp) => {
    const fileQuark = await runOn(tmp, 'blend.metal', [
      '#include <metal_stdlib>',
      'using namespace metal;',
      '',
      'kernel void blend(array<texture2d<float>, 2> layers [[texture(0)]],',
      '                  device float * out [[buffer(0)]],',
      '                  uint id [[thread_position_in_grid]]) {',
      '    out[id] = 0;',
      '}',
      '',
    ].join('\n'));

    const params = (await readdir(path.join(fileQuark, 'metal_kernel__blend')))
      .filter((name) => name.startsWith('param__'))
      .sort();
    assert.deepEqual(params, ['param__id', 'param__layers', 'param__out']);
  });
});

test('a Ruby hash rocket does not stop later macro arguments from splitting', async () => {
  await withTempWorkspace(async (tmp) => {
    const fileQuark = await runOn(tmp, 'sample.rb', [
      'class Post',
      '  has_many :comments, :class_name => "Note", :dependent => :destroy',
      'end',
      '',
    ].join('\n'));

    const args = await argFolders(path.join(fileQuark, 'class__Post', 'annotation__has_many'));
    assert.equal(args.length, 3, args.join('\n'));
  });
});
