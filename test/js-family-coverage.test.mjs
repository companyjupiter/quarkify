import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

async function runSource(extension, source, args, check, hiddenSymbol) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'quarkify-js-coverage-'));
  try {
    const srcDir = path.join(workspace, 'src');
    const outDir = path.join(workspace, 'out');
    const fileName = `sample${extension}`;
    const configPath = path.join(workspace, 'config.json');
    await mkdir(srcDir);
    await writeFile(path.join(srcDir, fileName), source);
    await writeFile(configPath, JSON.stringify({
      name: 'js-family-coverage', srcDir, outDir, sourceFiles: [fileName], perfData: {},
    }));
    const nodeArgs = [];
    if (hiddenSymbol) {
      // Simulate a missing tree entry without depending on a parser bug.
      // Only the isolated CLI child gets this filesystem view; no node is deleted.
      const preloadPath = path.join(workspace, 'hide-symbol.mjs');
      await writeFile(preloadPath, `
        import fs from 'node:fs';
        import path from 'node:path';
        const readdir = fs.readdirSync.bind(fs);
        fs.readdirSync = (directory, options) => {
          const entries = readdir(directory, options);
          if (options?.withFileTypes && path.basename(directory) === ${JSON.stringify(`file__${fileName}`)} &&
              path.basename(path.dirname(directory)) === 'quark') {
            return entries.filter(entry => entry.name !== ${JSON.stringify(`fn__${hiddenSymbol}`)});
          }
          return entries;
        };
      `);
      nodeArgs.push('--import', pathToFileURL(preloadPath).href);
    }
    const result = spawnSync(process.execPath, [...nodeArgs, cliPath, ...args, configPath], {
      cwd: repoRoot, encoding: 'utf8',
    });
    await check(result, path.join(outDir, 'quark', `file__${fileName}`));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

for (const extension of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']) {
  test(`${extension} reports coverage and ignores quoted/commented declarations`, async () => {
    await runSource(extension, [
      '// function commented() {}',
      'const text = "function quoted() {}";',
      'function visible() { return 1; }',
      '',
    ].join('\n'), ['--strict-coverage'], (result, output) => {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /1\/1 \(100\.0%\)/);
      assert.ok(existsSync(path.join(output, 'fn__visible')));
      assert.doesNotMatch(result.stderr, /commented|quoted/);
    });
  });
}

for (const extension of ['.jsx', '.tsx']) {
  for (const strict of [false, true]) {
    test(`${extension} ${strict ? 'fails strict coverage' : 'warns'} for a hidden tree entry`, async () => {
      await runSource(extension, [
        'function visible() { return 1; }',
        'function hiddenFromAudit() { return 2; }',
        '',
      ].join('\n'), strict ? ['--strict-coverage'] : [], (result, output) => {
        assert.equal(result.status, strict ? 1 : 0, result.stderr || result.stdout);
        assert.match(result.stdout, /1\/2 \(50\.0%\)/);
        assert.match(result.stderr, /hiddenFromAudit/);
        assert.ok(existsSync(path.join(output, 'fn__visible')));
        assert.ok(existsSync(path.join(output, 'fn__hiddenFromAudit')));
      }, 'hiddenFromAudit');
    });
  }
}
