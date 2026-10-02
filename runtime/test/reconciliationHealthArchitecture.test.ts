/**
 * runtime/test/reconciliationHealthArchitecture.test.ts
 *
 * Mirrors `executionArchitecture.test.ts`'s "no exchange-name string
 * literal" guard (Invariant #3) for the `runtime-health-reconciliation`
 * capability's own directories: `runtime/src/reconciliation/` and
 * `runtime/src/health/`. Kept as a separate file (rather than extending the
 * `paper-execution-engine` test's `dirs` array) since this change owns a
 * different capability and should carry its own architecture guard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNTIME_SRC = resolve(__dirname, '../src');
const RECONCILIATION_DIR = resolve(RUNTIME_SRC, 'reconciliation');
const HEALTH_DIR = resolve(RUNTIME_SRC, 'health');

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

describe('runtime-health-reconciliation architecture guards', () => {
  it('runtime/src/reconciliation/ and runtime/src/health/ contain no exchange-name string literal', () => {
    const offenders: string[] = [];
    for (const dir of [RECONCILIATION_DIR, HEALTH_DIR]) {
      for (const file of sourceFiles(dir)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        for (const literal of EXCHANGE_LITERALS) {
          if (code.includes(`'${literal}'`) || code.includes(`"${literal}"`)) {
            offenders.push(`${relative(RUNTIME_SRC, file)} contains literal '${literal}'`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime/src/reconciliation/ and runtime/src/health/ exist and contain at least one source file (guard is not vacuous)', () => {
    const files = [...sourceFiles(RECONCILIATION_DIR), ...sourceFiles(HEALTH_DIR)];
    expect(files.length).toBeGreaterThan(0);
  });
});
