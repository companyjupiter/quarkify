import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-non-file-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runWith(workspace, sourceFiles) {
  const configPath = path.join(workspace, 'config.json');
  const outDir = path.join(workspace, 'out');
  await writeFile(configPath, JSON.stringify({
    name: 'non-file-check',
    srcDir: path.join(workspace, 'src'),
    outDir,
    sourceFiles,
    perfData: {},
  }), 'utf8');
  const result = spawnSync(process.execPath, [cliPath, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, quarkDir: path.join(outDir, 'quark') };
}

// A directory symlink is ordinary in a real tree (a vendored package, a shared
// config folder). `**/*` used to match it as a file and the run died on EISDIR.
test('a glob does not match a symlinked directory', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const realDir = path.join(workspace, 'src', 'real');
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, 'a.py'), 'def f():\n    return 1\n', 'utf8');
    try {
      // 'junction' lets Windows create it without elevation; POSIX ignores it.
      await symlink(realDir, path.join(workspace, 'src', 'linked'), 'junction');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const { result, quarkDir } = await runWith(workspace, ['**/*']);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /분해 중: linked\s*$/m);
    const quarks = await readdir(quarkDir);
    assert.ok(quarks.some((name) => name.includes('a.py')), quarks.join('\n'));
    assert.ok(!quarks.some((name) => /linked$/.test(name)), quarks.join('\n'));
  });
});

// Named explicitly, a directory is skipped like a missing file rather than
// failing every other file in the run.
test('an explicit sourceFiles entry that is a directory is skipped', async () => {
  await withTempWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, 'src', 'pkg'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'b.py'), 'def g():\n    return 2\n', 'utf8');

    const { result, quarkDir } = await runWith(workspace, ['pkg', 'b.py']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /건너뜀.*: pkg/);
    const quarks = await readdir(quarkDir);
    assert.ok(quarks.some((name) => name.includes('b.py')), quarks.join('\n'));
  });
});
