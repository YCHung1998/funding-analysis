import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// cost-model spec "策略與掃描層不得寫死手續費": runtime/src/strategy/, runtime/src/scanner/ and the
// research-side net-pnl calculation (server/liveScanMath.ts) MUST only obtain fees through the
// Fee Engine (runtime/src/accounting/feeEngine.ts) — these fee literals (percent-as-decimal, the
// pre-net-cost-model defaults) MUST NOT appear as hardcoded constants. `server.ts` itself is out
// of scope (spec: "server.ts 本體不在掃描範圍").
const REPO_ROOT = resolve(__dirname, '../..');
const SCAN_TARGETS = [resolve(REPO_ROOT, 'runtime/src/strategy'), resolve(REPO_ROOT, 'runtime/src/scanner')];
const LIVE_SCAN_MATH_FILE = resolve(REPO_ROOT, 'server/liveScanMath.ts');

const FEE_LITERALS = ['0.0005', '0.00055', '0.0006', '0.0020', '0.002'];

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

function findLiteralViolations(files: string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const literal of FEE_LITERALS) {
      const pattern = new RegExp(`(?<![0-9.])${literal.replace('.', '\\.')}(?![0-9])`);
      if (pattern.test(code)) {
        violations.push(`${relative(REPO_ROOT, file)} contains fee literal ${literal}`);
      }
    }
  }
  return violations;
}

describe('cost-model: 策略 / 掃描層不得寫死手續費', () => {
  it('runtime/src/strategy/、runtime/src/scanner/ 不得出現手續費字面值', () => {
    const files = SCAN_TARGETS.flatMap((dir) => sourceFiles(dir));
    expect(findLiteralViolations(files)).toEqual([]);
  });

  it('server/liveScanMath.ts 的淨值計算不得出現手續費字面值（改走 Fee Engine，task 5.2）', () => {
    expect(findLiteralViolations([LIVE_SCAN_MATH_FILE])).toEqual([]);
  });
});
