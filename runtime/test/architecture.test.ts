import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// runtime/ 的架構守門：違反時列出檔案，讓 PR 在 npm test 就失敗。
const RUNTIME_SRC = resolve(__dirname, '../src');
const REPO_SRC = resolve(__dirname, '../../src');
const MARKET_SRC = resolve(__dirname, '../src/market');

// 唯一允許直接讀系統時間 / 排程的檔案（paper-trading-event-loop 的 RealClock）。
const SYSTEM_TIME_ALLOWLIST = ['clock/realClock.ts'];

// websocket-data-layer spec「Clock-driven timing without exchange branching」：
// runtime/src/market/（不含 adapters/）不得出現交易所名稱字面值。
const EXCHANGE_LITERALS = ['Binance', 'Bybit', 'OKX', 'Bitget', 'Pionex'];

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function findSystemTimeViolations(root: string, allowlist: string[]): string[] {
  return sourceFiles(root)
    .filter((file) => !allowlist.includes(relative(root, file).split(sep).join('/')))
    .filter((file) => /\b(Date\.now|setTimeout|setInterval)\s*\(/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(root, file));
}

function findExchangeLiteralViolations(root: string, literals: string[]): string[] {
  const pattern = new RegExp(`'(${literals.join('|')})'|"(${literals.join('|')})"`);
  return sourceFiles(root)
    .filter((file) => pattern.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(root, file));
}

function findResearchImports(root: string, researchSrc: string): string[] {
  const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  return sourceFiles(root).flatMap((file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    return [...code.matchAll(importPattern)]
      .map((m) => resolve(dirname(file), m[1]))
      .filter((target) => target === researchSrc || target.startsWith(researchSrc + sep))
      .map((target) => `${relative(root, file)} -> ${relative(resolve(root, '../..'), target)}`);
  });
}

describe('runtime architecture', () => {
  it('runtime/src 除 RealClock 外不得直接呼叫 Date.now / setTimeout / setInterval（請注入 Clock）', () => {
    expect(findSystemTimeViolations(RUNTIME_SRC, SYSTEM_TIME_ALLOWLIST)).toEqual([]);
  });

  it('runtime/src 不得 import 研究原型 src/（C-11 規則 3：新邏輯不依賴舊檔案）', () => {
    expect(findResearchImports(RUNTIME_SRC, REPO_SRC)).toEqual([]);
  });

  it('runtime/src/market/（不含 adapters）不得出現交易所名稱字面值（websocket-data-layer spec）', () => {
    expect(findExchangeLiteralViolations(MARKET_SRC, EXCHANGE_LITERALS)).toEqual([]);
  });
});
