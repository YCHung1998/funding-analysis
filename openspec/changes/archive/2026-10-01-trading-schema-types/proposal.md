## Why

Paper Runtime 的每個模組（Execution、Position、PnL、Risk、Reconciliation、UI）都要讀寫同一組交易實體；目前 repo 只有 v0.1 研究型別（`src/types/schema.ts` 以 Pionex×Binance 為中心、`src/types/systemSpec.ts` 以 5 所欄位平鋪、無時間戳，HANDOFF P10），無法表達規格書 v0.2 的 `Opportunity → Trade → TradeLeg → Order → Fill → FundingSettlement → TradeResult` 階層。必須先建立**唯一的型別來源與術語表**，其他 change 才有共同契約；同時依 C-11 訂出舊型別的漸進遷移規則，避免新舊型別並存擴散。

> 原規劃的 `trading-schema-storage` 超過 12 項任務，依 `openspec/config.yaml` 規則拆為兩份：本 change（型別 + 術語表 + 舊型別遷移規則，capability `trading-schema`）與 `trading-event-store`（SQLite + Event Store + Event Queue，capability `event-store`）。

分支：`feature-trading-schema-types`（來自 `develop`）。

## What Changes

- 新增 `runtime/src/types/`：v0.2 Schema 的 TypeScript 型別單一來源（規格書 §5–§21、技術書 §27）——`ExchangeId`、`Opportunity`、`Trade`、`TradeLeg`、`PaperOrder`、`Fill`、`FundingSettlement`、`TradeResult`、`TradingEvent`、`RiskCheck`、`AccountSnapshot`、`PaperPosition`（儲存用列型別）、全部狀態 enum（§9、§18、§26）與事件代碼目錄（技術書 §26）。
- 狀態轉換表（Opportunity §26.1、Trade §26.2、Leg §26.3、Order §9、FundingSettlement §18）以資料形式定義，並定義「狀態轉換 → 事件代碼」對照，讓「每次狀態轉換都產生 TradingEvent」（§25 #2）可被測試。
- 實體不變式驗證函式（reduce-only、`remaining_quantity`、終態時間、`REJECTED` 必填原因、epoch ms 整數、費率為小數、`mode` 不得為 `LIVE`）與 `TradingEvent.payload` 憑證檢查（Invariant #2）。
- 新增 `runtime/src/types/glossary.ts`：所有狀態 / 事件代碼的英文代碼、中文名稱、一句話定義（✅ C-15、技術書 §27.1），測試保證沒有遺漏。
- 舊型別遷移（✅ C-11、規格書 §2.1）：`FunnelCandidate`、`ArbitrageTradeResult`、`SimulatedOrderLeg`、`OrderState`、`PositionState`、`TimelineMilestone` 標 `@deprecated`；提供「新 → 舊」顯示用 adapter 與歷史資料匯入時的 `timestamp_source: 'UNKNOWN'` 規則；自動檢查 `runtime/src/` 不得 import `src/`；訂出後續一次一型別的遷移順序。
- `RiskStatusReport` / `RiskCheckItem` 的定義搬到 `runtime/src/types/risk.ts`，`src/types/systemSpec.ts` 改為 re-export（形狀不變，規格書 §6「沿用」）。

## Non-goals

- 不建立 SQLite、migration、Event Store、Event Queue（屬 `trading-event-store`）。
- 不實作任何狀態機的執行邏輯（撮合、對沖、平倉屬 `paper-execution-engine`；Position / PnL 計算屬 `position-funding-pnl`）。
- 不在本 change 內實際把研究 UI 的 import 改到新型別；每個舊型別的替換是之後各自獨立、一次一型別的 PR（規格書 §2.1 規則 2）。
- 不修改規格書 / 技術書；發現需調整之處列於 design 的 Open Questions。
- 不加入 `Trade.mode = 'LIVE'`（✅ C-18）、不定義 `KILL_SWITCH_*` 事件（⚠️ C-16 待決）、不決定 hedge ratio 計算基準（⚠️ C-19 待決）。
- 不新增任何真實下單端點（Invariant #1）。

## Capabilities

### New Capabilities

- `trading-schema`: v0.2 交易實體型別、狀態 enum 與轉換表、事件代碼目錄與 `TradingEvent` 形狀、實體不變式與憑證檢查、術語表、舊型別遷移規則。其他 change 一律 import 本 capability，不得自行定義同名型別。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability）

## Impact

- **新增程式**：`runtime/src/types/*.ts`（純型別 + 純函式 + 單元測試）、`src/types/legacy/`（新 → 舊顯示 adapter、歷史資料匯入）。
- **修改程式**：`src/types/schema.ts`、`src/types/systemSpec.ts` 加 `@deprecated` JSDoc 與 re-export，行為不變。
- **依賴**：`setup-vitest`（`test-infrastructure`）。若 `paper-trading-event-loop` 尚未建立 `runtime/` 骨架（其 task 2.1），本 change 建立同一份骨架。
- **下游**：`trading-event-store`、`paper-execution-engine`、`runtime-health-reconciliation`、`position-funding-pnl`、`risk-engine-kill-switch`、`paper-trading-ui`、`paper-trading-event-loop` 皆 import 本 capability。
- **對應**：規格書 §2.1、§4–§21、§25、§26、§33；技術書 §4、§26、§27、§27.1；決策 ✅ C-10、C-11、C-12、C-14、C-15、C-17、C-18；HANDOFF P10、Invariant #1、#2、#5、#6。
