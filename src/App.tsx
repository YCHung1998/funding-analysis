/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Header, ActiveTab } from './components/Header';
import { FunnelScannerView } from './components/FunnelScannerView';
import { DryRunConsole } from './components/DryRunConsole';
import { ArbitrageScanner } from './components/ArbitrageScanner';
import { SettlementKlineViewer } from './components/SettlementKlineViewer';
import { ExecutionSimulator } from './components/ExecutionSimulator';
import { SensitivityMatrix } from './components/SensitivityMatrix';
import { SchemaInspector } from './components/SchemaInspector';
import { LocalSecretsView } from './components/LocalSecretsView';
import { SpecViewer } from './components/SpecViewer';
import { HelpModal } from './components/HelpModal';
import { MOCK_DATASETS, runAllBacktests } from './data/mockMarketData';
import { runFunnelScan } from './engine/funnelScanner';
import { FunnelCandidate } from './types/systemSpec';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('funnel');
  const [selectedSymbol, setSelectedSymbol] = useState<string>('PEPEUSDT');
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);

  const datasets = MOCK_DATASETS;
  const backtestResults = runAllBacktests(datasets);
  const currentDataset = datasets.find(d => d.symbol === selectedSymbol) || datasets[0];

  // Funnel Data & Active Candidate for Dry-Run
  const funnel = runFunnelScan(Date.now(), 1000);
  const [selectedCandidate, setSelectedCandidate] = useState<FunnelCandidate>(
    funnel.level3_selected || funnel.level2_top3[0]
  );

  const handleSelectCandidateForDryRun = (candidate: FunnelCandidate) => {
    setSelectedCandidate(candidate);
    setSelectedSymbol(candidate.symbol);
    setActiveTab('dryrun');
  };

  const handleSelectEvent = (symbol: string, _fundingTime: number) => {
    setSelectedSymbol(symbol);
    const matchedCandidate = funnel.level1_candidates.find(c => c.symbol === symbol);
    if (matchedCandidate) {
      setSelectedCandidate(matchedCandidate);
    }
  };

  const handleNavigateTab = (tab: 'klines' | 'simulator' | 'sensitivity') => {
    setActiveTab(tab);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Top Bar with 7-Module Navigation & Universal (?) Button */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedSymbol={selectedSymbol}
        onOpenHelp={() => setIsHelpOpen(true)}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Module 3: Three-Level Funnel Scanner */}
        {activeTab === 'funnel' && (
          <FunnelScannerView
            onSelectCandidateForDryRun={handleSelectCandidateForDryRun}
            onOpenHelp={() => setIsHelpOpen(true)}
          />
        )}

        {/* Module 5 / Module 7: Dry-Run Console (The 4 Requested Zones) */}
        {activeTab === 'dryrun' && (
          <DryRunConsole
            top3Candidates={funnel.level2_top3}
            selectedCandidate={selectedCandidate}
            onSelectCandidate={setSelectedCandidate}
          />
        )}

        {/* Module 4: Arbitrage Scanner */}
        {activeTab === 'scanner' && (
          <ArbitrageScanner
            datasets={datasets}
            results={backtestResults}
            selectedSymbol={selectedSymbol}
            onSelectEvent={handleSelectEvent}
            onNavigateTab={handleNavigateTab}
          />
        )}

        {/* Module 2: ±2m 1m Kline & Volume Analysis */}
        {activeTab === 'klines' && (
          <SettlementKlineViewer
            currentDataset={currentDataset}
            allDatasets={datasets}
            onSelectSymbol={setSelectedSymbol}
          />
        )}

        {/* Module 5: 60s Execution Flow & Realized Net PnL Waterfall */}
        {activeTab === 'simulator' && (
          <ExecutionSimulator
            currentDataset={currentDataset}
            allDatasets={datasets}
            onSelectSymbol={setSelectedSymbol}
          />
        )}

        {/* Module 4: Sensitivity Matrix & Breakeven Frontier */}
        {activeTab === 'sensitivity' && (
          <SensitivityMatrix />
        )}

        {/* Module 1: Common Schema & Adapters */}
        {activeTab === 'schema' && (
          <SchemaInspector />
        )}

        {/* Security & Local Secrets Vault */}
        {activeTab === 'secrets' && (
          <LocalSecretsView />
        )}

        {/* System Spec v0.2 Knowledge Base & Notes */}
        {activeTab === 'spec' && (
          <SpecViewer />
        )}
      </main>

      {/* Contextual Documentation / Help Modal (?) */}
      <HelpModal
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
        activeTab={activeTab}
      />

      {/* Institutional System Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/80 py-4 text-xs text-slate-500 font-mono">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Pionex × Binance Funding Arbitrage Engine</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-400">Spec v0.2 Architecture</span>
            <span aria-hidden="true">·</span>
            <span>M1 ~ M7 Modular Pipeline</span>
          </div>
          <div className="flex items-center gap-3 text-slate-500 text-[11px]">
            <span>Dynamic Intervals (1h/4h/8h)</span>
            <span aria-hidden="true">·</span>
            <button
              onClick={() => setIsHelpOpen(true)}
              className="text-cyan-400 hover:text-cyan-300 underline font-sans"
            >
              使用手冊與 API Key 作用說明 (?)
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
