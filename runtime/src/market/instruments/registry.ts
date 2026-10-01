/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 記憶體版 Instrument Registry（design.md Decision 1/2/5/7、spec 多項 Requirement）。
 * 不得以交易所名稱做條件分支（Invariant #3）。
 */

import type {
  EventSink,
  ExchangeId,
  FundingSchedule,
  FundingScheduleUpdate,
  Instrument,
  InstrumentSnapshotInput,
  InstrumentSourceStatus,
  RegistryDiff,
  ScheduleStatus,
  UpdateFundingScheduleResult,
} from './types';
import type { TradingEventType } from '../../types/event';

const SPEC_FIELDS = ['price_multiplier', 'qty_unit_in_base', 'tick_size', 'qty_step', 'min_qty', 'min_notional'] as const;
type SpecField = (typeof SPEC_FIELDS)[number];

function computeScheduleStatus(funding: Pick<FundingSchedule, 'next_funding_time'>, now: number): ScheduleStatus {
  if (funding.next_funding_time === null) return 'MISSING';
  if (funding.next_funding_time <= now) return 'STALE';
  return 'VALID';
}

type ChangeListener = (diff: RegistryDiff) => void;

export class InstrumentRegistry {
  private readonly instruments = new Map<string, Instrument>();
  private readonly byExchange = new Map<ExchangeId, Map<string, Instrument>>();
  private readonly sourceStatuses = new Map<ExchangeId, InstrumentSourceStatus>();
  private readonly listeners = new Set<ChangeListener>();
  private registryVersion = 0;

  constructor(private readonly eventSink: EventSink) {}

  private emit(timestamp: number, eventType: TradingEventType, exchange: ExchangeId | null, symbol: string | null, payload: Record<string, unknown>): void {
    this.eventSink.emit({
      event_id: crypto.randomUUID(),
      event_type: eventType,
      timestamp,
      recorded_at: timestamp,
      trade_id: null,
      ...(exchange !== null && { exchange }),
      ...(symbol !== null && { symbol }),
      payload,
    });
  }

  get(exchange: ExchangeId, nativeSymbol: string): Instrument | undefined {
    return this.instruments.get(`${exchange}:${nativeSymbol}`);
  }

  findByKey(instrumentKey: string): Instrument[] {
    return [...this.instruments.values()].filter((i) => i.instrument_key === instrumentKey);
  }

  list(filter?: Partial<Pick<Instrument, 'exchange' | 'status' | 'contract_type'>>): Instrument[] {
    return [...this.instruments.values()].filter((i) => {
      if (filter?.exchange && i.exchange !== filter.exchange) return false;
      if (filter?.status && i.status !== filter.status) return false;
      if (filter?.contract_type && i.contract_type !== filter.contract_type) return false;
      return true;
    });
  }

  subscribableSymbols(exchange: ExchangeId, pairableContractTypes: string[] = ['LINEAR_PERPETUAL']): string[] {
    return [...(this.byExchange.get(exchange)?.values() ?? [])]
      .filter((i) => i.status === 'TRADING' && !i.ambiguous && pairableContractTypes.includes(i.contract_type))
      .map((i) => i.native_symbol);
  }

  version(): number {
    return this.registryVersion;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sourceStatus(exchange: ExchangeId): InstrumentSourceStatus | undefined {
    return this.sourceStatuses.get(exchange);
  }

  markSourceFailed(exchange: ExchangeId, errorKind: string, httpStatus: number | undefined, now: number): void {
    this.sourceStatuses.set(exchange, { exchange, status: 'FAILED', error_kind: errorKind, http_status: httpStatus, updated_at: now });
    this.emit(now, 'INSTRUMENT_SOURCE_STATUS_CHANGED', exchange, null, { status: 'FAILED', error_kind: errorKind, http_status: httpStatus });
  }

  applySnapshot(exchange: ExchangeId, items: InstrumentSnapshotInput[], now: number): void {
    const exchangeMap = this.byExchange.get(exchange) ?? new Map<string, Instrument>();
    this.byExchange.set(exchange, exchangeMap);

    const seenIds = new Set<string>();
    const addedIds: string[] = [];
    const changedIds: string[] = [];

    for (const item of items) {
      const id = item.instrument_id;
      seenIds.add(id);
      const existing = exchangeMap.get(id);

      if (!existing) {
        const instrument: Instrument = {
          ...item,
          funding: { ...item.funding, schedule_status: computeScheduleStatus(item.funding, now) },
          ambiguous: false,
          created_at: now,
          updated_at: now,
          status_changed_at: now,
          last_seen_at: now,
        };
        exchangeMap.set(id, instrument);
        this.instruments.set(id, instrument);
        addedIds.push(id);
        this.emit(now, 'INSTRUMENT_LISTED', exchange, item.native_symbol, { instrument_id: id });
        continue;
      }

      let changed = false;

      for (const field of SPEC_FIELDS as readonly SpecField[]) {
        if (existing[field] !== item[field]) {
          this.emit(now, 'INSTRUMENT_SPEC_CHANGED', exchange, item.native_symbol, {
            field,
            from: existing[field],
            to: item[field],
          });
          (existing[field] as number | null) = item[field];
          changed = true;
        }
      }

      if (existing.status !== item.status) {
        this.emit(now, 'INSTRUMENT_STATUS_CHANGED', exchange, item.native_symbol, {
          from: existing.status,
          to: item.status,
          reason: 'SOURCE_STATUS',
        });
        existing.status = item.status;
        existing.status_changed_at = now;
        changed = true;
      }
      if (existing.native_status !== item.native_status) {
        existing.native_status = item.native_status;
        changed = true;
      }
      if (
        existing.instrument_key !== item.instrument_key ||
        existing.base_asset !== item.base_asset ||
        existing.quote_asset !== item.quote_asset ||
        existing.settle_asset !== item.settle_asset ||
        existing.contract_type !== item.contract_type ||
        existing.multiplier_source !== item.multiplier_source
      ) {
        existing.instrument_key = item.instrument_key;
        existing.base_asset = item.base_asset;
        existing.quote_asset = item.quote_asset;
        existing.settle_asset = item.settle_asset;
        existing.contract_type = item.contract_type;
        existing.multiplier_source = item.multiplier_source;
        changed = true;
      }

      // 週期 metadata（Bybit fundingInterval、Bitget fundInterval 等）可隨快照更新；
      // next_funding_time 只透過 updateFundingSchedule() 更新，snapshot 不得覆寫。
      if (
        item.funding.funding_interval_hours !== null &&
        item.funding.funding_interval_hours !== existing.funding.funding_interval_hours
      ) {
        this.emit(now, 'FUNDING_SCHEDULE_CHANGED', exchange, item.native_symbol, {
          from: existing.funding.funding_interval_hours,
          to: item.funding.funding_interval_hours,
        });
        existing.funding.funding_interval_hours = item.funding.funding_interval_hours;
        existing.funding.interval_source = item.funding.interval_source;
        changed = true;
      }

      const recomputedStatus = computeScheduleStatus(existing.funding, now);
      if (recomputedStatus !== existing.funding.schedule_status) {
        existing.funding.schedule_status = recomputedStatus;
      }

      existing.last_seen_at = now;
      if (changed) {
        existing.updated_at = now;
        changedIds.push(id);
      }
    }

    for (const [id, instrument] of exchangeMap) {
      if (!seenIds.has(id) && instrument.status !== 'DELISTED') {
        this.emit(now, 'INSTRUMENT_STATUS_CHANGED', exchange, instrument.native_symbol, {
          from: instrument.status,
          to: 'DELISTED',
          reason: 'ABSENT_FROM_SOURCE',
        });
        instrument.status = 'DELISTED';
        instrument.status_changed_at = now;
        instrument.updated_at = now;
        changedIds.push(id);
      }
    }

    this.recomputeAmbiguous(exchange, now, changedIds);
    this.sourceStatuses.set(exchange, { exchange, status: 'OK', updated_at: now });

    const uniqueChanged = [...new Set(changedIds)].filter((id) => !addedIds.includes(id));
    if (addedIds.length > 0 || uniqueChanged.length > 0) {
      this.registryVersion += 1;
      const diff: RegistryDiff = { added: addedIds, removed: [], changed: uniqueChanged };
      for (const listener of this.listeners) listener(diff);
    }
  }

  private recomputeAmbiguous(exchange: ExchangeId, now: number, changedIds: string[]): void {
    const exchangeMap = this.byExchange.get(exchange);
    if (!exchangeMap) return;

    const groups = new Map<string, Instrument[]>();
    for (const instrument of exchangeMap.values()) {
      if (instrument.status !== 'TRADING') continue;
      const key = `${instrument.instrument_key}|${instrument.contract_type}`;
      const group = groups.get(key) ?? [];
      group.push(instrument);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const shouldBeAmbiguous = group.length > 1;
      for (const instrument of group) {
        if (instrument.ambiguous !== shouldBeAmbiguous) {
          instrument.ambiguous = shouldBeAmbiguous;
          instrument.updated_at = now;
          changedIds.push(instrument.instrument_id);
          if (shouldBeAmbiguous) {
            this.emit(now, 'INSTRUMENT_AMBIGUOUS', exchange, instrument.native_symbol, {
              instrument_key: instrument.instrument_key,
              contract_type: instrument.contract_type,
            });
          }
        }
      }
    }
  }

  updateFundingSchedule(
    exchange: ExchangeId,
    nativeSymbol: string,
    update: FundingScheduleUpdate,
    now: number,
  ): UpdateFundingScheduleResult {
    const instrument = this.get(exchange, nativeSymbol);
    if (!instrument) {
      return { status: 'UNKNOWN_INSTRUMENT' };
    }

    if (
      instrument.funding.exchange_timestamp !== null &&
      update.exchange_timestamp < instrument.funding.exchange_timestamp
    ) {
      return { status: 'IGNORED_OUT_OF_ORDER' };
    }

    const nextFundingTime = update.next_funding_time === 0 ? null : update.next_funding_time;
    const previousInterval = instrument.funding.funding_interval_hours;

    instrument.funding = {
      next_funding_time: nextFundingTime,
      funding_interval_hours: update.funding_interval_hours ?? instrument.funding.funding_interval_hours,
      interval_source: update.interval_source ?? instrument.funding.interval_source,
      schedule_status: computeScheduleStatus({ next_funding_time: nextFundingTime }, now),
      exchange_timestamp: update.exchange_timestamp,
      local_received_timestamp: now,
      updated_at: now,
    };
    instrument.updated_at = now;

    if (
      update.funding_interval_hours !== undefined &&
      update.funding_interval_hours !== null &&
      previousInterval !== null &&
      update.funding_interval_hours !== previousInterval
    ) {
      this.emit(now, 'FUNDING_SCHEDULE_CHANGED', exchange, nativeSymbol, {
        from: previousInterval,
        to: update.funding_interval_hours,
      });
    }

    this.registryVersion += 1;
    const diff: RegistryDiff = { added: [], removed: [], changed: [instrument.instrument_id] };
    for (const listener of this.listeners) listener(diff);

    return { status: 'OK' };
  }
}
