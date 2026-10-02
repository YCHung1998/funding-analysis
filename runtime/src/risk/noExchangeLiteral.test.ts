import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 2.3 / HANDOFF §3 Invariant #3: no check in runtime/src/risk/ may
// branch on an exchange name literal — all exchange differences must come
// in as injected data (PreTradeContext/EntryContext/PositionContext's
// `long`/`short` leg maps), never as a conditional on 'Binance'/'Bybit'/etc.
const RISK_DIR = resolve(__dirname, '.');
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

describe('runtime/src/risk architecture', () => {
  it('不得以交易所名稱字面值做條件分支（Invariant #3）', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(RISK_DIR)) {
      const code = readFileSync(file, 'utf8');
      for (const literal of EXCHANGE_LITERALS) {
        if (code.includes(`'${literal}'`) || code.includes(`"${literal}"`)) {
          violations.push(`${relative(RISK_DIR, file)} contains literal '${literal}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
