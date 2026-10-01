/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `MockBadge` / `MockDataBanner` (HANDOFF Invariant #7).
 * Used next to every data block's title when `VITE_PAPER_DATA_SOURCE=mock`.
 */
import React from 'react';

export const MockBadge: React.FC<{ className?: string }> = ({ className }) => (
  <span
    className={`ml-2 inline-block rounded border border-amber-600/60 bg-amber-950/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-400 ${className ?? ''}`}
  >
    MOCK
  </span>
);

export const MockDataBanner: React.FC = () => (
  <div className="mb-4 rounded border border-amber-600/60 bg-amber-950/40 px-3 py-2 text-center font-mono text-xs font-semibold text-amber-400">
    MOCK DATA — VITE_PAPER_DATA_SOURCE=mock
  </div>
);
