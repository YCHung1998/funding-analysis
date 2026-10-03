/**
 * server/test/paperDbFixture.ts
 *
 * Shared test-only fixture for `paper-trading-read-api`: a temp-dir SQLite
 * file with every migration applied (001-004), writable through the real
 * `trading-event-store` repositories (`createTradeRepository` /
 * `createOrderRepository` / `createAccountRepository`) plus a thin
 * `insertTradeResult` helper for the `trade_results` table this change's
 * task 1.1 added (no repository owns it yet — see
 * `runtime/src/storage/migrations/004_trade_results.ts`'s doc comment).
 * Never touches a real exchange API; never writes to `data/`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteDriver } from '../../runtime/src/storage/driver';
import { migrate } from '../../runtime/src/storage/migrate';
import { migration001 } from '../../runtime/src/storage/migrations/001_initial';
import { migration002 } from '../../runtime/src/storage/migrations/002_position_accounting_fields';
import { migration003 } from '../../runtime/src/storage/migrations/003_runtime_health';
import { migration004 } from '../../runtime/src/storage/migrations/004_trade_results';
import { createAccountRepository } from '../../runtime/src/storage/accountRepository';
import { createOrderRepository } from '../../runtime/src/storage/orderRepository';
import { createTradeRepository } from '../../runtime/src/storage/tradeRepository';
import type { TradeResult } from '../../runtime/src/types/result';

export interface PaperDbFixture {
  path: string;
  driver: NodeSqliteDriver;
  tradeRepo: ReturnType<typeof createTradeRepository>;
  orderRepo: ReturnType<typeof createOrderRepository>;
  accountRepo: ReturnType<typeof createAccountRepository>;
  insertTradeResult(result: TradeResult): void;
  close(): void;
}

const TRADE_RESULT_COLUMNS = [
  'trade_id',
  'symbol',
  'mode',
  'long_exchange',
  'short_exchange',
  'target_notional_per_leg_usdt',
  'actual_long_notional_usdt',
  'actual_short_notional_usdt',
  'leverage',
  'entry_duration_ms',
  'exit_duration_ms',
  'total_trade_duration_ms',
  'funding_pnl_usdt',
  'price_pnl_usdt',
  'fee_usdt',
  'slippage_attribution_usdt',
  'net_pnl_usdt',
  'roi_on_capital_pct',
  'roi_on_notional_pct',
  'max_leg_imbalance_usdt',
  'max_leg_imbalance_duration_ms',
  'final_status',
  'result_reason',
  'finalized_at',
  'funding_confirmed',
  'created_at',
  'updated_at',
] as const;

export function createPaperDbFixture(): PaperDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'paper-read-api-test-'));
  const path = join(dir, 'paper.sqlite');
  const driver = new NodeSqliteDriver(path);
  migrate(driver, [migration001, migration002, migration003, migration004]);

  const upsertResult = driver.prepare(
    `INSERT INTO trade_results (${TRADE_RESULT_COLUMNS.join(', ')}) VALUES (${TRADE_RESULT_COLUMNS.map(() => '?').join(', ')})
     ON CONFLICT(trade_id) DO UPDATE SET ${TRADE_RESULT_COLUMNS.filter((c) => c !== 'trade_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );

  return {
    path,
    driver,
    tradeRepo: createTradeRepository(driver),
    orderRepo: createOrderRepository(driver),
    accountRepo: createAccountRepository(driver),
    insertTradeResult(result) {
      upsertResult.run(
        result.trade_id,
        result.symbol,
        result.mode,
        result.long_exchange,
        result.short_exchange,
        result.target_notional_per_leg_usdt,
        result.actual_long_notional_usdt,
        result.actual_short_notional_usdt,
        result.leverage,
        result.entry_duration_ms,
        result.exit_duration_ms,
        result.total_trade_duration_ms,
        result.funding_pnl_usdt,
        result.price_pnl_usdt,
        result.fee_usdt,
        result.slippage_attribution_usdt,
        result.net_pnl_usdt,
        result.roi_on_capital_pct,
        result.roi_on_notional_pct,
        result.max_leg_imbalance_usdt,
        result.max_leg_imbalance_duration_ms,
        result.final_status,
        result.result_reason,
        result.finalized_at ?? null,
        result.funding_confirmed ? 1 : 0,
        result.created_at,
        result.updated_at,
      );
    },
    close() {
      driver.close();
    },
  };
}
