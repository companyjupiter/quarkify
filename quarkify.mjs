#!/usr/bin/env node
/**
 * 쿼크화(Quarkify) v1.0.1 — Generic config-driven engine (Quarkify v1.0.1 — Generic config-driven engine)
 *
 * Copyright 2026 teamjupiter
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * v3.1 의 모든 분해 로직을 보존하면서, 프로젝트별 정보(SRC_DIR / OUTPUT_DIR /
 * SOURCE_FILES / PERF_DATA / role classifier)를 외부 config 파일로 분리. (Preserving all decomposition logic from v3.1, while separating project-specific information (SRC_DIR / OUTPUT_DIR / SOURCE_FILES / PERF_DATA / role classifier) into external config files.)
 *
 * 사용법 (Usage):
 *   node quarkify.mjs configs/project.json
 *   node quarkify.mjs --allow-executable-config configs/trusted_project.mjs
 *
 * Config 인터페이스 (Config Interface) (configs/*.mjs):
 *   export default {
 *     name:         'sovereign-cuda-llama3',
 *     srcDir:       '/abs/path/to/source/root',
 *     outDir:       '/abs/path/to/quark/output',
 *     sourceFiles:  ['rel/path/file.ext', ...],
 *     perfData:     { 'kernel_name': { dram_pct: 73.9, sm_pct: 86.9, ... } },
 *     guessRole:    (name: string) => string,   // project-specific role map
 *   };
 *
 * v3.1 대비 v4 변경점 (Changes in v4 compared to v3.1):
 *   1. SRC_DIR / OUTPUT_DIR / SOURCE_FILES / PERF_DATA / guessRole 모두 config 로 이동 (All moved to config)
 *   2. Metal `.metal` (MSL) 파서 강화 (Enhanced Metal .metal (MSL) parser) — kernel void / device / threadgroup /
 *      constant storage qualifier 인식 (recognizing qualifiers), [[buffer(N)]] attribute 추출 (extracting attributes),
 *      함수 본문 재귀 파싱 (recursive parsing of function body) (Zig fn parser 와 동일 트릭 - same trick as Zig fn parser)
 *   3. Objective-C `.m` / `.mm` 기본 파싱 (Basic parsing of Objective-C .m / .mm) (interface / implementation / @-decl)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { execSync } from 'child_process';

// ─── CLI / 컨피그 로드 (Load CLI / Config) ───
const cli = parseCliArgs(process.argv.slice(2));
const configPath = cli.configPath;
const STRICT_COVERAGE = cli.strictCoverage;
if (!configPath) {
  console.error('❌ 에러: 설정 파일 경로가 제공되지 않았습니다.');
  console.error('사용법: node quarkify.mjs [--allow-executable-config] [--strict-coverage] <configs/config_name.json|mjs>');
  process.exit(1);
}
if (!fs.existsSync(configPath)) {
  console.error(`❌ 에러: 지정한 설정 파일을 찾을 수 없습니다: "${configPath}"`);
  process.exit(1);
}
const cfgAbs = path.resolve(configPath);
if (!fs.existsSync(cfgAbs)) {
  console.error(`Config not found: ${cfgAbs}`);
  process.exit(1);
}

let CONFIG;
try {
  CONFIG = validateConfig(await loadConfig(cfgAbs, cli.allowExecutableConfig));
} catch (err) {
  console.error(`❌ 에러: 설정 파일을 불러오는 중 오류가 발생했습니다:`, err.message);
  process.exit(1);
}

// ─── 유틸 (Utils) ───
function parseCliArgs(args) {
  let allowExecutableConfig = false;
  let strictCoverage = false;
  const positional = [];
  for (const arg of args) {
    if (arg === '--allow-executable-config') {
      allowExecutableConfig = true;
    } else if (arg === '--strict-coverage') {
      strictCoverage = true;
    } else if (arg.startsWith('-')) {
      console.error(`❌ 에러: 알 수 없는 옵션입니다: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    console.error('❌ 에러: 설정 파일은 하나만 지정할 수 있습니다.');
    process.exit(1);
  }
  return { configPath: positional[0], allowExecutableConfig, strictCoverage };
}

async function loadConfig(absPath, allowExecutableConfig) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    return parsed;
  }
  if (['.mjs', '.js', '.cjs'].includes(ext)) {
    if (!allowExecutableConfig) {
      throw new Error(
        'Executable JavaScript configs can run arbitrary local code. ' +
        'Use a JSON config, or pass --allow-executable-config for trusted configs.'
      );
    }
    const imported = await import(pathToFileURL(absPath).href);
    if (!imported || !imported.default) {
      throw new Error(`설정 파일에 'default export'가 정의되어 있지 않습니다: "${absPath}"`);
    }
    return imported.default;
  }
  throw new Error(`Unsupported config extension: ${ext || '(none)'}`);
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Config must be an object.');
  }
  for (const field of ['srcDir', 'outDir']) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new Error(`Config field '${field}' must be a non-empty string.`);
    }
  }
  if (!Array.isArray(config.sourceFiles) || config.sourceFiles.length === 0 ||
      config.sourceFiles.some((file) => typeof file !== 'string' || file.trim() === '')) {
    throw new Error("Config field 'sourceFiles' must be an array of non-empty strings.");
  }
  if (config.perfData !== undefined && (!config.perfData || typeof config.perfData !== 'object' || Array.isArray(config.perfData))) {
    throw new Error("Config field 'perfData' must be an object.");
  }
  if (config.roleRules !== undefined) {
    if (!config.roleRules || typeof config.roleRules !== 'object' || Array.isArray(config.roleRules) ||
        Object.entries(config.roleRules).some(([fragment, role]) => !fragment.trim() || typeof role !== 'string' || !role.trim())) {
      throw new Error("Config field 'roleRules' must map non-empty name fragments to role strings.");
    }
  }
  return config;
}

function safeName(name) {
  if (!name) return '_anonymous_';
  return name.replace(/[^a-zA-Z0-9_$.]/g, '_').substring(0, 100);
}
function safeLiteralName(value, key = '') {
  if (shouldRedactLiteral(value, key)) return 'redacted_literal';
  return safeName(value);
}
function shouldRedactLiteral(value, key = '') {
  const raw = String(value || '').trim();
  const keyText = String(key || '');
  const combined = `${keyText} ${raw}`;
  if (/['"`]/.test(raw)) return true;
  if (/(api[_-]?key|auth(orization)?|credential|passwd|password|secret|token)/i.test(combined)) {
    return true;
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(raw)) return true;
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(raw.replace(/^['"`]|['"`]$/g, ''))) return true;
  if (/['"`][^'"`]{80,}['"`]/.test(raw)) return true;
  if (/https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(raw)) return true;
  return false;
}
function mkdirSync(d) { fs.mkdirSync(d, { recursive: true }); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function perfBand(pct) {
  if (pct < 1)   return 'lt_01';
  if (pct < 10)  return '01_10';
  if (pct < 30)  return '10_30';
  if (pct < 50)  return '30_50';
  if (pct < 70)  return '50_70';
  if (pct < 85)  return '70_85';
  if (pct < 95)  return '85_95';
  return '95_max';
}

const roleRules = Object.entries(CONFIG.roleRules || {}).map(([fragment, role]) => [fragment.trim().toLowerCase(), role.trim()]);
const guessRole = typeof CONFIG.guessRole === 'function'
  ? CONFIG.guessRole
  : (name) => roleRules.find(([fragment]) => String(name).toLowerCase().includes(fragment))?.[1] || 'general';
const OUTPUT_MARKER = '.quarkify-output';

// ─── PTX arg 의미 분류 (PTX Argument Classification) ───
function classifyPtxArg(raw, opcode) {
  let r = raw.trim();
  if (!r) return { kind: 'empty', value: '', type: '' };
  if (r.startsWith('@')) return { kind: 'pred', value: r.substring(1), type: '' };
  if (r.startsWith('%')) return { kind: 'reg', value: r.substring(1), type: '' };
  if (r.startsWith('addr_')) return { kind: 'addr', value: r.substring(5), type: '' };
  if (/^0[fd][0-9A-Fa-f]+$/.test(r)) return { kind: 'imm', value: r, type: r[1] === 'f' ? 'f32' : 'f64' };
  if (/^0[xX][0-9A-Fa-f]+$/.test(r)) return { kind: 'imm', value: r, type: 'hex' };
  if (/^-?\d+$/.test(r)) return { kind: 'imm', value: r, type: 'i32' };
  if (/^[A-Z_][A-Z0-9_]*$/.test(r) || (opcode === 'bra' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r))) {
    return { kind: 'label', value: r, type: '' };
  }
  return { kind: 'other', value: r, type: '' };
}

// ─── Zig struct 필드 파서 (Zig Struct Field Parser) ───
function parseZigStructFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    let l = raw.replace(/\/\/.*/g, '').trim();
    if (!l || l.startsWith('pub ') || l.startsWith('fn ') ||
        l.startsWith('const ') || l.startsWith('var ')) continue;
    const m = l.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^,;=]+)(?:=\s*([^,;]+))?[,;]?\s*$/);
    if (!m) continue;
    fields.push({ name: m[1].trim(), type: (m[2] || '').trim(), default: (m[3] || '').trim() });
  }
  return fields;
}

// ─── Java class/interface 필드 파서 (Java Class/Interface Field Parser) ───
function parseJavaFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    let l = raw.replace(/\/\/.*/g, '').trim();
    if (!l || l.includes('(') || l.includes(')') || l.startsWith('class ') || l.startsWith('interface ') || l.startsWith('public class ')) continue;
    const m = l.match(/^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|transient\s+|volatile\s+)*([a-zA-Z0-9_<>\[\]]+)\s+([a-zA-Z0-9_]+)\s*(?:=\s*([^;]+))?;\s*$/);
    if (!m) continue;
    fields.push({ name: m[2].trim(), type: m[1].trim(), default: (m[3] || '').trim() });
  }
  return fields;
}

// ─── JS/TS class/interface 필드 파서 (JS/TS Class/Interface Field Parser) ───
function parseJSFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    let l = raw.replace(/\/\/.*/g, '').trim();
    if (!l || l.includes('(') || l.includes(')') || l.startsWith('class ') || l.startsWith('interface ') || l.startsWith('export class ') || l.startsWith('export interface ')) continue;
    // JS/TS 프로퍼티 정규식 (JS/TS Property Regex)
    const m = l.match(/^\s*(?:(?:public|private|protected|readonly|static)\s+)*([a-zA-Z0-9_]+)(\?)?(?:\s*:\s*([^=;]+))?(?:\s*=\s*([^;]+))?;\s*$/);
    if (!m) continue;
    fields.push({
      name: m[1].trim(),
      type: (m[3] || '').trim(),
      default: (m[4] || '').trim()
    });
  }
  return fields;
}

// ─── Zig 식 분해 (Decompose Zig Expression) ───
function decomposeZigExpr(expr) {
  const e = expr.trim();
  if (!e) return null;
  const ops = [
    { sym: '||', tag: 'or' }, { sym: '&&', tag: 'and' },
    { sym: '==', tag: 'eq' }, { sym: '!=', tag: 'neq' },
    { sym: '<=', tag: 'leq' }, { sym: '>=', tag: 'geq' },
    { sym: '<',  tag: 'lt' },  { sym: '>',  tag: 'gt' },
    { sym: '+',  tag: 'add' }, { sym: '-',  tag: 'sub' },
    { sym: '*',  tag: 'mul' }, { sym: '/',  tag: 'div' },
  ];
  for (const { sym, tag } of ops) {
    let depth = 0;
    for (let i = 0; i < e.length - sym.length + 1; i++) {
      const ch = e[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (depth === 0 && e.substring(i, i + sym.length) === sym) {
        if ((sym === '+' || sym === '-') &&
            (i === 0 || /[+\-*\/=<>!&|(,?:%]/.test(e[i - 1]))) continue;
        return { op: tag, lhs: e.substring(0, i).trim(), rhs: e.substring(i + sym.length).trim() };
      }
    }
  }
  return null;
}

// ─── 재귀 stmt 파서 (Recursive Statement Parser) (Zig + MSL/C++ 공용 - Shared Zig + MSL/C++) ───
// MSL 은 C++ 서브셋. Zig 와 syntax 가 다르지만 (e.g. `}` 의미, 캡처 `|x|` 미사용) (MSL is a C++ subset. Although the syntax differs from Zig (e.g., meaning of `}`, capture `|x|` is not used))
// 핵심 구조 — if/while/for/return/generic stmt — 는 거의 동일하므로 재사용. (The core structure — if/while/for/return/generic stmt — is almost identical, so it is reused.)
class CStyleStmtParser {
  constructor(text, dialect = 'zig') {
    this.t = text;
    this.p = 0;
    this.dialect = dialect; // 'zig' | 'msl'
  }

  eof() { return this.p >= this.t.length; }
  peek(n = 0) { return this.t[this.p + n]; }

  skipWsComments() {
    while (!this.eof()) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.p++; continue; }
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      break;
    }
  }

  matchKeyword(kw) {
    this.skipWsComments();
    if (this.t.substring(this.p, this.p + kw.length) !== kw) return false;
    const after = this.t[this.p + kw.length];
    if (after !== undefined && /[a-zA-Z0-9_]/.test(after)) return false;
    this.p += kw.length;
    return true;
  }

  readBalancedParens() {
    this.skipWsComments();
    if (this.peek() !== '(') return null;
    let depth = 0;
    const start = this.p + 1;
    while (!this.eof()) {
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      const c = this.peek();
      if (c === '"') {
        this.p++;
        while (!this.eof() && this.peek() !== '"') {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === "'") {
        this.p++;
        while (!this.eof() && this.peek() !== "'") {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          const inside = this.t.substring(start, this.p);
          this.p++;
          return inside;
        }
      }
      this.p++;
    }
    return null;
  }

  tryReadCapture() {
    if (this.dialect !== 'zig') return null;
    this.skipWsComments();
    if (this.peek() !== '|') return null;
    this.p++;
    const start = this.p;
    while (!this.eof() && this.peek() !== '|') this.p++;
    const cap = this.t.substring(start, this.p);
    if (this.peek() === '|') this.p++;
    return cap;
  }

  readBody() {
    this.skipWsComments();
    if (this.peek() === '{') return this.parseBlock();
    const s = this.parseStmt();
    return s ? [s] : [];
  }

  parseBlock() {
    this.skipWsComments();
    if (this.peek() !== '{') return [];
    this.p++;
    const stmts = [];
    while (!this.eof()) {
      this.skipWsComments();
      if (this.peek() === '}') { this.p++; return stmts; }
      const before = this.p;
      const s = this.parseStmt();
      if (s) stmts.push(s);
      else if (this.p === before) this.p++;
    }
    return stmts;
  }

  parseStmt() {
    this.skipWsComments();
    if (this.eof()) return null;
    if (this.peek() === '}') return null;

    if (this.matchKeyword('if'))     return this.parseIf();
    if (this.matchKeyword('while'))  return this.parseWhile();
    if (this.matchKeyword('for'))    return this.parseFor();
    if (this.matchKeyword('return')) return this.parseReturn();
    if (this.matchKeyword('switch')) return this.parseSwitch();
    if (this.matchKeyword('try'))    return this.parseTry();
    if (this.dialect === 'zig') {
      if (this.matchKeyword('defer'))    return this.parseDeferLike('defer');
      if (this.matchKeyword('errdefer')) return this.parseDeferLike('errdefer');
    }
    return this.parseGeneric();
  }

  parseIf() {
    const cond = (this.readBalancedParens() || '').trim();
    const capture = this.tryReadCapture();
    const thenBody = this.readBody();
    const elseBranches = [];
    while (true) {
      this.skipWsComments();
      if (!this.matchKeyword('else')) break;
      const elseCap = this.tryReadCapture();
      this.skipWsComments();
      if (this.matchKeyword('if')) {
        const c = (this.readBalancedParens() || '').trim();
        const cap2 = this.tryReadCapture();
        const b = this.readBody();
        elseBranches.push({ cond: c, capture: cap2 || elseCap, body: b });
      } else {
        const b = this.readBody();
        elseBranches.push({ cond: null, capture: elseCap, body: b });
        break;
      }
    }
    return { kind: 'if', cond, capture, then: thenBody, elseBranches };
  }

  parseWhile() {
    const cond = (this.readBalancedParens() || '').trim();
    const capture = this.tryReadCapture();
    let contExpr = null;
    if (this.dialect === 'zig') {
      this.skipWsComments();
      if (this.peek() === ':') {
        this.p++;
        this.skipWsComments();
        contExpr = (this.readBalancedParens() || '').trim();
      }
    }
    const body = this.readBody();
    return { kind: 'while', cond, capture, contExpr, body };
  }

  parseFor() {
    const range = (this.readBalancedParens() || '').trim();
    const capture = this.tryReadCapture();
    const body = this.readBody();
    return { kind: 'for', range, capture, body };
  }

  parseReturn() {
    const start = this.p;
    let depth = 0;
    while (!this.eof()) {
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      const c = this.peek();
      if (c === '"') {
        this.p++;
        while (!this.eof() && this.peek() !== '"') {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === "'") {
        this.p++;
        while (!this.eof() && this.peek() !== "'") {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; this.p++; continue; }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--; this.p++; continue;
      }
      if (c === ';' && depth === 0) {
        const val = this.t.substring(start, this.p).trim();
        this.p++;
        return { kind: 'return', val };
      }
      this.p++;
    }
    return { kind: 'return', val: this.t.substring(start, this.p).trim() };
  }

  parseSwitch() {
    const expr = (this.readBalancedParens() || '').trim();
    const body = this.readBody();
    return { kind: 'switch', expr, body };
  }

  parseTry() {
    this.skipWsComments();
    let resource = null;
    if (this.peek() === '(') {
      resource = this.readBalancedParens();
    }
    const tryBody = this.readBody();
    const catches = [];
    let finallyBody = null;

    while (!this.eof()) {
      this.skipWsComments();
      if (this.matchKeyword('catch')) {
        const catchSig = (this.readBalancedParens() || '').trim();
        const catchBody = this.readBody();
        catches.push({ sig: catchSig, body: catchBody });
      } else if (this.matchKeyword('finally')) {
        finallyBody = this.readBody();
        break;
      } else {
        break;
      }
    }
    return { kind: 'try', resource, tryBody, catches, finallyBody };
  }

  parseDeferLike(kind) {
    const body = this.readBody();
    return { kind, body };
  }

  parseGeneric() {
    const start = this.p;
    let depth = 0;
    while (!this.eof()) {
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      const c = this.peek();
      if (c === '"') {
        this.p++;
        while (!this.eof() && this.peek() !== '"') {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === "'") {
        this.p++;
        while (!this.eof() && this.peek() !== "'") {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; this.p++; continue; }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) {
          const txt = this.t.substring(start, this.p).trim();
          return txt ? { kind: 'stmt', text: txt } : null;
        }
        depth--; this.p++; continue;
      }
      if (c === ';' && depth === 0) {
        const txt = this.t.substring(start, this.p).trim();
        this.p++;
        return txt ? { kind: 'stmt', text: txt } : null;
      }
      this.p++;
    }
    const txt = this.t.substring(start, this.p).trim();
    return txt ? { kind: 'stmt', text: txt } : null;
  }
}

// ─── stmt AST → 폴더 트리 (stmt AST to Folder Tree) ───
function emitStmtNode(stmt, parentPath, idx) {
  const prefix = `stmt_${idx}`;
  let stmtName;
  switch (stmt.kind) {
    case 'if': stmtName = `${prefix}__if`; break;
    case 'while': stmtName = `${prefix}__while`; break;
    case 'for': stmtName = `${prefix}__for`; break;
    case 'switch': stmtName = `${prefix}__switch`; break;
    case 'return': stmtName = `${prefix}__return`; break;
    case 'try': stmtName = `${prefix}__try`; break;
    case 'defer': stmtName = `${prefix}__defer`; break;
    case 'errdefer': stmtName = `${prefix}__errdefer`; break;
    default: stmtName = `${prefix}__expr`; break;
  }
  const dir = path.join(parentPath, safeName(stmtName));
  ensureDir(dir);

  if (stmt.kind === 'if') {
    const condTag = `cond___${safeLiteralName(stmt.cond).substring(0, 32)}`;
    const condDir = path.join(dir, condTag);
    ensureDir(condDir);
    if (stmt.capture) mkdirSync(path.join(condDir, `capture__${safeName(stmt.capture).substring(0, 24)}`));
    const thenDir = path.join(condDir, 'then');
    ensureDir(thenDir);
    emitStmtList(stmt.then || [], thenDir);
    annotateGeneric(stmt.cond, condDir);
    const branches = stmt.elseBranches || [];
    for (let bi = 0; bi < branches.length; bi++) {
      const br = branches[bi];
      const tag = br.cond === null ? 'else' : `elif_${bi}__cond___${safeLiteralName(br.cond).substring(0, 28)}`;
      const brDir = path.join(dir, tag);
      ensureDir(brDir);
      if (br.capture) mkdirSync(path.join(brDir, `capture__${safeName(br.capture).substring(0, 24)}`));
      emitStmtList(br.body || [], brDir);
      if (br.cond !== null) annotateGeneric(br.cond, brDir);
    }
    return;
  }
  if (stmt.kind === 'while') {
    const sigDir = path.join(dir, `cond___${safeLiteralName(stmt.cond).substring(0, 60)}`);
    ensureDir(sigDir);
    if (stmt.capture) mkdirSync(path.join(sigDir, `capture__${safeName(stmt.capture).substring(0, 40)}`));
    if (stmt.contExpr) mkdirSync(path.join(sigDir, `cont__${safeLiteralName(stmt.contExpr).substring(0, 40)}`));
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  if (stmt.kind === 'for') {
    const sigDir = path.join(dir, `range___${safeLiteralName(stmt.range).substring(0, 60)}`);
    ensureDir(sigDir);
    if (stmt.capture) mkdirSync(path.join(sigDir, `capture__${safeName(stmt.capture).substring(0, 40)}`));
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  if (stmt.kind === 'switch') {
    const sigDir = path.join(dir, `expr___${safeLiteralName(stmt.expr).substring(0, 60)}`);
    ensureDir(sigDir);
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  if (stmt.kind === 'return') {
    if (stmt.val) {
      mkdirSync(path.join(dir, `val__${safeLiteralName(stmt.val).substring(0, 60)}`));
      annotateGeneric(stmt.val, dir);
    }
    return;
  }
  if (stmt.kind === 'try') {
    if (stmt.resource) {
      mkdirSync(path.join(dir, `resource___${safeLiteralName(stmt.resource).substring(0, 40)}`));
    }
    const tryBodyDir = path.join(dir, 'body');
    ensureDir(tryBodyDir);
    emitStmtList(stmt.tryBody || [], tryBodyDir);

    for (let ci = 0; ci < stmt.catches.length; ci++) {
      const c = stmt.catches[ci];
      const catchDir = path.join(dir, `catch___${safeLiteralName(c.sig).substring(0, 40)}`);
      ensureDir(catchDir);
      emitStmtList(c.body || [], catchDir);
    }
    if (stmt.finallyBody) {
      const finDir = path.join(dir, 'finally');
      ensureDir(finDir);
      emitStmtList(stmt.finallyBody || [], finDir);
    }
    return;
  }
  if (stmt.kind === 'defer' || stmt.kind === 'errdefer') {
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  annotateGeneric(stmt.text || '', dir);
}

function emitStmtList(stmts, parentPath) {
  for (let i = 0; i < stmts.length; i++) emitStmtNode(stmts[i], parentPath, i);
}

// ─── Python 인덴테이션 기반 구문 분석기 (Python Indentation-based Parser) ───
class PythonIndentParser {
  constructor(lines) {
    this.lines = lines;
  }

  getIndent(line) {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  }

  parse(startIndex = 0, parentIndent = -1) {
    const nodes = [];
    let i = startIndex;
    while (i < this.lines.length) {
      const line = this.lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        i++;
        continue;
      }

      const indent = this.getIndent(line);
      if (indent <= parentIndent) {
        break;
      }

      let bodyLines = [];
      let j = i + 1;
      while (j < this.lines.length) {
        const nextLine = this.lines[j];
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed || nextTrimmed.startsWith('#')) {
          j++;
          continue;
        }
        const nextIndent = this.getIndent(nextLine);
        if (nextIndent > indent) {
          bodyLines.push(nextLine);
          j++;
        } else {
          break;
        }
      }

      let decorators = [];
      let k = i - 1;
      while (k >= 0) {
        const prevLine = this.lines[k];
        const prevTrim = prevLine.trim();
        if (prevTrim.startsWith('@')) {
          const decM = prevTrim.match(/^@([a-zA-Z0-9_.]+)(?:\((.*)\))?/);
          if (decM) {
            decorators.unshift({ name: decM[1], args: decM[2] || '' });
          }
          k--;
        } else if (!prevTrim || prevTrim.startsWith('#')) {
          k--;
        } else {
          break;
        }
      }

      let node = {
        line: trimmed,
        indent,
        index: i,
        decorators,
        body: bodyLines.length > 0 ? new PythonIndentParser(bodyLines).parse(0, indent) : []
      };

      let kind = 'stmt';
      let name = '';
      let m;
      if ((m = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/))) {
        kind = 'class';
        name = m[1];
      } else if ((m = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)/))) {
        kind = 'fn';
        name = m[1];
      } else if (trimmed.startsWith('if ') || trimmed.startsWith('if(')) {
        kind = 'if';
      } else if (trimmed.startsWith('elif ') || trimmed.startsWith('elif(')) {
        kind = 'elif';
      } else if (trimmed.startsWith('else:')) {
        kind = 'else';
      } else if (trimmed.startsWith('for ')) {
        kind = 'for';
      } else if (trimmed.startsWith('while ')) {
        kind = 'while';
      } else if (trimmed.startsWith('try:')) {
        kind = 'try';
      } else if (trimmed.startsWith('except ') || trimmed.startsWith('except:')) {
        kind = 'except';
      } else if (trimmed.startsWith('finally:')) {
        kind = 'finally';
      } else if (trimmed.startsWith('return ') || trimmed === 'return') {
        kind = 'return';
      } else if (trimmed.includes('=')) {
        const leftM = trimmed.match(/^([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=/);
        if (leftM && !trimmed.startsWith('if ') && !trimmed.startsWith('while ')) {
          kind = 'var';
          name = leftM[1];
        }
      }

      node.kind = kind;
      node.name = name;
      nodes.push(node);

      i = j;
    }
    return nodes;
  }
}

// ─── Python 노드 → 폴더 트리 실체화 (Python Node to Folder Tree Realization) ───
function emitPythonNode(node, parentPath, idx) {
  const prefix = `stmt_${idx}`;
  let stmtName = `${prefix}__expr`;

  if (node.kind === 'class') stmtName = `class__${safeName(node.name)}`;
  else if (node.kind === 'fn') stmtName = `fn__${safeName(node.name)}`;
  else if (node.kind === 'var') stmtName = `var__${safeName(node.name)}`;
  else if (node.kind === 'if') stmtName = `${prefix}__if`;
  else if (node.kind === 'elif') stmtName = `${prefix}__elif`;
  else if (node.kind === 'else') stmtName = `${prefix}__else`;
  else if (node.kind === 'for') stmtName = `${prefix}__for`;
  else if (node.kind === 'while') stmtName = `${prefix}__while`;
  else if (node.kind === 'try') stmtName = `${prefix}__try`;
  else if (node.kind === 'except') stmtName = `${prefix}__except`;
  else if (node.kind === 'finally') stmtName = `${prefix}__finally`;
  else if (node.kind === 'return') stmtName = `${prefix}__return`;

  const dir = path.join(parentPath, stmtName);
  ensureDir(dir);

  if (node.decorators && node.decorators.length > 0) {
    for (const dec of node.decorators) {
      const decDir = path.join(dir, `decorator__${safeName(dec.name)}`);
      mkdirSync(decDir);
      if (dec.args) {
        const parts = splitParamsTopLevel(dec.args);
        for (let ai = 0; ai < parts.length; ai++) {
          const p = parts[ai].trim();
          if (!p) continue;
          if (p.includes('=')) {
            const [k, v] = p.split('=').map(s => s.trim());
            mkdirSync(path.join(decDir, `arg__${safeName(k)}___${safeLiteralName(v, k).substring(0, 40)}`));
          } else {
            mkdirSync(path.join(decDir, `arg__${ai}___${safeLiteralName(p).substring(0, 40)}`));
          }
        }
      }
    }
  }

  if (node.kind !== 'class' && node.kind !== 'fn') {
    const line = node.line;
    const callMatches = line.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
    for (const m of callMatches) {
      const callName = m[1];
      if (!/^(if|while|for|return|try|except|finally|import|from|class|def|print)$/.test(callName)) {
        ensureDir(path.join(dir, `call__${safeName(callName)}`));
      }
    }
  }

  if (node.body && node.body.length > 0) {
    const bodyDir = (node.kind === 'class' || node.kind === 'fn') ? dir : path.join(dir, 'body');
    ensureDir(bodyDir);
    emitPythonList(node.body, bodyDir);
  }
}

function emitPythonList(nodes, parentPath) {
  for (let i = 0; i < nodes.length; i++) {
    emitPythonNode(nodes[i], parentPath, i);
  }
}

function annotateGeneric(text, dir) {
  const stmt = (text || '').trim();
  if (!stmt) return;
  const children = [];
  const callMatches = stmt.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
  for (const m of callMatches) {
    const callName = m[1];
    if (!/^(if|while|for|switch|return|try|catch|orelse|defer|errdefer|comptime|sizeof|static_cast|reinterpret_cast)$/.test(callName)) {
      children.push(`call__${callName}`);
    }
  }
  const varMatches = stmt.matchAll(/\b(?:const|var|auto|let)\s+([a-zA-Z0-9_]+)\b/g);
  for (const m of varMatches) children.push(`var__${m[1]}`);
  if (stmt.includes('==')) children.push('binop__equals');
  else if (stmt.includes('!=')) children.push('binop__not_equals');
  else if (stmt.includes('<=')) children.push('binop__leq');
  else if (stmt.includes('>=')) children.push('binop__geq');
  else if (stmt.includes('=')) children.push('assign');
  // CUDA / Metal 표식 (CUDA / Metal markers)
  if (stmt.includes('__syncthreads')) children.push('cuda__syncthreads');
  if (stmt.includes('__shfl')) children.push('cuda__shfl');
  if (stmt.includes('__shared__')) children.push('cuda__shared_decl');
  if (stmt.includes('threadgroup_barrier')) children.push('metal__threadgroup_barrier');
  if (stmt.includes('simd_shuffle')) children.push('metal__simd_shuffle');
  if (stmt.includes('simdgroup_barrier')) children.push('metal__simdgroup_barrier');
  if (stmt.includes('[[buffer(')) children.push('metal__buffer_attr');
  if (stmt.includes('[[thread_position')) children.push('metal__thread_pos');
  for (const c of children) ensureDir(path.join(dir, safeName(c)));

  const eqIdx = stmt.indexOf('=');
  if (eqIdx > 0 && !stmt.startsWith('if') && !stmt.includes('==') &&
      !stmt.includes('!=') && !stmt.includes('<=') && !stmt.includes('>=')) {
    const rhs = stmt.substring(eqIdx + 1).trim();
    const decomp = decomposeZigExpr(rhs);
    if (decomp) {
      const exprDir = path.join(dir, 'expr');
      ensureDir(exprDir);
      const opDir = path.join(exprDir, `bin_op__${decomp.op}`);
      ensureDir(opDir);
      if (decomp.lhs) mkdirSync(path.join(opDir, `lhs__${safeLiteralName(decomp.lhs).substring(0, 40)}`));
      if (decomp.rhs) mkdirSync(path.join(opDir, `rhs__${safeLiteralName(decomp.rhs).substring(0, 40)}`));
    }
  }
}

// ─── ELF (compiled binary) ───
//
// Source analysis can only describe what was written. A linked binary is what
// actually exists: functions the optimizer inlined away are gone, symbols pulled
// in from other objects are present, and every function has a real size in bytes
// rather than a line count. For a Zig/C/C++ project the `.so` is the ground truth
// that the sources only approximate — so it deserves a quark tree of its own.
//
// Parsed here directly (no nm/objdump dependency) because quarkify must run the
// same way on a machine that has no binutils installed.
const ELF_ST_TYPE = { 0: 'NOTYPE', 1: 'OBJECT', 2: 'FUNC', 3: 'SECTION', 4: 'FILE', 6: 'TLS', 10: 'GNU_IFUNC' };
const ELF_ST_BIND = { 0: 'LOCAL', 1: 'GLOBAL', 2: 'WEAK', 10: 'GNU_UNIQUE' };
const ELF_MACHINE = { 3: 'x86', 40: 'ARM', 62: 'x86_64', 183: 'AArch64', 243: 'RISC-V' };

function isElfFile(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) !== 4) return false;
    return head.readUInt32BE(0) === 0x7f454c46; // \x7fELF
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readElf64(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file');
  if (buf[4] !== 2) throw new Error('only 64-bit ELF is supported');
  if (buf[5] !== 1) throw new Error('only little-endian ELF is supported');

  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);
  const shstrndx = buf.readUInt16LE(0x3e);

  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({
      nameOff: buf.readUInt32LE(o),
      type: buf.readUInt32LE(o + 4),
      addr: Number(buf.readBigUInt64LE(o + 16)),
      offset: Number(buf.readBigUInt64LE(o + 24)),
      size: Number(buf.readBigUInt64LE(o + 32)),
      link: buf.readUInt32LE(o + 40),
      entsize: Number(buf.readBigUInt64LE(o + 56)),
    });
  }

  const readStr = (base, off) => {
    let end = base + off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('utf8', base + off, end);
  };
  const shstr = sections[shstrndx];
  if (shstr) for (const s of sections) s.name = readStr(shstr.offset, s.nameOff);

  // SHT_SYMTAB = 2 (dropped when stripped), SHT_DYNSYM = 11 (always present in a .so).
  // Both are read, then de-duplicated — a symbol usually appears in each.
  const seen = new Set();
  const symbols = [];
  for (const s of sections) {
    if (s.type !== 2 && s.type !== 11) continue;
    const strtab = sections[s.link];
    if (!strtab) continue;
    const count = s.entsize ? Math.floor(s.size / s.entsize) : 0;
    for (let i = 0; i < count; i++) {
      const o = s.offset + i * 24;
      const name = readStr(strtab.offset, buf.readUInt32LE(o));
      if (!name) continue;
      const info = buf[o + 4];
      const shndx = buf.readUInt16LE(o + 6);
      const value = Number(buf.readBigUInt64LE(o + 8));
      const key = `${name}@${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name,
        bind: ELF_ST_BIND[info >> 4] ?? `BIND_${info >> 4}`,
        type: ELF_ST_TYPE[info & 0xf] ?? `TYPE_${info & 0xf}`,
        value,
        size: Number(buf.readBigUInt64LE(o + 16)),
        section: shndx === 0 ? 'UNDEF' : (sections[shndx]?.name || `shndx_${shndx}`),
      });
    }
  }

  return {
    machine: ELF_MACHINE[buf.readUInt16LE(0x12)] ?? `machine_${buf.readUInt16LE(0x12)}`,
    sections,
    symbols,
  };
}

// ─── 엔진 (Engine) ───
class QuarkFolderEngine {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.quarkDir = path.join(outputDir, 'quark');
    this.mirrorDir = path.join(outputDir, '_mirror');
    this.axonDir = path.join(outputDir, '_axon');
    this.mirrors = { by_kind: {}, by_role: {}, by_file: {}, by_depth: {}, by_perf_band: {} };
    this.axons = [];
    this.byOpcodeSites = {};
    this.perfEntries = 0;
    // Symbol coverage audit: what a deliberately naive scan expects to find,
    // recorded per file so it can be diffed against what actually got built.
    this.expectedSymbols = [];
    this.filePaths = new Map();
  }

  // ─── Symbol coverage audit ───
  //
  // A folder tree has no schema to violate, so when a parser pattern misses a
  // declaration the result is indistinguishable from "that symbol does not
  // exist": no error, no warning, and an output that looks complete. A real
  // case: the Zig matcher accepted `pub`/`inline`/`noinline` but not `export`,
  // so an engine's entire ABI surface (JNI entry points, the public API) was
  // absent and only a hand-written symbol count caught it.
  //
  // This scan exists to make that failure loud. It is deliberately NOT the
  // parser's regex — a shared pattern would be blind in exactly the same way.
  // It is a permissive keyword sweep, and only the direction that matters is
  // reported: declared in the source but missing from the tree.
  static NAIVE_SYMBOL_SCANS = {
    '.zig': /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    '.py': /^[ \t]*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
    '.js': /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
    '.mjs': /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
    '.ts': /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
  };

  // Strip line/block comments and string bodies so a `fn` inside prose or a
  // literal is not reported as a missing symbol.
  static stripNonCode(text) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/#[^\n]*/g, ' ')
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  }

  recordExpectedSymbols(text, ext, relPath, fileFolderName) {
    const pattern = QuarkFolderEngine.NAIVE_SYMBOL_SCANS[ext];
    if (!pattern) return; // no independent scan for this language yet
    const names = new Set();
    const code = QuarkFolderEngine.stripNonCode(text);
    for (const match of code.matchAll(pattern)) names.add(match[1]);
    if (names.size) this.expectedSymbols.push({ relPath, fileFolderName, names });
  }

  auditSymbolCoverage() {
    const collectFnNames = (dir, found = new Set()) => {
      if (!fs.existsSync(dir)) return found;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('fn__')) found.add(entry.name.slice(4));
        collectFnNames(path.join(dir, entry.name), found);
      }
      return found;
    };

    let expected = 0;
    let matched = 0;
    const gaps = [];
    for (const file of this.expectedSymbols) {
      const built = collectFnNames(path.join(this.quarkDir, file.fileFolderName));
      const missing = [...file.names].filter((name) => !built.has(safeName(name)) && !built.has(name));
      expected += file.names.size;
      matched += file.names.size - missing.length;
      if (missing.length) gaps.push({ relPath: file.relPath, missing });
    }
    return { expected, matched, gaps };
  }

  init() {
    // v7: wipe ONLY the materialized-structure subtrees (quark/_mirror/_axon).
    // The derived perf layer (_hotpath/_ledger/_fingerprint/_dispatch) shares
    // this outDir and MUST persist across regens — _ledger is append-only
    // history. (Pre-v7 this rmSync'd the whole outDir, which would nuke the
    // ledger on the next regen; that folder collision is what v7 fixes.)
    for (const d of [this.quarkDir, this.mirrorDir, this.axonDir]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
    mkdirSync(this.outputDir);
    fs.writeFileSync(path.join(this.outputDir, OUTPUT_MARKER), 'quarkify output directory\n', 'utf-8');
    mkdirSync(this.quarkDir);
    mkdirSync(this.mirrorDir);
    mkdirSync(this.axonDir);
  }

  processFile(absPath, relPath) {
    // A compiled artifact is not text, and reading it as UTF-8 would corrupt it
    // before we ever get to look. Sniff the ELF magic from the raw bytes first.
    if (isElfFile(absPath)) {
      const binFolderName = `binary__${safeName(relPath)}`;
      const binQuarkPath = path.join(this.quarkDir, binFolderName);
      mkdirSync(binQuarkPath);
      this.processElf(absPath, binQuarkPath, relPath);
      return;
    }

    const text = fs.readFileSync(absPath, 'utf-8');
    const lines = text.split('\n');
    const ext = path.extname(absPath);
    const fileFolderName = `file__${safeName(relPath)}`;
    this.filePaths.set(fileFolderName, relPath);
    const fileQuarkPath = path.join(this.quarkDir, fileFolderName);
    mkdirSync(fileQuarkPath);
    this.recordExpectedSymbols(text, ext, relPath, fileFolderName);

    if (ext === '.ptx') { this.processPTX(text, fileQuarkPath, relPath); return; }
    if (ext === '.metal') { this.processMetal(text, fileQuarkPath, relPath); return; }
    if (ext === '.m' || ext === '.mm') { this.processObjC(text, fileQuarkPath, relPath); return; }
    if (ext === '.py') { this.processPython(text, fileQuarkPath, relPath); return; }

    // Zig / .cu / .cuh — symbol detection + recursive fn body for Zig
    this.processCStyle(text, lines, ext, fileQuarkPath, relPath);
  }

  // Materialize a linked binary. Layout mirrors what the file itself is made of:
  //
  //   binary__libfoo.so/
  //     machine__AArch64/
  //     section__.text/
  //       sym__forwardOneToken/  addr__0xd1470/  size__99804/  bind__GLOBAL/
  //     section__UNDEF/          <- what this binary needs from someone else
  //       sym__c_enn_execute/
  //
  // `size` here is compiled bytes, not lines — the number you actually need when
  // reasoning about I-cache pressure or why a "small" function is expensive.
  processElf(absPath, binQuarkPath, relPath) {
    let elf;
    try {
      elf = readElf64(absPath);
    } catch (err) {
      console.log(`[-] ELF 파싱 실패: ${relPath} (${err.message})`);
      return;
    }

    mkdirSync(path.join(binQuarkPath, `machine__${safeName(elf.machine)}`));

    let functions = 0;
    let undefined_ = 0;
    for (const sym of elf.symbols) {
      if (sym.type === 'SECTION' || sym.type === 'FILE') continue;
      const sectionDir = path.join(binQuarkPath, `section__${safeName(sym.section)}`);
      const symQuarkPath = path.join(sectionDir, `sym__${safeName(sym.name)}`);
      mkdirSync(symQuarkPath);
      mkdirSync(path.join(symQuarkPath, `addr__0x${sym.value.toString(16)}`));
      mkdirSync(path.join(symQuarkPath, `size__${sym.size}`));
      mkdirSync(path.join(symQuarkPath, `bind__${safeName(sym.bind)}`));
      mkdirSync(path.join(symQuarkPath, `type__${safeName(sym.type)}`));

      const role = sym.section === 'UNDEF' ? 'external_dependency' : guessRole(sym.name);
      this.registerMirror(sym.type.toLowerCase(), role, relPath,
        path.relative(this.quarkDir, symQuarkPath));

      if (sym.type === 'FUNC') functions++;
      if (sym.section === 'UNDEF') undefined_++;
    }

    console.log(`    ↳ ${elf.machine} · 심볼 ${elf.symbols.length} (FUNC ${functions} / 외부참조 ${undefined_})`);
  }

  processPython(text, fileQuarkPath, relPath) {
    let pyVer = 'unknown';
    try {
      pyVer = execSync('python3 --version', { encoding: 'utf8' }).trim();
    } catch {
      try {
        pyVer = execSync('python --version', { encoding: 'utf8' }).trim();
      } catch {}
    }
    const verClean = pyVer.replace(/[^0-9.]/g, '').replace(/\./g, '_');
    if (verClean) {
      mkdirSync(path.join(fileQuarkPath, `python_version__${verClean}`));
    }

    const lines = text.split('\n');
    const parser = new PythonIndentParser(lines);
    const nodes = parser.parse();

    emitPythonList(nodes, fileQuarkPath);

    const registerMirrorsRecursively = (n) => {
      if (n.kind === 'class') {
        this.registerMirror('class', 'type', relPath, path.relative(this.quarkDir, path.join(fileQuarkPath, `class__${safeName(n.name)}`)));
      } else if (n.kind === 'fn') {
        const role = guessRole(n.name);
        this.registerMirror('fn', role, relPath, path.relative(this.quarkDir, path.join(fileQuarkPath, `fn__${safeName(n.name)}`)));
      }
      if (n.body) {
        for (const child of n.body) registerMirrorsRecursively(child);
      }
    };
    for (const n of nodes) registerMirrorsRecursively(n);
  }

  // ─── Zig / CUDA C++ (.cu/.cuh) ───
  processCStyle(text, lines, ext, fileQuarkPath, relPath) {
    let cur = null;
    let depth = 0;
    let openedOnce = false;
    let symStart = 0;
    let pendingAnnotations = [];

    const finishSymbol = (endLine) => {
      if (!cur) return;
      const body = lines.slice(symStart, endLine).join('\n');
      const symFolderName = `${cur.kind}__${safeName(cur.name)}`;
      const symQuarkPath = path.join(fileQuarkPath, symFolderName);
      mkdirSync(symQuarkPath);

      if (cur.annotations && cur.annotations.length > 0) {
        for (const ann of cur.annotations) {
          const annDir = path.join(symQuarkPath, `annotation__${safeName(ann.name)}`);
          mkdirSync(annDir);
          if (ann.args) {
            const parts = splitParamsTopLevel(ann.args);
            for (let ai = 0; ai < parts.length; ai++) {
              const p = parts[ai].trim();
              if (!p) continue;
              if (p.includes('=')) {
                const [k, v] = p.split('=').map(s => s.trim());
                mkdirSync(path.join(annDir, `arg__${safeName(k)}___${safeLiteralName(v, k).substring(0, 40)}`));
              } else {
                mkdirSync(path.join(annDir, `arg__${ai}___${safeLiteralName(p).substring(0, 40)}`));
              }
            }
          }
        }
      }

      if (cur.kind === 'struct' || cur.kind === 'union' || cur.kind === 'enum' ||
          cur.kind === 'class' || cur.kind === 'namespace' || cur.kind === 'interface' || cur.kind === 'record') {
        const bodyOpen = body.indexOf('{');
        const bodyClose = body.lastIndexOf('}');
        if (bodyOpen >= 0 && bodyClose > bodyOpen) {
          const inner = body.substring(bodyOpen + 1, bodyClose);
          let fields = [];
          if (ext === '.java') {
            fields = parseJavaFields(inner);
          } else if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
            fields = parseJSFields(inner);
          } else {
            fields = parseZigStructFields(inner);
          }
          for (const f of fields) {
            const fDir = path.join(symQuarkPath, `field__${safeName(f.name)}`);
            mkdirSync(fDir);
            if (f.type) mkdirSync(path.join(fDir, `type__${safeName(f.type).substring(0, 60)}`));
            if (f.default) mkdirSync(path.join(fDir, `default__${safeLiteralName(f.default, f.name).substring(0, 60)}`));
            else mkdirSync(path.join(fDir, `default__missing__uninit_hazard`));
          }
          // RECURSE into the container body
          if (/(?:^|\n)\s*(?:pub\s+)?(?:export\s+|extern\s+(?:\"[^\"]*\"\s+)?|noinline\s+|inline\s+)?fn\s+[a-zA-Z0-9_]+\s*\(|(?:^|\n)\s*(?:pub\s+)?const\s+[a-zA-Z0-9_]+\s*=\s*(?:extern\s+|packed\s+)?(?:struct|union|enum)|(?:^|\n)\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+[a-zA-Z_]|\b(?:class|interface|enum|record)\s+[a-zA-Z0-9_]+|\b[a-zA-Z0-9_]+\s+[a-zA-Z0-9_]+\s*\([^;]*\{|\b(?:function)\b|=>/.test(inner)) {
            const innerLines = inner.split('\n');
            this.processCStyle(inner, innerLines, ext, symQuarkPath, relPath);
          }
        }
      } else if (cur.kind === 'fn' && (ext === '.zig' || ext === '.java')) {
        const open = body.indexOf('{');
        const close = body.lastIndexOf('}');
        if (open >= 0 && close > open) {
          const inner = body.substring(open + 1, close);
          const parser = new CStyleStmtParser(inner, ext === '.zig' ? 'zig' : 'msl');
          const stmts = [];
          while (!parser.eof()) {
            parser.skipWsComments();
            if (parser.eof()) break;
            const before = parser.p;
            const s = parser.parseStmt();
            if (s) stmts.push(s);
            else if (parser.p === before) parser.p++;
          }
          emitStmtList(stmts, symQuarkPath);
        }
      } else {
        this.quarkifyBodyFlat(body, symQuarkPath);
      }

      this.registerMirror(cur.kind, cur.role, relPath, path.relative(this.quarkDir, symQuarkPath));
      cur = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\/\/.*/g, '');
      const openers = (stripped.match(/\{/g) || []).length;
      const closers = (stripped.match(/\}/g) || []).length;
      if (ext === '.java' && !cur) {
        const annM = line.match(/^\s*@([a-zA-Z0-9_]+)(?:\((.*)\))?/);
        if (annM) {
          pendingAnnotations.push({ name: annM[1], args: annM[2] || '' });
        }
      }
      if (!cur) {
        let m, name, kind, role;
        if (ext === '.zig') {
          if ((m = line.match(/^\s*(?:pub\s+)?(?:export\s+|extern\s+(?:\"[^\"]*\"\s+)?|noinline\s+|inline\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:pub\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:extern\s+|packed\s+)?struct/))) {
            name = m[1]; kind = 'struct'; role = 'type';
          } else if ((m = line.match(/^\s*(?:pub\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:extern\s+|packed\s+)?union/))) {
            name = m[1]; kind = 'union'; role = 'type';
          } else if ((m = line.match(/^\s*(?:pub\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*enum/))) {
            name = m[1]; kind = 'enum'; role = 'type';
          } else if ((m = line.match(/^(?:pub\s+)?var\s+([a-zA-Z0-9_]+)\s*:/))) {
            name = m[1]; kind = 'var'; role = 'state';
          }
        } else if (ext === '.cu' || ext === '.cuh') {
          if ((m = line.match(/__global__\s+\w[\w\s\*&<>,]*?\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'kernel'; role = guessRole(name);
          } else if ((m = line.match(/__device__\s+\w[\w\s\*&<>,]*?\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'device_fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:static\s+|inline\s+|extern\s+(?:"C"\s+)?)*\w[\w\s\*&<>,]*?\s+([a-zA-Z0-9_]+)\s*\([^;]*$/)) && !line.includes('=') && !line.match(/\breturn\b/)) {
            name = m[1]; kind = 'host_fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*struct\s+([a-zA-Z0-9_]+)\s*\{/))) {
            name = m[1]; kind = 'struct'; role = 'type';
          }
        } else if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.h' || ext === '.hpp') {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.length === 0) {
          } else if ((m = line.match(/([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_~][a-zA-Z0-9_]*)\s*\([^;]*$/)) && !line.match(/^\s*\/\//) && !line.match(/\breturn\b/) && line.indexOf('=') === -1) {
            name = `${m[1]}__${m[2]}`; kind = 'method'; role = guessRole(m[2]);
          } else if ((m = line.match(/^\s*(?:static\s+|inline\s+|virtual\s+|constexpr\s+|extern\s+(?:"C"\s+)?|template\s*<[^>]*>\s*)*[\w:<>,\s\*&]+?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;]*$/)) && !line.includes('=') && !line.match(/\breturn\b/) && !line.match(/^\s*(?:if|while|for|switch|return)\b/)) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:[A-Z_]+\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::[^{]*)?\s*\{/))) {
            name = m[1]; kind = (line.includes('class ') ? 'class' : 'struct'); role = 'type';
          } else if ((m = line.match(/^\s*(?:typedef\s+)?enum(?:\s+class)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::[^{]*)?\s*\{/))) {
            name = m[1]; kind = 'enum'; role = 'type';
          } else if ((m = line.match(/^\s*namespace\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/))) {
            name = m[1]; kind = 'namespace'; role = 'namespace';
          }
        } else if (ext === '.java') {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.length === 0 || trimmed.startsWith('package ') || trimmed.startsWith('import ')) {
          } else if ((m = line.match(/^\s*(?:public\s+|protected\s+|private\s+|abstract\s+|static\s+|final\s+|sealed\s+|non-sealed\s+)*(class|interface|enum|record)\s+([a-zA-Z0-9_]+)/))) {
            name = m[2]; kind = m[1]; role = 'type';
          } else if ((m = line.match(/^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|synchronized\s+|abstract\s+|default\s+|native\s+|<[^>]+>\s*)*[a-zA-Z0-9_<>\[\]@\.]+\s+([a-zA-Z0-9_]+)\s*\([^;]*$/)) && !line.includes('=') && !line.match(/\breturn\b/) && !line.match(/^\s*(?:if|while|for|switch|return)\b/)) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|transient\s+|volatile\s+)*[a-zA-Z0-9_<>\[\]]+\s+([a-zA-Z0-9_]+)\s*(?:=|;)/))) {
            name = m[1]; kind = 'var'; role = 'state';
          }
        } else if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.length === 0 || trimmed.startsWith('import ') || trimmed.startsWith('export *')) {
          } else if ((m = line.match(/^\s*(?:export\s+)?(class|interface)\s+([a-zA-Z0-9_]+)/))) {
            name = m[2]; kind = m[1]; role = 'type';
          } else if ((m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s+)?function\b/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          }
        }
        if (name) {
          cur = { name, kind, role };
          cur.annotations = pendingAnnotations;
          pendingAnnotations = [];
          symStart = i;
          depth = openers - closers;
          openedOnce = openers > 0;
          if (cur.kind === 'var' && line.includes(';')) finishSymbol(i + 1);
          else if (openedOnce && depth <= 0) finishSymbol(i + 1);
        }
      } else {
        depth += openers - closers;
        if (openers > 0) openedOnce = true;
        if (cur.kind === 'var' && line.includes(';')) finishSymbol(i + 1);
        else if (openedOnce && depth <= 0) finishSymbol(i + 1);
      }
    }
    finishSymbol(lines.length);
  }

  quarkifyBodyFlat(body, parentPath) {
    const cleanBody = body.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const statements = cleanBody.split(/(;|\{|\})/);
    let stmtIndex = 0;
    for (let stmt of statements) {
      stmt = stmt.trim();
      if (!stmt || stmt === ';' || stmt === '{' || stmt === '}') continue;
      let stmtName = '';
      const children = [];
      if (stmt.startsWith('if ') || stmt.startsWith('if(')) {
        stmtName = 'if';
        const condMatch = stmt.match(/if\s*\(([\s\S]*)\)/);
        if (condMatch) children.push(`cond___${safeLiteralName(condMatch[1]).substring(0, 40)}`);
      } else if (stmt.startsWith('while ') || stmt.startsWith('while(')) stmtName = 'while';
      else if (stmt.startsWith('for ') || stmt.startsWith('for(')) stmtName = 'for';
      else if (stmt.startsWith('return ') || stmt === 'return') {
        stmtName = 'return';
        const retVal = stmt.replace('return', '').trim();
        if (retVal) children.push(`val__${safeLiteralName(retVal).substring(0, 40)}`);
      } else if (stmt.startsWith('switch ') || stmt.startsWith('switch(')) stmtName = 'switch';
      else if (stmt.startsWith('asm')) {
        stmtName = `asm_${stmtIndex++}`;
        if (stmt.includes('dp4a')) children.push('inline_asm__dp4a');
        if (stmt.includes('mma.sync')) children.push('inline_asm__mma_sync');
        if (stmt.includes('cp.async')) children.push('inline_asm__cp_async');
      } else stmtName = `stmt_${stmtIndex++}`;
      const callMatches = stmt.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
      for (const m of callMatches) {
        const callName = m[1];
        if (!/^(if|while|for|switch|return|try|catch|orelse|defer|errdefer|comptime|sizeof|static_cast|reinterpret_cast)$/.test(callName)) {
          children.push(`call__${callName}`);
        }
      }
      const varMatches = stmt.matchAll(/\b(?:const|var|auto)\s+([a-zA-Z0-9_]+)\b/g);
      for (const m of varMatches) children.push(`var__${m[1]}`);
      if (stmt.includes('==')) children.push('binop__equals');
      else if (stmt.includes('!=')) children.push('binop__not_equals');
      else if (stmt.includes('<=')) children.push('binop__leq');
      else if (stmt.includes('>=')) children.push('binop__geq');
      else if (stmt.includes('=')) children.push('assign');
      if (stmt.includes('__syncthreads')) children.push('cuda__syncthreads');
      if (stmt.includes('__shfl')) children.push('cuda__shfl');
      if (stmt.includes('__shared__')) children.push('cuda__shared_decl');
      const stmtPath = path.join(parentPath, safeName(stmtName));
      ensureDir(stmtPath);
      for (const c of children) ensureDir(path.join(stmtPath, safeName(c)));
      const eqIdx = stmt.indexOf('=');
      if (eqIdx > 0 && !stmt.startsWith('if') && !stmt.includes('==') &&
          !stmt.includes('!=') && !stmt.includes('<=') && !stmt.includes('>=')) {
        const rhs = stmt.substring(eqIdx + 1).trim();
        const decomp = decomposeZigExpr(rhs);
        if (decomp) {
          const exprDir = path.join(stmtPath, 'expr');
          ensureDir(exprDir);
          const opDir = path.join(exprDir, `bin_op__${decomp.op}`);
          ensureDir(opDir);
          if (decomp.lhs) mkdirSync(path.join(opDir, `lhs__${safeLiteralName(decomp.lhs).substring(0, 40)}`));
          if (decomp.rhs) mkdirSync(path.join(opDir, `rhs__${safeLiteralName(decomp.rhs).substring(0, 40)}`));
        }
      }
    }
  }

  // ─── Metal `.metal` (MSL: Metal Shading Language) ───
  // MSL = C++ subset. 핵심 디코드 (Core decodes):
  //   - `kernel void NAME(args) { ... }`    → kernel (PTX entry 와 동등 - equivalent to PTX entry)
  //   - `void NAME(args) { ... }`            → device_fn
  //   - `struct NAME { ... };`               → struct
  //   - param 안의 `[[buffer(N)]]`, `[[thread_position_in_grid]]` 등 attribute 캡처 (capturing attributes inside params)
  //   - storage qualifier: device / constant / threadgroup / thread
  processMetal(text, fileQuarkPath, relPath) {
    const lines = text.split('\n');
    const PERF_DATA = CONFIG.perfData || {};

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // kernel signature: 한 줄 또는 여러 줄에 걸침 (spans one or multiple lines)
      const km = line.match(/^\s*kernel\s+void\s+([a-zA-Z0-9_]+)\s*\(/);
      const fm = !km && line.match(/^\s*(?:static\s+|inline\s+)*(?:[a-zA-Z_][a-zA-Z0-9_]*(?:\s*<[^>]*>)?\s+[*&]*\s*|void\s+)([a-zA-Z0-9_]+)\s*\(/);
      const sm = !km && !fm && line.match(/^\s*struct\s+([a-zA-Z0-9_]+)\s*\{/);

      if (!km && !fm && !sm) { i++; continue; }

      let kind, role, entryName;
      if (km) {
        entryName = km[1]; kind = 'metal_kernel'; role = guessRole(entryName);
      } else if (fm) {
        // generic free function — 헷갈리니까 device_fn 으로 라벨 (labeled as device_fn to avoid confusion)
        // (host_fn 이 아니므로 — Metal MSL 은 host 코드 못 작성) (since it is not host_fn — Metal MSL cannot write host code)
        entryName = fm[1]; kind = 'device_fn'; role = guessRole(entryName);
      } else {
        entryName = sm[1]; kind = 'struct'; role = 'type';
      }

      // 시그니처/구조 끝까지 수집해서 본문 brace 찾기. (Collect signature/structure to the end to find body brace.)
      // 주의: Metal kernel 시그니처에는 `[[buffer(0)]]` 같은 attribute 가 포함되어 (Note: Metal kernel signature contains attributes like `[[buffer(0)]]`)
      // 그 안의 `()` 가 단순한 `.includes(')')` 매칭을 깨뜨림. 따라서 paren (which breaks simple `.includes(')')` matching inside. Thus,)
      // depth 를 추적하면서 unmatched `)` 가 닫힐 때까지 모은다. (tracking paren depth to collect until unmatched `)` is closed.)
      let sigLines = [line];
      let j = i + 1;
      if (kind === 'struct') {
        // already has '{'
      } else {
        let parenDepth = 0;
        for (const c of line) {
          if (c === '(') parenDepth++;
          else if (c === ')') parenDepth--;
        }
        while (j < lines.length && parenDepth > 0) {
          const nl = lines[j];
          for (const c of nl) {
            if (c === '(') parenDepth++;
            else if (c === ')') parenDepth--;
          }
          sigLines.push(nl);
          j++;
        }
      }

      // body brace scan — 라인 i 부터 첫 `{` 찾고 그 다음 줄을 bodyStart 로. (scan body brace — find first `{` from line i and set next line as bodyStart.)
      // 매칭 `}` 찾으면 bodyEnd. 단순하고 sigText 의존성 없음. (bodyEnd when matching `}` is found. Simple and has no dependency on sigText.)
      const sigText = sigLines.join('\n');
      let bodyStart = -1, bodyEnd = -1;
      let foundOpen = false;
      let bDepth = 0;
      let k = i;
      while (k < lines.length) {
        const L = lines[k];
        for (let ci = 0; ci < L.length; ci++) {
          const ch = L[ci];
          if (ch === '{') {
            bDepth++;
            if (!foundOpen) {
              foundOpen = true;
              // body content 는 `{` 다음 라인부터. (one-liner struct 의 인라인 body (body content starts from next line after `{`. (inlined body of one-liner struct)
              // 는 놓치지만 field parser 가 ; split 으로 견딘다.) (is missed, but field parser handles it via ; split))
              bodyStart = k + 1;
            }
          } else if (ch === '}') {
            bDepth--;
            if (bDepth === 0) { bodyEnd = k; break; }
          }
        }
        if (foundOpen && bDepth === 0) break;
        k++;
      }
      if (bodyStart < 0 || bodyEnd < 0) { i = j; continue; }

      const symFolderName = (kind === 'metal_kernel' ? `metal_kernel__` : kind === 'struct' ? `struct__` : `device_fn__`) + safeName(entryName);
      const symQuarkPath = path.join(fileQuarkPath, symFolderName);
      mkdirSync(symQuarkPath);

      if (kind !== 'struct') {
        // params 파싱: () 안의 콤마 분리 (Parsing params: split by comma inside ())
        const sigOnly = sigText.split('{')[0];
        const parenStart = sigOnly.indexOf('(');
        const parenEnd = sigOnly.lastIndexOf(')');
        if (parenStart >= 0 && parenEnd > parenStart) {
          const paramText = sigOnly.substring(parenStart + 1, parenEnd);
          const params = splitParamsTopLevel(paramText);
          for (let pi = 0; pi < params.length; pi++) {
            const p = params[pi].trim();
            if (!p) continue;
            // 형식: `device float* arg [[buffer(N)]]` / `constant uint& dim [[buffer(N)]]` (Format: `device float* arg [[buffer(N)]]` / `constant uint& dim [[buffer(N)]]`)
            // 이름 = `[[` 앞의 마지막 identifier (Name = last identifier before `[[`)
            const beforeAttr = p.replace(/\[\[[^\]]*\]\]/g, ' ').trim();
            const nameMatch = beforeAttr.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
            const pname = nameMatch ? nameMatch[1] : `arg${pi}`;
            const pdir = path.join(symQuarkPath, `param__${safeName(pname)}`);
            mkdirSync(pdir);
            // storage qualifier
            const sq = (p.match(/\b(device|constant|threadgroup|thread)\b/) || [])[1];
            if (sq) mkdirSync(path.join(pdir, `storage__${safeName(sq)}`));
            // type — qualifier + reference/pointer 떼고 마지막 type token (type — stripping qualifier + reference/pointer and getting last type token)
            const typeMatch = beforeAttr.match(/^\s*(?:device\s+|constant\s+|threadgroup\s+|thread\s+)?\s*((?:const\s+)?[a-zA-Z_][a-zA-Z0-9_]*(?:\s*<[^>]*>)?(?:\s*[*&])?)/);
            if (typeMatch) mkdirSync(path.join(pdir, `type__${safeName(typeMatch[1].trim()).substring(0, 40)}`));
            // attributes
            const attrs = (p.match(/\[\[[^\]]+\]\]/g) || []);
            for (const a of attrs) {
              const inner = a.replace(/\[\[|\]\]/g, '').trim();
              // buffer(N), thread_position_in_grid, threads_per_threadgroup 등 (buffer(N), thread_position_in_grid, threads_per_threadgroup, etc.)
              const tag = inner.replace(/\s+/g, '_').replace(/[()]/g, '_').substring(0, 40);
              mkdirSync(path.join(pdir, `attr__${safeName(tag)}`));
            }
          }
        }
        // 본문 재귀 파싱 — MSL 은 C++ 이므로 dialect 'msl' 로 (Recursive body parsing — MSL is C++, so dialect 'msl' is used)
        const innerBody = lines.slice(bodyStart, bodyEnd).join('\n');
        const parser = new CStyleStmtParser(innerBody, 'msl');
        const stmts = [];
        while (!parser.eof()) {
          parser.skipWsComments();
          if (parser.eof()) break;
          const before = parser.p;
          const s = parser.parseStmt();
          if (s) stmts.push(s);
          else if (parser.p === before) parser.p++;
        }
        emitStmtList(stmts, symQuarkPath);
      } else {
        // struct: 필드 파싱 (struct: parse fields)
        const innerBody = lines.slice(bodyStart, bodyEnd).join('\n');
        const fieldLines = innerBody.split(';');
        for (const fl of fieldLines) {
          const cleaned = fl.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
          if (!cleaned) continue;
          const m = cleaned.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\s*<[^>]*>)?\s*[*&]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\[(\d+)\])?\s*(?:=\s*(.+))?$/);
          if (!m) continue;
          const fDir = path.join(symQuarkPath, `field__${safeName(m[2])}`);
          mkdirSync(fDir);
          mkdirSync(path.join(fDir, `type__${safeName(m[1].trim()).substring(0, 40)}`));
          if (m[3]) mkdirSync(path.join(fDir, `array_size__${m[3]}`));
          if (m[4]) mkdirSync(path.join(fDir, `default__${safeLiteralName(m[4], m[2]).substring(0, 40)}`));
          else if (!m[4]) mkdirSync(path.join(fDir, `default__missing__uninit_hazard`));
        }
      }

      // perf data
      let perfBandTag = null;
      if (PERF_DATA[entryName]) {
        const perf = PERF_DATA[entryName];
        const perfDir = path.join(symQuarkPath, `_perf__measured`);
        mkdirSync(perfDir);
        for (const [key, val] of Object.entries(perf)) {
          const v = typeof val === 'number' ? String(val).replace('.', '_') : String(val);
          mkdirSync(path.join(perfDir, `${safeName(key)}__${safeName(v)}`));
        }
        if (typeof perf.dram_pct === 'number') {
          const band = perfBand(perf.dram_pct);
          mkdirSync(path.join(perfDir, `dram_band__${band}`));
          perfBandTag = band;
        }
        this.perfEntries++;
      }

      this.registerMirror(kind, role, relPath, path.relative(this.quarkDir, symQuarkPath), perfBandTag);
      i = bodyEnd + 1;
    }
  }

  // ─── Objective-C `.m` / `.mm` ───
  // 간단한 인터페이스/구현/메소드 캡처. 깊이있는 분해는 향후 작업. (Simple interface/implementation/method capture. Deep decomposition is future work.)
  processObjC(text, fileQuarkPath, relPath) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // @interface NAME / @implementation NAME / @protocol NAME
      let m;
      if ((m = line.match(/^\s*@(interface|implementation|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/))) {
        const kind = `objc_${m[1]}`;
        const name = m[2];
        const role = guessRole(name);
        const dir = path.join(fileQuarkPath, `${kind}__${safeName(name)}`);
        mkdirSync(dir);
        this.registerMirror(kind, role, relPath, path.relative(this.quarkDir, dir));
        continue;
      }
      // method: - (RetType)name:args... { or + (RetType)...
      if ((m = line.match(/^\s*[-+]\s*\(([^)]+)\)\s*([A-Za-z_][A-Za-z0-9_:]*)/))) {
        const method = m[2].split(':')[0];
        const dir = path.join(fileQuarkPath, `objc_method__${safeName(method)}`);
        mkdirSync(dir);
        mkdirSync(path.join(dir, `ret_type__${safeName(m[1].trim()).substring(0, 40)}`));
        this.registerMirror('objc_method', guessRole(method), relPath, path.relative(this.quarkDir, dir));
        continue;
      }
    }
  }

  // ─── PTX (v3.1 그대로 - same as v3.1) ───
  processPTX(text, fileQuarkPath, relPath) {
    const PERF_DATA = CONFIG.perfData || {};
    const targetMatch = text.match(/\.target\s+([a-zA-Z0-9_]+)/);
    const versionMatch = text.match(/\.version\s+([0-9.]+)/);
    const target = targetMatch ? targetMatch[1] : 'unknown_target';
    const version = versionMatch ? versionMatch[1] : 'unknown_version';
    mkdirSync(path.join(fileQuarkPath, `target__${safeName(target)}`));
    mkdirSync(path.join(fileQuarkPath, `version__${safeName(version)}`));

    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const em = line.match(/\.visible\s+\.entry\s+([a-zA-Z0-9_]+)\s*\(/);
      if (!em) { i++; continue; }
      const entryName = em[1];
      let sigLines = [line];
      let j = i + 1;
      while (j < lines.length && !sigLines.join(' ').includes(')')) { sigLines.push(lines[j]); j++; }
      const sigText = sigLines.join('\n');
      const paramMatch = sigText.match(/\(([\s\S]*?)\)/);
      const params = paramMatch ? paramMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];

      let depth = 0;
      let bodyStart = -1, bodyEnd = -1;
      let k = j;
      while (k < lines.length) { if (lines[k].includes('{')) { bodyStart = k + 1; depth = 1; k++; break; } k++; }
      while (k < lines.length && depth > 0) {
        for (const ch of lines[k]) {
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { bodyEnd = k; break; } }
        }
        if (depth === 0) break;
        k++;
      }
      if (bodyStart < 0 || bodyEnd < 0) { i = j; continue; }
      const bodyLines = lines.slice(bodyStart, bodyEnd);

      const role = guessRole(entryName);
      const symFolderName = `ptx_entry__${safeName(entryName)}`;
      const symQuarkPath = path.join(fileQuarkPath, symFolderName);
      mkdirSync(symQuarkPath);

      for (let pi = 0; pi < params.length; pi++) {
        const p = params[pi];
        const pm = p.match(/\.param\s+\.([a-z0-9_]+)\s+([a-zA-Z0-9_]+)/);
        const pname = pm ? pm[2] : `arg${pi}`;
        const ptype = pm ? pm[1] : null;
        const pdir = path.join(symQuarkPath, `param__${safeName(pname)}`);
        mkdirSync(pdir);
        if (ptype) mkdirSync(path.join(pdir, `type__${safeName(ptype)}`));
      }

      let curBlock = 'entry';
      let curBlockDir = path.join(symQuarkPath, `block__${safeName(curBlock)}`);
      mkdirSync(curBlockDir);
      const blockOpcodeIndices = { [curBlock]: {} };
      const regsByType = {};
      const blockSucc = {};
      const blockPred = {};
      const blockStmtCounter = { [curBlock]: 0 };
      let globalStmtIdx = 0;

      const incBlockOp = (block, op, idxInBlock) => {
        if (!blockOpcodeIndices[block]) blockOpcodeIndices[block] = {};
        if (!blockOpcodeIndices[block][op]) blockOpcodeIndices[block][op] = [];
        blockOpcodeIndices[block][op].push(idxInBlock);
      };

      for (const rawLine of bodyLines) {
        let l = rawLine.replace(/\/\/.*/g, '').trim();
        if (!l) continue;
        const shMatch = l.match(/^\.shared\s+(?:\.align\s+\d+\s+)?\.([a-z0-9_]+)\s+([a-zA-Z0-9_]+)\s*(?:\[(\d+)\])?\s*;/);
        if (shMatch) {
          const sDir = path.join(symQuarkPath, `shared__${safeName(shMatch[2])}`);
          mkdirSync(sDir);
          mkdirSync(path.join(sDir, `type__${safeName(shMatch[1])}`));
          if (shMatch[3]) mkdirSync(path.join(sDir, `size__${safeName(shMatch[3])}`));
          continue;
        }
        const regMatch = l.match(/^\.reg\s+\.([a-z0-9_]+)\s+(.*);$/);
        if (regMatch) {
          const typeKey = regMatch[1];
          if (!regsByType[typeKey]) regsByType[typeKey] = [];
          const regs = regMatch[2].split(',').map(s => s.trim()).filter(Boolean);
          for (const r of regs) {
            const nm = r.match(/^%([A-Za-z_][A-Za-z0-9_]*)/);
            if (nm) regsByType[typeKey].push(nm[1]);
          }
          continue;
        }
        const labelMatch = l.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/);
        if (labelMatch) {
          curBlock = labelMatch[1];
          curBlockDir = path.join(symQuarkPath, `block__${safeName(curBlock)}`);
          ensureDir(curBlockDir);
          if (!blockOpcodeIndices[curBlock]) blockOpcodeIndices[curBlock] = {};
          if (!(curBlock in blockStmtCounter)) blockStmtCounter[curBlock] = 0;
          continue;
        }
        const pieces = l.split(';').map(s => s.trim()).filter(Boolean);
        for (const piece of pieces) {
          let stmt = piece;
          let predTag = null;
          const pm = stmt.match(/^@(!?%?[A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
          if (pm) { predTag = pm[1].replace(/[!%]/g, ''); stmt = pm[2].trim(); }
          const opM = stmt.match(/^([a-z][a-z0-9._]*)/);
          if (!opM) continue;
          const opcodeRaw = opM[1];
          const opcode = opcodeRaw.replace(/\./g, '_');
          const idxInBlock = blockStmtCounter[curBlock]++;
          incBlockOp(curBlock, opcode, idxInBlock);
          if (!this.byOpcodeSites[opcode]) this.byOpcodeSites[opcode] = [];
          this.byOpcodeSites[opcode].push({ entry: entryName, block: curBlock, stmtGlobal: globalStmtIdx, stmtInBlock: idxInBlock });
          const after = stmt.slice(opcodeRaw.length).trim();
          const args = after.split(',').map(s => s.trim()).filter(Boolean)
            .map(s => s.replace(/\[\s*([^\]]+?)\s*\]/g, 'addr_$1'));
          const stmtName = `stmt_${String(globalStmtIdx).padStart(4, '0')}__${opcode}${predTag ? '__pred_' + safeName(predTag) : ''}`;
          globalStmtIdx++;
          const stmtDir = path.join(curBlockDir, stmtName);
          ensureDir(stmtDir);
          if (predTag) mkdirSync(path.join(stmtDir, `pred__${safeName(predTag)}`));
          for (let ai = 0; ai < args.length && ai < 6; ai++) {
            const cls = classifyPtxArg(args[ai], opcode);
            const valTag = cls.value.replace(/[{}]/g, '').replace(/\s+/g, '_').substring(0, 40);
            const argDir = path.join(stmtDir, `arg${ai}__${safeName(valTag || cls.kind)}`);
            mkdirSync(argDir);
            mkdirSync(path.join(argDir, `kind__${cls.kind}`));
            if (cls.type) mkdirSync(path.join(argDir, `type__${safeName(cls.type)}`));
          }
          if (opcode === 'bra' && args.length >= 1) {
            const cls = classifyPtxArg(args[0], opcode);
            if (cls.kind === 'label') {
              const target = cls.value;
              mkdirSync(path.join(stmtDir, `target__block__${safeName(target)}`));
              if (!blockSucc[curBlock]) blockSucc[curBlock] = new Set();
              blockSucc[curBlock].add(target);
              if (!blockPred[target]) blockPred[target] = new Set();
              blockPred[target].add(curBlock);
            }
          }
        }
      }
      for (const [block, ops] of Object.entries(blockOpcodeIndices)) {
        const blockDir = path.join(symQuarkPath, `block__${safeName(block)}`);
        ensureDir(blockDir);
        for (const [op, indices] of Object.entries(ops)) {
          const opDir = path.join(blockDir, `opcode__${safeName(op)}__count_${indices.length}`);
          mkdirSync(opDir);
          for (const idx of indices) mkdirSync(path.join(opDir, `site__stmt_${String(idx).padStart(4, '0')}`));
        }
      }
      for (const [typeKey, regNames] of Object.entries(regsByType)) {
        const regGroupDir = path.join(symQuarkPath, `reg__${safeName(typeKey)}`);
        ensureDir(regGroupDir);
        mkdirSync(path.join(regGroupDir, `count__${regNames.length}`));
        const uniq = new Set(regNames);
        for (const rname of uniq) mkdirSync(path.join(regGroupDir, `name__${safeName(rname)}`));
      }
      for (const [block, succs] of Object.entries(blockSucc)) {
        const blockDir = path.join(symQuarkPath, `block__${safeName(block)}`);
        ensureDir(blockDir);
        for (const s of succs) mkdirSync(path.join(blockDir, `succ__block__${safeName(s)}`));
      }
      for (const [block, preds] of Object.entries(blockPred)) {
        const blockDir = path.join(symQuarkPath, `block__${safeName(block)}`);
        ensureDir(blockDir);
        for (const p of preds) mkdirSync(path.join(blockDir, `pred__block__${safeName(p)}`));
      }
      let perfBandTag = null;
      if (PERF_DATA[entryName]) {
        const perf = PERF_DATA[entryName];
        const perfDir = path.join(symQuarkPath, `_perf__measured`);
        mkdirSync(perfDir);
        for (const [key, val] of Object.entries(perf)) {
          const v = typeof val === 'number' ? String(val).replace('.', '_') : String(val);
          mkdirSync(path.join(perfDir, `${safeName(key)}__${safeName(v)}`));
        }
        if (typeof perf.dram_pct === 'number') {
          const band = perfBand(perf.dram_pct);
          mkdirSync(path.join(perfDir, `dram_band__${band}`));
          perfBandTag = band;
        }
        this.perfEntries++;
      }
      this.registerMirror('ptx_entry', role, relPath, path.relative(this.quarkDir, symQuarkPath), perfBandTag);
      i = k + 1;
    }
  }

  registerMirror(kind, role, file, relPath, perfBandTag) {
    if (!this.mirrors.by_kind[kind]) this.mirrors.by_kind[kind] = [];
    this.mirrors.by_kind[kind].push(relPath);
    if (!this.mirrors.by_role[role]) this.mirrors.by_role[role] = [];
    this.mirrors.by_role[role].push(relPath);
    const fileKey = safeName(file);
    if (!this.mirrors.by_file[fileKey]) this.mirrors.by_file[fileKey] = [];
    this.mirrors.by_file[fileKey].push(relPath);
    if (!this.mirrors.by_depth['depth_1']) this.mirrors.by_depth['depth_1'] = [];
    this.mirrors.by_depth['depth_1'].push(relPath);
    if (perfBandTag) {
      const bandKey = `dram_${perfBandTag}`;
      if (!this.mirrors.by_perf_band[bandKey]) this.mirrors.by_perf_band[bandKey] = [];
      this.mirrors.by_perf_band[bandKey].push(relPath);
    }
  }

  buildMirrors() {
    for (const [category, entries] of Object.entries(this.mirrors)) {
      const categoryDir = path.join(this.mirrorDir, category);
      mkdirSync(categoryDir);
      for (const [key, paths] of Object.entries(entries)) {
        const keyDir = path.join(categoryDir, safeName(key));
        mkdirSync(keyDir);
        for (const relPath of paths) {
          const entryDir = path.join(keyDir, safeName(relPath));
          mkdirSync(entryDir);
          this.axons.push({ quark: relPath, mirror: path.relative(this.outputDir, entryDir), category, key });
        }
      }
    }
  }

  buildAxons() {
    const axonIndex = {};
    for (const axon of this.axons) {
      const quarkKey = safeName(axon.quark);
      if (!axonIndex[quarkKey]) axonIndex[quarkKey] = [];
      axonIndex[quarkKey].push({ category: axon.category, key: axon.key });
    }
    for (const [quarkKey, connections] of Object.entries(axonIndex)) {
      const axonEntryDir = path.join(this.axonDir, quarkKey);
      mkdirSync(axonEntryDir);
      for (const conn of connections) mkdirSync(path.join(axonEntryDir, `${conn.category}__${safeName(conn.key)}`));
    }
    const byOpcodeDir = path.join(this.axonDir, 'by_opcode');
    mkdirSync(byOpcodeDir);
    for (const [op, sites] of Object.entries(this.byOpcodeSites)) {
      const opDir = path.join(byOpcodeDir, `opcode__${safeName(op)}__total_${sites.length}`);
      mkdirSync(opDir);
      const byEntry = {};
      for (const s of sites) { if (!byEntry[s.entry]) byEntry[s.entry] = []; byEntry[s.entry].push(s); }
      for (const [entry, entrySites] of Object.entries(byEntry)) {
        mkdirSync(path.join(opDir, `entry__${safeName(entry)}__sites_${entrySites.length}`));
      }
    }
  }

  getStats() {
    const countDirs = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      let count = 0;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) { count++; count += countDirs(path.join(dir, entry.name)); }
      }
      return count;
    };
    return {
      quarkCount: countDirs(this.quarkDir),
      mirrorCount: countDirs(this.mirrorDir),
      axonCount: this.axons.length,
      perfEntries: this.perfEntries,
      opcodeFamilies: Object.keys(this.byOpcodeSites).length,
    };
  }

  collectTopologyGraphData() {
    const nodes = [];
    const idMap = new Map();
    const directoryMap = new Map();

    const addNode = (id, label, type, val = 1, parent = -1) => {
      if (idMap.has(id)) return idMap.get(id);
      const index = nodes.length;
      idMap.set(id, index);
      nodes.push({ id, label, type, val, parent });
      return index;
    };

    const project = addNode('project::root', CONFIG.name, 'project', 12);
    const directoryParent = (relPath) => {
      const parts = path.dirname(relPath).split(path.sep).filter((part) => part && part !== '.');
      let parent = project, current = '';
      for (const part of parts) {
        current = current ? path.join(current, part) : part;
        if (!directoryMap.has(current)) directoryMap.set(current, addNode(`directory::${current}`, part, 'directory', 9, parent));
        parent = directoryMap.get(current);
      }
      return parent;
    };

    const scanDir = (currPath, parent = project, topLevel = false) => {
      if (!fs.existsSync(currPath)) return;
      const entries = fs.readdirSync(currPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = path.join(currPath, entry.name);
        const relPath = path.relative(this.quarkDir, fullPath);
        const nodeId = `quark::${relPath}`;

        let type = 'generic_stmt';
        let label = entry.name;
        if (entry.name.startsWith('file__')) { type = 'file'; label = this.filePaths.get(entry.name) || entry.name.replace('file__', ''); }
        else if (entry.name.startsWith('class__')) { type = 'class'; label = entry.name.replace('class__', ''); }
        else if (entry.name.startsWith('interface__')) { type = 'interface'; label = entry.name.replace('interface__', ''); }
        else if (entry.name.startsWith('struct__')) { type = 'struct'; label = entry.name.replace('struct__', ''); }
        else if (entry.name.startsWith('fn__')) { type = 'function'; label = entry.name.replace('fn__', ''); }
        else if (entry.name.startsWith('field__')) { type = 'field'; label = entry.name.replace('field__', ''); }
        else if (entry.name.startsWith('var__')) { type = 'var'; label = entry.name.replace('var__', ''); }
        else if (entry.name.startsWith('annotation__')) { type = 'annotation'; label = '@' + entry.name.replace('annotation__', ''); }
        else if (entry.name.startsWith('stmt_')) { type = 'control_stmt'; }
        else if (entry.name.startsWith('call__')) { type = 'api_call'; label = entry.name.replace('call__', '') + '()'; }
        else if (entry.name.startsWith('cond__') || entry.name.startsWith('cond___')) { type = 'condition'; }
        else if (entry.name.startsWith('catch__') || entry.name.startsWith('catch___')) { type = 'catch'; }

        const sizeVal = type === 'file' ? 10 : type === 'class' ? 8 : type === 'function' ? 6 : type === 'annotation' ? 5 : 3;
        const nodeParent = topLevel && type === 'file' ? directoryParent(label) : parent;
        const index = addNode(nodeId, label, type, sizeVal, nodeParent);
        scanDir(fullPath, index);
      }
    };

    scanDir(this.quarkDir, project, true);
    return { nodes, linkCount: nodes.filter((node) => node.parent >= 0).length };
  }

  writeHtmlViewer() {
    const graphData = this.collectTopologyGraphData();
    const htmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quarkify v1.0.1 Explorer - ${CONFIG.name}</title>
    <style>
        * { box-sizing: border-box; }
        :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
        body { background: #080c14; color: #e5e7eb; height: 100vh; margin: 0; overflow: hidden; }
        button, input, select { background: #111827; border: 1px solid #334155; border-radius: .5rem; color: inherit; font: inherit; padding: .6rem .75rem; }
        button { cursor: pointer; } button:hover, button:focus-visible, input:focus-visible, select:focus-visible { border-color: #818cf8; outline: none; }
        button.active { background: #4f46e5; border-color: #818cf8; }
        .app { display: grid; grid-template-columns: 19rem 1fr; height: 100%; }
        .sidebar { background: #0f172a; border-right: 1px solid #1e293b; display: flex; flex-direction: column; gap: 1rem; overflow: auto; padding: 1.25rem; }
        .title { color: #c084fc; font-size: 1.2rem; margin: 0; } .subtitle, .muted { color: #94a3b8; font-size: .78rem; }
        .subtitle { margin: .2rem 0 0; } .controls { display: grid; gap: .6rem; } .controls input { width: 100%; }
        .stats { display: grid; gap: .5rem; grid-template-columns: 1fr 1fr; }
        .stat, .details { background: #111827; border: 1px solid #1e293b; border-radius: .65rem; padding: .75rem; }
        .help { background: #111827; border: 1px solid #1e293b; border-radius: .65rem; color: #94a3b8; font-size: .72rem; line-height: 1.5; padding: .75rem; }
        .help strong { color: #e2e8f0; display: block; margin-bottom: .3rem; }
        .stat strong { display: block; font-size: 1.05rem; } .stat span { color: #94a3b8; font-size: .72rem; }
        .details { margin-top: auto; overflow-wrap: anywhere; } .details strong { display: block; margin: .25rem 0; }
        .workspace { display: grid; grid-template-rows: auto 1fr; min-width: 0; }
        .toolbar { align-items: center; border-bottom: 1px solid #1e293b; display: flex; gap: .75rem; min-height: 3.5rem; padding: .7rem 1rem; }
        #breadcrumb { color: #cbd5e1; font-size: .85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #graph-container { min-height: 0; position: relative; } canvas { cursor: grab; display: block; height: 100%; width: 100%; } canvas.dragging { cursor: grabbing; }
        #status { margin-left: auto; white-space: nowrap; }
        .legend { display: flex; flex-wrap: wrap; gap: .55rem; } .legend span { color: #94a3b8; font-size: .7rem; }
        .dot { border-radius: 50%; display: inline-block; height: .55rem; margin-right: .25rem; width: .55rem; }
        @media (max-width: 720px) { .app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } .sidebar { border-bottom: 1px solid #1e293b; border-right: 0; max-height: 15rem; } }
    </style>
</head>
<body>
  <main class="app">
    <aside class="sidebar">
        <header>
            <h1 class="title">Quarkify v1.0.1 ⚛️</h1>
            <p class="subtitle">${CONFIG.name}</p>
        </header>
        <div class="stats">
          <div class="stat"><strong>${graphData.nodes.length}</strong><span>Total nodes</span></div>
          <div class="stat"><strong>${graphData.linkCount}</strong><span>Total links</span></div>
        </div>
        <div class="controls">
          <label class="muted" for="search">Search all nodes</label>
          <input id="search" type="search" placeholder="File, class, function…" autocomplete="off">
          <label class="muted" for="type-filter">Node type</label>
          <select id="type-filter"><option value="">All types</option></select>
        </div>
        <div class="legend" id="legend"></div>
        <div class="help"><strong>How to read</strong>중앙에서 바깥쪽으로 Project → Directory → File → Class/Function → Statement 순서입니다.<br>선은 부모–자식 포함 관계입니다.<br>클릭: 정보 · 더블클릭: 상세 탐색<br>휠: 확대/축소 · 드래그: 이동</div>
        <div class="details"><span class="muted">Selected node</span><strong id="node-name">None</strong><span class="muted" id="node-type">Click a node to inspect it.</span></div>
    </aside>
    <section class="workspace">
      <div class="toolbar"><button id="overview" class="active" type="button">Overview</button><button id="explore" type="button">Explore</button><button id="back" type="button" disabled>← Back</button><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="zoom-reset" type="button">100%</button><button id="zoom-in" type="button" aria-label="Zoom in">+</button><span id="breadcrumb">Full topology</span><span id="status" aria-live="polite"></span></div>
      <div id="graph-container"><canvas id="graph" tabindex="0" role="img" aria-label="Code topology graph"></canvas></div>
    </section>
  </main>

    <script>
        const data = ${JSON.stringify(graphData)};
        const colors = { project:'#f8fafc', directory:'#22d3ee', file:'#38bdf8', class:'#a855f7', interface:'#c084fc', struct:'#818cf8', function:'#f43f5e', field:'#10b981', var:'#34d399', annotation:'#fbbf24', control_stmt:'#64748b', api_call:'#f472b6', condition:'#06b6d4', catch:'#f97316', generic_stmt:'#94a3b8' };
        const children = Array.from({ length: data.nodes.length }, () => []);
        const roots = [];
        data.nodes.forEach((node, index) => node.parent < 0 ? roots.push(index) : children[node.parent].push(index));
        const canvas = document.getElementById('graph');
        const context = canvas.getContext('2d');
        const search = document.getElementById('search');
        const typeFilter = document.getElementById('type-filter');
        const back = document.getElementById('back');
        const overviewButton = document.getElementById('overview');
        const exploreButton = document.getElementById('explore');
        const breadcrumb = document.getElementById('breadcrumb');
        const status = document.getElementById('status');
        const zoomReset = document.getElementById('zoom-reset');
        let mode = 'overview', focus = roots[0] ?? -1, selected = focus, hits = [], visibleTotal = 0;
        let scale = 1, offsetX = 0, offsetY = 0, dragStart = null, dragged = false, renderFrame = 0;
        let overviewXs = null, overviewYs = null;
        const MAX_VISIBLE = 120;
        const nodesByType = new Map();
        data.nodes.forEach((node, index) => { if (!nodesByType.has(node.type)) nodesByType.set(node.type, []); nodesByType.get(node.type).push(index); });

        [...new Set(data.nodes.map((node) => node.type))].sort().forEach((type) => typeFilter.add(new Option(type.replaceAll('_', ' '), type)));
        search.value = ''; typeFilter.value = '';
        document.getElementById('legend').innerHTML = ['directory','file','class','function','var','api_call'].map((type) => '<span><i class="dot" style="background:'+colors[type]+'"></i>'+type.replaceAll('_',' ')+'</span>').join('');

        function visibleNodes() {
          const query = search.value.trim().toLowerCase();
          const type = typeFilter.value;
          const global = query || type;
          const source = global ? data.nodes : (focus < 0 ? roots : [focus, ...children[focus]]);
          const visible = [];
          visibleTotal = 0;
          for (let position = 0; position < source.length; position++) {
            const index = global ? position : source[position], node = data.nodes[index];
            if ((!query || node.label.toLowerCase().includes(query)) && (!type || node.type === type)) {
              visibleTotal++;
              if (visible.length < MAX_VISIBLE) visible.push(index);
            }
          }
          return visible;
        }

        function prepareCanvas() {
          const rect = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = Math.max(1, Math.round(rect.height * ratio));
          context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, rect.width, rect.height); hits = [];
          context.setTransform(ratio*scale, 0, 0, ratio*scale, ratio*offsetX, ratio*offsetY);
          return rect;
        }

        function renderOverview() {
          const rect = prepareCanvas(), total = data.nodes.length;
          const centerX = rect.width/2, centerY = rect.height/2, radius = Math.max(120, Math.min(rect.width,rect.height)*.44);
          const xs = new Float32Array(total), ys = new Float32Array(total);
          const depths = new Uint16Array(total); let maxDepth = 1;
          for (let index=0; index<total; index++) { const parent=data.nodes[index].parent; depths[index]=parent<0?0:depths[parent]+1; if(depths[index]>maxDepth) maxDepth=depths[index]; }
          for (let index=0; index<total; index++) { const angle=Math.PI*2*index/total, distance=radius*depths[index]/maxDepth; xs[index]=centerX+Math.cos(angle)*distance; ys[index]=centerY+Math.sin(angle)*distance; }
          overviewXs=xs; overviewYs=ys;
          context.strokeStyle='rgba(148,163,184,.16)'; context.lineWidth=.65; context.beginPath();
          for (let index=0; index<total; index++) {
            const parent=data.nodes[index].parent; if(parent<0) continue;
            context.moveTo(xs[parent],ys[parent]); context.lineTo(xs[index],ys[index]);
            if(index%5000===0) { context.stroke(); context.beginPath(); }
          }
          context.stroke();
          for (const [type,indexes] of nodesByType) { context.fillStyle=colors[type]||colors.generic_stmt; for(const index of indexes) context.fillRect(xs[index]-1,ys[index]-1,2,2); }
          if (selected>=0) { context.beginPath(); context.arc(xs[selected],ys[selected],7,0,Math.PI*2); context.fillStyle=colors[data.nodes[selected].type]||'#fff'; context.fill(); context.strokeStyle='#fff'; context.stroke(); context.fillStyle='#fff'; context.font='12px system-ui'; context.fillText(data.nodes[selected].label,xs[selected]+10,ys[selected]-8); }
          back.disabled=true; breadcrumb.textContent='Full topology'; status.textContent=total+' nodes · '+data.linkCount+' links';
        }

        function renderExplore() {
          let visible = visibleNodes();
          const rect = prepareCanvas();
          const rowCapacity = Math.max(1, Math.floor((rect.height - 40) / 46));
          const columnCapacity = Math.max(1, Math.floor((rect.width - 250) / 210));
          visible = visible.slice(0, rowCapacity * columnCapacity + 1);
          const centered = focus >= 0 && visible.includes(focus) && !search.value && !typeFilter.value;
          const others = centered ? visible.filter((index) => index !== focus) : visible;
          const positions = new Map();
          if (centered) positions.set(focus, { x: 90, y: rect.height / 2 });
          const rows = rowCapacity;
          const columns = Math.max(1, Math.ceil(others.length / rows));
          others.forEach((index, position) => positions.set(index, {
            x: centered ? 280 + Math.floor(position / rows) * Math.max(210, (rect.width - 320) / columns) : 40 + Math.floor(position / rows) * 230,
            y: 30 + (position % rows) * 46,
          }));
          if (centered) {
            context.strokeStyle = 'rgba(148,163,184,.25)'; context.lineWidth = 1;
            for (const index of others) { const point = positions.get(index); context.beginPath(); context.moveTo(102, rect.height/2); context.lineTo(point.x-12, point.y); context.stroke(); }
          }
          for (const index of visible) {
            const node = data.nodes[index], point = positions.get(index); if (!point) continue;
            const radius = index === selected ? 11 : 8;
            context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI*2); context.fillStyle = colors[node.type] || colors.generic_stmt; context.fill();
            if (index === selected) { context.strokeStyle = '#fff'; context.lineWidth = 2; context.stroke(); }
            context.fillStyle = '#e2e8f0'; context.font = (index === focus ? '600 ' : '') + '12px system-ui'; context.textAlign = 'left';
            context.fillText(node.label.length > 30 ? node.label.slice(0,29)+'…' : node.label, point.x + 14, point.y + 4);
            hits.push({ index, x: point.x, y: point.y, radius: 14 });
          }
          status.textContent = visible.length < visibleTotal ? 'Showing '+visible.length+' of '+visibleTotal+' nodes — refine the search.' : visibleTotal+' nodes shown';
          back.disabled = focus < 0 || data.nodes[focus].parent < 0; breadcrumb.textContent = focus < 0 ? 'Project' : data.nodes[focus].id.replace(/^(quark|directory|project)::/,'').replaceAll('/', ' › ');
        }

        function render() {
          overviewButton.classList.toggle('active',mode==='overview'); exploreButton.classList.toggle('active',mode==='explore');
          zoomReset.textContent=Math.round(scale*100)+'%';
          mode === 'overview' ? renderOverview() : renderExplore();
        }

        function scheduleRender() { if(!renderFrame) renderFrame=requestAnimationFrame(()=>{renderFrame=0;render();}); }

        function screenPoint(event) {
          const rect=canvas.getBoundingClientRect();
          return { x:(event.clientX-rect.left-offsetX)/scale, y:(event.clientY-rect.top-offsetY)/scale, screenX:event.clientX-rect.left, screenY:event.clientY-rect.top };
        }

        function zoomTo(nextScale, x=canvas.clientWidth/2, y=canvas.clientHeight/2) {
          nextScale=Math.min(8,Math.max(.25,nextScale));
          const worldX=(x-offsetX)/scale, worldY=(y-offsetY)/scale;
          offsetX=x-worldX*nextScale; offsetY=y-worldY*nextScale; scale=nextScale; scheduleRender();
        }

        function resetView() { scale=1; offsetX=0; offsetY=0; render(); }

        function showDetails(index) {
          selected=index; const node=data.nodes[index];
          document.getElementById('node-name').textContent=node.label;
          document.getElementById('node-type').textContent=node.type.replaceAll('_',' ')+' · '+children[index].length+' children · '+node.id.replace('quark::','');
        }

        function choose(index) {
          showDetails(index); const node=data.nodes[index];
          if (children[index].length) { focus=index; search.value=''; typeFilter.value=''; }
          render();
        }
        canvas.addEventListener('click', (event) => {
          if(dragged) return; const rect=canvas.getBoundingClientRect(), point=screenPoint(event), x=point.x, y=point.y;
          if (mode==='overview') {
            let angle=Math.atan2(y-rect.height/2,x-rect.width/2); if(angle<0) angle+=Math.PI*2;
            const center=Math.round(angle*data.nodes.length/(Math.PI*2))%data.nodes.length, span=Math.min(1500,data.nodes.length-1);
            let nearest=-1, distance=Infinity;
            for(let delta=-span;delta<=span;delta++) { const index=(center+delta+data.nodes.length)%data.nodes.length, next=Math.hypot(overviewXs[index]-x,overviewYs[index]-y); if(next<distance){distance=next;nearest=index;} }
            for(const index of roots){const next=Math.hypot(overviewXs[index]-x,overviewYs[index]-y);if(next<distance){distance=next;nearest=index;}}
            if(nearest>=0&&distance<=Math.max(16/scale,4)){showDetails(nearest);render();} return;
          }
          let hit=null, distance=Infinity; for(const item of hits){const next=Math.hypot(item.x-x,item.y-y);if(next<=item.radius&&next<distance){hit=item;distance=next;}} if(hit) choose(hit.index);
        });
        canvas.addEventListener('dblclick', () => { if(mode==='overview'&&selected>=0) { focus=selected; mode='explore'; render(); } });
        canvas.addEventListener('wheel',(event)=>{event.preventDefault();const point=screenPoint(event);zoomTo(scale*(event.deltaY<0?1.2:1/1.2),point.screenX,point.screenY);},{passive:false});
        canvas.addEventListener('mousedown',(event)=>{dragStart={x:event.clientX-offsetX,y:event.clientY-offsetY};dragged=false;canvas.classList.add('dragging');});
        window.addEventListener('mousemove',(event)=>{if(!dragStart)return;const nextX=event.clientX-dragStart.x,nextY=event.clientY-dragStart.y;if(Math.hypot(nextX-offsetX,nextY-offsetY)>3)dragged=true;offsetX=nextX;offsetY=nextY;scheduleRender();});
        window.addEventListener('mouseup',()=>{dragStart=null;canvas.classList.remove('dragging');setTimeout(()=>{dragged=false;},0);});
        canvas.addEventListener('keydown', (event) => { if (!hits.length) return; let position = Math.max(0, hits.findIndex((item) => item.index === selected)); if (event.key === 'ArrowDown' || event.key === 'ArrowRight') position = (position+1)%hits.length; else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') position = (position-1+hits.length)%hits.length; else if (event.key === 'Enter') return choose(hits[position].index); else return; event.preventDefault(); selected = hits[position].index; render(); });
        back.addEventListener('click', () => { if (focus < 0) return; focus=data.nodes[focus].parent; selected=focus; render(); });
        overviewButton.addEventListener('click',()=>{mode='overview';render();}); exploreButton.addEventListener('click',()=>{mode='explore';render();});
        document.getElementById('zoom-in').addEventListener('click',()=>zoomTo(scale*1.25)); document.getElementById('zoom-out').addEventListener('click',()=>zoomTo(scale/1.25)); zoomReset.addEventListener('click',resetView);
        search.addEventListener('input',()=>{mode='explore';render();}); typeFilter.addEventListener('change',()=>{mode='explore';render();}); new ResizeObserver(render).observe(canvas.parentElement); render();
    </script>
</body>
</html>`;
    const outPath = path.join(this.outputDir, 'index.html');
    fs.writeFileSync(outPath, htmlContent, 'utf-8');
    console.log(`[+] 인터랙티브 HTML 뷰어 빌드 완료: ${outPath}`);
  }

  writeAiContextGuide() {
    const text = `================================================================================
🤖 AI 코딩 에이전트(LLM) 전용 위상 지도 네비게이션 가이드 (AI Context Guide)
================================================================================

본 디렉터리는 'Everything is a folder' 설계 철학에 따라 정적 분석 완료된 소스 코드 위상 맵입니다.
에이전트가 소스 코드를 읽거나 수정하는 작업을 진행할 때, 불필요한 토큰 낭비를 차단하고 
Hallucination을 방지하기 위해 다음 탐색 규칙을 반드시 준수하여 인지 구조를 최적화하십시오.

--------------------------------------------------------------------------------
📌 [핵심 행동 강령]
--------------------------------------------------------------------------------
1. ❌ 원본 코드 파일을 처음부터 끝까지 전체 다 읽지 마십시오. (심한 토큰 낭비 및 인지 오버헤드 유발)
2. 🔍 작업 공간 내의 '_mirror/' 또는 '_axon/' 구조적 스냅샷을 'list_dir' 도구로 먼저 확인하십시오.
3. 🎯 분석 또는 수정의 타겟이 되는 메서드(fn__) 폴더나 어노테이션(annotation__) 폴더 경로로 직행하십시오.
4. 🧠 최소한의 폴더 컨텍스트(Statement, Condition 등)만을 확인하고 작업 범위(Scope)를 제한하십시오.

--------------------------------------------------------------------------------
📂 [계층 폴더 구조 명세]
--------------------------------------------------------------------------------
* quark/
  └─ file__[파일명]/
     └─ [class/interface/struct]__[심볼명]/
        ├─ annotation__[어노테이션명]/    <-- 스프링 웹 엔드포인트 및 DI 정보 주입
        ├─ var__[멤버변수명]/
        └─ fn__[메서드명]/
           └─ stmt_idx__[구문유형]/        <-- if, while, return, try 등의 제어 흐름 분해

* _mirror/
  ├─ by_kind/     <-- 심볼의 종류별 모아보기 (class, struct, fn, var 등)
  ├─ by_role/     <-- 프로젝트 도메인 역할별 모아보기 (web_endpoint, business_logic 등)
  └─ by_file/     <-- 소스 파일별 연관 쿼크 모아보기

* _axon/          <-- 쿼크와 미러 폴더 간의 상호 의존성(의존 연결 관계) 및 Opcode 색인

--------------------------------------------------------------------------------
🛠️ [유용한 터미널 명령어 템플릿]
--------------------------------------------------------------------------------
* 특정 컨트롤러의 GetMapping 라우팅 및 try-catch 예외 흐름을 시각화할 때:
  $ tree [output_dir]/quark/file__[파일명].java/class__[클래스명]/fn__[메서드명]

* 프로젝트 내에서 특정 API 호출('call__...')을 수행하는 모든 노드 영역 탐색:
  $ fd -t d "call__[API명]" [output_dir]/quark

* 도메인 역할(예: web_endpoint)을 담당하는 모든 모듈 목록을 평평하게 조회:
  $ ls [output_dir]/_mirror/by_role/web_endpoint
================================================================================
`;
    const outPath = path.join(this.outputDir, 'ai_context_guide.txt');
    fs.writeFileSync(outPath, text, 'utf-8');
    console.log(`[+] AI 컨텍스트 가이드 지침서 작성 완료: ${outPath}`);
  }
}

// ─── 헬퍼 (Helpers) ───
function splitParamsTopLevel(text) {
  // depth-aware comma split (Metal params 의 [[ ]] 안 콤마는 무시 - ignores commas inside [[ ]] of Metal params)
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.substring(start, i));
      start = i + 1;
    }
  }
  out.push(text.substring(start));
  return out;
}

// ─── Glob 파일 검색 및 매칭 헬퍼 (Glob File Search & Match Helpers) ───
function getFilesRecursively(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const res = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && entry.name !== 'node_modules') {
        getFilesRecursively(res, files);
      }
    } else {
      files.push(res);
    }
  }
  return files;
}

function matchGlobPattern(relPath, pattern) {
  const patternSegments = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
  const relSegments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const memo = new Map();

  const segmentMatches = (segment, relSegment) => {
    const escaped = segment
      .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(relSegment);
  };

  const matchFrom = (patternIdx, relIdx) => {
    const key = `${patternIdx}:${relIdx}`;
    if (memo.has(key)) return memo.get(key);
    if (patternIdx === patternSegments.length) return relIdx === relSegments.length;

    const segment = patternSegments[patternIdx];
    let matched = false;
    if (segment === '**') {
      for (let nextRelIdx = relIdx; nextRelIdx <= relSegments.length; nextRelIdx++) {
        if (matchFrom(patternIdx + 1, nextRelIdx)) {
          matched = true;
          break;
        }
      }
    } else if (relIdx < relSegments.length && segmentMatches(segment, relSegments[relIdx])) {
      matched = matchFrom(patternIdx + 1, relIdx + 1);
    }

    memo.set(key, matched);
    return matched;
  };

  return matchFrom(0, 0);
}

function isSamePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function validateOutputDir(outDir, srcDir) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw new Error('unsafe output directory: outDir is required');
  }
  const resolvedOut = path.resolve(outDir);
  const resolvedSrc = fs.realpathSync(srcDir);
  const homeDir = os.homedir();
  const cwd = process.cwd();
  const root = path.parse(resolvedOut).root;
  const existingOut = fs.existsSync(resolvedOut) ? fs.realpathSync(resolvedOut) : resolvedOut;

  if (
    isSamePath(existingOut, root) ||
    isSamePath(existingOut, homeDir) ||
    isSamePath(existingOut, cwd) ||
    isSamePath(existingOut, resolvedSrc)
  ) {
    throw new Error(`unsafe output directory: ${resolvedOut}`);
  }

  if (fs.existsSync(existingOut)) {
    const entries = fs.readdirSync(existingOut);
    const hasMarker = entries.includes(OUTPUT_MARKER);
    if (entries.length > 0 && !hasMarker) {
      throw new Error(`output directory is not marked as Quarkify output: ${resolvedOut}`);
    }
  }
  return resolvedOut;
}

function isInsideDir(parentDir, childPath) {
  const rel = path.relative(parentDir, childPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function validateSourceFilePath(srcRoot, relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('sourceFiles entries must be non-empty strings');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`source file is outside srcDir: ${relPath}`);
  }
  const abs = path.resolve(srcRoot, relPath);
  if (!isInsideDir(srcRoot, abs)) {
    throw new Error(`source file is outside srcDir: ${relPath}`);
  }
  if (fs.existsSync(abs)) {
    const realAbs = fs.realpathSync(abs);
    if (!isInsideDir(srcRoot, realAbs)) {
      throw new Error(`source file is outside srcDir: ${relPath}`);
    }
  }
  return abs;
}

// ─── main (Main Entry Point) ───
async function main() {
  console.log(`🔬 quarkify v1.0.1 — ${CONFIG.name} 시작...`);
  console.log(`📂 srcDir:  ${CONFIG.srcDir}`);
  console.log(`📁 outDir:  ${CONFIG.outDir}\n`);

  if (!fs.existsSync(CONFIG.srcDir)) {
    console.error(`❌ 에러: 설정된 소스 디렉터리(srcDir)가 존재하지 않습니다: "${CONFIG.srcDir}"`);
    console.error('설정 파일(*.mjs)의 srcDir 경로를 본인의 실제 로컬 경로로 수정해 주세요.');
    process.exit(1);
  }
  const srcRoot = fs.realpathSync(CONFIG.srcDir);
  CONFIG.outDir = validateOutputDir(CONFIG.outDir, srcRoot);

  // Glob 파일 스캔 및 매핑 (Glob File Scan and Mapping)
  let resolvedFiles = [];
  const hasGlob = CONFIG.sourceFiles.some(f => f.includes('*'));
  if (hasGlob) {
    console.log('🔍 Glob 패턴 감지됨. 소스 디렉터리 스캔 중...');
    const allFiles = getFilesRecursively(CONFIG.srcDir);
    for (const fileAbs of allFiles) {
      const fileRel = path.relative(CONFIG.srcDir, fileAbs);
      const isMatched = CONFIG.sourceFiles.some(pat => matchGlobPattern(fileRel, pat));
      if (isMatched) {
        validateSourceFilePath(srcRoot, fileRel);
        resolvedFiles.push(fileRel);
      }
    }
    console.log(`[+] 스캔 완료: 총 ${resolvedFiles.length}개 파일 매칭됨.\n`);
  } else {
    resolvedFiles = CONFIG.sourceFiles.map((rel) => {
      validateSourceFilePath(srcRoot, rel);
      return rel;
    });
  }

  if (resolvedFiles.length === 0) {
    console.error('❌ 에러: 매칭된 소스 파일이 하나도 없습니다.');
    console.error(`설정 파일의 'sourceFiles' 패턴(${JSON.stringify(CONFIG.sourceFiles)})과 'srcDir' 경로가 올바른지 확인해 주세요.`);
    process.exit(1);
  }

  const engine = new QuarkFolderEngine(CONFIG.outDir);
  engine.init();

  for (const rel of resolvedFiles) {
    const abs = validateSourceFilePath(srcRoot, rel);
    if (!fs.existsSync(abs)) { console.log(`[-] 건너뜀: ${rel}`); continue; }
    console.log(`[+] 분해 중: ${rel}`);
    engine.processFile(abs, rel);
  }

  console.log('\n🪞 미러 구성...');
  engine.buildMirrors();
  console.log('🔗 액손 + by_opcode 인덱스...');
  engine.buildAxons();

  // 시각화 뷰어 및 AI 가이드 자동 생성 (Automatically generate visualization viewer and AI guide)
  engine.writeHtmlViewer();
  engine.writeAiContextGuide();

  const s = engine.getStats();
  console.log('\n=============================================');
  console.log(` 🎉 ${CONFIG.name} 쿼크나이제이션 완료!`);
  console.log('=============================================');
  console.log(` ⚛️  쿼크 폴더:        ${s.quarkCount}`);
  console.log(` 🪞 미러 폴더:        ${s.mirrorCount}`);
  console.log(` 🔗 액손:             ${s.axonCount}`);
  console.log(` 📊 perf 임베드:      ${s.perfEntries}`);
  console.log(` 🔣 opcode 종류:      ${s.opcodeFamilies}`);

  // Symbol coverage — the one line that tells you whether to trust the rest.
  const audit = engine.auditSymbolCoverage();
  if (audit.expected > 0) {
    const pct = ((audit.matched / audit.expected) * 100).toFixed(1);
    const label = audit.gaps.length ? '⚠️  심볼 커버리지' : ' 🔎 심볼 커버리지';
    console.log(`${label}:    ${audit.matched}/${audit.expected} (${pct}%)`);
  }
  console.log(` 📁 경로:             ${path.resolve(CONFIG.outDir)}`);
  console.log('=============================================\n');

  if (audit.gaps.length) {
    // Loud on purpose. A silent gap is the failure mode this exists to prevent.
    console.warn('⚠️  일부 심볼이 소스에는 있으나 쿼크 트리에 없습니다 (파서가 놓쳤을 수 있습니다):');
    for (const gap of audit.gaps) {
      const shown = gap.missing.slice(0, 10).join(', ');
      const rest = gap.missing.length > 10 ? ` … 외 ${gap.missing.length - 10}개` : '';
      console.warn(`    ${gap.relPath}: ${shown}${rest}`);
    }
    console.warn('    --strict-coverage 를 주면 이 상태에서 실패로 종료합니다.\n');
    if (STRICT_COVERAGE) {
      throw new Error(`symbol coverage gap: ${audit.expected - audit.matched} symbol(s) missing from the quark tree`);
    }
  }
}
main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
