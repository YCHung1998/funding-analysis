/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Contextual Help & Documentation Modal (?)
 * Provides page-specific guides, mathematical definitions, terminology,
 * and clear explanations of API Key usage.
 */

import React from 'react';
import { ActiveTab } from './Header';
import {
  HelpCircle,
  X,
  Key,
  ShieldCheck,
  Zap,
  Clock,
  Layers,
  Sliders,
  DollarSign,
  AlertTriangle,
  ArrowRight
} from 'lucide-react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: ActiveTab;
}

interface PageHelpContent {
  title: string;
  moduleTag: string;
  purpose: string;
  howToUse: string[];
  keyTerms: Array<{ term: string; explanation: string }>;
  apiKeyNote?: string;
}

const HELP_DICTIONARY: Record<ActiveTab, PageHelpContent> = {
  funnel: {
    title: 'M3. Funnel Scanner (五大交易所套利漏斗)',
    moduleTag: 'MODULE 3: MULTI-EXCHANGE SCANNER',
    purpose: '自動同時監控 Pionex、Binance、Bybit、Bitget、OKX 五大交易所共 850+ 永續合約，即時計算全排列長短腿最佳資費差 (Max Spread) 與預期純利 (Expected Net PnL)。',
    howToUse: [
      '點擊上方「即時掃描五大交易所」，後端在 300ms 內並行拉取五家交易所全部合約資費（無需任何 API Key）。',
      '點選上方交易所按鈕 (Pionex / Binance / Bybit / Bitget / OKX) 可自由勾選或剔除特定交易所。',
      '「交易所覆蓋度」可篩選 5/5 全網通、≥4 家通用型、≥3 家普及型或雙所配對型。',
      '點擊任意表頭（如 Pionex Rate、Binance Rate、Bybit Rate、Bitget Rate、OKX Rate、Max Spread 等）皆可正反排序。',
      '點選任一行右側的「Run Dry-Run」，可直接將該雙邊合約帶入 Dry-Run 控制台進行 10 秒即時更新與 60 秒模擬。',
    ],
    keyTerms: [
      { term: 'Max Spread (最大跨所費率差)', explanation: '在所選交易所中 max(Funding Rate) - min(Funding Rate)。例如 OKX 費率 0.01% 而 Bitget 為 0.27%，差值即為 0.26%。' },
      { term: '最佳套利方向 (Long A / Short B)', explanation: '費率最低（或最負）的交易所開多倉收資金費；費率最高的交易所開空倉收資金費，鎖定無方向性雙重收益。' },
      { term: 'Deterministic Fee Drag (0.20%)', explanation: '雙邊開倉 + 雙邊平倉共 4 筆 Taker 交易手續費剛性扣除 0.20% (4 × 0.05%)。' },
      { term: 'Expected Net PnL', explanation: 'Max Spread 扣除 0.20% 手續費與預估滑價後，單次 1000U 能真正賺到的淨利潤。' },
    ],
    apiKeyNote: '五大交易所公開行情掃描皆為官方公開 REST 端點，100% 不需要任何 API Key。只有實盤下單與私有帳戶保證金查詢才需要私有金鑰。',
  },
  dryrun: {
    title: 'M5/M7. Dry-Run Console (全流程模擬控制台)',
    moduleTag: 'MODULE 5 & 7: EXECUTION & VISUALIZATION',
    purpose: '模擬 T-30s 到 T+30s 的 60 秒真實執行生命週期，忠實還原 REST 下單、WebSocket ACK、撮合成交、資金劃轉與手續費/滑價損益瀑布。',
    howToUse: [
      'Zone A 檢視 T-5m 篩選出的 Top 3 標的與預期收益。',
      'Zone B 查看微秒/毫秒級的執行時間軸，評估網路延遲 (API Latency) 對滑價的影響。',
      'Zone C 檢閱 Pionex 與 Binance 各自的分拆成本表（倉位、4 筆手續費、4 筆滑價、價差偏離與最終 Net PnL）。',
      'Zone D 查看 9 大風控指標。可點擊「Inject Leg Imbalance」模擬一邊成交一邊被拒絕的單腿殘留急停平倉情境。',
    ],
    keyTerms: [
      { term: 'Deterministic Fee Drag (0.20%)', explanation: '雙邊開倉 + 雙邊平倉共 4 筆 Taker 訂單 (4 × 0.05% = 0.20%)，1000U 名義部位剛性固定扣除 2.00 USDT。' },
      { term: 'Cancel vs Close', explanation: '未成交的掛單調用 CANCEL；已成交的部位必須調用 CLOSE 市價平倉，絕不能靠取消訂單處理。' },
      { term: 'Leg Imbalance (單腿失衡)', explanation: 'Pionex 已成交但 Binance 遭拒時，系統觸發緊急避險，在數百毫秒內平倉已成交邊，避免單邊裸露風險。' },
    ],
  },
  scanner: {
    title: 'M4. Arbitrage Scanner (回測與歷史機會掃描)',
    moduleTag: 'MODULE 4: STRATEGY & SCANNER',
    purpose: '展示歷史回測與跨週期異動事件庫，提供研究門檻過濾與損益分拆。',
    howToUse: [
      '透過搜尋框輸入幣種名稱，或點選門檻過濾器 (≥ 0.20% / Realized Net > 0)。',
      '點選任一行可切換當前選定幣種，或點擊「View ±2m」深入查看該結算事件前後的 K 線。',
    ],
    keyTerms: [
      { term: 'Research Threshold = 0.20%', explanation: '由於手續費剛性損耗恰好 0.20%，Spread < 0.20% 即使零滑價也必然虧損，因此 0.20% 為最低研究門檻。' },
      { term: 'Price PnL (基差偏離)', explanation: '持倉 60 秒期間兩交易所合約價格微幅脫鉤所造成的價差損益。' },
    ],
  },
  klines: {
    title: 'M2. ±2m Kline & Volume (結算波動與成交量衝擊)',
    moduleTag: 'MODULE 2: HISTORICAL KLINE & SHOCK',
    purpose: '記錄資金費率結算時間 T 的前後兩分鐘 (T-2m, T-1m, T, T+1m, T+2m) 連續 5 根 1 分鐘 K 線與成交量，評估瞬間滑價因子。',
    howToUse: [
      '點擊右上角「Fetch Live 1m Klines」可即時從交易所抓取該幣種真實的 1 分鐘 K 線。',
      '對比 T 結算時刻的 Volume Bar 與前後基準，觀察成交量突增倍數 (Volume Shock)。',
      '下方表格呈現每根 K 線的 High-Low 振幅、漲跌幅與波動度，量化套利者平倉湧入對盤口的衝擊。',
    ],
    keyTerms: [
      { term: 'Volume Shock (成交量暴衝)', explanation: 'T 結算時刻成交量除以 (T-2m, T-1m) 平均成交量的倍數，通常高達 3x ~ 6x。' },
      { term: 'Max Excursion', explanation: '結算瞬間價格擺動的最大振幅，是決定進出場市價單被吃穿幾檔（滑價）的核心推手。' },
    ],
  },
  simulator: {
    title: 'M5. 60s Execution Flow (執行生命週期瀑布)',
    moduleTag: 'MODULE 5: EXECUTION FLOW',
    purpose: '步進式解析 T-30s 進場 ──► T 資金結算 ──► T+30s 出場的損益扣減瀑布。',
    howToUse: [
      '調整上方 Position Notional (500U, 1000U, 2000U) 與 Slippage 滑價容忍度。',
      '觀察淨利潤如何從 Gross PnL 一路扣除手續費與滑價，最終得出 Realized Net PnL。',
    ],
    keyTerms: [
      { term: 'Gross PnL', explanation: 'Funding PnL (資金費收入) + Price PnL (價格偏離損益)。' },
      { term: 'Net PnL', explanation: 'Gross PnL - (Entry Fee + Exit Fee) - (Entry Slippage + Exit Slippage)。' },
    ],
  },
  sensitivity: {
    title: 'M4. Sensitivity Matrix (敏感度前沿矩陣)',
    moduleTag: 'MODULE 4: RESEARCH FRONTIER',
    purpose: '二維映射 Funding Spread (0.10% ~ 0.50%) 與盤口滑價 (0.01% ~ 0.08%)，找出絕對保證盈利的損益兩平邊界線。',
    howToUse: [
      '觀察綠色（盈利）與紅色（虧損）的分水嶺。',
      '點擊 VIP 0 vs VIP 1 切換不同手續費等級，了解降低手續費如何擴大獲利空間。',
    ],
    keyTerms: [
      { term: 'Breakeven Frontier (兩平前沿)', explanation: 'Spread = 總手續費率 (0.20%) + 總滑價率時的邊界線。' },
    ],
  },
  schema: {
    title: 'M1. Common Schema & Adapters (共同資料架構)',
    moduleTag: 'MODULE 1: DATA ABSTRACTION',
    purpose: '展示四大交易所 (Pionex, Binance, Bybit, Bitget) 如何透過各自的 Adapter 轉換成統一的 21 個核心操作欄位，徹底杜絕多交易所程式碼污染。',
    howToUse: [
      '檢視 21 個標準欄位與四大交易所原生 API 欄位的精確對映矩陣。',
      '點選切換「Pionex / Binance / Bybit / Bitget Live Transform」查看真實 JSON 轉換為 Common Schema 的即時過程。',
    ],
    keyTerms: [
      { term: 'Common Schema', explanation: '策略與風控唯一依賴的資料模型，增加新交易所只需新增 Adapter，核心策略無需任何改動。' },
      { term: 'Traceability (溯源)', explanation: '透過 native_symbol 與 native_field_mapping 隨時能追蹤數據對應的原生欄位。' },
    ],
  },
  secrets: {
    title: 'Local Secret Vault (本機機密金鑰管理)',
    moduleTag: 'SECURITY & LOCAL CREDENTIALS',
    purpose: '管理四大交易所 API Key 與 Secret。嚴格遵循本機儲存、權限最小化（絕無提現權限）與 IP 白名單防護。',
    howToUse: [
      '查看下方「為什麼需要這些 API Key」的詳細職責清單。',
      '填入 Pionex、Binance、Bybit、Bitget 的 API Key / Secret（金鑰僅存於您的本機瀏覽器 localStorage，絕不上傳雲端）。',
      '確認勾選「未開通提現權限」與「IP 白名單綁定」安全檢查項。',
    ],
    keyTerms: [
      { term: 'Zero-Trust Local Storage', explanation: 'API Key 與任何回測數據完全隔離，絕不隨 Parquet/CSV 上傳，絕不進 Server 日誌。' },
      { term: 'Least Privilege (權限最小化)', explanation: '僅開通 Read (讀取) 與 Futures Trading (合約下單)，嚴格關閉 Withdrawal (提現)。' },
    ],
    apiKeyNote: '公開市場掃描不需任何 API Key；只有實盤下單、保證金檢查與帳戶倉位監控需要私有 Key。',
  },
  spec: {
    title: 'System Spec v0.1 (規格庫與未來備忘錄)',
    moduleTag: 'SPECIFICATION KNOWLEDGE BASE',
    purpose: '永久固化 7 大模組規格定義、公式手冊，並提供本機持久化的未來版本備忘錄（逐步記憶擴充庫）。',
    howToUse: [
      '點擊左側章節切換查看 00 ~ 07 完整規格與數學公式。',
      '在最下方「未來 Spec 擴充備忘錄」可隨時新增您後續想加入的策略規則，自動保存至本機。',
    ],
    keyTerms: [
      { term: 'Spec Memory Vault', explanation: '協助您逐步累積與固化套利系統的演進歷史與規則版本。' },
    ],
  },
};

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose, activeTab }) => {
  if (!isOpen) return null;

  const content = HELP_DICTIONARY[activeTab] || HELP_DICTIONARY.funnel;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <HelpCircle className="w-5 h-5" />
            </div>
            <div>
              <div className="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">
                {content.moduleTag} · 使用說明與核心定義
              </div>
              <h3 className="text-base font-bold text-slate-100 mt-0.5">
                {content.title}
              </h3>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs leading-relaxed font-sans scrollbar-thin">
          {/* Section 1: Page Purpose */}
          <div className="space-y-1.5 bg-slate-950/60 p-4 rounded-lg border border-slate-800">
            <h4 className="font-semibold text-slate-200 text-xs font-mono flex items-center gap-2 text-cyan-300">
              <Zap className="w-3.5 h-3.5" />
              <span>本頁核心目的 (Module Purpose)</span>
            </h4>
            <p className="text-slate-300 leading-relaxed font-sans">
              {content.purpose}
            </p>
          </div>

          {/* Special Section: Why Do We Need API Keys? (Always shown or highlighted) */}
          <div className="p-4 rounded-lg bg-emerald-950/20 border border-emerald-800/40 space-y-2">
            <div className="flex items-center gap-2 text-emerald-300 font-mono font-bold text-xs">
              <Key className="w-4 h-4 text-emerald-400" />
              <span>API Key 在本系統中的真實作用與職責劃分 (Transparent API Key Rationale)</span>
            </div>
            <div className="text-slate-300 space-y-2 text-[11px] font-sans leading-relaxed">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800 space-y-1">
                  <div className="font-bold text-cyan-400 font-mono">1. 行情掃描 (免 API Key)</div>
                  <p className="text-slate-400 text-[10px]">
                    全市場 400+ 永續合約資金費率、標記價格、24h 成交量與 1m K 線皆為交易所公開端點，<strong>不需任何 Key 即可免費即時掃描</strong>。
                  </p>
                </div>
                <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800 space-y-1">
                  <div className="font-bold text-amber-400 font-mono">2. 實盤交易 (需要私有 Key)</div>
                  <p className="text-slate-400 text-[10px]">
                    <strong>Pionex &amp; Binance Key 僅用於：</strong>
                    (1) 查詢帳戶可用保證金與保證金率；(2) 在 T-30s 發送反向開倉訂單與 T+30s 平倉；(3) 接收 WebSocket 即時成交回報。
                  </p>
                </div>
              </div>
              <div className="text-[10px] text-slate-400 pt-1 flex items-center gap-1.5 font-mono">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>安全保證：金鑰僅存於本機端瀏覽器 localStorage，絕不隨網路回測或資料分析上傳，且<strong>嚴格禁止開通提現權限</strong>！</span>
              </div>
            </div>
          </div>

          {/* Section 2: How to Use */}
          <div className="space-y-2">
            <h4 className="font-semibold text-slate-200 text-xs font-mono flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-cyan-400" />
              <span>操作指引與使用流程 (How to Use)</span>
            </h4>
            <div className="space-y-2">
              {content.howToUse.map((step, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-slate-950/40 p-2.5 rounded border border-slate-800/80">
                  <span className="w-4 h-4 rounded-full bg-cyan-950 border border-cyan-700/60 text-cyan-300 font-mono font-bold text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                    {idx + 1}
                  </span>
                  <span className="text-slate-300 text-[11px] leading-relaxed">{step}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Section 3: Key Terminology */}
          <div className="space-y-2">
            <h4 className="font-semibold text-slate-200 text-xs font-mono flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <span>核心指標與名詞定義 (Key Metrics &amp; Definitions)</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {content.keyTerms.map((term, i) => (
                <div key={i} className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1">
                  <div className="font-semibold text-cyan-300 font-mono text-[11px]">
                    {term.term}
                  </div>
                  <div className="text-slate-400 text-[10px] leading-relaxed font-sans">
                    {term.explanation}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs font-mono">
          <span className="text-slate-500 text-[11px]">
            Pionex × Binance Funding Arbitrage Specification v0.1
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded font-medium transition-colors"
          >
            關閉說明 (Close)
          </button>
        </div>
      </div>
    </div>
  );
};
