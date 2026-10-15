#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `.kts` is deliberately absent: the CLI parses it, but auto-discovery would
// sweep in build.gradle.kts / settings.gradle.kts, whose Gradle DSL is mostly
// configuration lambdas and adds noise rather than topology. List it in a
// config's sourceFiles to map it on purpose.
const SUPPORTED_EXTENSIONS = new Set([
  '.cc', '.cpp', '.cu', '.cuh', '.cxx', '.h', '.hpp', '.java', '.js', '.jsx',
  '.cjs', '.kt', '.m', '.metal', '.mjs', '.mm', '.ptx', '.py', '.rb', '.ts',
  '.tsx', '.zig',
]);

const IGNORED_DIRECTORIES = new Set([
  '.cache', '.git', '.next', '.nuxt', '.quarkify', '.venv', 'DerivedData', 'Pods',
  '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target', 'vendor', 'venv',
]);

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Quarkify requires Node.js 22.12.0 or newer; found ${process.versions.node}`);
  }
}

async function assertDirectory(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${directory}`);
}

async function rejectSymlink(target) {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`Refusing to use a symbolic link for Quarkify output: ${target}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function discoverSourceFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
        continue;
      }
      if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.relative(root, absolutePath).split(path.sep).join('/'));
      }
    }
  }

  await visit(root);
  return files;
}

function extensionCounts(files) {
  return Object.fromEntries(
    [...files.reduce((counts, file) => {
      const extension = path.posix.extname(file);
      counts.set(extension, (counts.get(extension) || 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function safeProjectName(root) {
  return path.basename(root).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'project';
}

export async function analyze(projectRoot = process.cwd()) {
  assertSupportedNode();
  const root = await realpath(path.resolve(projectRoot));
  await assertDirectory(root);

  const sourceFiles = await discoverSourceFiles(root);
  if (sourceFiles.length === 0) {
    throw new Error(`No supported source files found in ${root}`);
  }

  const outputRoot = path.join(root, '.quarkify');
  const outputDir = path.join(outputRoot, 'output');
  await rejectSymlink(outputRoot);
  await rejectSymlink(outputDir);
  await mkdir(outputRoot, { recursive: true });
  try {
    await writeFile(path.join(outputRoot, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'quarkify-plugin-'));
  const configPath = path.join(temporaryDirectory, 'config.json');
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const cliPath = path.join(pluginRoot, 'quarkify.mjs');
  const config = JSON.stringify({
    name: safeProjectName(root),
    srcDir: root,
    outDir: outputDir,
    sourceFiles,
    perfData: {},
  }, null, 2);

  try {
    await writeFile(configPath, config, { encoding: 'utf8', mode: 0o600 });
    const result = spawnSync(process.execPath, [cliPath, configPath], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    if (result.status !== 0) return null;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  return {
    projectRoot: root,
    sourceFiles: sourceFiles.length,
    extensions: extensionCounts(sourceFiles),
    outputDir,
    viewer: path.join(outputDir, 'index.html'),
    guide: path.join(outputDir, 'ai_context_guide.txt'),
  };
}

async function main() {
  const result = await analyze(process.argv[2]);
  if (result) console.log(`QUARKIFY_RESULT ${JSON.stringify(result)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`Quarkify plugin error: ${error.message}`);
    process.exitCode = 1;
  });
}
