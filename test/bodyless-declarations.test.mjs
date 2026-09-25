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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-bodyless-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOn(workspace, fileName, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, fileName), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'bodyless-check',
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

// A declaration with no body waited for a `{` that never came, so it swallowed
// every declaration after it — here the second extern and the ordinary
// function below it — into its own folder.
test('zig extern declarations end at their semicolon', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOn(workspace, 'ws2.zig', [
      'pub extern "ws2_32" fn WSAGetLastError() callconv(.winapi) i32;',
      '',
      'pub extern "ws2_32" fn WSAStartup(',
      '    wVersionRequired: u16,',
      '    lpWSAData: *anyopaque,',
      ') callconv(.winapi) i32;',
      '',
      'pub fn startup() i32 {',
      '    return 0;',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3\/3 \(100\.0%\)/);
    assert.deepEqual((await readdir(fileQuark)).sort(), ['fn__WSAGetLastError', 'fn__WSAStartup', 'fn__startup']);
  });
});

test('zig extern declarations inside a struct end at their semicolon', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOn(workspace, 'k32.zig', [
      'const kernel32 = struct {',
      '    pub extern "kernel32" fn ReadFile(',
      '        hFile: *anyopaque,',
      '    ) callconv(.winapi) i32;',
      '',
      '    pub extern "kernel32" fn SetHandleInformation(',
      '        hObject: *anyopaque,',
      '    ) callconv(.winapi) i32;',
      '};',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
    const members = (await readdir(path.join(fileQuark, 'struct__kernel32'))).filter((e) => e.startsWith('fn__'));
    assert.deepEqual(members.sort(), ['fn__ReadFile', 'fn__SetHandleInformation']);
  });
});

// C has no coverage scan, so here the loss was silent: the prototype took the
// definition below it into its own folder.
test('a multi-line C prototype does not swallow the next definition', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOn(workspace, 'api.h', [
      'int api_open(',
      '    const char *path,',
      '    int flags);',
      '',
      'int api_close(int fd) {',
      '    return fd;',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(fileQuark)).sort(), ['fn__api_close', 'fn__api_open']);
    assert.ok((await readdir(path.join(fileQuark, 'fn__api_close'))).length > 0, 'api_close body missing');
  });
});
