/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Funding Arbitrage System Spec - Formal Repository
 * Spec v0.1: Foundations + 7-Module System Architecture (Research / Dry-run).
 * Spec v0.2 (Paper Trading) lives in docs/TRADING_SYSTEM_SPEC.md.
 */

export interface SpecSection {
  id: string;
  number: string;
  title: string;
  summary: string;
  contentMarkdown: string;
  keyFormulas?: string[];
  metricsTable?: { field: string; definition: string; purpose: string }[];
}

export const SPEC_V01_SECTIONS: SpecSection[] = [
  {
    id: 'section-system-modules',
    number: '00',
    title: '系統 7 大架構模組 (The 7-Module System Architecture)',
    summary: '將系統嚴格固定為 M1 ~ M7 七個專業模組，支撐從 Research → Dry-run → Live Trading 的漸進式落地。',
    contentMarkdown: `
### 7 大核心模組分工表
| Module | 模組名稱 | 職責與核心工作 |
| :--- | :--- | :--- |
| **M1** | **Data Adapter** | Pionex / Binance / Bitget (Truth) & CoinGlass (Intelligence) → 統一轉為 Common Schema |
| **M2** | **Historical Data** | Funding 結算紀錄 + 結算前後 ±2m 1m Kline + Volume 成交量衝擊分析 |
| **M3** | **Funnel Scanner** | 三級篩選漏斗：T-30m 廣篩 → T-5m 深度與預期純利 → T-30s 終審 Top 3 |
| **M4** | **Strategy Engine** | 動態結算週期 (1h/4h/8h)、費率差計算、固定剛性手續費損耗、預期純利模型 |
| **M5** | **Execution & Latency** | REST POST / WebSocket ACK / Fill / Cancel / Close，精確記錄微秒級延遲數據 |
| **M6** | **Risk Engine** | 9 大盤前/盤中風控檢查、Leg Imbalance 單腿殘留自動平倉、掛單取消 vs 部位平倉防護 |
| **M7** | **Visualization & Console** | 4 區塊 Dry-run 即時控制台、執行時序圖、損益瀑布、本機端機密管理庫 |
    `,
  },
  {
    id: 'section-data-sources',
    number: '01',
    title: '資料源邊界：Exchange Truth Layer vs Market Intelligence Layer',
    summary: 'CoinGlass 嚴格作為市場情報層，絕不作為下單來源；Pionex / Binance / Bitget 才是真實撮合與帳戶結算 Truth Layer。',
    contentMarkdown: `
### 核心邊界隔離原則
\`\`\`text
Market Intelligence Layer (市場情報層)
      CoinGlass API (資金費率聚合、全市場橫向比較、熱門板塊雷達)
      ※ 嚴禁直接用於實盤下單與部位狀態確認！

Execution / Exchange Truth Layer (真實撮合層)
      Pionex API / Binance API / Bitget API (真實深度、即時撮合、帳戶保證金)
      ※ 唯一的訂單發送、WebSocket User Data 與帳戶真實資產來源！
\`\`\`

### Common Schema 欄位統一原則
無論未來擴充至 5 間還是 10 間交易所 (OKX, Bybit...)，皆由各自的 Adapter 轉換為 Common Schema，Strategy 模組絕不出現在程式碼內寫 \`if (Pionex) ... else if (Binance)\` 的硬編碼分支。
    `,
  },
  {
    id: 'section-dynamic-intervals',
    number: '02',
    title: '動態結算週期修正 (Dynamic 1h / 4h / 8h + ~1m Tolerance)',
    summary: '修正固定 8 小時假設！Pionex 官方合約明確包含 1h、4h、8h 等多種週期，且結算存在約 1 分鐘偏差，必須以實際 funding_time 為準。',
    contentMarkdown: `
### 關鍵實務修正
* **不得硬編碼 8 小時週期**：
  * 高波動熱門合約 (如 WIF、PEPE 等) 在極端行情下常開啟 **1 小時或 4 小時動態結算**。
  * 主流幣 (BTC, ETH) 通常為 8 小時。
* **約 1 分鐘結算時間偏差 (~1 min Settlement Drift)**：
  * 交易所撮合引擎在大量合約同時清算時，資金劃轉常有數秒至 1 分鐘的計算延遲。
  * 系統必須以交易所返回的 \`funding_time\` 與 \`next_funding_time\` 動態對齊，不依賴本機作業系統的整點時鐘。
    `,
  },
  {
    id: 'section-three-level-funnel',
    number: '03',
    title: '掃幣機制：三級漏斗 (Three-Level Funnel Scanner)',
    summary: 'T-30m 廣泛篩選 → T-5m 深度與預期純利排定 Top 3 → T-30s 最終風控審查 Trade / Abort。',
    contentMarkdown: `
### 漏斗分級工作時序
1. **Level 1 (T-30m ~ T-10m) 廣泛篩選**:
   * 對象：所有共同交易標的 (20+ Perpetuals)
   * 評估：Funding Spread > 0.10%、24h 成交量、基本流動性
   * 產出：**Top 20 候選清單**
2. **Level 2 (T-5m) 深度與預期純利審查**:
   * 對象：Top 20
   * 評估：重新拉取最新 Order Book 買賣盤口、盤口點差、成交量突增、雙邊 Taker 費率
   * 計算公式：$$\\text{Expected Net PnL} = \\text{Spread} - \\text{Fee Drag (0.20\\%)} - \\text{Est. Slippage}$$
   * 產出：**Top 3 精選標的**
3. **Level 3 (T-30s) 最終下單驗證 (Final Pre-Flight Check)**:
   * 對象：Top 3 (鎖定 Rank 1 標的)
   * 評估：雙邊 API 延遲 (Ping)、盤口深度能否吃下 1000U、費率有無突變、保證金是否充裕
   * 最終決策：**TRADE 或 ABORT (放棄交易)**
    `,
  },
  {
    id: 'section-latency-schema',
    number: '04',
    title: 'Latency Layer：延遲數據結構化 (Latency Telemetry Schema)',
    summary: 'API 與撮合延遲絕不能只是 Debug Log，必須升級為一級資料欄位，以量化每毫秒的滑價代價。',
    contentMarkdown: `
### 延遲結構化 Schema 欄位
* **Request 往返延遲**:
  * \`request_sent_at\`: 本地發出 HTTP REST 請求微秒戳
  * \`request_received_at\`: 交易所網關接收戳
  * \`response_received_at\`: 本地收到 HTTP 回應微秒戳
  * \`network_latency_ms\`: 網路往返往返時間
* **Order 撮合生命週期延遲**:
  * \`order_submit_time\`: 送出下單
  * \`order_ack_time\`: 交易所返回訂單確認 (ACK)
  * \`order_fill_time\`: WebSocket User Data 推送完全成交 (FILL)
  * \`order_cancel_time\`: 取消確認延遲
* **核心量化衍生指標**:
  * \`api_latency_ms = order_ack_time - order_submit_time\`
  * \`fill_latency_ms = order_fill_time - order_ack_time\`

> **量化核心問題：** 當你發現 0.20% 資金費差的那一刻，到雙邊完成成交的數百毫秒內，這個 0.20% 還剩多少？
    `,
  },
  {
    id: 'section-execution-safety',
    number: '05',
    title: 'Execution Safety Layer：掛單取消 vs 部位平倉防護',
    summary: '嚴格區分 Cancel Pending Order 與 Close Filled Position，並內建 Leg Imbalance 單腿殘留自動平倉機制。',
    contentMarkdown: `
### 實盤最致命的盲區：Cancel ≠ Close
1. **Pending 未成交訂單**:
   * 狀態為 \`NEW\` 或 \`PARTIALLY_FILLED\`
   * 可調用 \`CANCEL_ORDER\` 取消掛單，釋放保證金。
2. **已成交部位 (Filled Position)**:
   * 狀態為 \`FILLED\`
   * **絕不能靠取消訂單解決！** 必須立即以市價執行 \`CLOSE_POSITION\`。

### 單腿殘留 (Leg Imbalance) 急停平倉
若發生極端異常：
\`\`\`text
Pionex  = FILLED (持有 1000U 裸空頭)
Binance = REJECTED / NOT FILLED (0U 部位)
\`\`\`
此時系統立即進入 **\`LEG_IMBALANCE\` 狀態**，嚴禁盲目等待！Safety Layer 會在數百毫秒內發起 **EMERGENCY CLOSE** 將 Pionex 已成交部位平倉，切斷單邊行情暴拉暴跌的巨大非對稱風險。
    `,
  },
  {
    id: 'section-local-secrets',
    number: '06',
    title: '隱私安全：Local Only 機密管理與權限最小化',
    summary: 'API Key 與 Secret 永遠保存在本機端，絕不進入 Common Data，嚴禁開啟提現權限，強制 IP 白名單。',
    contentMarkdown: `
### 機密管理四項軍規
1. **Common Schema ≠ Credentials**:
   * 機密參數與行情回測數據徹底物理隔離。
   * 回測、報表、Parquet、CSV 匯出絕對不含任何 API 憑證。
2. **Local Machine Storage**:
   * 憑證僅保留在本機端記憶體或本地安全密鑰庫中。
   * 不上傳 Cloud、不進日誌、不隨 Telemetry 發送。
3. **權限最小化 (Least Privilege)**:
   * Pionex: Read ✅, Trading ✅, **Withdraw ❌**
   * Binance: Read ✅, Futures Trading ✅, **Withdraw ❌**
4. **IP 白名單強制 (IP Whitelist)**:
   * 所有實盤金鑰皆需綁定固定伺服器 IP，防止金鑰外洩遭第三方調用。
    `,
  },
  {
    id: 'section-dry-run-spec',
    number: '07',
    title: 'Dry-Run 模擬全流程 (Full-Fidelity Simulation)',
    summary: 'Dry-run 必須模擬包含網路延遲、ACK、成交、資金劃轉、雙邊平倉與滑價損益的完整生命週期。',
    contentMarkdown: `
### 4 大視覺化監控區 (The 4 Zones)
* **Zone A: Pre-Market / Pre-Funding Analysis**
  * 呈現 Top 3 候選標的之 Pionex / Binance 費率、Spread、預估滑價、預期淨純利。
* **Zone B: Execution Timeline**
  * 毫秒級時間軸，忠實展示 T-30m 掃描到 T+30s 平倉每一步驟與 API 延遲。
* **Zone C: Cost / Profit Decomposition Table**
  * 雙邊交易所分拆表 (Position, Entry Fee, Exit Fee, Entry Slip, Exit Slip, Price PnL, Funding PnL, Realized Net PnL)。
* **Zone D: 9-Factor Risk Health Panel**
  * 連線、延遲、單腿平衡、盤口厚度、滑價上限、保證金率等 9 大檢查點。
    `,
  },
];
