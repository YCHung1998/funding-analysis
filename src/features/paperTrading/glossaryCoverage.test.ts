import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  FUNDING_SETTLEMENT_STATUSES,
  GLOSSARY,
  LEG_STATUSES,
  OPPORTUNITY_STATUSES,
  ORDER_STATES,
  TRADE_STATUSES,
  TRADING_EVENT_TYPES,
  getGlossaryEntry,
} from './api/contracts';

/**
 * spec.md Requirement "狀態代碼以英文顯示並由單一術語表提供中文說明":
 * every code the UI can show for Trade/Leg/Order/FundingSettlement/
 * Opportunity/TradingEventType MUST have a glossary entry.
 *
 * NOTE: Runtime Health status codes (RUNNING/CONNECTED/HEALTHY/ARMED/STALE/
 * RUNTIME_UNREACHABLE/...) are NOT covered here. design.md assumption A-3
 * assigns that glossary coverage to `trading-schema-types` +
 * `runtime-health-reconciliation` adding a `HEALTH` category to
 * runtime/src/types/glossary.ts — neither has landed it yet, and this
 * change must not edit runtime/src/. Until then, RuntimeHealthPanel's
 * StatusCode usages fall back to the spec's documented "術語表缺少此代碼"
 * path, which is itself a tested, non-throwing requirement (see
 * StatusCode.test.tsx). This is a flagged gap, not a silent one.
 */
describe('glossary covers every UI-visible status / event code (except Health — see note above)', () => {
  it.each(TRADE_STATUSES)('TRADE %s', (code) => {
    expect(getGlossaryEntry('TRADE', code)).toBeDefined();
  });
  it.each(LEG_STATUSES)('LEG %s', (code) => {
    expect(getGlossaryEntry('LEG', code)).toBeDefined();
  });
  it.each(ORDER_STATES)('ORDER %s', (code) => {
    expect(getGlossaryEntry('ORDER', code)).toBeDefined();
  });
  it.each(FUNDING_SETTLEMENT_STATUSES)('FUNDING %s', (code) => {
    expect(getGlossaryEntry('FUNDING', code)).toBeDefined();
  });
  it.each(OPPORTUNITY_STATUSES)('OPPORTUNITY %s', (code) => {
    expect(getGlossaryEntry('OPPORTUNITY', code)).toBeDefined();
  });
  it.each(TRADING_EVENT_TYPES)('EVENT %s', (code) => {
    expect(getGlossaryEntry('EVENT', code)).toBeDefined();
  });
});

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no second glossary inside src/features/paperTrading (spec.md "UI 不得有第二份術語表")', () => {
  const dir = join(__dirname);
  if (!existsSync(dir)) throw new Error('paperTrading directory missing');
  const files = listSourceFiles(dir);
  const zhNames = GLOSSARY.map((e) => e.zh);

  it('scanned at least one source file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(zhNames)('the literal %j does not appear as a hardcoded string in any paperTrading source file', (zh) => {
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Allow the literal to appear only as data read FROM the glossary
      // itself (contracts.ts re-exports it) — exclude that one file.
      if (file.endsWith(`${join('api', 'contracts.ts')}`)) continue;
      const quoted = new RegExp(`['"\`]${zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
      expect(quoted.test(content)).toBe(false);
    }
  });
});
