/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure live-scan calculations extracted verbatim from server.ts (transitional server layer).
 * No side effects on import: no Express, no Vite, no .env, no fetch.
 */

/**
 * Normalizes symbols into standard base symbol (e.g. BTC_USDT_PERP -> BTC, BTC-USDT-SWAP -> BTC, 1000PEPEUSDT -> PEPE)
 */
export function extractBaseSymbol(raw: string): string {
  let s = raw.toUpperCase()
    .replace('-SWAP', '')
    .replace('_PERP', '')
    .replace('_USDT', '')
    .replace('-USDT', '')
    .replace('USDT', '')
    .replace(/[-_]/g, '');

  if (s.startsWith('1000000')) s = s.replace('1000000', '');
  else if (s.startsWith('100000')) s = s.replace('100000', '');
  else if (s.startsWith('10000')) s = s.replace('10000', '');
  else if (s.startsWith('1000')) s = s.replace('1000', '');

  return s;
}

export function findBestPair<E extends string>(rates: Partial<Record<E, number>>, exchanges: readonly E[]): {
  activeExchanges: E[];
  maxSpread: number;
  bestLongEx: E;
  bestShortEx: E;
  pairSpreads: Record<string, number>;
} | null {
      const activeExchanges = exchanges.filter(ex => rates[ex] !== undefined);
      if (activeExchanges.length < 2) return null;

      let maxSpread = 0;
      let bestLongEx: E = activeExchanges[0];
      let bestShortEx: E = activeExchanges[1];

      const pairSpreads: Record<string, number> = {};

      for (let i = 0; i < activeExchanges.length; i++) {
        for (let j = i + 1; j < activeExchanges.length; j++) {
          const exA = activeExchanges[i];
          const exB = activeExchanges[j];
          const rateA = rates[exA]!;
          const rateB = rates[exB]!;
          const spread = Math.abs(rateA - rateB);

          pairSpreads[`${exA}_${exB}`] = spread;

          if (spread > maxSpread) {
            maxSpread = spread;
            if (rateA < rateB) {
              bestLongEx = exA;
              bestShortEx = exB;
            } else {
              bestLongEx = exB;
              bestShortEx = exA;
            }
          }
        }
      }

  return { activeExchanges, maxSpread, bestLongEx, bestShortEx, pairSpreads };
}

export function resolveSettlement(
  nextFundingTimes: Partial<Record<string, number>>,
  intervalsByExchange: Partial<Record<string, number>>,
  now: number,
): { nextFundingTime: number; timeToSettlementSec: number; intervalHours: number } {
      const validTimes = Object.values(nextFundingTimes).filter((t): t is number => typeof t === 'number' && t > now);
      const nextFundingTime = validTimes.length > 0 ? Math.min(...validTimes) : now + 8 * 3600 * 1000;
      const timeToSettlementSec = Math.max(Math.floor((nextFundingTime - now) / 1000), 0);

      const intervals = Object.values(intervalsByExchange).filter((v): v is number => typeof v === 'number');
      const intervalHours = intervals.length > 0 ? Math.min(...intervals) : 8;

  return { nextFundingTime, timeToSettlementSec, intervalHours };
}

export function computeLiveScanNetPnl(maxSpread: number, volume24h: number): {
  estSlippagePct: number;
  feeDragPct: number;
  expectedNetPnlPct: number;
  expectedNetPnlUsdt: number;
  meetsThreshold: boolean;
} {
      const estSlippagePct = volume24h > 100000000 ? 0.00015 : volume24h > 20000000 ? 0.0003 : 0.0005;
      const totalSlippagePct = estSlippagePct * 4;
      const fixedFeeDragPct = 0.0020; // 0.20%
      const expectedNetPnlPct = maxSpread - fixedFeeDragPct - totalSlippagePct;

  return {
    estSlippagePct: totalSlippagePct,
    feeDragPct: fixedFeeDragPct,
    expectedNetPnlPct,
    expectedNetPnlUsdt: 1000 * expectedNetPnlPct,
    meetsThreshold: maxSpread >= 0.0020,
  };
}
