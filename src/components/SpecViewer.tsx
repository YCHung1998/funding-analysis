/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Spec v0.1 Formal Repository & Notes Memory
 * Preserves the fixed Pionex × Binance Funding Arbitrage Spec v0.1
 * and stores incremental notes for future revisions.
 */

import React, { useState, useEffect } from 'react';
import { SPEC_V01_SECTIONS, SpecSection } from '../spec/arbitrageSpecV01';
import { BookOpen, Copy, Check, Download, Plus, Trash2, Save, FileText, CheckCircle2 } from 'lucide-react';

interface FutureSpecNote {
  id: string;
  timestamp: string;
  title: string;
  category: 'Adapter' | 'Kline Window' | 'Fee Model' | 'Execution' | 'Risk Control';
  content: string;
}

const DEFAULT_FUTURE_NOTES: FutureSpecNote[] = [
  {
    id: 'note-1',
    timestamp: '2024-06-12',
    title: 'Bybit & OKX Adapter 擴充計畫',
    category: 'Adapter',
    content: '在 Spec v0.2 中將擴充 Bybit V5 與 OKX API，同樣遵循 Common Schema 架構。Strategy 完全不需重構。',
  },
  {
    id: 'note-2',
    timestamp: '2024-06-12',
    title: 'Post-Only Maker 局部吃單可行性評估',
    category: 'Fee Model',
    content: '評估在 T-30s 先以 Post-Only Maker 掛單，若 T-10s 尚未成交才降級為 Taker IOC。手續費可由 0.05% 降至 0.02%，雙邊固定成本由 0.20% 降至 0.14%。',
  },
  {
    id: 'note-3',
    timestamp: '2024-06-12',
    title: 'Sub-second API 延遲與 WebSocket 撮合排程',
    category: 'Execution',
    content: '針對 Binance FAPI 與 Pionex 實測 REST vs WS 延遲，確保 T-30s 精準至 100ms 內送達交易所撮合引擎。',
  },
];

export const SpecViewer: React.FC = () => {
  const [selectedSection, setSelectedSection] = useState<string>(SPEC_V01_SECTIONS[0].id);
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState<FutureSpecNote[]>(() => {
    try {
      const saved = localStorage.getItem('px_bn_spec_future_notes');
      return saved ? JSON.parse(saved) : DEFAULT_FUTURE_NOTES;
    } catch {
      return DEFAULT_FUTURE_NOTES;
    }
  });

  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<FutureSpecNote['category']>('Execution');
  const [newContent, setNewContent] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('px_bn_spec_future_notes', JSON.stringify(notes));
    } catch (e) {
      console.error('Failed to save spec notes to localStorage', e);
    }
  }, [notes]);

  const activeSec = SPEC_V01_SECTIONS.find(s => s.id === selectedSection) || SPEC_V01_SECTIONS[0];

  const handleAddNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;

    const newNote: FutureSpecNote = {
      id: `note-${Date.now()}`,
      timestamp: new Date().toISOString().slice(0, 10),
      title: newTitle.trim(),
      category: newCategory,
      content: newContent.trim(),
    };

    setNotes([newNote, ...notes]);
    setNewTitle('');
    setNewContent('');
    setShowAddForm(false);
  };

  const handleDeleteNote = (id: string) => {
    setNotes(notes.filter(n => n.id !== id));
  };

  const copyFullSpec = () => {
    const fullText = SPEC_V01_SECTIONS.map(s => `## ${s.number}. ${s.title}\n\n${s.summary}\n${s.contentMarkdown}`).join('\n\n---\n\n');
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
              <span>Spec v0.1 Knowledge Base & Memory Vault</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>逐步記憶與後續擴充庫</span>
            </div>
            <h2 className="text-lg font-bold text-slate-100 mt-0.5">
              Pionex × Binance Funding Arbitrage Spec v0.1 規格庫
            </h2>
            <p className="text-xs text-slate-400 mt-1 max-w-3xl">
              此處永久固化本策略的 8 大基礎規格章節，並提供未來 Spec (v0.2+) 提案備忘錄，確保量化模型在迭代中架構始終乾淨清晰。
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={copyFullSpec}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded text-xs font-medium flex items-center gap-1.5 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied Full Spec' : 'Copy Spec Markdown'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Spec Browser: Left Index, Right Section Content */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Section Navigation */}
        <div className="lg:col-span-4 space-y-2">
          <div className="text-xs font-mono uppercase tracking-wider text-slate-400 px-1 mb-2">
            Spec v0.1 Chapters
          </div>
          <div className="space-y-1">
            {SPEC_V01_SECTIONS.map((sec) => {
              const isSelected = sec.id === selectedSection;
              return (
                <button
                  key={sec.id}
                  onClick={() => setSelectedSection(sec.id)}
                  className={`w-full text-left p-3 rounded-lg transition-all text-xs border ${
                    isSelected
                      ? 'bg-slate-800 border-cyan-500/50 shadow-sm'
                      : 'bg-slate-950/80 border-slate-800/80 hover:bg-slate-900/60 text-slate-400'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-cyan-400 font-bold">{sec.number}</span>
                    <span className={`font-semibold ${isSelected ? 'text-slate-100' : 'text-slate-300'}`}>
                      {sec.title}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1 line-clamp-1 font-sans">
                    {sec.summary}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Section Content Detail */}
        <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-4">
          <div className="border-b border-slate-800 pb-3">
            <div className="text-xs font-mono text-cyan-400 font-bold mb-1">
              CHAPTER {activeSec.number}
            </div>
            <h3 className="text-base font-bold text-slate-100">
              {activeSec.title}
            </h3>
            <p className="text-xs text-slate-400 mt-1 font-sans">
              {activeSec.summary}
            </p>
          </div>

          {/* Key Formulas if present */}
          {activeSec.keyFormulas && activeSec.keyFormulas.length > 0 && (
            <div className="bg-slate-950 border border-slate-800 p-3 rounded space-y-1.5">
              <div className="text-[11px] font-mono text-cyan-400 font-semibold">
                Mathematical Formulas:
              </div>
              <div className="space-y-1 font-mono text-xs text-emerald-300">
                {activeSec.keyFormulas.map((form, i) => (
                  <div key={i} className="bg-slate-900/60 px-2.5 py-1 rounded border border-slate-800/60">
                    {form}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Formatted Markdown Content */}
          <div className="prose prose-invert prose-xs max-w-none text-slate-300 space-y-3 font-sans leading-relaxed text-xs">
            <div className="whitespace-pre-line font-sans text-xs text-slate-300">
              {activeSec.contentMarkdown}
            </div>
          </div>
        </div>
      </div>

      {/* Incremental Memory Notebook: "這些是我未來要加入spec 的部分 你要幫我逐步記得" */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
              <h3 className="font-semibold text-slate-100 text-sm">
                未來 Spec 擴充備忘錄 (Future Spec Additions & Notes)
              </h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              「這些是我未來要加入 spec 的部分，你要幫我逐步記得」— 任何新想法、新交易所、新費率與風控規則均自動保存在此。
            </p>
          </div>

          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 rounded text-xs font-medium flex items-center gap-1.5 transition-colors self-start sm:self-auto"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{showAddForm ? 'Cancel' : 'Add Future Spec Note'}</span>
          </button>
        </div>

        {/* Add Note Form */}
        {showAddForm && (
          <form onSubmit={handleAddNote} className="bg-slate-950 border border-slate-800 p-4 rounded-lg space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-slate-400 font-mono mb-1">主題名稱 (Title)</label>
                <input
                  type="text"
                  placeholder="例如：OKX & Bybit Adapter 整合規格..."
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 font-mono mb-1">分類 (Category)</label>
                <select
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value as any)}
                  className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-cyan-500"
                >
                  <option value="Adapter">Adapter</option>
                  <option value="Kline Window">Kline Window</option>
                  <option value="Fee Model">Fee Model</option>
                  <option value="Execution">Execution</option>
                  <option value="Risk Control">Risk Control</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 font-mono mb-1">詳細說明與量化規格</label>
              <textarea
                rows={3}
                placeholder="輸入詳細演算法、API 欄位或執行時序細節..."
                value={newContent}
                onChange={e => setNewContent(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded p-2.5 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-3 py-1.5 text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium flex items-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save to Spec Vault</span>
              </button>
            </div>
          </form>
        )}

        {/* Existing Notes List */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {notes.map(note => (
            <div key={note.id} className="bg-slate-950 border border-slate-800 p-3.5 rounded-lg space-y-2 text-xs relative group">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 border border-cyan-800/60 px-1.5 py-0.5 rounded">
                  {note.category}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500 font-mono">{note.timestamp}</span>
                  <button
                    onClick={() => handleDeleteNote(note.id)}
                    className="text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete Note"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <h4 className="font-semibold text-slate-200 text-xs">
                {note.title}
              </h4>

              <p className="text-slate-400 text-[11px] leading-relaxed font-sans">
                {note.content}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
