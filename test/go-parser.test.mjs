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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-go-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOnGo(workspace, source, extraArgs = []) {
  const srcDir = path.join(workspace, 'src');
  const outDir = path.join(workspace, 'out');
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, 'sample.go'), source, 'utf8');

  const configPath = path.join(workspace, 'config.json');
  await writeFile(configPath, JSON.stringify({
    name: 'go-check',
    srcDir,
    outDir,
    sourceFiles: ['sample.go'],
    perfData: {},
  }), 'utf8');

  const result = spawnSync(process.execPath, [cliPath, ...extraArgs, configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { result, fileQuark: path.join(outDir, 'quark', 'file__sample.go') };
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

async function topLevel(fileQuark) {
  return (await readdir(fileQuark)).sort();
}

test('functions, generic functions and receiver methods become fn folders', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package stack',
      '',
      'func New[T any]() *Stack[T] { return &Stack[T]{} }',
      '',
      'func Map[K comparable, V any](m map[K]V, f func(V) V) map[K]V {',
      '\treturn m',
      '}',
      '',
      'func Keys[M ~map[K]V, K comparable, V any](m M) []K { return nil }',
      '',
      'func (s *Stack[T]) Push(v T) {',
      '\ts.items = append(s.items, v)',
      '}',
      '',
      'func (Stack[T]) Len() int { return 0 }',
      '',
      'func (p Pair[K, V]) Key() K { return p.k }',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /6\/6 \(100\.0%\)/);
    assert.deepEqual(await topLevel(fileQuark), [
      'fn__Keys', 'fn__Map', 'fn__New', 'fn__Pair__Key', 'fn__Stack__Len', 'fn__Stack__Push',
    ]);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('fn__Stack__Push/stmt_0__expr/call__append'), entries.join('\n'));
  });
});

// Two types defining String() in one file is idiomatic Go. mkdir is recursive,
// so a bare fn__String folder would silently merge both bodies into one node.
test('the same method name on different receivers keeps distinct nodes', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package color',
      '',
      'func (c Color) String() string { return colorName(c) }',
      'func (s Shade) String() string { return shadeName(s) }',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('fn__Color__String/stmt_0__return/call__colorName'), entries.join('\n'));
    assert.ok(entries.includes('fn__Shade__String/stmt_0__return/call__shadeName'), entries.join('\n'));
    assert.ok(!entries.some((e) => e.startsWith('fn__String')), entries.join('\n'));
  });
});

test('repeated init and blank declarations do not merge into one folder', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package main',
      '',
      'var _ io.Reader = (*File)(nil)',
      'var _ io.Writer = (*File)(nil)',
      '',
      'func init() { registerA() }',
      'func init() { registerB() }',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('fn__init/stmt_0__expr/call__registerA'), entries.join('\n'));
    assert.ok(entries.includes('fn__init__2/stmt_0__expr/call__registerB'), entries.join('\n'));
    assert.ok(!entries.includes('fn__init/stmt_0__expr/call__registerB'), entries.join('\n'));
    assert.ok(entries.includes('var___/type__io.Reader'), entries.join('\n'));
    assert.ok(entries.includes('var_____2/type__io.Writer'), entries.join('\n'));
  });
});

// In Go case is visibility, so `Execute` beside `execute` is common. On a
// case-insensitive filesystem (macOS, Windows) those are one folder, and mkdir
// would silently merge the two bodies.
test('names differing only by case keep distinct nodes on any filesystem', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package cli',
      '',
      'func (c *Command) Execute() error { return c.execute() }',
      'func (c *Command) execute() error { return runPublic() }',
      'func Unique() {}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3\/3 \(100\.0%\)/);
    const top = await topLevel(fileQuark);
    assert.equal(top.length, 3, top.join('\n'));
    assert.ok(top.includes('fn__Unique'), top.join('\n'));
    const upper = top.find((e) => /^fn__Command__Execute__[0-9a-f]{8}$/.test(e));
    const lower = top.find((e) => /^fn__Command__execute__[0-9a-f]{8}$/.test(e));
    assert.ok(upper && lower, top.join('\n'));
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes(`${upper}/stmt_0__return/call__execute`), entries.join('\n'));
    assert.ok(entries.includes(`${lower}/stmt_0__return/call__runPublic`), entries.join('\n'));
    assert.ok(!entries.includes(`${upper}/stmt_0__return/call__runPublic`), entries.join('\n'));
  });
});

test('struct fields cover multi-name, embedded and tagged fields', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package model',
      '',
      'type User struct {',
      '\tsync.Mutex',
      '\t*Base',
      '\tID, Version int64',
      '\tName string `json:"name,omitempty"`',
      '\tMeta struct {',
      '\t\tInnerOnly bool',
      '\t}',
      '}',
      '',
      'type Point struct{ X, Y float64 }',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    for (const expected of [
      'struct__User/embed__Mutex/type__sync.Mutex',
      'struct__User/embed__Base',
      'struct__User/field__ID/type__int64',
      'struct__User/field__Version/type__int64',
      'struct__User/field__Name/type__string',
      'struct__User/field__Meta/type__struct',
      'struct__Point/field__X/type__float64',
      'struct__Point/field__Y/type__float64',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
    // A nested anonymous struct's member belongs to Meta's type, not to User.
    assert.ok(!entries.some((e) => e.includes('InnerOnly')), entries.join('\n'));
    // Go zero-initializes every field, so the uninit hazard marker would be false.
    assert.ok(!entries.some((e) => e.includes('uninit_hazard')), entries.join('\n'));
  });
});

test('interfaces list their methods and embedded interfaces', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package store',
      '',
      'type Repository interface {',
      '\tio.Closer',
      '\tGet(ctx context.Context, id string) (*User, error)',
      '\tList(ctx context.Context) ([]*User, error)',
      '}',
      '',
      'type Number interface {',
      '\t~int | ~float64',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(fileQuark);
    assert.ok(entries.includes('interface__Repository/embed__io.Closer'), entries.join('\n'));
    assert.ok(entries.includes('interface__Repository/method__Get'), entries.join('\n'));
    assert.ok(entries.includes('interface__Repository/method__List'), entries.join('\n'));
    assert.deepEqual(entries.filter((e) => e.startsWith('interface__Number/')), []);
  });
});

test('grouped and single-line declarations each get their own node', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package config',
      '',
      'import (',
      '\t"fmt"',
      '\t"os"',
      ')',
      '',
      'const Version = "1.2.0"',
      'var retries = 3',
      '',
      'const (',
      '\tLow Level = iota',
      '\tMid',
      '\tHigh',
      ')',
      '',
      'var (',
      '\thost, port = "localhost", 8080',
      '\ttimeout time.Duration',
      ')',
      '',
      'type (',
      '\tLevel int',
      '\tAlias = Level',
      '\tOptions struct {',
      '\t\tVerbose bool',
      '\t}',
      ')',
      '',
      'func Load() error { return nil }',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await topLevel(fileQuark), [
      'const__High', 'const__Low', 'const__Mid', 'const__Version',
      'fn__Load',
      'struct__Options',
      'type__Alias', 'type__Level',
      'var__host', 'var__port', 'var__retries', 'var__timeout',
    ]);
    const entries = await listRelativeEntries(fileQuark);
    for (const expected of [
      'const__Low/type__Level',
      'const__Low/default__iota',
      'const__Version/default__redacted_literal',
      'var__retries/default__3',
      'var__port/default__8080',
      'var__timeout/type__time.Duration',
      'type__Level/underlying__int',
      'type__Alias/alias__Level',
      'struct__Options/field__Verbose/type__bool',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
  });
});

// Go allows specs on a group's `(` and `)` lines, and `;` between specs on one
// line. Reading only the lines strictly between them dropped `var ( a = 1; b = 2 )`
// entirely, and the first/last spec of a group that shares its delimiter lines.
// The coverage scan covers functions only, so --strict-coverage passed anyway.
test('specs on a group\'s delimiter lines and after `;` are not dropped', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package p',
      'var ( a = 1; b = 2 )',
      'const (Alpha = 1',
      '\tBeta = 2',
      '\tGamma = 3)',
      'type ( ID string; Name = ID )',
      'func f() {}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await topLevel(fileQuark), [
      'const__Alpha', 'const__Beta', 'const__Gamma',
      'fn__f',
      'type__ID', 'type__Name',
      'var__a', 'var__b',
    ]);
    const entries = await listRelativeEntries(fileQuark);
    for (const expected of ['var__a/default__1', 'var__b/default__2', 'const__Gamma/default__3', 'type__Name/alias__ID']) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
  });
});

// There is no `;` to end a Go declaration. A single-line var that waited for
// one would swallow every declaration after it.
test('a single-line var or const does not swallow the next function', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package main',
      'var counter int',
      'const name = "svc"',
      'func first() { step() }',
      'var total = sum(1,',
      '\t2)',
      'func second() {}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await topLevel(fileQuark), [
      'const__name', 'fn__first', 'fn__second', 'var__counter', 'var__total',
    ]);
  });
});

// A local variable is not a field and not a package-level var.
test('function-local variables are not materialized as declarations', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package calc',
      '',
      'type Calculator struct {',
      '\tprecision int',
      '}',
      '',
      'func (c *Calculator) Run() int {',
      '\tlocalShort := 2',
      '\tvar localLong int = 3',
      '\ttype localType struct{ hidden int }',
      '\treturn localShort + localLong',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await topLevel(fileQuark), ['fn__Calculator__Run', 'struct__Calculator']);
    const entries = await listRelativeEntries(fileQuark);
    assert.deepEqual(entries.filter((e) => e.startsWith('struct__Calculator/')), [
      'struct__Calculator/field__precision',
      'struct__Calculator/field__precision/type__int',
    ]);
    assert.ok(!entries.some((e) => /field__(localShort|localLong|hidden)/.test(e)), entries.join('\n'));
  });
});

// Braces inside a raw string, rune or comment must not move declaration
// boundaries, and a `func` inside one is not a symbol.
test('braces and func keywords inside literals and comments are ignored', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package tmpl',
      '',
      'const page = `',
      '{{ range .Items }}',
      'func fakeInRaw() {',
      '`',
      '',
      '/*',
      'func fakeInBlock() {',
      '*/',
      '',
      '// func fakeInLine() {',
      '',
      'func Open() rune {',
      "\tr := '{'",
      '\ts := "}{ func fakeInString() {"',
      '\t_ = s',
      '\treturn r',
      '}',
      '',
      'func Close() {}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
    assert.deepEqual(await topLevel(fileQuark), ['const__page', 'fn__Close', 'fn__Open']);
  });
});

// The audit's scan is deliberately not the parser's walk. When the parser
// loses declarations — here to an unclosed brace swallowing the rest of the
// file — the scan still sees them, and --strict-coverage must fail.
test('declarations the parser loses are reported and fail --strict-coverage', async () => {
  await withTempWorkspace(async (workspace) => {
    const source = [
      'package broken',
      '',
      'func unclosed() {',
      '\tif ready {',
      '}',
      '',
      'func (s *Server) Lost() {}',
      'func alsoLost[T any]() {}',
      '',
    ].join('\n');

    const report = await runOnGo(workspace, source);
    assert.equal(report.result.status, 0, report.result.stderr);
    assert.match(report.result.stdout, /1\/3 \(33\.3%\)/);

    const strict = await runOnGo(workspace, source, ['--strict-coverage']);
    assert.notEqual(strict.result.status, 0);
    assert.match(`${strict.result.stdout}${strict.result.stderr}`, /Lost/);
    assert.match(`${strict.result.stdout}${strict.result.stderr}`, /alsoLost/);
  });
});

// A func literal can start a line (an argument on its own line). If it returns
// a map or a generic type, `func() map[` looks like a declaration of `map`;
// the parser rightly creates no such function, so the scan must not expect one.
test('a func literal that starts a line is not expected as a declaration', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package opt',
      '',
      'type Option[T any] struct{ v T }',
      '',
      'func Find[T any](items []T) Option[T] {',
      '\tpick := apply(',
      '\t\tfunc() Option[T] {',
      '\t\t\treturn Option[T]{}',
      '\t\t},',
      '\t)',
      '\tcounts := build(',
      '\t\tfunc(n int) map[string]int {',
      '\t\t\treturn nil',
      '\t\t},',
      '\t)',
      '\t_, _ = pick, counts',
      '\treturn Option[T]{}',
      '}',
      '',
      'func (s *Store) Load(key string) int { return 0 }',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /2\/2 \(100\.0%\)/);
    assert.deepEqual(await topLevel(fileQuark), ['fn__Find', 'fn__Store__Load', 'struct__Option']);
  });
});

// A line that ends in a comparison or shift continues, like any other binary
// operator: `ok := a >` and `b` are one statement.
test('a statement broken after a comparison stays one statement', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package cmp',
      '',
      'func Big(a, b int) bool {',
      '\tok := a >',
      '\t\tb',
      '\tmask := a <<',
      '\t\t2',
      '\treturn ok && mask > 0',
      '}',
      '',
    ].join('\n'));

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(path.join(fileQuark, 'fn__Big'));
    assert.deepEqual(entries.filter((e) => !e.includes('/')), ['stmt_0__expr', 'stmt_1__expr', 'stmt_2__return']);
  });
});

// A Go statement ends at a newline. Splitting bodies on `;{}` fused a line
// into the `if` below it, so the `if` vanished and every `return` merged into
// one folder.
test('each line of a function body is its own statement node', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package find',
      '',
      'func Find(args []string) (string, error) {',
      '\trest := strip(args)',
      '\tif len(rest) == 0 {',
      '\t\treturn first, nil',
      '\t}',
      '\treturn last, nil',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(path.join(fileQuark, 'fn__Find'));
    assert.deepEqual(entries.filter((e) => !e.includes('/')), ['stmt_0__expr', 'stmt_1__if', 'stmt_2__return']);
    for (const expected of [
      'stmt_0__expr/call__strip',
      'stmt_1__if/cond___len_rest_____0',
      'stmt_1__if/body/stmt_0__return/val___first__nil',
      'stmt_2__return/val___last__nil',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
  });
});

test('if, for, switch and select headers are split into their clauses', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package flow',
      '',
      'func Flow(m map[string]int, ch chan int) (total int) {',
      '\tif err := load(); err != nil {',
      '\t\tfail(err)',
      '\t} else if total > 10 {',
      '\t\ttotal = 10',
      '\t} else {',
      '\t\ttotal++',
      '\t}',
      '\tfor i := 0; i < 3; i++ {',
      '\t\ttotal += i',
      '\t}',
      '\tfor k, v := range m {',
      '\t\tuse(k, v)',
      '\t}',
      '\tfor _, n := range []int{1, 2} {',
      '\t\ttotal += n',
      '\t}',
      '\tfor total < 100 {',
      '\t\ttotal *= 2',
      '\t}',
      '\tswitch x := pick(); x {',
      '\tcase 1, 2:',
      '\t\tone()',
      '\tdefault:',
      '\t\tother()',
      '\t}',
      '\tselect {',
      '\tcase n := <-ch:',
      '\t\ttotal += n',
      '\t}',
      '\treturn total',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(path.join(fileQuark, 'fn__Flow'));
    assert.deepEqual(entries.filter((e) => !e.includes('/')), [
      'stmt_0__if', 'stmt_1__else_if', 'stmt_2__else', 'stmt_3__for', 'stmt_4__for',
      'stmt_5__for', 'stmt_6__for', 'stmt_7__switch', 'stmt_8__select', 'stmt_9__return',
    ].sort());
    for (const expected of [
      'stmt_0__if/init___err____load__',
      'stmt_0__if/cond___err____nil',
      'stmt_0__if/call__load',
      'stmt_0__if/body/stmt_0__expr/call__fail',
      'stmt_1__else_if/cond___total___10',
      'stmt_2__else/body/stmt_0__expr',
      'stmt_3__for/init___i____0',
      'stmt_3__for/cond___i___3',
      'stmt_3__for/post___i__',
      'stmt_4__for/vars___k__v',
      'stmt_4__for/range___m',
      'stmt_4__for/body/stmt_0__expr/call__use',
      // a composite literal in the header is not the loop's block
      'stmt_5__for/range_____int_1__2_',
      'stmt_5__for/body/stmt_0__expr',
      'stmt_6__for/cond___total___100',
      'stmt_7__switch/init___x____pick__',
      'stmt_7__switch/tag___x',
      'stmt_7__switch/body/stmt_0__case/value___1__2',
      'stmt_7__switch/body/stmt_0__case/body/stmt_0__expr/call__one',
      'stmt_7__switch/body/stmt_1__default/body/stmt_0__expr/call__other',
      'stmt_8__select/body/stmt_0__case/value___n______ch',
      'stmt_9__return/val___total',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
  });
});

// A closure's statements belong to the closure, and a multi-line composite
// literal is one statement.
test('func literals get their own body and multi-line literals stay whole', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package async',
      '',
      'func Start(t *testing.T) {',
      '\tvar handler func(int) error',
      '\tcfg := Config{',
      '\t\tName: name,',
      '\t\tPort: port(),',
      '\t}',
      '\tgo func() {',
      '\t\twork(cfg)',
      '\t}()',
      '\tt.Run(label, func(t *testing.T) {',
      '\t\tif !check() {',
      '\t\t\tt.Fail()',
      '\t\t}',
      '\t})',
      '\tdefer cleanup()',
      '}',
      '',
      'func Save(db *DB) {',
      '\tif err := db.Update(func(tx *Tx) error {',
      '\t\treturn tx.Put(key)',
      '\t}); err != nil {',
      '\t\tpanic(err)',
      '\t}',
      '}',
      '',
      'var formatter = func(p Params) string {',
      '\tif p.Color() {',
      '\t\treturn colored(p)',
      '\t}',
      '\treturn plain(p)',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    const entries = await listRelativeEntries(path.join(fileQuark, 'fn__Start'));
    assert.deepEqual(entries.filter((e) => !e.includes('/')), [
      'stmt_0__expr', 'stmt_1__expr', 'stmt_2__go', 'stmt_3__expr', 'stmt_4__defer',
    ]);
    for (const expected of [
      'stmt_1__expr/call__port',
      'stmt_2__go/body/stmt_0__func_lit/body/stmt_0__expr/call__work',
      'stmt_3__expr/call__Run',
      'stmt_3__expr/body/stmt_0__func_lit/body/stmt_0__if/call__check',
      'stmt_3__expr/body/stmt_0__func_lit/body/stmt_0__if/body/stmt_0__expr/call__Fail',
      'stmt_4__defer/call__cleanup',
    ]) {
      assert.ok(entries.includes(expected), `${expected} missing:\n${entries.join('\n')}`);
    }
    // `func` in a func type or a cut literal is not a call, and a closure's
    // calls are not credited to the statement that holds it.
    assert.ok(!entries.some((e) => /call__(func|go)$/.test(e)), entries.join('\n'));
    assert.ok(!entries.includes('stmt_3__expr/call__check'), entries.join('\n'));

    // A literal in an if header goes under header/, not into the if's block.
    const save = await listRelativeEntries(path.join(fileQuark, 'fn__Save'));
    for (const expected of [
      'stmt_0__if/call__Update',
      'stmt_0__if/cond___err____nil',
      'stmt_0__if/header/stmt_0__func_lit/body/stmt_0__return/call__Put',
      'stmt_0__if/body/stmt_0__expr/call__panic',
    ]) {
      assert.ok(save.includes(expected), `${expected} missing:\n${save.join('\n')}`);
    }
    assert.ok(!save.includes('stmt_0__if/call__Put'), save.join('\n'));

    // A package-level func value's body is materialized like a function's.
    const formatter = await listRelativeEntries(path.join(fileQuark, 'var__formatter'));
    for (const expected of [
      'stmt_0__func_lit/body/stmt_0__if/cond___p.Color__',
      'stmt_0__func_lit/body/stmt_0__if/body/stmt_0__return/call__colored',
      'stmt_0__func_lit/body/stmt_1__return/call__plain',
    ]) {
      assert.ok(formatter.includes(expected), `${expected} missing:\n${formatter.join('\n')}`);
    }
  });
});

// `func 인사()` is valid Go. safeName() flattens both `인사` and `안녕` to the
// same `__`, so without disambiguation their bodies would merge into one folder.
// The assertions read bodies, not folder spellings, so they hold however
// safeName() treats non-ASCII.
test('non-ASCII identifiers are parsed and never merge', async () => {
  await withTempWorkspace(async (workspace) => {
    const { result, fileQuark } = await runOnGo(workspace, [
      'package 인사말',
      '',
      'type 고객 struct {',
      '\t이름 string',
      '\t나이 int',
      '}',
      '',
      'func 인사() { alpha() }',
      'func 안녕() { beta() }',
      'func (c 고객) 소개() string { return gamma(c) }',
      '',
      'func Run() {',
      '\tgo인사 := 1',
      '\t_ = go인사',
      '}',
      '',
    ].join('\n'), ['--strict-coverage']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /4\/4 \(100\.0%\)/);
    const top = await topLevel(fileQuark);
    assert.equal(top.filter((e) => e.startsWith('fn__')).length, 4, top.join('\n'));
    assert.equal(top.filter((e) => e.startsWith('struct__')).length, 1, top.join('\n'));

    const entries = await listRelativeEntries(fileQuark);
    for (const call of ['alpha', 'beta', 'gamma']) {
      const owners = entries.filter((e) => e.endsWith(`/call__${call}`));
      assert.equal(owners.length, 1, `${call}:\n${entries.join('\n')}`);
    }
    const alphaFn = entries.find((e) => e.endsWith('/call__alpha')).split('/')[0];
    assert.ok(!entries.includes(`${alphaFn}/stmt_0__expr/call__beta`), entries.join('\n'));
    // Two non-ASCII fields are two nodes, not one.
    assert.equal(entries.filter((e) => /^struct__[^/]+\/(field|embed)__[^/]+$/.test(e)).length, 2, entries.join('\n'));
    // `go인사 := 1` is an assignment to an identifier, not a go statement.
    assert.ok(entries.includes('fn__Run/stmt_0__expr'), entries.join('\n'));
  });
});
