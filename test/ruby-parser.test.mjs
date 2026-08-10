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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-ruby-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnRuby(workspace, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'sample.rb'), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'ruby-check',
    srcDir,
    outDir,
    sourceFiles: ['sample.rb'],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', 'file__sample.rb') };
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

test('class, module and method nesting becomes a folder tree', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'module Billing',
      '  class Invoice',
      '    def total',
      '      @lines.sum',
      '    end',
      '',
      '    def self.build(rows)',
      '      new(rows)',
      '    end',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('module__Billing'), entries.join('\n'));
    assert.ok(entries.includes('module__Billing/class__Invoice'), entries.join('\n'));
    assert.ok(entries.includes('module__Billing/class__Invoice/fn__total'), entries.join('\n'));
    assert.ok(entries.includes('module__Billing/class__Invoice/fn__build'), entries.join('\n'));
  });
});

// safeName() maps ?, ! and = all to `_`, so without suffix encoding these
// three distinct methods would silently merge into a single `valid_` folder.
test('predicate, bang and setter methods stay distinct', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Record',
      '  def valid?',
      '    true',
      '  end',
      '  def valid!',
      '    raise unless valid?',
      '  end',
      '  def valid=(flag)',
      '    @valid = flag',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Record/fn__valid__q'), entries.join('\n'));
    assert.ok(entries.includes('class__Record/fn__valid__bang'), entries.join('\n'));
    assert.ok(entries.includes('class__Record/fn__valid__eq'), entries.join('\n'));
  });
});

// Trap 1: `return x if y` opens no block. A naive `end` counter that treats
// every `if` as an opener runs one level deep for the rest of the file.
test('modifier if does not open a block', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Guard',
      '  def check(x)',
      '    return nil if x.nil?',
      '    x.to_s unless x.frozen?',
      '  end',
      '  def after',
      '    :ok',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Guard/fn__check'), entries.join('\n'));
    assert.ok(entries.includes('class__Guard/fn__after'), entries.join('\n'));
  });
});

// Trap 3: a heredoc body may contain a bare `end`; it must not be counted.
test('heredoc body does not move block depth', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Report',
      '  def sql',
      '    <<~SQL',
      '      select * from t',
      '      end',
      '      def not_a_method',
      '    SQL',
      '  end',
      '  def title',
      '    "x"',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Report/fn__sql'), entries.join('\n'));
    assert.ok(entries.includes('class__Report/fn__title'), entries.join('\n'));
    assert.ok(!entries.some((e) => e.includes('fn__not_a_method')), entries.join('\n'));
  });
});

// Trap 4: an endless method has no `end`. Consuming one would close its class.
test('endless method definitions are leaves', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Point',
      '  def x = @x',
      '  def scaled(k) = @x * k',
      '  def label',
      '    "p"',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Point/fn__x'), entries.join('\n'));
    assert.ok(entries.includes('class__Point/fn__scaled'), entries.join('\n'));
    assert.ok(entries.includes('class__Point/fn__label'), entries.join('\n'));
  });
});

// Trap 5: =begin/=end may wrap anything, including a fake def.
test('=begin block comments are skipped whole', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      '=begin',
      'def commented_out',
      'end',
      '=end',
      'class Live',
      '  def real',
      '    1',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Live/fn__real'), entries.join('\n'));
    assert.ok(!entries.some((e) => e.includes('commented_out')), entries.join('\n'));
  });
});

test('control flow inside a method is decomposed into statement folders', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Router',
      '  def dispatch(code)',
      '    case code',
      '    when 200',
      '      :ok',
      '    else',
      '      :err',
      '    end',
      '  rescue StandardError',
      '    :boom',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    const inFn = entries.filter((e) => e.startsWith('class__Router/fn__dispatch/'));
    assert.ok(inFn.some((e) => e.endsWith('__case')), inFn.join('\n'));
    assert.ok(inFn.some((e) => e.endsWith('__when')), inFn.join('\n'));
    assert.ok(inFn.some((e) => e.endsWith('__else')), inFn.join('\n'));
    assert.ok(inFn.some((e) => e.endsWith('__rescue')), inFn.join('\n'));
  });
});

// Class-body macros are the Ruby twin of a Spring annotation, and are what
// makes the by_role mirror useful for a Rails app.
test('class body DSL macros become annotation folders', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Post',
      '  has_many :comments',
      '  has_many :tags',
      '  validates :title, presence: true',
      '  private',
      '',
      '  def slug',
      '    puts :not_a_macro',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Post/annotation__has_many'), entries.join('\n'));
    assert.ok(entries.includes('class__Post/annotation__validates'), entries.join('\n'));
    assert.ok(entries.includes('class__Post/annotation__private'), entries.join('\n'));
    assert.ok(entries.some((e) => e.startsWith('class__Post/annotation__has_many/arg__')), entries.join('\n'));
    // A repeated macro keeps its own folder instead of merging into the first.
    assert.ok(entries.includes('class__Post/annotation__has_many__2'), entries.join('\n'));
    assert.ok(entries.some((e) => e.startsWith('class__Post/annotation__has_many__2/arg__0___tags')), entries.join('\n'));
    // A bare call inside a method body is a call, not a macro.
    assert.ok(!entries.some((e) => e.includes('fn__slug/annotation__puts')), entries.join('\n'));
  });
});

// `x = case env`, `a || if b`, `foo(if c … end)` all open a real block. Missing
// one means the closing `end` is counted with nothing open, and the class it
// was written in closes early.
test('if/case in a value position opens a block', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Config',
      '  def self.base_url',
      '    ENV["URL"].presence || case Rails.env',
      '                           when "production"',
      '                             "https://prod"',
      '                           else',
      '                             "http://localhost"',
      '                           end',
      '  end',
      '',
      '  def self.alerting?(status, ms)',
      '    status >= 500 ||',
      '      (if status == 404',
      '         ms >= 200',
      '       else',
      '         false',
      '       end)',
      '  end',
      '',
      '  def self.tail',
      '    :still_parsed',
      '  end',
      'end',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const entries = await listRelativeEntries(fileQuark);
    // The tail method must still be inside the class, not orphaned at file level.
    assert.ok(entries.includes('class__Config/fn__tail'), entries.join('\n'));
    assert.ok(entries.includes('class__Config/fn__alerting__q'), entries.join('\n'));
  });
});

// No block-depth heuristic is perfect, so an unmatched `end` must degrade to a
// local mis-nesting rather than discarding every symbol below it.
test('an unmatched end does not discard the rest of the file', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnRuby(workspace, [
      'class Broken',
      '  def first',
      '    1',
      '  end',
      'end',
      'end',
      '',
      'class Later',
      '  def survivor',
      '    2',
      '  end',
      'end',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('class__Broken/fn__first'), entries.join('\n'));
    assert.ok(entries.includes('class__Later/fn__survivor'), entries.join('\n'));
  });
});

test('a Ruby file reaches full symbol coverage under --strict-coverage', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result } = await runOnRuby(workspace, [
      'module Api',
      '  class Client',
      '    def initialize(host)',
      '      @host = host',
      '    end',
      '',
      '    def get(path)',
      '      items.each do |i|',
      '        next if i.nil?',
      '      end',
      '    end',
      '',
      '    def ok? = true',
      '    def reset!',
      '      @host = nil',
      '    end',
      '    def host=(value)',
      '      @host = value',
      '    end',
      '',
      '    def self.default',
      '      new("localhost")',
      '    end',
      '  end',
      'end',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /6\/6 \(100\.0%\)/);
  });
});
