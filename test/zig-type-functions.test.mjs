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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-zig-type-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnZig(workspace, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'server.zig'), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'zig-type-check',
    srcDir,
    outDir,
    sourceFiles: ['server.zig'],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', 'file__server.zig') };
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

// A function returning `type` is Zig's generic type. The statement walk saw
// only a `return`, so the type's fields and methods never reached the tree.
test('the container a type function returns is materialized', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnZig(workspace, [
      'pub fn Server(comptime H: type) type {',
      '    return struct {',
      '        handler: H,',
      '        port: u16 = 8080,',
      '',
      '        const Self = @This();',
      '',
      '        pub fn init(handler: H) Self {',
      '            return .{ .handler = handler };',
      '        }',
      '',
      '        pub fn listen(self: *Self) !void {',
      '            _ = self;',
      '        }',
      '    };',
      '}',
      '',
      'pub fn helper() u32 {',
      '    return 1;',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /4\/4 \(100\.0%\)/);
    const entries = await listRelativeEntries(fileQuark);
    for (const expected of [
      'fn__Server/returns__struct/field__handler/type__H',
      'fn__Server/returns__struct/field__port/type__u16',
      'fn__Server/returns__struct/field__port/default__8080',
      'fn__Server/returns__struct/fn__init',
      'fn__Server/returns__struct/fn__listen',
      'fn__helper',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
    assert.ok(!entries.some((e) => e.startsWith('fn__helper/returns__')), entries.join('\n'));
  });
});

test('nested and packed type functions are materialized', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnZig(workspace, [
      'pub fn Router(comptime T: type) type {',
      '    return struct {',
      '        pub fn Group(comptime G: type) type {',
      '            return struct {',
      '                pub fn get(self: *G) void {',
      '                    _ = self;',
      '                }',
      '            };',
      '        }',
      '    };',
      '}',
      '',
      'pub fn Flags(comptime n: usize) type {',
      '    return packed struct {',
      '        bits: [n]bool,',
      '    };',
      '}',
      '',
      'pub fn Kind(comptime tag: type) type {',
      '    return enum(tag) {',
      '        a,',
      '        b,',
      '    };',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /5\/5 \(100\.0%\)/);
    const entries = await listRelativeEntries(fileQuark);
    for (const expected of [
      'fn__Router/returns__struct/fn__Group/returns__struct/fn__get',
      'fn__Flags/returns__struct/field__bits',
      'fn__Kind/returns__enum',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
  });
});

// The container's closing `}` is found by brace matching. A `}` inside a
// string, a character literal or a comment is text, and counting it closed
// the container early: `run` below was dropped and --strict-coverage failed.
test('braces inside literals and comments do not end the returned container', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnZig(workspace, [
      'pub fn Type() type {',
      '    // return struct { is not the container',
      '    return struct {',
      '        label: []const u8 = "}",',
      "        close: u8 = '}',",
      '        // }',
      '        pub fn run() void {}',
      '    };',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    for (const expected of [
      'fn__Type/returns__struct/field__label',
      'fn__Type/returns__struct/field__close',
      'fn__Type/returns__struct/fn__run',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
  });
});
