# runtime/ — Paper Trading Runtime（Node）

技術書 §4 指定的新程式碼位置。研究原型（`src/`、`server.ts`）凍結，新邏輯一律放這裡。

## 規則（`runtime/test/architecture.test.ts` 自動把關）

1. **時間只能經由注入的 `Clock` 取得**：`runtime/src/` 內除 `clock/realClock.ts` 外，不得直接呼叫 `Date.now()`、`setTimeout`、`setInterval`。
2. **單向依賴**：`runtime/src/` 不得 import 研究原型 `src/`（C-11 規則 3）；研究 UI 需要新型別時，由 `src/` re-export `runtime/src/types/`。
3. **測試放在模組旁**：`runtime/src/**/x.test.ts`；跨模組情境測試放 `runtime/test/scenarios/`。`npm test` 會自動執行 `runtime/**/*.test.ts`。
4. **型別單一來源**：交易實體型別（`ExchangeId`、`TradingEvent`、`Trade` …）只能定義在 `runtime/src/types/`，由 change `trading-schema-types` 擁有。

## 目錄所有權（第一波並行開發時避免衝突）

| 目錄 | 擁有的 change |
|------|--------------|
| `runtime/src/types/` | `trading-schema-types` |
| `runtime/src/clock/`、`scheduler/`、`session/`、`opportunity/`、`venue/`、`funding/`（純邏輯：時鐘、排程、結算場次、機會失效、交易所結算規則、資金費確認） | `paper-trading-event-loop` |
| `runtime/src/market/instruments/` | `instrument-registry` |
| `runtime/test/architecture.test.ts`、本檔 | 共用骨架（修改需在 PR 說明） |

非擁有者需要的型別若尚未合併，先在**自己目錄內**宣告本地型別並加 `// TODO(trading-schema-types): 合併後改為 import`，不得在 `runtime/src/types/` 建立同名檔案。
