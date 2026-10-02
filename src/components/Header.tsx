/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Layers,
  Activity,
  BarChart3,
  Sliders,
  ArrowRightLeft,
  BookOpen,
  Filter,
  ShieldCheck,
  Lock,
  Play,
  PlayCircle,
  HelpCircle
} from 'lucide-react';

export type ActiveTab =
  | 'funnel'
  | 'scanner'
  | 'klines'
  | 'dryrun'
  | 'simulator'
  | 'sensitivity'
  | 'schema'
  | 'secrets'
  | 'spec'
  | 'paper';

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  selectedSymbol: string;
  onOpenHelp: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  selectedSymbol,
  onOpenHelp,
}) => {
  const tabs = [
    { id: 'schema' as ActiveTab, label: 'M1. Common Schema & Adapters', icon: Layers },
    { id: 'klines' as ActiveTab, label: 'M2. ±2m Kline & Volume Shock', icon: BarChart3 },
    { id: 'funnel' as ActiveTab, label: 'M3. Multi-Ex Funnel Scanner', icon: Filter, highlight: true },
    { id: 'scanner' as ActiveTab, label: 'M4. Arbitrage Scanner', icon: ArrowRightLeft },
    { id: 'sensitivity' as ActiveTab, label: 'M4. Sensitivity Matrix', icon: Sliders },
    { id: 'simulator' as ActiveTab, label: 'M5. 60s Execution Flow', icon: Activity, badge: 'MOCK' as const },
    {
      id: 'dryrun' as ActiveTab,
      label: 'M6/M7. Dry-Run & Risk Console',
      icon: Play,
      highlight: true,
      badge: 'FROZEN' as const,
    },
    { id: 'paper' as ActiveTab, label: 'Paper Trading', icon: PlayCircle, highlight: true },
    { id: 'secrets' as ActiveTab, label: 'Local Secret Vault', icon: Lock },
    { id: 'spec' as ActiveTab, label: 'System Spec v0.1', icon: BookOpen },
  ];

  return (
    <header className="border-b border-slate-800 bg-slate-950/90 sticky top-0 z-30 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand & System Spec Version */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-mono font-bold text-sm">
              PX×BN
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold tracking-tight text-slate-100">
                  Funding Arbitrage System Engine
                </span>
                <span className="text-xs font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-1.5 py-0.5 rounded">
                  7-MODULE SPEC v0.1
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="text-cyan-400 font-mono font-semibold">Research ──► Dry-Run ──► Live</span>
                <span aria-hidden="true">·</span>
                <span>Active Target: <strong className="text-slate-200 font-mono">{selectedSymbol}</strong></span>
              </div>
            </div>
          </div>

          {/* Quick Truth Layer Indicators & Universal Help (?) Button */}
          <div className="flex items-center gap-3 text-xs font-mono">
            <div className="hidden lg:flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded">
              <span className="text-slate-400">Truth Layer (5 Ex):</span>
              <span className="text-emerald-400 font-semibold">Pionex · Binance · Bybit · Bitget · OKX</span>
            </div>
            <div className="hidden sm:flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded">
              <span className="text-slate-400">Fixed Fee Drag:</span>
              <span className="text-rose-400 font-semibold">0.20% (VIP 0)</span>
            </div>

            {/* REQUIREMENT 3: Universal Help Button (?) */}
            <button
              onClick={onOpenHelp}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 rounded-lg transition-all font-sans text-xs font-medium shadow-sm hover:border-cyan-400 group"
              title="查看當前頁面使用說明、名詞定義與 API Key 作用"
            >
              <HelpCircle className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform" />
              <span>使用說明 (?)</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1 overflow-x-auto py-1 border-t border-slate-800/60 scrollbar-none">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-800 text-cyan-400 shadow-sm border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-cyan-400' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
                {'badge' in tab && tab.badge && (
                  <span
                    className={`rounded border px-1 py-0.5 font-mono text-[9px] font-semibold ${
                      tab.badge === 'FROZEN'
                        ? 'border-sky-700/60 bg-sky-950/60 text-sky-400'
                        : 'border-amber-600/60 bg-amber-950/60 text-amber-400'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
                {tab.highlight && !isActive && (
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
};
