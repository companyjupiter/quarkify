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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-unicode-'));
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
    name: 'unicode-check',
    srcDir,
    outDir,
    sourceFiles: Object.keys(files),
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, '--strict-coverage', configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, quarkDir: path.join(outDir, 'quark') };
}

const RUBY = 'class A\n  def ok\n    1\n  end\nend\n';

// Flattening every non-ASCII character to `_` turned both paths into
// `file__src_____…`: unreadable, and the planner had to fall back to digests.
test('non-ASCII paths keep readable folder names', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, quarkDir } = await run(workspace, {
      'src/서비스/주문.rb': RUBY,
      'src/서비스/결제.rb': RUBY,
      'src/café/menü.rb': RUBY,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(quarkDir)).sort(), [
      'file__src_café_menü.rb',
      'file__src_서비스_결제.rb',
      'file__src_서비스_주문.rb',
    ]);
  });
});

// 100 characters of Hangul are 300 bytes, past the 255-byte name limit of
// Linux filesystems, so a character cap alone fails the whole run there with
// ENAMETOOLONG. (macOS counts characters and would not notice.)
test('a long non-ASCII name is capped in bytes, not characters', async () => {
  await withTempWorkspace(async (workspace) => {
    const longDir = '가'.repeat(80); // 240 bytes: a legal directory name
    const { result, quarkDir } = await run(workspace, { [`${longDir}/나다.rb`]: RUBY });

    assert.equal(result.status, 0, result.stderr);
    const [folder] = await readdir(quarkDir);
    assert.ok(Buffer.byteLength(folder) <= 'file__'.length + 100, `${Buffer.byteLength(folder)} bytes: ${folder}`);
    assert.ok(folder.startsWith(`file__${'가'.repeat(33)}`), folder);
    assert.ok(!folder.includes('�'), folder);
  });
});

// The same text can arrive composed (NFC) or decomposed (NFD). It must name
// the same folder either way.
test('decomposed and composed spellings produce the same NFC folder name', async () => {
  await withTempWorkspace(async (workspace) => {
    const decomposed = '한글.rb'.normalize('NFD');
    assert.notEqual(decomposed, '한글.rb'.normalize('NFC'));
    const { result, quarkDir } = await run(workspace, { [decomposed]: RUBY });

    assert.equal(result.status, 0, result.stderr);
    const folders = await readdir(quarkDir);
    assert.deepEqual(folders.map((f) => f.normalize('NFC')), ['file__한글.rb']);
    assert.equal(folders[0], folders[0].normalize('NFC'));
  });
});
