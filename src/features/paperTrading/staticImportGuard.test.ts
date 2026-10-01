import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * spec.md Requirement "既有 Dry-Run 與 Execution Simulator 分頁明確標示為非
 * Paper": "Paper Trading 分頁 MUST NOT 讀取或匯入 dryRunEngine、
 * mockMarketData、arbitrageEngine 的任何資料." Static scan, task 1.1.
 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const FORBIDDEN_IMPORTS = [/dryRunEngine/, /mockMarketData/, /arbitrageEngine/];

describe('src/features/paperTrading does not import the frozen dry-run / mock engines', () => {
  // Exclude this test file itself — it legitimately mentions the forbidden
  // names as string literals to scan for them.
  const files = listSourceFiles(__dirname).filter((f) => f !== __filename);

  it('scanned at least one source file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s has no forbidden import', (file) => {
    const content = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_IMPORTS) {
      expect(pattern.test(content)).toBe(false);
    }
  });
});
