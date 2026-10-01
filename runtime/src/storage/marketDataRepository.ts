/**
 * runtime/src/storage/marketDataRepository.ts
 *
 * `market_events` + `funding_rates` (design.md §7). This change only owns
 * the table and round trip — the content/semantics of what gets written is
 * owned by `market-data-stream` (proposal.md Non-goals). Row shapes are
 * declared locally (not in `runtime/src/types/`, which is owned by
 * `trading-schema-types`) per `runtime/README.md` ownership rules.
 */
import type { ExchangeId } from '../types/ids';
import type { SqliteDriver } from './driver';
import { jsonFromRow, jsonToRow, optionalFromRow, optionalToRow } from './rowMapping';

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export interface MarketEventRow {
  market_event_id: string;
  exchange: ExchangeId;
  symbol: string;
  event_type: string;
  exchange_timestamp?: number;
  local_received_timestamp: number;
  sequence?: number;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface FundingRateRow {
  funding_rate_id: string;
  exchange: ExchangeId;
  symbol: string;
  funding_rate: number;
  funding_time: number;
  interval_hours?: number;
  recorded_at: number;
  created_at: number;
}

const MARKET_EVENT_COLUMNS = [
  'market_event_id',
  'exchange',
  'symbol',
  'event_type',
  'exchange_timestamp',
  'local_received_timestamp',
  'sequence',
  'payload',
  'created_at',
] as const;

function marketEventToRow(e: MarketEventRow): unknown[] {
  return [
    e.market_event_id,
    e.exchange,
    e.symbol,
    e.event_type,
    optionalToRow(e.exchange_timestamp),
    e.local_received_timestamp,
    optionalToRow(e.sequence),
    jsonToRow(e.payload),
    e.created_at,
  ];
}

interface MarketEventSqlRow {
  market_event_id: string;
  exchange: ExchangeId;
  symbol: string;
  event_type: string;
  exchange_timestamp: number | null;
  local_received_timestamp: number;
  sequence: number | null;
  payload: string;
  created_at: number;
}

function rowToMarketEvent(row: MarketEventSqlRow): MarketEventRow {
  return {
    market_event_id: row.market_event_id,
    exchange: row.exchange,
    symbol: row.symbol,
    event_type: row.event_type,
    exchange_timestamp: optionalFromRow(row.exchange_timestamp),
    local_received_timestamp: row.local_received_timestamp,
    sequence: optionalFromRow(row.sequence),
    payload: jsonFromRow(row.payload),
    created_at: row.created_at,
  };
}

const FUNDING_RATE_COLUMNS = [
  'funding_rate_id',
  'exchange',
  'symbol',
  'funding_rate',
  'funding_time',
  'interval_hours',
  'recorded_at',
  'created_at',
] as const;

function fundingRateToRow(r: FundingRateRow): unknown[] {
  return [r.funding_rate_id, r.exchange, r.symbol, r.funding_rate, r.funding_time, optionalToRow(r.interval_hours), r.recorded_at, r.created_at];
}

interface FundingRateSqlRow {
  funding_rate_id: string;
  exchange: ExchangeId;
  symbol: string;
  funding_rate: number;
  funding_time: number;
  interval_hours: number | null;
  recorded_at: number;
  created_at: number;
}

function rowToFundingRate(row: FundingRateSqlRow): FundingRateRow {
  return {
    funding_rate_id: row.funding_rate_id,
    exchange: row.exchange,
    symbol: row.symbol,
    funding_rate: row.funding_rate,
    funding_time: row.funding_time,
    interval_hours: optionalFromRow(row.interval_hours),
    recorded_at: row.recorded_at,
    created_at: row.created_at,
  };
}

export interface MarketDataRepository {
  saveMarketEvent(event: MarketEventRow): void;
  listMarketEvents(filter: { exchange: ExchangeId; symbol: string }): MarketEventRow[];
  saveFundingRate(rate: FundingRateRow): void;
  listFundingRates(filter: { exchange: ExchangeId; symbol: string }): FundingRateRow[];
}

/** No method here deletes rows. */
export function createMarketDataRepository(db: SqliteDriver): MarketDataRepository {
  const upsertMarketEvent = db.prepare(
    `INSERT INTO market_events (${MARKET_EVENT_COLUMNS.join(', ')}) VALUES (${placeholders(MARKET_EVENT_COLUMNS.length)})
     ON CONFLICT(market_event_id) DO UPDATE SET ${MARKET_EVENT_COLUMNS.filter((c) => c !== 'market_event_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectMarketEvents = db.prepare(
    `SELECT * FROM market_events WHERE exchange = ? AND symbol = ? ORDER BY local_received_timestamp ASC`,
  );

  const upsertFundingRate = db.prepare(
    `INSERT INTO funding_rates (${FUNDING_RATE_COLUMNS.join(', ')}) VALUES (${placeholders(FUNDING_RATE_COLUMNS.length)})
     ON CONFLICT(funding_rate_id) DO UPDATE SET ${FUNDING_RATE_COLUMNS.filter((c) => c !== 'funding_rate_id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
  );
  const selectFundingRates = db.prepare(`SELECT * FROM funding_rates WHERE exchange = ? AND symbol = ? ORDER BY funding_time ASC`);

  return {
    saveMarketEvent(event) {
      upsertMarketEvent.run(...marketEventToRow(event));
    },
    listMarketEvents(filter) {
      const rows = selectMarketEvents.all(filter.exchange, filter.symbol) as MarketEventSqlRow[];
      return rows.map(rowToMarketEvent);
    },
    saveFundingRate(rate) {
      upsertFundingRate.run(...fundingRateToRow(rate));
    },
    listFundingRates(filter) {
      const rows = selectFundingRates.all(filter.exchange, filter.symbol) as FundingRateSqlRow[];
      return rows.map(rowToFundingRate);
    },
  };
}
