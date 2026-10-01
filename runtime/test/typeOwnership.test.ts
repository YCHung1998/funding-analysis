import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// trading-schema-types capability guard: outside runtime/src/types/, no file
// under runtime/src/ may declare a type/interface with one of these names
// (spec.md "Single source of v0.2 trading types": "No other module under
// `runtime/src/` MAY declare a type with any of these names.").
const RUNTIME_SRC = resolve(__dirname, '../src');
const TYPES_DIR = resolve(RUNTIME_SRC, 'types');

const RESERVED_TYPE_NAMES = [
  'ExchangeId',
  'Opportunity',
  'Trade',
  'TradeLeg',
  'PaperOrder',
  'OrderState',
  'Fill',
  'FundingSettlement',
  'TradeResult',
  'TradingEvent',
  'TradingEventType',
  'RiskCheck',
  'RiskStatusReport',
  'RiskCheckItem',
  'AccountSnapshot',
  'PaperPosition',
  'OpportunityStatus',
  'TradeStatus',
  'LegStatus',
  'FundingSettlementStatus',
];

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

function findDuplicateDeclarations(root: string, excludeDir: string, names: readonly string[]): string[] {
  const declPattern = /\b(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
  const violations: string[] = [];
  for (const file of sourceFiles(root)) {
    if (file === excludeDir || file.startsWith(excludeDir + sep)) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const match of code.matchAll(declPattern)) {
      if (names.includes(match[1])) {
        violations.push(`${relative(root, file)} declares ${match[1]}`);
      }
    }
  }
  return violations;
}

describe('trading-schema type ownership guard', () => {
  it('outside runtime/src/types/, no file declares a reserved trading-schema type name', () => {
    expect(findDuplicateDeclarations(RUNTIME_SRC, TYPES_DIR, RESERVED_TYPE_NAMES)).toEqual([]);
  });
});
