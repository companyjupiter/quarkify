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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-collision-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function run(workspace, files) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.join(srcDir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(srcDir, rel), body, 'utf8');
  }
  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'collision-check',
    srcDir,
    outDir,
    sourceFiles: Object.keys(files),
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, configPath], { cwd: repoRoot, encoding: 'utf8' });
  return { result, quarkDir: path.join(outDir, 'quark') };
}

// safeName() flattens every path separator to `_`, so these two paths produce
// the same `file__…` name. mkdir is recursive, so before the planner existed
// the second file's symbols landed silently inside the first file's folder —
// and the coverage audit could not see it, because it scans the merged folder
// and finds everything it expected.
test('paths that flatten to the same folder name stay separate', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, quarkDir } = await run(workspace, {
      'src/admin/user_settings.rb': 'class A\n  def from_first\n    1\n  end\nend\n',
      'src/admin_user/settings.rb': 'class B\n  def from_second\n    2\n  end\nend\n',
    });

    assert.equal(result.status, 0, result.stderr);
    const folders = (await readdir(quarkDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
    assert.equal(folders.length, 2, folders.join('\n'));

    // Each folder holds exactly one file's symbols, not both merged.
    const owners = [];
    for (const folder of folders) {
      const entries = await readdir(path.join(quarkDir, folder));
      owners.push(entries.sort().join(','));
    }
    assert.ok(owners.includes('class__A'), owners.join(' | '));
    assert.ok(owners.includes('class__B'), owners.join(' | '));
    assert.match(result.stdout, /파일 폴더명 충돌/);
  });
});

test('a non-colliding path keeps its plain readable folder name', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, quarkDir } = await run(workspace, {
      'src/models/post.rb': 'class Post\n  def title\n    @title\n  end\nend\n',
    });

    assert.equal(result.status, 0, result.stderr);
    const folders = await readdir(quarkDir);
    assert.deepEqual(folders, ['file__src_models_post.rb']);
    assert.doesNotMatch(result.stdout, /충돌/);
  });
});
