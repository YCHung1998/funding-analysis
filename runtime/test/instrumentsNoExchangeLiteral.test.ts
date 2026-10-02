import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// spec「No exchange-name branching outside adapters」: runtime/src/market/instruments/ 下
// 任一非測試原始檔都不得出現交易所名稱字面值。
const INSTRUMENTS_DIR = resolve(__dirname, '../src/market/instruments');
const EXCHANGE_LITERALS = ['Binance', 'Bybit', 'OKX', 'Bitget', 'Pionex'];

// types.ts 排除在外：ExchangeId 的聯集型別本身必須列舉交易所名稱（design.md
// 跨 change 假設 A2，trading-schema-types 合併前的本地型別），這是型別宣告而非條件分支。
const EXCLUDED_FILES = ['types.ts'];

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
    if (EXCLUDED_FILES.includes(name)) return [];
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('runtime/src/market/instruments architecture', () => {
  it('不得以交易所名稱字面值做條件分支（Invariant #3）', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(INSTRUMENTS_DIR)) {
      const code = readFileSync(file, 'utf8');
      for (const literal of EXCHANGE_LITERALS) {
        if (code.includes(`'${literal}'`) || code.includes(`"${literal}"`)) {
          violations.push(`${relative(INSTRUMENTS_DIR, file)} contains literal '${literal}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
