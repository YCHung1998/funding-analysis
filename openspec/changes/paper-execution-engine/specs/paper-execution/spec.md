## ADDED Requirements

### Requirement: Replaceable execution interface
The system SHALL define `ExecutionEngine` with `submit(request: OrderRequest): Promise<PaperOrder>`, `cancel(orderId: string): Promise<PaperOrder>`, `getOrder(orderId: string): Promise<PaperOrder>` (tech spec §46) and `onOrderUpdate(listener: (order: PaperOrder, fills: Fill[]) => void): () => void`. `OrderRequest` SHALL contain `client_order_id`, `trade_id`, `leg_id`, `purpose`, `exchange`, `symbol`, `order_type`, `side`, `position_side`, `reduce_only`, `requested_quantity`, `requested_notional_usdt`, `requested_price?`, `reference_price`, `estimated_fee_usdt`, `estimated_slippage_pct`, `time_in_force?: 'GTC' | 'IOC'`. Strategy, trade coordinators and risk code SHALL depend only on `ExecutionEngine`, never on `PaperExecutionAdapter`. A reusable contract test suite SHALL run against any `ExecutionEngine` implementation.

#### Scenario: Coordinators do not know the implementation
- **WHEN** the import-boundary check scans `runtime/src/trading/` and `runtime/src/strategy/`
- **THEN** no file imports `paperExecution`, and the check fails naming any file that does

#### Scenario: Contract suite runs against paper adapter
- **WHEN** the execution contract suite is executed with a `PaperExecutionAdapter`, a fake order book and a `VirtualClock`
- **THEN** all contract cases (submit → ACK → fill, cancel, getOrder consistency, update notifications) pass

#### Scenario: No real order endpoints
- **WHEN** the source check scans `runtime/src/` for real order endpoints (`/fapi/v1/order`, `/v5/order/create`, `/v5/order/cancel`, `/api/v5/trade/order`) or HTTP clients in `runtime/src/execution/`
- **THEN** none are found (Invariant #1)

### Requirement: Order state machine per C-14
`PaperExecutionAdapter` SHALL move orders only along transitions allowed by the `trading-schema` order table, persist each transition with `Ledger.applyOrderTransition` together with the event given by `transitionEventType`, and set timestamps: `created_at` at creation, `submit_time` at `SUBMITTED`, `ack_time` at `ACKNOWLEDGED`, `first_fill_time` / `final_fill_time` at the first / completing fill, `cancel_request_time` at `CANCEL_REQUESTED`, `cancel_ack_time` at `CANCELED`, `terminal_time` at any terminal state. `CREATED → SUBMITTED` SHALL be committed in the same transaction as the order's creation inside `submit` (a persisted order is never left in `CREATED`). `ORDER_TIMEOUT`, `ORDER_ACK_TIMEOUT` and `ORDER_CANCEL_REJECTED` SHALL be events, not states; no order SHALL ever be `CLOSED`.

#### Scenario: Normal lifecycle timestamps
- **WHEN** a market order is submitted at t=1000 with ACK latency 45 ms and fill latency 10 ms against sufficient depth
- **THEN** the order passes `CREATED → SUBMITTED → ACKNOWLEDGED → FILLED` with `submit_time = 1000`, `ack_time = 1045`, `first_fill_time = final_fill_time = terminal_time = 1055`, and events `ORDER_CREATED`, `ORDER_SUBMITTED`, `ORDER_ACK`, `ORDER_FILL` exist in that order

#### Scenario: Rejected order keeps reason
- **WHEN** the simulator rejects an order with reason `INSUFFICIENT_MARGIN_SIMULATED`
- **THEN** the order is `REJECTED` with that `rejection_reason`, `terminal_time` set, and an `ORDER_REJECTED` event

### Requirement: Market order depth walking
A MARKET BUY SHALL consume ask levels from the best ask upward and a MARKET SELL SHALL consume bid levels from the best bid downward, at the order book snapshot current when matching runs (after ACK plus fill latency). Each consumed level SHALL produce one `Fill` with that level's price; `average_fill_price` SHALL be the quantity-weighted average of fills; `Fill.notional_usdt = quantity × price × contract_multiplier`; `Fill.fee_usdt = notional_usdt × taker_fee_rate` from the cost-model fee provider; `liquidity = 'TAKER'`. `actual_slippage_pct` and `Fill.slippage_from_reference_pct` SHALL be `(price − reference_price) / reference_price × 100` for BUY and the negation for SELL (positive = worse than reference). Quantities SHALL be multiples of the instrument step size, otherwise the order SHALL be `REJECTED` with `INVALID_QUANTITY_STEP`.

#### Scenario: Tech spec §14 example
- **WHEN** a MARKET BUY for 250 (multiplier 1, reference 100.00, taker fee 0.0005) matches asks `100.00×100, 100.01×200, 100.03×300`
- **THEN** two fills are produced (100 @ 100.00 and 150 @ 100.01), `average_fill_price = 100.006`, `filled_quantity = 250`, `actual_slippage_pct = 0.006`, and total `actual_fee_usdt = 12.50075`

#### Scenario: SELL walks bids
- **WHEN** a MARKET SELL for 150 matches bids `99.99×100, 99.98×100` with reference 99.99
- **THEN** fills are 100 @ 99.99 and 50 @ 99.98 and `average_fill_price = 99.9866…` (rounded to 1e-9 in assertions)

#### Scenario: Not best ask
- **WHEN** the requested quantity exceeds the best ask level size
- **THEN** `average_fill_price` is strictly greater than the best ask

### Requirement: Partial fills and remainder handling
When available depth is less than the remaining quantity, the adapter SHALL fill what is available and set `PARTIALLY_FILLED` (tech spec §15). For `time_in_force = 'GTC'` (default `market_order_time_in_force`) the remainder SHALL be re-matched on each subsequent order book update until filled, canceled or timed out; for `IOC` the remainder SHALL be `EXPIRED` immediately after the first matching pass. LIMIT orders SHALL only consume levels at or better than `requested_price`. When `enable_partial_fill = false`, an order whose full quantity is not available SHALL receive no fill in that pass.

#### Scenario: Tech spec §15 example
- **WHEN** a MARKET order for 1 000 finds only 300 available
- **THEN** `filled_quantity = 300`, `remaining_quantity = 700`, `order_state = 'PARTIALLY_FILLED'`, and an `ORDER_PARTIAL_FILL` event exists

#### Scenario: Remainder filled on book update
- **WHEN** the book later shows 700 more at the ask
- **THEN** the order becomes `FILLED` with `filled_quantity = 1000` and an `ORDER_FILL` event

#### Scenario: IOC remainder expires
- **WHEN** an IOC MARKET order for 1 000 finds 300
- **THEN** it ends `EXPIRED` with `filled_quantity = 300` and an `ORDER_EXPIRED` event

#### Scenario: Limit price respected
- **WHEN** a LIMIT BUY 250 @ 100.00 meets asks `100.00×100, 100.01×200`
- **THEN** only 100 is filled at 100.00 and 150 remains

### Requirement: Order lifetime timeout
Every order SHALL be scheduled via `Clock` to check `max_order_lifetime_ms` from `submit_time`. If not terminal by then, the adapter SHALL emit `ORDER_TIMEOUT` with `timeout_reason = 'MAX_ORDER_LIFETIME'` and the order's owner (execution policy) SHALL receive it; the default policy for ENTRY and EXIT orders SHALL request cancel immediately (state `CANCEL_REQUESTED`).

#### Scenario: Spec §12 no-fill timeline
- **WHEN** `max_order_lifetime_ms = 800`, an order is submitted at 15:31:02.153, ACKed at 15:31:02.198, never fills, and cancel latency is 68 ms
- **THEN** `ORDER_TIMEOUT` is recorded at 15:31:02.953, `cancel_request_time = 15:31:02.953`, `cancel_ack_time = 15:31:03.021`, final `order_state = 'CANCELED'`, `filled_quantity = 0`

### Requirement: ACK timeout
If an order stays `SUBMITTED` for `ack_timeout_ms`, the adapter SHALL emit `ORDER_ACK_TIMEOUT` and then resolve the actual state through `getOrder`, whose answer is decided by the simulator: if the simulated exchange received the order it SHALL become `ACKNOWLEDGED` at its simulated ACK time; if the order was lost (failure injection `ack_loss_probability`) it SHALL become `REJECTED` with `ORDER_NOT_FOUND_AFTER_ACK_TIMEOUT`.

#### Scenario: Late ACK
- **WHEN** `ack_timeout_ms = 300` and the injected ACK latency is 350 ms for an order submitted at t=0
- **THEN** `ORDER_ACK_TIMEOUT` is recorded at t=300 and the order becomes `ACKNOWLEDGED` with `ack_time = 350`

#### Scenario: Lost order
- **WHEN** the order is lost by injection and `ack_timeout_ms = 300`
- **THEN** after `ORDER_ACK_TIMEOUT` at t=300 the order is `REJECTED` with `rejection_reason = 'ORDER_NOT_FOUND_AFTER_ACK_TIMEOUT'`

### Requirement: Cancel outcomes
`cancel(orderId)` SHALL move a non-terminal, acknowledged order to `CANCEL_REQUESTED` and resolve after the simulated cancel latency: success → `CANCELED` (keeping any `filled_quantity`); the order becoming fully filled before the cancel arrives → `FILLED`; injected cancel failure or exchange disconnect → back to the pre-cancel state with an `ORDER_CANCEL_REJECTED` event and `cancel_reject_reason`. Fills arriving during `CANCEL_REQUESTED` SHALL be recorded without leaving `CANCEL_REQUESTED` unless they complete the order. Canceling a `SUBMITTED` order SHALL be deferred (no state change, since §9 has no `SUBMITTED → CANCEL_REQUESTED`) and applied immediately after the order is resolved to `ACKNOWLEDGED`. Canceling a terminal order SHALL throw `ORDER_NOT_CANCELABLE` without changing it.

#### Scenario: S05 cancel success with partial fill
- **WHEN** an order with 300 of 1 000 filled is canceled with cancel latency 60 ms
- **THEN** it ends `CANCELED` with `filled_quantity = 300`, `remaining_quantity = 700`, `cancel_ack_time = cancel_request_time + 60`

#### Scenario: S06 cancel failure
- **WHEN** `cancel_failure_probability = 1.0` and an `ACKNOWLEDGED` order is canceled
- **THEN** it returns to `ACKNOWLEDGED`, an `ORDER_CANCEL_REJECTED` event with `cancel_reject_reason = 'CANCEL_REJECTED_SIMULATED'` exists, and `cancel_ack_time` is unset

#### Scenario: Filled before cancel arrives
- **WHEN** the remaining 700 fills 20 ms after `cancel_request_time` with cancel latency 60 ms
- **THEN** the order ends `FILLED`, not `CANCELED`

#### Scenario: Cancel before ACK is deferred
- **WHEN** `cancel` is called at t=20 on an order submitted at t=0 with ACK latency 45 ms and cancel latency 60 ms
- **THEN** the order stays `SUBMITTED` until t=45, becomes `ACKNOWLEDGED` then `CANCEL_REQUESTED` at t=45, and `CANCELED` at t=105 (absent fills)

#### Scenario: Cancel terminal order
- **WHEN** `cancel` is called on a `FILLED` order
- **THEN** it throws `ORDER_NOT_CANCELABLE` and no event is written

### Requirement: Reduce-only close orders and Cancel ≠ Close
Orders with `purpose ∈ {EXIT, EMERGENCY_CLOSE}` MUST have `reduce_only = true` and `purpose = ENTRY` MUST have `reduce_only = false`; `submit` SHALL throw `INVALID_ORDER_REQUEST` otherwise, without creating an order. A reduce-only order whose quantity exceeds the leg's open position (from `position-accounting`) SHALL be `REJECTED` with `REDUCE_ONLY_EXCEEDS_POSITION`. Canceling an order SHALL never change a position; a filled position SHALL only be reduced by a new close order (Invariant #6).

#### Scenario: Oversized reduce-only
- **WHEN** a leg holds LONG 10 and an EXIT SELL for 12 with `reduce_only = true` is submitted
- **THEN** the order is `REJECTED` with `REDUCE_ONLY_EXCEEDS_POSITION`

#### Scenario: Exit without reduce-only refused
- **WHEN** an EXIT order is submitted with `reduce_only = false`
- **THEN** `submit` throws `INVALID_ORDER_REQUEST` and no order row exists

#### Scenario: Cancel does not close
- **WHEN** an entry order with 300 filled is canceled
- **THEN** the leg position stays 300 and no EXIT or EMERGENCY_CLOSE order is created by the cancel

### Requirement: Simulated latency and reproducible failure injection
ACK, fill and cancel latencies SHALL come from per-exchange configuration data (`execution_latency[exchange] = { ack_ms, fill_ms, cancel_ms, jitter_ms }`) with no exchange-name branches in code (Invariant #3). When `enable_failure_injection = true`, per-exchange `failure_injection` SHALL support: `ack_latency_ms` override, `reject_probability`, `fill_probability`, `max_fill_ratio`, `ack_loss_probability`, `cancel_failure_probability`, `disconnect_windows` (submit → `REJECTED` `EXCHANGE_DISCONNECTED`; ACK/fills suspended; cancels rejected), `liquidity_multiplier` (orderbook liquidity collapse), `price_shift_pct` (market spike), and stale book (submit → `REJECTED` `STALE_MARKET_DATA` when book age > `data_stale_threshold_ms`). All randomness SHALL come from a seeded PRNG whose per-order stream is derived from `(seed, client_order_id)`, so identical seed, config and inputs SHALL yield identical order states, fills, timestamps and event sequences regardless of interleaving.

#### Scenario: Same seed reproduces
- **WHEN** a scenario with `seed = 42`, Bybit `ack_latency_ms = 350` and `fill_probability = 0.6` runs twice
- **THEN** the two event logs (types, timestamps, payloads excluding `event_id`/`recorded_at`) are identical

#### Scenario: Different seed differs
- **WHEN** the same scenario runs with `seed = 43`
- **THEN** at least one fill outcome differs from the `seed = 42` run

#### Scenario: No exchange-name branches
- **WHEN** the source check scans `runtime/src/execution/` and `runtime/src/trading/` for string literals `'Binance'`, `'Bybit'`, `'OKX'`, `'Pionex'`, `'Bitget'`
- **THEN** none are found

#### Scenario: Stale book rejects
- **WHEN** the order book age is 3 000 ms and `data_stale_threshold_ms = 2000`
- **THEN** the order is `REJECTED` with `STALE_MARKET_DATA`

### Requirement: Clock-driven scheduling
All latencies, timeouts, re-matching and timers in this capability SHALL be scheduled through the `Clock` interface of `trading-clock`; no code in `runtime/src/execution/` or `runtime/src/trading/` SHALL call `Date.now`, `setTimeout` or `setInterval`.

#### Scenario: Virtual clock drives execution
- **WHEN** a scenario runs on `VirtualClock` and the clock is not advanced after `submit`
- **THEN** the order stays `SUBMITTED` and no ACK or fill occurs

### Requirement: Hedge ratio behaviour with switchable basis
The execution layer SHALL obtain `hedge_ratio` and its classification exclusively from `position-accounting` (`hedge_ratio = min / max` per spec §14 and `classifyHedge`) and MUST NOT implement its own formula. The basis SHALL follow config `hedge_ratio_basis: 'NOTIONAL' | 'QUANTITY'` (default `NOTIONAL` per spec §14; ⚠️ C-19 undecided, MUST NOT be hard-coded), and thresholds SHALL be `hedge_ratio_hedged_min` (default 0.99), `hedge_ratio_imbalance_below` (default 0.90) including `symbol_tier_overrides`. After every entry fill the coordinator SHALL emit `HEDGE_RATIO_CHANGED` with `ratio`, `basis`, `notional_ratio`, `quantity_ratio`, `long_value`, `short_value`.

#### Scenario: Spec §13 examples
- **WHEN** long notional is 1 000 and short notional is 300, 950 and 995 respectively (basis NOTIONAL) and the coordinator evaluates the entry
- **THEN** the coordinator acts on the classifications `LEG_IMBALANCE` (0.30), `PARTIALLY_HEDGED` (0.95) and `HEDGED` (0.995)

#### Scenario: Basis switch changes outcome
- **WHEN** long is 10 @ 100 (notional 1 000) and short is 10 @ 101.2 (notional 1 012), multiplier 1
- **THEN** with `NOTIONAL` the trade becomes `PARTIALLY_HEDGED` (ratio 0.98814…) and with `QUANTITY` it becomes `HEDGED` (ratio 1.0), and the `HEDGE_RATIO_CHANGED` payload carries both ratios in either case

### Requirement: Two-leg entry coordination
`EntryCoordinator.start(trade)` SHALL require `trade.status = 'PRE_FLIGHT'`, check `funding-settlement-rules` `canSubmitEntry` for each order, submit both legs' ENTRY orders without waiting for one another, and move the trade to `ENTRY_PENDING` and legs to `OPENING`. Classification SHALL occur when every leg's entry orders are terminal, or when a leg's entry order becomes terminal with zero fills (the other leg's pending orders are then canceled first). Outcomes: both legs zero filled → `ABORTED` (`ENTRY_TIMEOUT` if caused by timeout, `ENTRY_REJECTED` if by rejection) and capital released; otherwise per hedge classification → `HEDGED`, `PARTIALLY_HEDGED` or `LEG_IMBALANCE`. In `PARTIALLY_HEDGED` the lagging leg's missing exposure SHALL be resubmitted (subject to `canSubmitEntry`; a refusal such as `ENTRY_DEADLINE_PASSED` creates no order) and a timer of `partial_hedge_max_duration_ms` started; reaching `hedged_min` before it fires → `HEDGED`, otherwise → `LEG_IMBALANCE` with reason `PARTIAL_HEDGE_TIMEOUT`. `forceLegImbalance(trade_id, reason)` SHALL be exposed for `funding-settlement-rules` (e.g. `NOT_HEDGED_BEFORE_WINDOW` at `hedged_by`). Leg statuses SHALL follow `OPENING → PARTIAL → OPEN` or `FAILED` (zero fill), each with `LEG_STATUS_CHANGED`.

#### Scenario: S01 entry both filled
- **WHEN** both legs' market orders for 10 fill completely at 100.00 and 100.02
- **THEN** the trade becomes `HEDGED` (NOTIONAL ratio 0.9998), both legs `OPEN`, and `TRADE_STATUS_CHANGED` `ENTRY_PENDING → HEDGED` exists

#### Scenario: S04 both timeout
- **WHEN** neither leg receives any fill before `max_order_lifetime_ms` and both cancels succeed
- **THEN** the trade becomes `ABORTED` with reason `ENTRY_TIMEOUT`, both legs `FAILED`, a `CAPITAL_RELEASED` event exists, and trade, orders and events remain stored

#### Scenario: S13 partial hedge repaired
- **WHEN** long fills 1 000 U and short fills 950 U, the short remainder of 50 U is resubmitted and fills 3 000 ms later
- **THEN** the trade goes `ENTRY_PENDING → PARTIALLY_HEDGED → HEDGED`

#### Scenario: S13 partial hedge timeout
- **WHEN** the resubmitted 50 U does not fill within `partial_hedge_max_duration_ms = 5000`
- **THEN** at 5 000 ms after entering `PARTIALLY_HEDGED` the trade becomes `LEG_IMBALANCE` with reason `PARTIAL_HEDGE_TIMEOUT`

#### Scenario: Resubmission after entry deadline
- **WHEN** the trade is `PARTIALLY_HEDGED` and `canSubmitEntry` returns `ENTRY_DEADLINE_PASSED`
- **THEN** no new order is created and the trade stays `PARTIALLY_HEDGED` until the timer or `forceLegImbalance`

#### Scenario: S02 long partial, short full
- **WHEN** long fills 300 U of 1 000 U (then times out and is canceled) and short fills 1 000 U
- **THEN** the ratio is 0.30 and the trade becomes `LEG_IMBALANCE`

### Requirement: Emergency close
On `LEG_IMBALANCE`, the system SHALL emit `EMERGENCY_EXIT_STARTED`, move the trade to `EMERGENCY_EXIT`, cancel every non-terminal order of the trade, and then submit reduce-only `EMERGENCY_CLOSE` MARKET orders for each leg's open position (spec §15, tech spec §19). Cancels that are rejected SHALL be retried every `cancel_retry_interval_ms` (default 200) up to `cancel_retry_max` (default 5); any later fills SHALL trigger additional close orders. Emergency close orders are not subject to the lock-window refusal. When all legs are flat the trade SHALL become `CLOSED` with `close_reason = 'EMERGENCY_EXIT'` and capital released; if not flat within `emergency_exit_timeout_ms` the trade SHALL become `FAILED` with reason `EMERGENCY_EXIT_TIMEOUT`. The trade MUST NOT be deleted.

#### Scenario: S03 long full, short reject
- **WHEN** long fills 10 and short is `REJECTED`
- **THEN** the trade goes `ENTRY_PENDING → LEG_IMBALANCE → EMERGENCY_EXIT`, one `EMERGENCY_CLOSE` SELL 10 order with `reduce_only = true` is submitted, and after it fills the trade is `CLOSED` with `close_reason = 'EMERGENCY_EXIT'`

#### Scenario: S12 tech spec §45 flow
- **WHEN** long is 1 000 U filled and short 0 U with short order still pending
- **THEN** the short order is canceled before the long emergency close order is submitted, and the original entry, emergency exit prices, slippage, fees and duration are all persisted

#### Scenario: Emergency exit timeout
- **WHEN** the close order cannot fill because the book is empty until `emergency_exit_timeout_ms` passes
- **THEN** the trade becomes `FAILED` with reason `EMERGENCY_EXIT_TIMEOUT`

### Requirement: Normal exit
`ExitCoordinator.exit(trade_id)` SHALL be invoked by the session at `exit_at` (settlement-session), SHALL call `canSubmitExit` (funding-settlement-rules) and, if refused (e.g. `LOCK_WINDOW`), leave the trade unchanged and return the refusal. Otherwise it SHALL move a `HEDGED` trade to `EXIT_PENDING` (event `EXIT_STARTED`), legs to `CLOSING`, and submit reduce-only EXIT MARKET orders for each leg's open position; timed-out exit orders SHALL be resubmitted for the remaining quantity. When both legs are flat the trade SHALL become `CLOSED` with `close_reason = 'NORMAL_EXIT'`, legs `CLOSED`, and capital released; if not flat within `emergency_exit_timeout_ms` from exit start the trade SHALL become `FAILED` with reason `EXIT_TIMEOUT`.

#### Scenario: S01 exit
- **WHEN** `exit` is called at `exit_at` for a HEDGED trade and both EXIT orders fill
- **THEN** the trade is `CLOSED` with `close_reason = 'NORMAL_EXIT'`, and `assertTraceability` passes for the trade

#### Scenario: Exit refused in lock window
- **WHEN** `exit` is called while `canSubmitExit` returns `LOCK_WINDOW`
- **THEN** no order is created, the trade stays `HEDGED`, and the result reason is `LOCK_WINDOW`

### Requirement: Execution-layer scenario coverage
Scenario tests in `runtime/test/scenarios/` SHALL cover S01, S02, S03, S04, S05, S06, S07, S10, S12 and S13 of tech spec §42 using recorded or fake order books and fixed seeds, and each SHALL end with `assertTraceability`. S07 (market spike) SHALL verify fills at shifted prices with recorded slippage; S10 (exchange disconnect) SHALL verify that a leg submitted during a disconnect window is `REJECTED` with `EXCHANGE_DISCONNECTED` and the trade follows the leg-imbalance or abort path.

#### Scenario: S07 market spike
- **WHEN** `price_shift_pct = 0.5` is injected on the long exchange before matching with reference 100.00 and asks at 100.00
- **THEN** the fill price is 100.50 and `actual_slippage_pct = 0.5`

#### Scenario: S10 disconnect during entry
- **WHEN** the short exchange is in a disconnect window when the entry is submitted and the long leg fills 10
- **THEN** the short order is `REJECTED` with `EXCHANGE_DISCONNECTED` and the trade reaches `CLOSED` with `close_reason = 'EMERGENCY_EXIT'`

#### Scenario: Traceability after every scenario
- **WHEN** any execution scenario completes
- **THEN** `assertTraceability` passes (timestamps present, every transition has an event, event timestamps non-decreasing per trade)
