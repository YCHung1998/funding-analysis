/**
 * runtime/test/executionArchitecture.test.ts
 *
 * Task 1.1 source checks (spec "Replaceable execution interface" /
 * "Simulated latency and reproducible failure injection"):
 *  - `runtime/src/trading/` and `runtime/src/strategy/` MUST NOT import
 *    `paperExecution` (Scenario "Coordinators do not know the implementation").
 *  - `runtime/src/` MUST NOT contain a real exchange order-placement endpoint
 *    string, and `runtime/src/execution/` MUST NOT contain an HTTP client
 *    (Scenario "No real order endpoints", Invariant #1).
 *  - `runtime/src/execution/` and `runtime/src/trading/` MUST NOT contain an
 *    exchange-name string literal (Scenario "No exchange-name branches",
 *    Invariant #3).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNTIME_SRC = resolve(__dirname, '../src');
const TRADING_DIR = resolve(RUNTIME_SRC, 'trading');
const STRATEGY_DIR = resolve(RUNTIME_SRC, 'strategy');
const EXECUTION_DIR = resolve(RUNTIME_SRC, 'execution');

const EXCHANGE_LITERALS = ['Binance', 'Bybit', 'OKX', 'Bitget', 'Pionex'];
const REAL_ORDER_ENDPOINTS = ['/fapi/v1/order', '/v5/order/create', '/v5/order/cancel', '/api/v5/trade/order'];

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

describe('paper-execution-engine architecture guards', () => {
  it('runtime/src/trading/ and runtime/src/strategy/ do not import paperExecution', () => {
    const offenders: string[] = [];
    for (const dir of [TRADING_DIR, STRATEGY_DIR]) {
      for (const file of sourceFiles(dir)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (/from\s+['"][^'"]*paperExecution['"]/.test(code) || /import\s*\(\s*['"][^'"]*paperExecution['"]\s*\)/.test(code)) {
          offenders.push(relative(RUNTIME_SRC, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime/src/ contains no real exchange order-placement endpoint string', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(RUNTIME_SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const endpoint of REAL_ORDER_ENDPOINTS) {
        if (code.includes(endpoint)) offenders.push(`${relative(RUNTIME_SRC, file)} contains "${endpoint}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime/src/execution/ contains no HTTP client', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(EXECUTION_DIR)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (/\bfetch\s*\(|\bXMLHttpRequest\b|from\s+['"]node:https?['"]|from\s+['"]axios['"]/.test(code)) {
        offenders.push(relative(RUNTIME_SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime/src/execution/ and runtime/src/trading/ contain no exchange-name string literal', () => {
    const offenders: string[] = [];
    for (const dir of [EXECUTION_DIR, TRADING_DIR]) {
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
});
