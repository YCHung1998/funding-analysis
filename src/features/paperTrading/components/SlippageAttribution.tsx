/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `SlippageAttribution` (design.md Decision 7, C-13,
 * spec §20.1). Renders `slippage_attribution_usdt` in a visually distinct
 * attribution style (gray, parenthesized, italic) with a fixed caption
 * stating it is already included in Price PnL. The `?` explains
 * `Net = Funding + Price − Fees` so callers summing values themselves don't
 * double-subtract slippage.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { formatUsdt } from '../format';

export interface SlippageAttributionProps {
  amountUsdt: number | undefined | null;
  className?: string;
}

export const SlippageAttribution: React.FC<SlippageAttributionProps> = ({ amountUsdt, className }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [open]);

  const display = amountUsdt === undefined || amountUsdt === null ? '—' : formatUsdt(amountUsdt);

  return (
    <span ref={containerRef} className={`inline-flex items-center gap-1 text-xs ${className ?? ''}`}>
      <em className="italic text-slate-500">({display})</em>
      <span className="text-[10px] text-slate-500">已含在 Price PnL 中，不另外扣除</span>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((o) => !o)}
        className="text-slate-400 hover:text-cyan-300 w-4 h-4 rounded-full border border-slate-700 text-[10px] leading-none"
      >
        ?
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          className="absolute z-40 mt-1 max-w-xs rounded border border-slate-700 bg-slate-900 p-2 text-xs text-slate-200 shadow-lg"
        >
          <div className="font-mono text-cyan-300">Net = Funding + Price − Fees</div>
          <div className="text-slate-400">自行加總時不要再減 Slippage</div>
        </div>
      )}
    </span>
  );
};
