## Context

- 規格書 v0.2 §5–§21 定義了交易實體；技術書 §4 指定 `runtime/src/types/` 為單一來源、§27.1 指定術語表位置。其他 agent 撰寫的 change（`position-funding-pnl`、`risk-engine-kill-switch`、`paper-trading-ui`、`paper-trading-event-loop`）被告知「以規格書 §5–§21 為準」，因此本 change 的欄位命名必須與規格書**逐字一致**，只能做「加欄位」式的補充，不得改名或改型別。
- 現況：`src/types/schema.ts`（`ArbitrageTradeResult` 以 `pionex_leg` / `binance_leg` 為中心）、`src/types/systemSpec.ts`（`FunnelCandidate` 5 所欄位平鋪、`OrderState` 只有 5 個狀態、`TimelineMilestone` 用相對 T 字串）。引用者：`src/App.tsx`、`src/components/FunnelScannerView.tsx`、`ArbitrageScanner.tsx`、`DryRunConsole.tsx`、`src/engine/dryRunEngine.ts`、`funnelScanner.ts`、`arbitrageEngine.ts`。
- 限制：HANDOFF §3 Invariants；規格書 §25 時間戳硬性規則；C-11 每步三綠；dry-run 凍結（C-04）。

## Goals / Non-Goals

**Goals:**
- 一份可被所有 Runtime 模組 import 的型別、狀態轉換表、事件目錄、術語表。
- 把規格書中「每次狀態轉換產生事件」「每個實體有時間戳」「reduce-only」「費率為小數」變成可自動測試的函式。
- 定義舊型別退場路徑，確保新邏輯永遠不依賴舊型別。

**Non-Goals:**
- 資料庫、事件寫入、撮合、PnL 計算；實際把研究 UI 改 import（後續各自 PR）。

## Decisions

### 1. 檔案切分

```
runtime/src/types/
├── ids.ts            ExchangeId、ID 型別別名（TradeId = string …）、TimestampSource
├── status.ts         *_STATES 陣列、union 型別、轉換表、isAllowedTransition、transitionEventType
├── opportunity.ts    Opportunity
├── trade.ts          Trade、TradeLeg
├── order.ts          PaperOrder、OrderRequest 不在此（屬 paper-execution）
├── fill.ts           Fill
├── funding.ts        FundingSettlement
├── result.ts         TradeResult
├── risk.ts           RiskStatusReport、RiskCheckItem（從 systemSpec.ts 搬入）、RiskCheck
├── account.ts        AccountSnapshot、PaperPosition
├── event.ts          TradingEventType、TradingEvent、makeTransitionEvent
├── validate.ts       validateEntity、assertNoCredentials
├── glossary.ts       GLOSSARY、getGlossaryEntry
└── index.ts
```

- 狀態 enum 以 `as const` 陣列 + `typeof X[number]` 產生 union：同時有型別與可迭代的執行期資料（術語表完整性測試、轉換表窮舉測試都需要）。**替代方案** TypeScript `enum` → 產生額外執行期物件、字串比較不直覺，且規格書以字串字面值描述，否決。
- 型別為純 TS，不引入 zod 等 schema 函式庫（`npm install` 不在本 change 範圍；驗證函式手寫即可）。**替代方案** zod → 型別與驗證同源是優點，但新增依賴、且與 `--legacy-peer-deps` 環境的相容性未驗證，留待日後評估。

### 2. 與規格書不一致處的處理原則：只加不改

| 位置 | 規格書 | 本 change | 理由 |
|------|--------|-----------|------|
| `Opportunity` | 無 `created_at` | 加 `created_at`（= `detected_at`） | §25 #1 硬性規則；技術書 §10 也寫 `created_at` |
| `Fill` | 無 `created_at`/`updated_at` | 加，兩者 = `recorded_at` | §25 #1 列出 Fill；Fill 不可變 |
| `TradeResult` | 無 `created_at`/`updated_at`；`finalized_at` 必填 | 加兩欄；`finalized_at?` 可選 + `funding_confirmed` | §25 #1；`funding-settlement-rules` 要求「已平倉 · 待入帳」 |
| `FundingSettlement` | — | 加 `mark_price_source?`、`settled_rate_published_at?`、`publication_delay_ms?` | event-loop 規則要求 |
| `TradingEvent.trade_id` | `string` | `string \| null` | 技術書 §26 自己列了 `OPPORTUNITY_*`、`STALE_MARKET_DATA` 等無 Trade 的事件，必填與之矛盾 |
| `TradingEvent` | — | 加 `opportunity_id?`、`session_id?`、`clock_reference?` | 查詢與 event-loop `clock_reference` 規則 |

全部列入 Open Questions 請使用者確認後回寫規格書；在確認前以本表為準（加欄位不破壞其他 change 對規格書欄位的依賴）。

### 3. `RiskStatusReport` 的「沿用」

規格書 §6 寫 `risk_status: RiskStatusReport // 沿用 src/types/systemSpec.ts`，但 C-11 規則 3 禁止新邏輯依賴舊檔案。做法：定義**原封不動**搬到 `runtime/src/types/risk.ts`，`systemSpec.ts` 改為 `export type { RiskStatusReport, RiskCheckItem } from '../../runtime/src/types/risk'`。形狀不變、來源唯一、研究 UI 零修改。**替代方案** runtime import `src/types/systemSpec.ts` → 違反方向規則，否決。

### 4. 狀態轉換表與事件對照

- Order 轉換完全依 §9 圖（C-14）：`CANCEL_REQUESTED` 可回到 `ACKNOWLEDGED` / `PARTIALLY_FILLED`（撤單失敗，事件 `ORDER_CANCEL_REJECTED`）；`ORDER_TIMEOUT`、`ORDER_ACK_TIMEOUT` 是非轉換事件。
- Leg 狀態：§26.3 只有表沒有圖，本 change 依定義推出轉換（見 spec），列入 Open Questions。
- 事件擴充碼：技術書 §26 未涵蓋但 §25 #2 要求的轉換（Leg、FundingSettlement 非 SETTLED 的轉換）、資金保留（§12 需可 replay）、event-loop 已使用的 `SESSION_PHASE_CHANGED` / `CLOCK_*`、以及 `runtime-health-reconciliation` 需要的 `ENTRY_HALT_REQUESTED`、`RUNTIME_*`，**集中在本 capability 定義**。其他 change 需要新代碼時，必須在自己的 tasks 中同時加入 `TradingEventType` 與術語表條目（完整性測試會擋下遺漏）。
- 轉換事件 payload 帶 `after`（轉換後實體完整快照）：讓 Event Store 能純靠事件重建所有投影表（`trading-event-store` 的 replay 需求），代價是事件體積較大；Paper 階段每筆 Trade 事件數在百筆量級，可接受。

### 5. 憑證檢查放在型別層

`assertNoCredentials` 是純函式、放在 `validate.ts`，由 `trading-event-store` 在寫入前呼叫、`makeTransitionEvent` 也呼叫。敏感值清單由 Runtime 啟動時從 `.env.local` 讀出後注入（本模組不讀環境變數）。錯誤訊息只含路徑不含值。

### 6. 費率小數檢查門檻

`|rate| ≤ 0.05`（5%/次）：各所單次費率上限遠低於此，而「把 0.25% 存成 0.25」會被擋下（Invariant #5）。常數可調整，列入 Open Questions。

### 7. 舊型別遷移路線（C-11）

- 本 change：標 `@deprecated`、建立 `src/types/legacy/`（v0.2 → v0.1 顯示 adapter、v0.1 歷史資料匯入 `WithUnknownTimestamps<T>`）、邊界測試（`runtime/src/**` 不得 import `src/**`）。
- 後續一次一型別（各自 PR，先寫 characterization test 鎖住現有輸出，每步三綠）：
  1. `OrderState` → 2. `SimulatedOrderLeg` → 3. `PositionState` → 4. `TimelineMilestone`（改由 `TradingEvent` 推導，技術書 §27）→ 5. `ArbitrageTradeResult` → 6. `FunnelCandidate`（最後，依賴 Instrument Registry 與 Runtime scanner）。
- `dryRunEngine.ts` 凍結（C-04）：只在上述步驟需要時改 import，不改行為；characterization test 為其輸出（固定輸入下的 `position_state`、`cost_table`）建立快照。

## Risks / Trade-offs

- [其他 change 已依規格書欄位撰寫，但本 change 加欄位] → 只加不改；新增欄位多為可選或由 Runtime 自動填入。
- [`trade_id: string | null` 與規格書不同] → 列 Open Question；型別層以 validator 保證 trade-scoped 事件必有 `trade_id`。
- [轉換事件帶完整快照使 DB 膨脹] → Paper 量級可接受；日後可改存差異並以 migration 轉換。
- [研究 UI 經 re-export 引入 `runtime/`，Vite / tsconfig 解析路徑] → `tsconfig.json` 無 `include` 限制、`moduleResolution: bundler` 支援相對路徑；task 1.2 以 `npm run build` 驗證。
- [event-loop 若先合併，可能已有暫時型別] → 其合併後由本 change 的 task 取代為 import（見 tasks 2.1 註記）。

## Migration Plan

- 新增檔案 + JSDoc，研究 UI 行為不變；在 `feature-trading-schema-types` 開發，`--no-ff` merge 回 `develop`；rollback = `git revert -m 1 <merge-commit>`（技術書 §51）。

## Open Questions

1. **規格書補欄位**（Decision 2 表）：`Opportunity.created_at`、`Fill.created_at/updated_at`、`TradeResult.created_at/updated_at/funding_confirmed`、`TradeResult.finalized_at` 改可選、`FundingSettlement` 三個 event-loop 欄位、`TradingEvent.trade_id: string | null` 與 `opportunity_id?`/`session_id?`/`clock_reference?`——是否同意回寫規格書 §5、§11、§18、§21 與技術書 §27？
2. **Leg 狀態轉換**：§26.3 無轉換圖，本 change 採 `PENDING→OPENING|FAILED`、`OPENING→PARTIAL|OPEN|FAILED`、`PARTIAL→OPEN|CLOSING`、`OPEN→CLOSING`、`CLOSING→CLOSED|FAILED`；`PARTIAL→CLOSING` 用於緊急平倉。是否同意？
3. **事件擴充碼**：`LEG_STATUS_CHANGED`、`FUNDING_STATUS_CHANGED`、`CAPITAL_RESERVED`、`CAPITAL_RELEASED`、`ENTRY_HALT_REQUESTED`、`ENTRY_HALT_CLEARED`、`RUNTIME_STARTUP_STEP`、`RUNTIME_ARMED`、`RUNTIME_DISARMED` 是否加入技術書 §26？
4. **`AccountSnapshot` 名稱衝突**：技術書 §5 `ExchangeAdapter.getAccount(): Promise<AccountSnapshot>` 指交易所唯讀帳戶資訊（手續費等級 / 限流），與 §29 `account_snapshots`（虛擬帳本）同名。本 change 以 `AccountSnapshot` = 虛擬帳本；建議 adapter 回傳型別改名 `ExchangeAccountInfo`（屬 adapter 所屬 change）。
5. **`PaperPosition`**：§29 有 `positions` 表但規格書無 Position 型別；本 change 只定義儲存列形狀，計算語意屬 `position-accounting`。若該 change 已有不同欄位，以協調後的版本為準。
6. **費率小數門檻 0.05** 是否合適？
7. **術語表 category** 是否加入 `SESSION`、`HEALTH`（event-loop 場次階段、runtime-health 狀態）？
