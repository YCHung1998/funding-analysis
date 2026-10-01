import { describe, expect, it } from 'vitest';
import {
  ORDER_STATES,
  TRADE_STATUSES,
  LEG_STATUSES,
  OPPORTUNITY_STATUSES,
  FUNDING_SETTLEMENT_STATUSES,
} from './status';
import { TRADING_EVENT_TYPES } from './event';
import { GLOSSARY, getGlossaryEntry } from './glossary';

describe('glossary completeness (spec.md "Glossary as single source for codes")', () => {
  it('every status/event code has exactly one entry with non-empty zh and definition_zh', () => {
    const groups: Array<[readonly string[], string]> = [
      [ORDER_STATES, 'ORDER'],
      [TRADE_STATUSES, 'TRADE'],
      [LEG_STATUSES, 'LEG'],
      [OPPORTUNITY_STATUSES, 'OPPORTUNITY'],
      [FUNDING_SETTLEMENT_STATUSES, 'FUNDING'],
      [TRADING_EVENT_TYPES, 'EVENT'],
    ];
    for (const [codes, category] of groups) {
      for (const code of codes) {
        const matches = GLOSSARY.filter((e) => e.code === code && e.category === category);
        expect(matches.length, `${category}/${code} should have exactly one entry`).toBe(1);
        expect(matches[0].zh.length).toBeGreaterThan(0);
        expect(matches[0].definition_zh.length).toBeGreaterThan(0);
      }
    }
  });

  it('entries are unique per (category, code) pair', () => {
    const seen = new Set<string>();
    for (const e of GLOSSARY) {
      const key = `${e.category}/${e.code}`;
      expect(seen.has(key), `duplicate glossary entry ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe('getGlossaryEntry', () => {
  it('PARTIALLY_HEDGED under TRADE matches spec §26.2 text verbatim', () => {
    const entry = getGlossaryEntry('TRADE', 'PARTIALLY_HEDGED');
    expect(entry?.zh).toBe('部分對沖');
    expect(entry?.definition_zh).toBe('兩腿都有成交，hedge ratio 介於兩門檻之間，正在補足');
  });

  it('CLOSED has distinct entries under TRADE and LEG', () => {
    const trade = getGlossaryEntry('TRADE', 'CLOSED');
    const leg = getGlossaryEntry('LEG', 'CLOSED');
    expect(trade?.zh).toBe('已結束');
    expect(leg?.zh).toBe('已平倉');
    expect(trade?.zh).not.toBe(leg?.zh);
  });
});
