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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-zig-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function listRelativeEntries(dir, root = dir) {
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    entries.push(path.relative(root, fullPath));
    if (entry.isDirectory()) {
      entries.push(...await listRelativeEntries(fullPath, root));
    }
  }
  return entries;
}

function runQuarkify(configPath, extraArgs = []) {
  return spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

// `export fn` is how Zig declares an ABI boundary: JNI entry points, C-callable
// library exports, anything the outside world can actually call. The parser used
// to accept only `pub` / `inline` / `noinline`, so for a Zig shared library every
// externally reachable symbol was silently absent from the topology map — the map
// had the internals but not a single entry point.
const ZIG_SOURCE = [
  'pub fn plainFn() void {}',
  'inline fn inlineFn() void {}',
  'noinline fn noinlineFn() void {}',
  'export fn exportedFn() void {}',
  'pub export fn pubExportedFn() void {}',
  '',
].join('\n');

const EXPECTED_FUNCTIONS = [
  'plainFn',
  'inlineFn',
  'noinlineFn',
  'exportedFn',
  'pubExportedFn',
];

test('zig export functions are materialized as quarks', async () => {
  await withTempWorkspace(async (workspace) => {
    const srcDir = path.join(workspace, 'src');
    const outDir = path.join(workspace, 'out');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'abi.zig'), ZIG_SOURCE, 'utf8');

    const configPath = path.join(workspace, 'config.json');
    await writeFile(configPath, JSON.stringify({
      name: 'zig-abi',
      srcDir,
      outDir,
      sourceFiles: ['abi.zig'],
      perfData: {},
    }), 'utf8');

    const result = runQuarkify(configPath);
    assert.equal(result.status, 0, result.stderr);

    const entries = await listRelativeEntries(path.join(outDir, 'quark'));
    for (const name of EXPECTED_FUNCTIONS) {
      assert.ok(
        entries.some((entry) => entry.endsWith(`fn__${name}`)),
        `expected a quark folder for fn__${name}`,
      );
    }
  });
});
