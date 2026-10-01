/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * net-cost-model spec "研究端 live-scan 使用成本模型": "前端 MUST 使用伺服器回傳的淨值，MUST NOT
 * 以 spread − fee_drag_pct − est_slippage_pct 自行重算". This looks up one exchange pair's
 * server-computed `net_spread_pct` from `LiveMarketCandidate.pair_net_spreads` (keyed
 * `${long}_${short}` in whatever order the server matched them), trying both orderings since the
 * UI doesn't know in advance which side the server treated as long/short.
 */
export function pairNetSpreadFor(
  item: { pair_net_spreads?: Record<string, number> },
  exA: string,
  exB: string,
): number | undefined {
  const spreads = item.pair_net_spreads;
  if (!spreads) return undefined;
  return spreads[`${exA}_${exB}`] ?? spreads[`${exB}_${exA}`];
}
