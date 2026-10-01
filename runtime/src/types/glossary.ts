/**
 * runtime/src/types/glossary.ts
 *
 * Single source for all status / event code English names, Chinese names
 * and one-line Chinese definitions (tech spec §27.1, C-15). `zh` and
 * `definition_zh` for codes listed in spec §9, §18, §26 are the spec
 * tables' text verbatim. Spec table cells that were left blank (noted
 * inline below) and the §26 event-code list (which has no zh/definition
 * columns at all) are filled with definitions written for this change —
 * see the final report's "spec fields interpreted" section.
 */

export interface GlossaryEntry {
  code: string;
  zh: string;
  definition_zh: string;
  category: 'OPPORTUNITY' | 'TRADE' | 'LEG' | 'ORDER' | 'FUNDING' | 'EVENT' | 'SESSION' | 'HEALTH';
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  // ---- Opportunity (spec §26.1) ----
  { code: 'DETECTED', zh: '已偵測', definition_zh: 'Scanner 發現費率差，尚未評估成本', category: 'OPPORTUNITY' },
  { code: 'QUALIFIED', zh: '已合格', definition_zh: '扣除成本後仍符合門檻', category: 'OPPORTUNITY' },
  { code: 'SELECTED', zh: '已選中', definition_zh: '通過 Pre-Trade Risk，將建立 Trade', category: 'OPPORTUNITY' },
  { code: 'REJECTED', zh: '已否決', definition_zh: '未通過篩選或風控，必須記錄原因', category: 'OPPORTUNITY' },
  { code: 'EXPIRED', zh: '已過期', definition_zh: '超過 TTL 未被選中', category: 'OPPORTUNITY' },

  // ---- Trade (spec §26.2) ----
  { code: 'CREATED', zh: '已建立', definition_zh: '已保留資金、建立 Trade 紀錄', category: 'TRADE' },
  { code: 'PRE_FLIGHT', zh: '下單前檢查', definition_zh: 'Order Submission 階段風控', category: 'TRADE' },
  { code: 'ENTRY_PENDING', zh: '進場中', definition_zh: '兩腿訂單已送出，等待成交', category: 'TRADE' },
  {
    code: 'PARTIALLY_HEDGED',
    zh: '部分對沖',
    definition_zh: '兩腿都有成交，hedge ratio 介於兩門檻之間，正在補足',
    category: 'TRADE',
  },
  {
    code: 'LEG_IMBALANCE',
    zh: '單腿失衡',
    definition_zh: 'hedge ratio 低於下門檻，或部分對沖超時',
    category: 'TRADE',
  },
  { code: 'HEDGED', zh: '已對沖', definition_zh: '兩腿成交且 hedge ratio ≥ 上門檻，持倉中', category: 'TRADE' },
  { code: 'EXIT_PENDING', zh: '出場中', definition_zh: '已送出兩腿平倉單', category: 'TRADE' },
  { code: 'EMERGENCY_EXIT', zh: '緊急平倉中', definition_zh: '撤掉掛單並平掉已成交部位', category: 'TRADE' },
  {
    code: 'CLOSED',
    zh: '已結束',
    definition_zh: '兩腿部位歸零；看 close_reason 區分正常 / 緊急 / Kill Switch',
    category: 'TRADE',
  },
  {
    code: 'ABORTED',
    zh: '已放棄',
    definition_zh: '未產生任何部位就結束（風控否決、0 成交逾時）',
    category: 'TRADE',
  },
  {
    code: 'FAILED',
    zh: '系統失敗',
    definition_zh: '無法自動處理的錯誤，停止新交易並待人工確認',
    category: 'TRADE',
  },

  // ---- Leg (spec §26.3) ----
  { code: 'PENDING', zh: '待進場', definition_zh: '尚未送單', category: 'LEG' },
  { code: 'OPENING', zh: '開倉中', definition_zh: '進場單已送出', category: 'LEG' },
  { code: 'PARTIAL', zh: '部分開倉', definition_zh: '有成交但未達目標數量', category: 'LEG' },
  {
    code: 'OPEN',
    zh: '已開倉',
    definition_zh: '達到目標數量（Leg 層級，與 Trade 的 HEDGED 不同）',
    category: 'LEG',
  },
  { code: 'CLOSING', zh: '平倉中', definition_zh: '平倉單已送出', category: 'LEG' },
  { code: 'CLOSED', zh: '已平倉', definition_zh: '部位歸零', category: 'LEG' },
  { code: 'FAILED', zh: '失敗', definition_zh: '未能開倉（0 成交）或無法平倉', category: 'LEG' },

  // ---- Order (spec §9–§10) ----
  { code: 'CREATED', zh: '已建立', definition_zh: '系統內建立，尚未送出', category: 'ORDER' },
  { code: 'SUBMITTED', zh: '已送出', definition_zh: '已送往（模擬）交易所，等待 ACK', category: 'ORDER' },
  { code: 'ACKNOWLEDGED', zh: '已確認', definition_zh: '交易所確認收單，尚未成交', category: 'ORDER' },
  { code: 'PARTIALLY_FILLED', zh: '部分成交', definition_zh: '有成交但未滿', category: 'ORDER' },
  // Spec §9 table leaves FILLED's 說明 cell blank; definition below is written for this
  // change (not spec text) to satisfy the non-empty-definition requirement.
  { code: 'FILLED', zh: '完全成交', definition_zh: '已完全成交，是訂單的終態', category: 'ORDER' },
  { code: 'CANCEL_REQUESTED', zh: '撤單中', definition_zh: '已送出撤單，等待撤單 ACK', category: 'ORDER' },
  {
    code: 'CANCELED',
    zh: '已撤單',
    definition_zh: '可能帶有部分成交量（filled_quantity > 0）',
    category: 'ORDER',
  },
  { code: 'REJECTED', zh: '已拒絕', definition_zh: '必填 rejection_reason', category: 'ORDER' },
  { code: 'EXPIRED', zh: '已過期', definition_zh: '交易所端依 time-in-force 取消', category: 'ORDER' },

  // ---- FundingSettlement (spec §18; table only has a 中文 column, no
  // separate definition column — definitions below restate that column). ----
  { code: 'EXPECTED', zh: '預期中', definition_zh: '尚未到結算時刻', category: 'FUNDING' },
  { code: 'ELIGIBLE', zh: '符合資格', definition_zh: '結算時刻持有部位', category: 'FUNDING' },
  { code: 'SETTLED', zh: '已結算', definition_zh: '已結算', category: 'FUNDING' },
  { code: 'NOT_ELIGIBLE', zh: '不符資格', definition_zh: '結算時刻未持倉', category: 'FUNDING' },
  { code: 'MISSED', zh: '錯過', definition_zh: '應結算但未取得結算結果', category: 'FUNDING' },

  // ---- Event codes (tech spec §26 lists codes only, no zh/definition
  // columns — all entries below are written for this change). ----
  { code: 'OPPORTUNITY_DETECTED', zh: '機會已偵測', definition_zh: 'Scanner 發現一筆候選費率差機會', category: 'EVENT' },
  { code: 'OPPORTUNITY_QUALIFIED', zh: '機會已合格', definition_zh: 'Opportunity 轉為 QUALIFIED 的狀態轉換事件', category: 'EVENT' },
  { code: 'OPPORTUNITY_SELECTED', zh: '機會已選中', definition_zh: 'Opportunity 轉為 SELECTED 的狀態轉換事件', category: 'EVENT' },
  { code: 'OPPORTUNITY_REJECTED', zh: '機會已否決', definition_zh: 'Opportunity 轉為 REJECTED 的狀態轉換事件', category: 'EVENT' },
  { code: 'OPPORTUNITY_EXPIRED', zh: '機會已過期', definition_zh: 'Opportunity 轉為 EXPIRED 的狀態轉換事件', category: 'EVENT' },
  { code: 'TRADE_CREATED', zh: 'Trade 已建立', definition_zh: '系統建立一筆新的 Trade 紀錄', category: 'EVENT' },
  { code: 'TRADE_STATUS_CHANGED', zh: 'Trade 狀態改變', definition_zh: 'Trade 狀態轉換事件，payload 含 from/to/reason', category: 'EVENT' },
  { code: 'RISK_CHECK_STARTED', zh: '風控開始', definition_zh: '一個階段的風控檢查開始執行', category: 'EVENT' },
  { code: 'RISK_CHECK_PASSED', zh: '風控通過', definition_zh: '一個階段的風控檢查全數通過', category: 'EVENT' },
  { code: 'RISK_CHECK_FAILED', zh: '風控失敗', definition_zh: '一個階段的風控檢查有項目 FAIL', category: 'EVENT' },
  { code: 'ORDER_CREATED', zh: '訂單已建立', definition_zh: '系統內建立訂單紀錄，尚未送出', category: 'EVENT' },
  { code: 'ORDER_SUBMITTED', zh: '訂單已送出', definition_zh: '訂單送往（模擬）交易所', category: 'EVENT' },
  { code: 'ORDER_ACK', zh: '訂單已確認', definition_zh: '交易所確認收單', category: 'EVENT' },
  { code: 'ORDER_ACK_TIMEOUT', zh: 'ACK 逾時', definition_zh: 'SUBMITTED 超過 ack_timeout_ms 未收到 ACK', category: 'EVENT' },
  { code: 'ORDER_PARTIAL_FILL', zh: '部分成交', definition_zh: '訂單有新的部分成交', category: 'EVENT' },
  { code: 'ORDER_FILL', zh: '完全成交', definition_zh: '訂單達到完全成交', category: 'EVENT' },
  { code: 'ORDER_TIMEOUT', zh: '訂單逾時', definition_zh: '超過 max_order_lifetime_ms 未達終態，記 timeout_reason 後轉入撤單', category: 'EVENT' },
  { code: 'ORDER_CANCEL_REQUESTED', zh: '撤單已送出', definition_zh: '系統送出撤單請求', category: 'EVENT' },
  { code: 'ORDER_CANCELED', zh: '已撤單', definition_zh: '撤單成功，訂單進入 CANCELED 終態', category: 'EVENT' },
  { code: 'ORDER_CANCEL_REJECTED', zh: '撤單失敗', definition_zh: '撤單被拒或逾時，狀態回到撤單前，記 cancel_reject_reason', category: 'EVENT' },
  { code: 'ORDER_REJECTED', zh: '訂單被拒', definition_zh: '交易所拒絕訂單，記 rejection_reason', category: 'EVENT' },
  { code: 'ORDER_EXPIRED', zh: '訂單已過期', definition_zh: '交易所端依 time-in-force 取消訂單', category: 'EVENT' },
  { code: 'HEDGE_RATIO_CHANGED', zh: 'Hedge Ratio 改變', definition_zh: '兩腿 hedge ratio 重新計算後數值改變', category: 'EVENT' },
  { code: 'LEG_IMBALANCE_DETECTED', zh: '偵測到單腿失衡', definition_zh: 'hedge ratio 低於下門檻或部分對沖超時', category: 'EVENT' },
  { code: 'EMERGENCY_EXIT_STARTED', zh: '緊急平倉開始', definition_zh: '系統開始撤單並緊急平掉已成交部位', category: 'EVENT' },
  { code: 'POSITION_OPENED', zh: '部位已開倉', definition_zh: '一腿部位開倉完成', category: 'EVENT' },
  { code: 'FUNDING_SETTLED', zh: '資金費已結算', definition_zh: 'FundingSettlement 轉為 SETTLED 的狀態轉換事件', category: 'EVENT' },
  { code: 'EXIT_STARTED', zh: '出場開始', definition_zh: '系統開始送出兩腿平倉單', category: 'EVENT' },
  { code: 'POSITION_CLOSED', zh: '部位已平倉', definition_zh: '一腿部位平倉完成，部位歸零', category: 'EVENT' },
  { code: 'TRADE_COMPLETED', zh: 'Trade 已完成', definition_zh: 'Trade 進入終態並產生 TradeResult', category: 'EVENT' },
  { code: 'RECONCILIATION_ERROR', zh: '對帳錯誤', definition_zh: '系統紀錄與交易所實際狀態不一致', category: 'EVENT' },
  { code: 'STALE_MARKET_DATA', zh: '行情資料過期', definition_zh: '市場資料更新時間超過新鮮度門檻', category: 'EVENT' },
  { code: 'EXCHANGE_DISCONNECTED', zh: '交易所斷線', definition_zh: '與交易所的連線中斷', category: 'EVENT' },

  // Extension codes owned by trading-schema-types (design.md Decision 4).
  { code: 'LEG_STATUS_CHANGED', zh: 'Leg 狀態改變', definition_zh: 'TradeLeg 狀態轉換事件，payload 含 from/to/reason', category: 'EVENT' },
  { code: 'FUNDING_STATUS_CHANGED', zh: '資金費狀態改變', definition_zh: 'FundingSettlement 非 SETTLED 的狀態轉換事件', category: 'EVENT' },
  { code: 'CAPITAL_RESERVED', zh: '資金已保留', definition_zh: '虛擬帳本為一筆 Trade 保留資金', category: 'EVENT' },
  { code: 'CAPITAL_RELEASED', zh: '資金已釋放', definition_zh: '虛擬帳本釋放先前保留的資金', category: 'EVENT' },
  { code: 'ENTRY_HALT_REQUESTED', zh: '要求暫停進場', definition_zh: 'runtime-health-reconciliation 要求暫停新進場', category: 'EVENT' },
  { code: 'ENTRY_HALT_CLEARED', zh: '解除暫停進場', definition_zh: '進場暫停狀態解除', category: 'EVENT' },
  { code: 'RUNTIME_STARTUP_STEP', zh: 'Runtime 啟動步驟', definition_zh: 'Runtime 啟動流程中的一個步驟完成', category: 'EVENT' },
  { code: 'RUNTIME_ARMED', zh: 'Runtime 已啟用', definition_zh: 'Runtime 完成啟動並開始接受新 Trade', category: 'EVENT' },
  { code: 'RUNTIME_DISARMED', zh: 'Runtime 已停用', definition_zh: 'Runtime 停止接受新 Trade', category: 'EVENT' },

  // Extension codes reserved for paper-trading-event-loop.
  { code: 'SESSION_PHASE_CHANGED', zh: '場次階段改變', definition_zh: '交易場次（Session）的階段轉換事件', category: 'EVENT' },
  { code: 'CLOCK_REFERENCE_CHANGED', zh: '時鐘基準改變', definition_zh: '系統改用不同交易所作為時鐘校正基準', category: 'EVENT' },
  { code: 'CLOCK_OFFSET_JUMP', zh: '時鐘偏差跳動', definition_zh: '本機與交易所時鐘偏差發生異常跳動', category: 'EVENT' },

  // Extension codes reserved for instrument-registry.
  { code: 'INSTRUMENT_LISTED', zh: '合約已上架', definition_zh: 'Instrument Registry 偵測到新合約上架', category: 'EVENT' },
  { code: 'INSTRUMENT_STATUS_CHANGED', zh: '合約狀態改變', definition_zh: '合約的交易狀態（如上架/下架/暫停）改變', category: 'EVENT' },
  { code: 'INSTRUMENT_SPEC_CHANGED', zh: '合約規格改變', definition_zh: '合約乘數、最小下單單位等規格改變', category: 'EVENT' },
  { code: 'FUNDING_SCHEDULE_CHANGED', zh: '結算週期改變', definition_zh: '合約的資金費結算週期或時間改變', category: 'EVENT' },
  { code: 'INSTRUMENT_AMBIGUOUS', zh: '合約對應不明確', definition_zh: '同一符號在多所對應到無法唯一判定的合約', category: 'EVENT' },
  { code: 'INSTRUMENT_UNKNOWN_VALUE', zh: '合約欄位未知值', definition_zh: '交易所回傳合約欄位為未預期或無法解析的值', category: 'EVENT' },
  { code: 'INSTRUMENT_SOURCE_STATUS_CHANGED', zh: '合約資料來源狀態改變', definition_zh: 'Instrument Registry 資料來源（交易所 API）可用性改變', category: 'EVENT' },
] as const;

export function getGlossaryEntry(category: GlossaryEntry['category'], code: string): GlossaryEntry | undefined {
  return GLOSSARY.find((e) => e.category === category && e.code === code);
}
