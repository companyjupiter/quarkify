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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-objc-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnObjC(workspace, source) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'Sample.m'), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'objc-check',
    srcDir,
    outDir,
    sourceFiles: ['Sample.m'],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', 'file__Sample.m') };
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

const methodFolders = (entries) => entries.filter((rel) => path.posix.basename(rel).startsWith('objc_method__'));

test('selectors that share a first keyword stay separate methods', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnObjC(workspace, [
      '@implementation Store',
      '- (void)setValue:(id)value {',
      '}',
      '- (void)setValue:(id)value forKey:(NSString *)key {',
      '}',
      '- (id)value {',
      '  return nil;',
      '}',
      '@end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(methodFolders(await listRelativeEntries(fileQuark)).sort(), [
      'objc_implementation__Store/objc_method__setValue_',
      'objc_implementation__Store/objc_method__setValue_forKey_',
      'objc_implementation__Store/objc_method__value',
    ]);
  });
});

test('two classes in one file keep their own init', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnObjC(workspace, [
      '@implementation Parser',
      '- (instancetype)init {',
      '  return self;',
      '}',
      '@end',
      '',
      '@implementation Lexer',
      '- (instancetype)init {',
      '  return self;',
      '}',
      '@end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(methodFolders(await listRelativeEntries(fileQuark)).sort(), [
      'objc_implementation__Lexer/objc_method__init',
      'objc_implementation__Parser/objc_method__init',
    ]);
  });
});

test('a class extension, a category and a forward protocol declaration', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnObjC(workspace, [
      '@protocol Loader;',
      '',
      '@interface Cache ()',
      '- (void)evict;',
      '@end',
      '',
      '@interface Cache (Stats)',
      '- (NSUInteger)hitCount;',
      '@end',
      '',
      '@implementation Cache',
      '- (void)evict {',
      '}',
      '@end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(!entries.some((rel) => rel.startsWith('objc_protocol__')), 'a forward @protocol declaration is not a protocol body');
    assert.deepEqual(methodFolders(entries).sort(), [
      'objc_implementation__Cache/objc_method__evict',
      'objc_interface__Cache/objc_method__evict',
      'objc_interface__Cache_Stats/objc_method__hitCount',
    ]);
  });
});

test('categories on generic classes and multi-name forward protocols', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnObjC(workspace, [
      '@protocol Loader, Saver;',
      '',
      '@protocol Plugin <NSObject>',
      '- (void)load;',
      '@end',
      '',
      '@interface NSArray<ObjectType> (Functional)',
      '- (NSArray *)mapWith:(id (^)(ObjectType obj))block;',
      '@end',
      '',
      '@interface Box<__covariant ObjectType : id<NSCopying>> (Sorting)',
      '- (void)sort;',
      '@end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(!entries.some((rel) => /^objc_protocol__(Loader|Saver)/.test(rel)), entries.join('\n'));
    assert.deepEqual(methodFolders(entries).sort(), [
      'objc_interface__Box_Sorting/objc_method__sort',
      'objc_interface__NSArray_Functional/objc_method__mapWith_',
      'objc_protocol__Plugin/objc_method__load',
    ]);
  });
});

test('wrapped selectors and block-typed parameters keep every keyword', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnObjC(workspace, [
      '@implementation Client',
      '- (void)fetchURL:(NSURL *)url',
      '         timeout:(NSTimeInterval)timeout',
      '      completion:(void (^)(NSData *data, NSError *error))completion {',
      '}',
      '+ (instancetype)clientWithBase:(NSURL *)base :(int)retries {',
      '  return nil;',
      '}',
      '@end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(methodFolders(await listRelativeEntries(fileQuark)).sort(), [
      'objc_implementation__Client/objc_method__clientWithBase__',
      'objc_implementation__Client/objc_method__fetchURL_timeout_completion_',
    ]);
  });
});
