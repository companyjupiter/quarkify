#!/usr/bin/env node
/**
 * 쿼크화(Quarkify) v1.0.0 — Generic config-driven engine (Quarkify v1.0.0 — Generic config-driven engine)
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
if (!configPath) {
  console.error('❌ 에러: 설정 파일 경로가 제공되지 않았습니다.');
  console.error('사용법: node quarkify.mjs [--allow-executable-config] <configs/config_name.json|mjs>');
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
  const positional = [];
  for (const arg of args) {
    if (arg === '--allow-executable-config') {
      allowExecutableConfig = true;
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
  return { configPath: positional[0], allowExecutableConfig };
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
  }

  init() {
    // v7: wipe ONLY the materialized-structure subtrees (quark/_mirror/_axon).
    // The derived perf layer (_hotpath/_ledger/_fingerprint/_dispatch) shares
    // this outDir and MUST persist across regens — _ledger is append-only
    // history. (Pre-v7 this rmSync'd the whole outDir, which would nuke the
    // ledger on the next regen; that folder collision is what v7 fixes.)
    for (const d of [this.quarkDir, this.mirrorDir, this.axonDir]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    }
    mkdirSync(this.outputDir);
    fs.writeFileSync(path.join(this.outputDir, OUTPUT_MARKER), 'quarkify output directory\n', 'utf-8');
    mkdirSync(this.quarkDir);
    mkdirSync(this.mirrorDir);
    mkdirSync(this.axonDir);
  }

  processFile(absPath, relPath) {
    const text = fs.readFileSync(absPath, 'utf-8');
    const lines = text.split('\n');
    const ext = path.extname(absPath);
    const fileFolderName = `file__${safeName(relPath)}`;
    const fileQuarkPath = path.join(this.quarkDir, fileFolderName);
    mkdirSync(fileQuarkPath);

    if (ext === '.ptx') { this.processPTX(text, fileQuarkPath, relPath); return; }
    if (ext === '.metal') { this.processMetal(text, fileQuarkPath, relPath); return; }
    if (ext === '.m' || ext === '.mm') { this.processObjC(text, fileQuarkPath, relPath); return; }
    if (ext === '.py') { this.processPython(text, fileQuarkPath, relPath); return; }

    // Zig / .cu / .cuh — symbol detection + recursive fn body for Zig
    this.processCStyle(text, lines, ext, fileQuarkPath, relPath);
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
          if (/(?:^|\n)\s*(?:pub\s+)?(?:noinline\s+|inline\s+)?fn\s+[a-zA-Z0-9_]+\s*\(|(?:^|\n)\s*(?:pub\s+)?const\s+[a-zA-Z0-9_]+\s*=\s*(?:extern\s+|packed\s+)?(?:struct|union|enum)|(?:^|\n)\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+[a-zA-Z_]|\b(?:class|interface|enum|record)\s+[a-zA-Z0-9_]+|\b[a-zA-Z0-9_]+\s+[a-zA-Z0-9_]+\s*\([^;]*\{|\b(?:function)\b|=>/.test(inner)) {
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
          if ((m = line.match(/^\s*(?:pub\s+)?(?:noinline\s+|inline\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/))) {
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
    const links = [];
    const idMap = new Set();

    const addNode = (id, label, type, val = 1) => {
      if (idMap.has(id)) return;
      idMap.add(id);
      nodes.push({ id, label, type, val });
    };

    const addLink = (source, target, value = 1) => {
      links.push({ source, target, value });
    };

    const scanDir = (currPath, parentId = null) => {
      if (!fs.existsSync(currPath)) return;
      const entries = fs.readdirSync(currPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = path.join(currPath, entry.name);
        const relPath = path.relative(this.quarkDir, fullPath);
        const nodeId = `quark::${relPath}`;

        let type = 'generic_stmt';
        let label = entry.name;
        if (entry.name.startsWith('file__')) { type = 'file'; label = entry.name.replace('file__', ''); }
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
        addNode(nodeId, label, type, sizeVal);

        if (parentId) {
          addLink(parentId, nodeId);
        }

        scanDir(fullPath, nodeId);
      }
    };

    scanDir(this.quarkDir);
    return { nodes, links };
  }

  writeHtmlViewer() {
    const graphData = this.collectTopologyGraphData();
    const htmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quarkify v1.0.0 Topology Viewer - ${CONFIG.name}</title>
    <style>
        body {
            background-color: #0b0f19;
            color: #e2e8f0;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            height: 100vh;
            margin: 0;
            overflow: hidden;
            position: relative;
        }
        * { box-sizing: border-box; }
        .sidebar {
            border-radius: 1rem;
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.35);
            display: flex;
            flex-direction: column;
            height: calc(100vh - 2rem);
            justify-content: space-between;
            margin: 1rem;
            padding: 1.5rem;
            position: relative;
            width: 20rem;
            z-index: 1;
        }
        .glass-panel {
            background: rgba(15, 23, 42, 0.65);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .title { color: #c084fc; font-size: 1.25rem; font-weight: 700; margin: 0; }
        .subtitle, .label { color: #64748b; font-size: 0.75rem; }
        .subtitle { margin: 0.25rem 0 0; }
        .divider { background: #334155; height: 1px; margin: 1rem 0; opacity: 0.7; }
        .stats { display: grid; gap: 0.75rem; }
        .label, .value { display: block; }
        .value { color: #e2e8f0; font-size: 0.875rem; font-weight: 600; }
        .value-indigo { color: #818cf8; }
        .value-purple { color: #c084fc; }
        .legend-title { color: #64748b; font-size: 0.75rem; margin: 0 0 0.5rem; text-transform: uppercase; }
        .legend-grid { display: grid; font-size: 0.75rem; gap: 0.5rem; grid-template-columns: 1fr 1fr; }
        .legend-item { align-items: center; color: #cbd5e1; display: flex; gap: 0.375rem; }
        .legend-dot { border-radius: 50%; height: 0.625rem; width: 0.625rem; }
        .details { background: rgba(15, 23, 42, 0.5); border: 1px solid rgba(30, 41, 59, 0.6); border-radius: 0.75rem; padding: 0.75rem; }
        .selected-name { color: #cbd5e1; display: block; font-size: 0.875rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .selected-type { color: #818cf8; display: block; font-size: 0.75rem; margin-top: 0.25rem; }
        #graph-container { height: 100%; inset: 0; position: absolute; width: 100%; }
        .node:hover {
            cursor: pointer;
            filter: brightness(1.3);
        }
        .link {
            stroke: rgba(255, 255, 255, 0.06);
            stroke-opacity: 0.6;
        }
        .color-file { fill: #38bdf8; }
        .color-class { fill: #a855f7; }
        .color-interface { fill: #c084fc; }
        .color-struct { fill: #818cf8; }
        .color-function { fill: #f43f5e; }
        .color-field { fill: #10b981; }
        .color-var { fill: #34d399; }
        .color-annotation { fill: #fbbf24; }
        .color-control_stmt { fill: #64748b; }
        .color-api_call { fill: #f472b6; }
        .color-condition { fill: #06b6d4; }
        .color-catch { fill: #f97316; }
        .color-default { fill: #94a3b8; }
        @media (max-width: 700px) {
            .sidebar { height: auto; max-height: calc(100vh - 2rem); overflow: auto; width: calc(100% - 2rem); }
        }
    </style>
</head>
<body>

    <aside class="sidebar glass-panel">
        <div>
            <h1 class="title">Quarkify v1.0.0 ⚛️</h1>
            <p class="subtitle">Topology Graph Visualizer</p>
            
            <div class="divider"></div>
            
            <div class="stats">
                <div>
                    <span class="label">Project Name</span>
                    <span class="value">${CONFIG.name}</span>
                </div>
                <div>
                    <span class="label">Total Nodes</span>
                    <span class="value value-indigo">\${graphData.nodes.length}</span>
                </div>
                <div>
                    <span class="label">Total Links</span>
                    <span class="value value-purple">\${graphData.links.length}</span>
                </div>
            </div>
            
            <div class="divider"></div>
            
            <h2 class="legend-title">Legend</h2>
            <div class="legend-grid">
                <div class="legend-item"><span class="legend-dot color-file"></span>File</div>
                <div class="legend-item"><span class="legend-dot color-class"></span>Class</div>
                <div class="legend-item"><span class="legend-dot color-function"></span>Method</div>
                <div class="legend-item"><span class="legend-dot color-annotation"></span>Annotation</div>
                <div class="legend-item"><span class="legend-dot color-field"></span>Field/Var</div>
                <div class="legend-item"><span class="legend-dot color-control_stmt"></span>Control Stmt</div>
                <div class="legend-item"><span class="legend-dot color-api_call"></span>API Call</div>
                <div class="legend-item"><span class="legend-dot color-condition"></span>Condition</div>
            </div>
        </div>
        
        <div class="details" id="details">
            <span class="label">Selected Node</span>
            <span class="selected-name" id="node-name">None (Click a node)</span>
            <span class="selected-type" id="node-type">-</span>
        </div>
    </aside>

    <div id="graph-container"></div>

    <script>
        const data = ${JSON.stringify(graphData)};
        
        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("viewBox", [0, 0, width, height].join(" "));
        container.appendChild(svg);

        const radius = Math.max(120, Math.min(width, height) * 0.36);
        const centerX = width / 2;
        const centerY = height / 2;
        const positions = new Map();
        data.nodes.forEach((node, index) => {
            const angle = (Math.PI * 2 * index) / Math.max(data.nodes.length, 1);
            positions.set(node.id, {
                x: centerX + Math.cos(angle) * radius,
                y: centerY + Math.sin(angle) * radius,
            });
        });

        for (const link of data.links) {
            const source = positions.get(typeof link.source === "string" ? link.source : link.source.id);
            const target = positions.get(typeof link.target === "string" ? link.target : link.target.id);
            if (!source || !target) continue;
            const line = document.createElementNS(svgNS, "line");
            line.setAttribute("x1", source.x);
            line.setAttribute("y1", source.y);
            line.setAttribute("x2", target.x);
            line.setAttribute("y2", target.y);
            line.setAttribute("class", "link");
            svg.appendChild(line);
        }

        for (const node of data.nodes) {
            const pos = positions.get(node.id);
            const circle = document.createElementNS(svgNS, "circle");
            circle.setAttribute("cx", pos.x);
            circle.setAttribute("cy", pos.y);
            circle.setAttribute("r", node.val + 2);
            circle.setAttribute("class", "node color-" + (node.type || "default"));
            circle.addEventListener("click", () => {
                document.getElementById("node-name").innerText = node.label;
                document.getElementById("node-type").innerText = "Type: " + node.type.toUpperCase() + " | ID: " + node.id;
                for (const el of svg.querySelectorAll("circle")) {
                    el.setAttribute("r", el === circle ? node.val + 8 : Number(el.dataset.baseRadius));
                }
            });
            circle.dataset.baseRadius = String(node.val + 2);
            svg.appendChild(circle);

            if (["file", "class", "function", "annotation"].includes(node.type)) {
                const label = document.createElementNS(svgNS, "text");
                label.setAttribute("x", pos.x);
                label.setAttribute("y", pos.y - 10);
                label.setAttribute("text-anchor", "middle");
                label.setAttribute("fill", "#94a3b8");
                label.setAttribute("font-size", "10px");
                label.textContent = node.label;
                svg.appendChild(label);
            }
        }
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
  console.log(`🔬 quarkify v1.0.0 — ${CONFIG.name} 시작...`);
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
  console.log(` 📁 경로:             ${path.resolve(CONFIG.outDir)}`);
  console.log('=============================================\n');
}
main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
