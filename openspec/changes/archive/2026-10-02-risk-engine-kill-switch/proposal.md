## Why

v0.1 的風控是裝飾：`dryRunEngine.ts` 的 9 項檢查中 r5（基差）、r7（保證金寫死 `$5,000`）、r9（上架驗證）永遠 PASS，r6 以 `volume_24h × 0.02` 冒充盤口深度，唯一的 FAIL 來源是手動 `forceLegImbalance`（HANDOFF P7、issue Q-08）。Paper Runtime 要開始建立 Trade 之前，必須先有一個**每一項都由真實輸入計算、每一項都能 FAIL** 的三階段 Risk Engine（規格書 §22），否則 event-loop 的 ARM 階段（`paper-trading-event-loop`）沒有可呼叫的否決依據；同時規格書 §31 要求「Paper Trading 必須先驗證 Kill Switch」，但 Kill Switch 的分層行為（C-16）仍待決。

分支：`feature-risk-engine-kill-switch`（來自 `develop`）。

> ⚠️ **待 C-16 決議，決議後可能修改**：本 change 的 `kill-switch` capability 依主對話向使用者提出的**推薦方案**（三層分級 L1 / L2 / L3）撰寫，**尚未經使用者決議**。C-16 決議前，kill switch 相關 tasks（tasks.md 第 4 組）一律 blocked，只實作 Risk Engine（第 1–3 組）。

## What Changes

- **Pre-Trade Risk（`runtime/src/risk/preTradeRisk`）**：15 項檢查（規格書 §22 列出的 13 項 + 時鐘可靠度 `CLOCK_UNRELIABLE` + 系統停止進場閘門），每項有明確公式、門檻、`reason_code` 與 FAIL 條件；輸入缺失一律 FAIL（值標 `UNKNOWN`），不得 PASS（Q-08 解方 2）。在 event-loop 的 ARM 階段呼叫；任一 CRITICAL FAIL → Opportunity `REJECTED`。
- **Entry Risk（`executionRisk`）**：在 `ENTRY_PENDING` / `PARTIALLY_HEDGED` 期間持續檢查 7 項（價格偏離、費率變動、訂單逾時、部分成交、leg imbalance、連線、波動），輸出 `CONTINUE` / `HALT_ENTRY` / `EMERGENCY_EXIT` 動作建議；hedge ratio 門檻的狀態轉換與 §15 緊急流程由 `paper-execution` 執行，本 change 只負責判斷與觸發。
- **Position Risk（`positionRisk`）**：在 `HEDGED` / `EXIT_PENDING` 期間檢查 6 項（部位失衡、mark price、basis 分歧、費率變動、持倉時間、退出停滯）。
- **紀錄**：每次評估的每一項寫入 `risk_checks`（含 `created_at` / `updated_at`、輸入快照、`config_version`），並產生 `RISK_CHECK_STARTED` / `RISK_CHECK_PASSED` / `RISK_CHECK_FAILED` TradingEvent；彙總結果沿用 `RiskStatusReport`（`src/types/systemSpec.ts`，規格書 §2.1「保留型別，三階段呼叫」）。
- **Kill Switch（`killSwitch`，⚠️ 待 C-16）**：依推薦方案：L1 `STOP_ENTRY`（預設，只禁止新交易）、L2 `CANCEL_ENTRY`（只撤進場單，絕不撤出場 / 緊急平倉單；因此變成單腿的 Trade 自動走 §15 緊急平倉）、L3 `FLATTEN`（平掉所有部位，Runtime 強制兩段式確認）；自動觸發：交易所斷線 / 資料持續過舊 → L1，Reconciliation Error → L1 + 受影響 Trade `FAILED` 待人工。產生 `KILL_SWITCH_*` 事件。
- **設定**：`PaperTradingConfig` 新增風控門檻欄位（見 design Decision 3），任何修改產生新 `config_version`。
- **文件**：C-16 決議後更新規格書 §23 / §31 / §34 與技術書 §26 / §33；HANDOFF §4.2 P7 標註 Runtime 端已解（研究原型 ② 凍結，不回改）。

## Non-goals

- **不替使用者決定 C-16**；C-16 決議前不實作 kill switch（tasks 第 4 組 blocked）。
- 不決定 C-19（hedge ratio 以名目或數量計算）：本 change 從 `position-accounting` 取得 `hedge_ratio` 數值，不自行定義計算基準。
- 不實作 hedge ratio 門檻的狀態轉換、補單、§15 緊急平倉的下單流程（`paper-execution`）、Trade / Opportunity 狀態機本體（`paper-execution` / `opportunity-lifecycle`）、資金保留的原子操作（`position-accounting`）、斷線與對帳的**偵測**（`runtime-health` / `reconciliation`）、Kill Switch 按鈕 UI（`paper-trading-ui`）。
- 不重新定義 event-loop 已定義的規則：場次階段、`entry_deadline` / `hedged_by` / 鎖定區間、Opportunity 失效規則、`CLOCK_UNRELIABLE` 的時鐘健康判定（`trading-clock`）。
- 不修改研究原型 `src/engine/dryRunEngine.ts`（階段 ② 凍結）。
- 不呼叫任何交易所 API、不下任何真實訂單（Invariant #1）。

## Capabilities

### New Capabilities

- `risk-engine`: 三階段風控（Pre-Trade 15 項、Entry 7 項、Position 6 項）的檢查定義、公式、門檻、FAIL 條件、動作建議、`RiskStatusReport` 彙總、`risk_checks` 紀錄與 TradingEvent；ARM 階段的呼叫契約。
- `kill-switch`: ⚠️ 待 C-16 決議，決議後可能修改。三層分級（L1 STOP_ENTRY / L2 CANCEL_ENTRY / L3 FLATTEN）、手動啟動與解除、L3 兩段式確認、自動觸發對應層級、`KILL_SWITCH_*` 事件。

### Modified Capabilities

（無；`openspec/specs/` 目前沒有既有 capability。引用但不修改：`trading-clock`、`settlement-session`、`opportunity-lifecycle`、`funding-settlement-rules`、`trading-schema`、`event-store`、`paper-execution`、`position-accounting`、`cost-model`、`instrument-registry`、`market-data-stream`、`runtime-health`、`reconciliation`、`paper-trading-ui`、`test-infrastructure`。）

## Impact

- **新增程式**：`runtime/src/risk/`（`preTradeRisk.ts`、`executionRisk.ts`、`positionRisk.ts`、`riskReport.ts`、`killSwitch.ts`）與相鄰 `*.test.ts`；Scenario Test `runtime/test/scenarios/` 的 S09 / S10（風控部分）、S11（kill switch，blocked）。純邏輯 + 注入式介面，不含網路 I/O。
- **依賴**：`setup-vitest`（必要）；型別與 `risk_checks` 表由 `trading-schema` / `event-store` 提供；輸入由 `trading-clock`、`market-data-stream`、`cost-model`、`instrument-registry`、`position-accounting`、`runtime-health` 提供——尚未完成的以假實作（fake）測試。
- **設定**：`PaperTradingConfig` 新增欄位（技術書 §38）。
- **對應**：規格書 §3、§7、§14、§15、§22、§23、§25、§26、§31、§34 C-16 / C-19；技術書 §8、§11、§12、§31–§33、§37、§38、§42 S09–S12；HANDOFF P7 / B8；issue Q-08、BE-07。
