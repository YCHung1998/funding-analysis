/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `StatusCode` (design.md Decision 7, C-15).
 *
 * Always renders the raw English code; a `?` button opens a popover with
 * the glossary's `zh` name and `definition_zh`. Data comes ONLY from
 * `runtime/src/types/glossary.ts` — this component MUST NOT hardcode any
 * Chinese status name or definition. An unknown code renders the code plus
 * "術語表缺少此代碼" instead of throwing (spec.md Scenario "未知代碼").
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { getGlossaryEntry, type GlossaryEntry } from '../api/contracts';

export interface StatusCodeProps {
  code: string;
  category: GlossaryEntry['category'];
  className?: string;
}

export const StatusCode: React.FC<StatusCodeProps> = ({ code, category, className }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();
  const entry = getGlossaryEntry(category, code);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [open]);

  return (
    <span ref={containerRef} className={`inline-flex items-center gap-1 font-mono text-xs ${className ?? ''}`}>
      <code>{code}</code>
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
          {entry ? (
            <>
              <div className="font-semibold text-cyan-300">{entry.zh}</div>
              <div className="text-slate-400">{entry.definition_zh}</div>
            </>
          ) : (
            <div className="text-amber-400">術語表缺少此代碼</div>
          )}
        </div>
      )}
    </span>
  );
};
