/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `KillSwitchPlaceholder` (design.md Decision 8,
 * blocked-by C-16, task 3.6). The button is disabled and has no `onClick`
 * — it MUST NOT send any network request. The command set / button layout
 * (one chained button vs three) is itself the open C-16 decision; this
 * placeholder intentionally does not pre-guess it (design.md "不預先畫成
 * 一顆或三顆按鈕").
 */
import React from 'react';
import type { RuntimeHealth } from '../api/contracts';

export interface KillSwitchPlaceholderProps {
  killSwitchStatus?: RuntimeHealth['kill_switch'];
}

export const KillSwitchPlaceholder: React.FC<KillSwitchPlaceholderProps> = ({ killSwitchStatus }) => (
  <section className="rounded border border-rose-900/60 bg-rose-950/20 p-4">
    <h3 className="mb-2 font-mono text-sm font-semibold text-rose-300">KILL SWITCH</h3>
    <p className="mb-3 text-xs text-rose-200">⚠️ 待決 C-16：決議前不可操作（命令集合與按鈕配置尚未決定）</p>
    <div className="mb-3 text-xs text-slate-400">
      Runtime 回報狀態：{killSwitchStatus ?? '—'}
    </div>
    <button
      type="button"
      disabled
      aria-disabled="true"
      className="cursor-not-allowed rounded border border-rose-900 bg-rose-950/40 px-3 py-1.5 text-xs font-semibold text-rose-500 opacity-60"
    >
      KILL SWITCH (blocked-by C-16)
    </button>
  </section>
);
