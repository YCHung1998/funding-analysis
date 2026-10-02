# trading-schema Specification

## Purpose
Paper Trading Runtime 的交易實體型別單一來源（`runtime/src/types/`）：ID、狀態轉換表、Opportunity / Trade / Order / Fill / FundingSettlement / TradeResult / Risk / Account、`TradingEvent` 與擴充碼、憑證守門與實體驗證、術語表，以及研究原型舊型別的棄用與遷移規則。由 change `trading-schema-types`（2026-10-01）建立。

## Requirements
### Requirement: Single source of v0.2 trading types
The system SHALL define all v0.2 trading types in `runtime/src/types/` and export them from `runtime/src/types/index.ts`: `ExchangeId`, `Opportunity`, `Trade`, `TradeLeg`, `PaperOrder`, `Fill`, `FundingSettlement`, `TradeResult`, `TradingEvent`, `RiskCheck`, `AccountSnapshot`, `PaperPosition`, `RiskStatusReport`, `RiskCheckItem`, and the status unions `OpportunityStatus`, `TradeStatus`, `LegStatus`, `OrderState`, `FundingSettlementStatus`, `TradingEventType`. Field names and types of the entities defined in spec §5–§21 MUST match the spec exactly (snake_case, epoch-ms `number` timestamps, decimal rates). No other module under `runtime/src/` MAY declare a type with any of these names.

#### Scenario: Spec field names are enforced at type level
- **WHEN** the type test asserts that `PaperOrder` has keys `order_id`, `client_order_id`, `trade_id`, `leg_id`, `purpose`, `order_type`, `side`, `position_side`, `reduce_only`, `requested_quantity`, `filled_quantity`, `remaining_quantity`, `order_state`, `submit_time`, `ack_time`, `cancel_request_time`, `cancel_ack_time`, `terminal_time`
- **THEN** `npm run lint` passes, and renaming any of them (e.g. `filled_quantity` → `requested_quantity_filled`) makes the type test fail

#### Scenario: Duplicate type declaration detected
- **WHEN** a file under `runtime/src/` other than `runtime/src/types/` declares `interface Trade` or `type OrderState`
- **THEN** the automated duplicate-declaration check fails and names the file

#### Scenario: Trade mode excludes LIVE
- **WHEN** code assigns `mode: 'LIVE'` to a `Trade` or `TradeResult`
- **THEN** type checking fails (allowed values are exactly `'PAPER' | 'BACKTEST'`, C-18)

### Requirement: Timestamp fields on every persisted entity
Every persisted entity type (`Opportunity`, `Trade`, `TradeLeg`, `PaperOrder`, `Fill`, `FundingSettlement`, `TradeResult`, `RiskCheck`, `AccountSnapshot`, `PaperPosition`) SHALL have `created_at: number` and `updated_at: number` (spec §25 #1). Where spec §5, §11 or §21 omit them, they SHALL be added as additive fields: `Opportunity.created_at` (equal to `detected_at` on creation), `Fill.created_at`/`updated_at` (both equal to `recorded_at`; fills are immutable), `TradeResult.created_at`/`updated_at`. `Fill` SHALL keep both `timestamp` (match time) and `recorded_at` (write time) as distinct fields (§25 #5).

#### Scenario: Fill timestamps
- **WHEN** a fill is matched at 1_700_000_000_120 and written at 1_700_000_000_135
- **THEN** `timestamp = 1_700_000_000_120`, `recorded_at = created_at = updated_at = 1_700_000_000_135`

#### Scenario: Validator rejects missing timestamps
- **WHEN** `validateEntity('Trade', t)` is called with `t.updated_at` undefined
- **THEN** it returns an error `MISSING_TIMESTAMP:updated_at`

#### Scenario: Validator rejects non-epoch-ms values
- **WHEN** a timestamp field holds `1_700_000_000.5`, a string `'2026-09-30T00:00:00Z'`, or a value below `1_000_000_000_000`
- **THEN** the validator returns `INVALID_TIMESTAMP` for that field

### Requirement: Event-loop fields on funding and result types
`FundingSettlement` SHALL additionally carry `mark_price_source?: 'SETTLEMENT_RECORD' | 'SNAPSHOT'`, `settled_rate_published_at?: number` and `publication_delay_ms?: number`; `TradeResult` SHALL carry `funding_confirmed: boolean` and optional `finalized_at?: number`, whose setting rules are owned by `funding-settlement-rules` (paper-trading-event-loop): `finalized_at` is set once every leg's settlement is `SETTLED`, `NOT_ELIGIBLE` or `MISSED`, so `funding_confirmed = false` with `finalized_at` set is valid (the `MISSED` case). `TradingEvent` SHALL carry optional `clock_reference?: ExchangeId` in addition to `clock_offset_ms?` (trading-clock).

#### Scenario: Closed trade pending funding
- **WHEN** a `TradeResult` is built with `funding_confirmed = false` and `finalized_at` undefined
- **THEN** the validator accepts it

#### Scenario: Confirmed funding requires finalization
- **WHEN** a `TradeResult` has `funding_confirmed = true` and `finalized_at` undefined
- **THEN** the validator returns `FINALIZATION_MISSING`

### Requirement: Status enums and transition tables
The system SHALL export each status set as a readonly array (`ORDER_STATES`, `TRADE_STATUSES`, `LEG_STATUSES`, `OPPORTUNITY_STATUSES`, `FUNDING_SETTLEMENT_STATUSES`) and a transition table per entity, plus `isAllowedTransition(entity, from, to): boolean`. The tables SHALL encode:
- Order (§9, C-14): `CREATED→SUBMITTED`; `SUBMITTED→ACKNOWLEDGED|REJECTED`; `ACKNOWLEDGED→PARTIALLY_FILLED|FILLED|REJECTED|CANCEL_REQUESTED|EXPIRED`; `PARTIALLY_FILLED→FILLED|CANCEL_REQUESTED|EXPIRED`; `CANCEL_REQUESTED→CANCELED|FILLED|ACKNOWLEDGED|PARTIALLY_FILLED` (the last two only as cancel-rejected reverts). Terminal: `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`. There SHALL be no `CLOSED` and no `TIMEOUT` order state.
- Trade (§26.2): `CREATED→PRE_FLIGHT`; `PRE_FLIGHT→ENTRY_PENDING|ABORTED`; `ENTRY_PENDING→HEDGED|PARTIALLY_HEDGED|LEG_IMBALANCE|ABORTED`; `PARTIALLY_HEDGED→HEDGED|LEG_IMBALANCE`; `LEG_IMBALANCE→EMERGENCY_EXIT`; `HEDGED→EXIT_PENDING|EMERGENCY_EXIT`; `EXIT_PENDING→CLOSED`; `EMERGENCY_EXIT→CLOSED`; any non-terminal → `FAILED`. Terminal: `CLOSED`, `ABORTED`, `FAILED`.
- Opportunity (§26.1): `DETECTED→QUALIFIED|REJECTED|EXPIRED`; `QUALIFIED→SELECTED|REJECTED|EXPIRED`.
- Leg (§26.3): `PENDING→OPENING|FAILED`; `OPENING→PARTIAL|OPEN|FAILED`; `PARTIAL→OPEN|CLOSING`; `OPEN→CLOSING`; `CLOSING→CLOSED|FAILED`.
- FundingSettlement (§18): `EXPECTED→ELIGIBLE|NOT_ELIGIBLE`; `ELIGIBLE→SETTLED|MISSED|NOT_ELIGIBLE`.

#### Scenario: Order cannot be CLOSED
- **WHEN** `isAllowedTransition('ORDER', 'FILLED', 'CLOSED')` is evaluated
- **THEN** it is a type error, and at runtime with an untyped value it returns `false`

#### Scenario: Terminal order states are final
- **WHEN** `isAllowedTransition('ORDER', 'CANCELED', 'FILLED')` is evaluated
- **THEN** it returns `false`

#### Scenario: Cancel-rejected revert allowed
- **WHEN** `isAllowedTransition('ORDER', 'CANCEL_REQUESTED', 'PARTIALLY_FILLED')` is evaluated
- **THEN** it returns `true`

#### Scenario: Any non-terminal trade can fail
- **WHEN** `isAllowedTransition('TRADE', s, 'FAILED')` is evaluated for every non-terminal `s`
- **THEN** all return `true`, and for `s ∈ {CLOSED, ABORTED, FAILED}` it returns `false`

#### Scenario: Trade cannot skip hedge
- **WHEN** `isAllowedTransition('TRADE', 'ENTRY_PENDING', 'EXIT_PENDING')` is evaluated
- **THEN** it returns `false`

### Requirement: Event type catalogue and transition-to-event mapping
`TradingEventType` SHALL be the union of the core codes of tech spec §26 (excluding `KILL_SWITCH_*`, C-16) and the extension codes `SESSION_PHASE_CHANGED`, `CLOCK_REFERENCE_CHANGED`, `CLOCK_OFFSET_JUMP` (paper-trading-event-loop), `LEG_STATUS_CHANGED`, `FUNDING_STATUS_CHANGED`, `CAPITAL_RESERVED`, `CAPITAL_RELEASED`, `ENTRY_HALT_REQUESTED`, `ENTRY_HALT_CLEARED`, `RUNTIME_STARTUP_STEP`, `RUNTIME_ARMED`, `RUNTIME_DISARMED`. The system SHALL export `transitionEventType(entity, from, to)` returning the event code required for every allowed transition: Order `→SUBMITTED` = `ORDER_SUBMITTED`, `→ACKNOWLEDGED` = `ORDER_ACK` (or `ORDER_CANCEL_REJECTED` when leaving `CANCEL_REQUESTED`), `→PARTIALLY_FILLED` = `ORDER_PARTIAL_FILL` (or `ORDER_CANCEL_REJECTED` when leaving `CANCEL_REQUESTED`), `→FILLED` = `ORDER_FILL`, `→CANCEL_REQUESTED` = `ORDER_CANCEL_REQUESTED`, `→CANCELED` = `ORDER_CANCELED`, `→REJECTED` = `ORDER_REJECTED`, `→EXPIRED` = `ORDER_EXPIRED`; Trade = `TRADE_STATUS_CHANGED`; Leg = `LEG_STATUS_CHANGED`; Opportunity `→X` = `OPPORTUNITY_X`; FundingSettlement `→SETTLED` = `FUNDING_SETTLED`, otherwise `FUNDING_STATUS_CHANGED`. Adding an event code SHALL require adding its glossary entry.

#### Scenario: Every allowed transition maps to an event
- **WHEN** the test iterates every allowed transition of every transition table
- **THEN** `transitionEventType` returns a member of `TradingEventType` for each, with no `undefined`

#### Scenario: Kill switch codes absent
- **WHEN** code uses `'KILL_SWITCH_ACTIVATED'` as a `TradingEventType`
- **THEN** type checking fails

### Requirement: TradingEvent shape and transition payload
`TradingEvent` SHALL have the fields of tech spec §27 (`event_id`, `event_type`, `timestamp`, `trade_id`, `leg_id?`, `order_id?`, `position_id?`, `exchange?`, `symbol?`, `payload`, `recorded_at`, `clock_offset_ms?`) plus additive optional `opportunity_id?`, `session_id?`, `clock_reference?`. `trade_id` SHALL be `string | null`, `null` only for event types not scoped to a trade (`OPPORTUNITY_*`, `SESSION_PHASE_CHANGED`, `CLOCK_*`, `STALE_MARKET_DATA`, `EXCHANGE_DISCONNECTED`, `RUNTIME_*`, `ENTRY_HALT_REQUESTED`, `ENTRY_HALT_CLEARED`, and account-level `RECONCILIATION_ERROR`). Every state-transition event SHALL carry `payload.from`, `payload.to`, `payload.reason` (string) and `payload.after` (the full entity snapshot after the transition). A helper `makeTransitionEvent(entity, before, after, reason, clock)` SHALL build such events and throw if the transition is not allowed.

#### Scenario: Transition event built
- **WHEN** `makeTransitionEvent('TRADE', trade{status:'ENTRY_PENDING'}, trade{status:'HEDGED'}, 'HEDGE_RATIO_OK', clock)` is called at clock time 1_700_000_000_095
- **THEN** it returns `event_type = 'TRADE_STATUS_CHANGED'`, `timestamp = 1_700_000_000_095`, `payload.from = 'ENTRY_PENDING'`, `payload.to = 'HEDGED'`, `payload.reason = 'HEDGE_RATIO_OK'`, and `payload.after.status = 'HEDGED'`

#### Scenario: Illegal transition refused
- **WHEN** `makeTransitionEvent('ORDER', {order_state:'FILLED'}, {order_state:'CANCELED'}, 'x', clock)` is called
- **THEN** it throws `IllegalTransitionError` naming `FILLED → CANCELED`

#### Scenario: Trade-scoped event requires trade_id
- **WHEN** an `ORDER_FILL` event is validated with `trade_id = null`
- **THEN** validation fails with `TRADE_ID_REQUIRED`

### Requirement: Credential-free event payloads
The system SHALL export `assertNoCredentials(value, knownSecrets)` which throws `CredentialLeakError` when any key (at any depth, case-insensitive) matches `api_key`, `apikey`, `api_secret`, `secret`, `passphrase`, `signature`, `password`, `private_key`, or any string value equals or contains one of `knownSecrets` (non-empty values loaded from `.env.local`). The error message MUST NOT include the secret value (Invariant #2, spec §33).

#### Scenario: Credential key rejected
- **WHEN** `assertNoCredentials({ order: { apiKey: 'x' } }, [])` is called
- **THEN** it throws `CredentialLeakError` whose message contains the path `order.apiKey` and not the value

#### Scenario: Secret value rejected
- **WHEN** `knownSecrets = ['s3cr3tVALUE']` and the payload is `{ note: 'debug s3cr3tVALUE' }`
- **THEN** it throws `CredentialLeakError` and the message does not contain `s3cr3tVALUE`

#### Scenario: Ordinary payload accepted
- **WHEN** the payload is `{ from: 'SUBMITTED', to: 'ACKNOWLEDGED', reason: 'ACK' }`
- **THEN** no error is thrown

### Requirement: Entity invariants
The system SHALL export `validateEntity(kind, value)` returning a list of errors and enforcing at least: `PaperOrder.reduce_only === true` when `purpose ∈ {EXIT, EMERGENCY_CLOSE}` and `false` when `purpose = ENTRY` (Invariant #6); `remaining_quantity === requested_quantity − filled_quantity` (tolerance 1e-9); `filled_quantity ≤ requested_quantity`; `order_state = REJECTED ⇒ rejection_reason` non-empty; terminal order state ⇒ `terminal_time` set; `updated_at ≥ created_at`; `Opportunity.funding_aligned === (funding_time_diff_ms ≤ funding_alignment_tolerance_ms)` when the tolerance is supplied; every field named `*_funding_rate`, `funding_rate` or `settled_funding_rate` satisfies `|rate| ≤ 0.10` (decimal, Invariant #5; threshold set to 10% by user decision 2026-10-01).

#### Scenario: Exit order without reduce-only
- **WHEN** a `PaperOrder` with `purpose = 'EXIT'` and `reduce_only = false` is validated
- **THEN** the result contains `REDUCE_ONLY_REQUIRED`

#### Scenario: Remaining quantity mismatch
- **WHEN** `requested_quantity = 100`, `filled_quantity = 30`, `remaining_quantity = 60`
- **THEN** the result contains `REMAINING_QUANTITY_MISMATCH`

#### Scenario: Rejected without reason
- **WHEN** `order_state = 'REJECTED'` and `rejection_reason` is empty
- **THEN** the result contains `REJECTION_REASON_REQUIRED`

#### Scenario: Percent stored instead of decimal
- **WHEN** an `Opportunity` has `long_funding_rate = 0.25`
- **THEN** the result contains `RATE_NOT_DECIMAL:long_funding_rate`

### Requirement: Supporting entity shapes
The system SHALL define `RiskCheck` (`risk_check_id`, `opportunity_id`, `trade_id?`, `stage: 'OPPORTUNITY' | 'TRADE_CREATION' | 'ORDER_SUBMISSION' | 'ENTRY' | 'POSITION'`, `check_id`, `name`, `status: 'PASS' | 'WARN' | 'FAIL'`, `critical`, `value`, `threshold`, `reason?`, `config_version`, `created_at`, `updated_at`), `AccountSnapshot` (`snapshot_id`, `mode`, `snapshot_time`, `total_capital_usdt`, `reserved_capital_usdt`, `available_capital_usdt`, `used_margin_usdt`, `realized_pnl_usdt`, `open_trade_count`, `reason: 'INITIAL' | 'CAPITAL_RESERVED' | 'CAPITAL_RELEASED' | 'PNL_REALIZED' | 'FUNDING_SETTLED' | 'PERIODIC'`, `trade_id?`, `config_version`, `created_at`, `updated_at`) representing the virtual paper ledger (tech spec §5 note), and `PaperPosition` (`position_id`, `trade_id`, `leg_id`, `exchange`, `symbol`, `position_side`, `quantity`, `average_entry_price`, `status: 'OPEN' | 'CLOSED'`, `opened_at`, `closed_at?`, `created_at`, `updated_at`) as a storage row whose computation is owned by `position-accounting`. `RiskStatusReport` and `RiskCheckItem` SHALL keep exactly the shape currently in `src/types/systemSpec.ts`, which SHALL re-export them from `runtime/src/types/risk.ts`.

#### Scenario: Ledger identity
- **WHEN** an `AccountSnapshot` with `total_capital_usdt = 10000`, `reserved_capital_usdt = 1000`, `available_capital_usdt = 9000` is validated
- **THEN** it passes, and with `available_capital_usdt = 9500` it fails with `LEDGER_IDENTITY_MISMATCH`

#### Scenario: Research UI keeps compiling
- **WHEN** `src/types/systemSpec.ts` re-exports `RiskStatusReport` from `runtime/src/types/risk.ts`
- **THEN** `npm run lint` and `npm run build` pass without changing any file under `src/components/` or `src/engine/`

### Requirement: Glossary as single source for codes
`runtime/src/types/glossary.ts` SHALL export `GLOSSARY: readonly GlossaryEntry[]` with `code`, `zh`, `definition_zh`, `category` (tech spec §27.1; categories `OPPORTUNITY | TRADE | LEG | ORDER | FUNDING | EVENT`, plus additive `SESSION | HEALTH` reserved for other changes) and `getGlossaryEntry(category, code)`. Every member of `ORDER_STATES`, `TRADE_STATUSES`, `LEG_STATUSES`, `OPPORTUNITY_STATUSES`, `FUNDING_SETTLEMENT_STATUSES` and every `TradingEventType` SHALL have exactly one entry in its category; `zh` and `definition_zh` for codes listed in spec §9, §18, §26 SHALL equal the spec tables' text.

#### Scenario: No missing glossary entry
- **WHEN** the glossary completeness test runs
- **THEN** every status and event code has exactly one entry with non-empty `zh` and `definition_zh`

#### Scenario: Spec wording preserved
- **WHEN** `getGlossaryEntry('TRADE', 'PARTIALLY_HEDGED')` is called
- **THEN** it returns `zh = '部分對沖'` and `definition_zh = '兩腿都有成交，hedge ratio 介於兩門檻之間，正在補足'`

#### Scenario: Same code in two categories
- **WHEN** `CLOSED` is looked up in `TRADE` and in `LEG`
- **THEN** two distinct entries are returned (`已結束` and `已平倉`)

### Requirement: Legacy type deprecation and one-way adapters
`FunnelCandidate`, `ArbitrageTradeResult`, `SimulatedOrderLeg`, `OrderState` (v0.1), `PositionState` and `TimelineMilestone` in `src/types/` SHALL carry `@deprecated` JSDoc naming their v0.2 replacement (spec §2.1). Display adapters converting v0.2 → v0.1 SHALL live in `src/types/legacy/`; no file under `runtime/src/` MAY import from `src/` (spec §2.1 rule 3). The mapping SHALL be: Order `CREATED|SUBMITTED|ACKNOWLEDGED → NEW`, `PARTIALLY_FILLED → PARTIALLY_FILLED`, `CANCEL_REQUESTED → PARTIALLY_FILLED` if `filled_quantity > 0` else `NEW`, `FILLED → FILLED`, `CANCELED|EXPIRED → CANCELED`, `REJECTED → REJECTED`; Trade → PositionState `CREATED|PRE_FLIGHT|ABORTED|CLOSED → FLAT`, `ENTRY_PENDING|PARTIALLY_HEDGED → OPENING`, `HEDGED → BALANCED_HEDGED`, `LEG_IMBALANCE → LEG_IMBALANCE`, `EXIT_PENDING → CLOSING`, `EMERGENCY_EXIT → EMERGENCY_EXIT`, `FAILED → null` (no legacy equivalent; UI shows the v0.2 code).

#### Scenario: Runtime must not import research types
- **WHEN** a file under `runtime/src/` imports from `../../src/types/systemSpec`
- **THEN** the import-boundary test fails and names the file

#### Scenario: Cancel requested with partial fill
- **WHEN** `toLegacyOrderState({ order_state: 'CANCEL_REQUESTED', filled_quantity: 30 })` is called
- **THEN** it returns `'PARTIALLY_FILLED'`

#### Scenario: FAILED has no legacy state
- **WHEN** `toLegacyPositionState('FAILED')` is called
- **THEN** it returns `null`

### Requirement: Unknown timestamps are never fabricated
When historical v0.1 data without timestamps is imported into v0.2 shapes, the importer SHALL set `timestamp_source: 'UNKNOWN'` and leave each unknown time field `null` (type `WithUnknownTimestamps<T>`); it MUST NOT substitute the import-time clock value (spec §2.1 rule 5). Records with `timestamp_source = 'UNKNOWN'` MUST NOT be written as `PAPER` entities.

#### Scenario: Import legacy trade result
- **WHEN** a v0.1 `ArbitrageTradeResult` with only `funding_time = 1_700_000_000_000` is imported at clock time 1_800_000_000_000
- **THEN** the result has `timestamp_source = 'UNKNOWN'`, `created_at = null`, `finalized_at = null`, and no field equals 1_800_000_000_000

#### Scenario: Unknown-timestamp record refused as paper data
- **WHEN** a record with `timestamp_source = 'UNKNOWN'` is validated as a `PAPER` entity
- **THEN** validation fails with `UNKNOWN_TIMESTAMP_NOT_ALLOWED`

