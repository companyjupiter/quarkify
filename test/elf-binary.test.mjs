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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-elf-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function listRelativeEntries(dir, root = dir) {
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    entries.push(path.relative(root, fullPath));
    if (entry.isDirectory()) {
      entries.push(...await listRelativeEntries(fullPath, root));
    }
  }
  return entries;
}

// A minimal but real little-endian AArch64 ELF64 with a symbol table, built in
// memory. Generating it keeps a compiled artifact out of the repository and
// keeps the test independent of any toolchain being installed.
function buildMinimalElf() {
  const SHNUM = 5; // NULL, .text, .symtab, .strtab, .shstrtab
  const EHSIZE = 64;
  const SHENTSIZE = 64;

  const shstrtab = Buffer.from('\0.text\0.symtab\0.strtab\0.shstrtab\0', 'binary');
  const NAME_TEXT = 1;
  const NAME_SYMTAB = 7;
  const NAME_STRTAB = 15;
  const NAME_SHSTRTAB = 23;

  const strtab = Buffer.from('\0definedFunc\0externalFunc\0', 'binary');
  const NAME_DEFINED = 1;
  const NAME_EXTERNAL = 13;

  // 3 entries: null, a defined FUNC in .text, an undefined FUNC.
  const symtab = Buffer.alloc(3 * 24);
  const writeSym = (i, nameOff, info, shndx, value, size) => {
    const o = i * 24;
    symtab.writeUInt32LE(nameOff, o);
    symtab.writeUInt8(info, o + 4);
    symtab.writeUInt8(0, o + 5);
    symtab.writeUInt16LE(shndx, o + 6);
    symtab.writeBigUInt64LE(BigInt(value), o + 8);
    symtab.writeBigUInt64LE(BigInt(size), o + 16);
  };
  writeSym(0, 0, 0, 0, 0, 0);
  writeSym(1, NAME_DEFINED, (1 << 4) | 2, 1, 0x1000, 512);  // GLOBAL FUNC in .text
  writeSym(2, NAME_EXTERNAL, (1 << 4) | 2, 0, 0, 0);        // GLOBAL FUNC, UNDEF

  const textBody = Buffer.alloc(16);

  let offset = EHSIZE + SHNUM * SHENTSIZE;
  const place = (buf) => {
    const at = offset;
    offset += buf.length;
    return at;
  };
  const textOff = place(textBody);
  const symtabOff = place(symtab);
  const strtabOff = place(strtab);
  const shstrtabOff = place(shstrtab);

  const header = Buffer.alloc(EHSIZE);
  header.writeUInt32BE(0x7f454c46, 0);   // \x7fELF
  header.writeUInt8(2, 4);               // ELFCLASS64
  header.writeUInt8(1, 5);               // ELFDATA2LSB
  header.writeUInt8(1, 6);               // EV_CURRENT
  header.writeUInt16LE(3, 0x10);         // ET_DYN
  header.writeUInt16LE(183, 0x12);       // EM_AARCH64
  header.writeUInt32LE(1, 0x14);
  header.writeBigUInt64LE(BigInt(EHSIZE), 0x28); // e_shoff
  header.writeUInt16LE(EHSIZE, 0x34);
  header.writeUInt16LE(SHENTSIZE, 0x3a);
  header.writeUInt16LE(SHNUM, 0x3c);
  header.writeUInt16LE(4, 0x3e);         // e_shstrndx

  const sh = Buffer.alloc(SHNUM * SHENTSIZE);
  const writeSection = (i, nameOff, type, addr, off, size, link, entsize) => {
    const o = i * SHENTSIZE;
    sh.writeUInt32LE(nameOff, o);
    sh.writeUInt32LE(type, o + 4);
    sh.writeBigUInt64LE(BigInt(addr), o + 16);
    sh.writeBigUInt64LE(BigInt(off), o + 24);
    sh.writeBigUInt64LE(BigInt(size), o + 32);
    sh.writeUInt32LE(link, o + 40);
    sh.writeBigUInt64LE(BigInt(entsize), o + 56);
  };
  writeSection(0, 0, 0, 0, 0, 0, 0, 0);
  writeSection(1, NAME_TEXT, 1, 0x1000, textOff, textBody.length, 0, 0);      // .text PROGBITS
  writeSection(2, NAME_SYMTAB, 2, 0, symtabOff, symtab.length, 3, 24);        // .symtab -> link .strtab
  writeSection(3, NAME_STRTAB, 3, 0, strtabOff, strtab.length, 0, 0);
  writeSection(4, NAME_SHSTRTAB, 3, 0, shstrtabOff, shstrtab.length, 0, 0);

  return Buffer.concat([header, sh, textBody, symtab, strtab, shstrtab]);
}

test('an ELF binary is quarkized by symbol, section, address and size', async () => {
  await withTempWorkspace(async (workspace) => {
    const srcDir = path.join(workspace, 'src');
    const outDir = path.join(workspace, 'out');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'libsample.so'), buildMinimalElf());

    const configPath = path.join(workspace, 'config.json');
    await writeFile(configPath, JSON.stringify({
      name: 'elf-sample',
      srcDir,
      outDir,
      sourceFiles: ['libsample.so'],
      perfData: {},
    }), 'utf8');

    const result = spawnSync(process.execPath, [cliPath, configPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const entries = await listRelativeEntries(path.join(outDir, 'quark'));
    const has = (suffix) => entries.some((entry) => entry.endsWith(suffix));

    assert.ok(has('binary__libsample.so'), 'binary folder');
    assert.ok(has(path.join('machine__AArch64')), 'machine folder');
    assert.ok(has(path.join('section__.text', 'sym__definedFunc')), 'defined symbol under its section');
    // Compiled size, not a line count — the whole reason to read the binary.
    assert.ok(has(path.join('sym__definedFunc', 'size__512')), 'symbol size');
    assert.ok(has(path.join('sym__definedFunc', 'addr__0x1000')), 'symbol address');
    assert.ok(has(path.join('sym__definedFunc', 'bind__GLOBAL')), 'symbol binding');
    // What this binary demands from somebody else.
    assert.ok(has(path.join('section__UNDEF', 'sym__externalFunc')), 'undefined symbol');
  });
});

test('a non-ELF source file is still parsed as text', async () => {
  await withTempWorkspace(async (workspace) => {
    const srcDir = path.join(workspace, 'src');
    const outDir = path.join(workspace, 'out');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'plain.zig'), 'pub fn stillText() void {}\n', 'utf8');

    const configPath = path.join(workspace, 'config.json');
    await writeFile(configPath, JSON.stringify({
      name: 'text-still-works',
      srcDir,
      outDir,
      sourceFiles: ['plain.zig'],
      perfData: {},
    }), 'utf8');

    const result = spawnSync(process.execPath, [cliPath, configPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const entries = await listRelativeEntries(path.join(outDir, 'quark'));
    assert.ok(entries.some((entry) => entry.endsWith('fn__stillText')), 'text path unaffected');
  });
});
