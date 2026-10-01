/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — `RuntimeHealthPanel` (tech spec §32, task 3.1).
 * Presentational: receives `RuntimeHealth` (or undefined + error) as props.
 * Exchange rows come entirely from `health.exchanges` — no exchange name is
 * ever hardcoded here (Invariant #3).
 */
import React from 'react';
import type { RuntimeHealth } from '../api/contracts';
import { formatClockUtc } from '../format';
import { MockBadge } from './MockBadge';
import { StatusCode } from './StatusCode';

export interface RuntimeHealthPanelProps {
  health: RuntimeHealth | undefined;
  error: Error | undefined;
  nowMs: number;
  staleAfterMs?: number;
  mock?: boolean;
}

export const RuntimeHealthPanel: React.FC<RuntimeHealthPanelProps> = ({
  health,
  error,
  nowMs,
  staleAfterMs = 10_000,
  mock,
}) => {
  const unreachable = !health && !!error;
  const stale = health ? nowMs - health.runtime_heartbeat_at > staleAfterMs : false;

  return (
    <section className="rounded border border-slate-800 bg-slate-950/60 p-4">
      <h3 className="mb-3 flex items-center font-mono text-sm font-semibold text-slate-200">
        Runtime Health
        {mock && <MockBadge />}
      </h3>

      {unreachable && <StatusCode code="RUNTIME_UNREACHABLE" category="HEALTH" />}

      {health && (
        <div className={`space-y-1.5 text-xs ${stale ? 'opacity-50' : ''}`}>
          <Row label="Engine">
            <StatusCode code={stale ? 'STALE' : health.engine} category="HEALTH" />
          </Row>
          {health.exchanges.map((ex) => (
            <Row key={ex.exchange} label={ex.exchange}>
              <StatusCode code={ex.status} category="HEALTH" />
            </Row>
          ))}
          <Row label="Market Data">
            <StatusCode code={health.market_data} category="HEALTH" />
          </Row>
          <Row label="Scanner">
            <StatusCode code={health.scanner} category="HEALTH" />
          </Row>
          <Row label="Risk Engine">
            <StatusCode code={health.risk_engine} category="HEALTH" />
          </Row>
          <Row label="Paper Execution">
            <StatusCode code={health.paper_execution} category="HEALTH" />
          </Row>
          <Row label="Database">
            <StatusCode code={health.database} category="HEALTH" />
          </Row>
          {health.kill_switch && (
            <Row label="Kill Switch">
              <StatusCode code={health.kill_switch} category="HEALTH" />
            </Row>
          )}
          <Row label="Last Event">
            <span className="font-mono">{formatClockUtc(health.last_event_at)}</span>
          </Row>
        </div>
      )}
    </section>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between border-b border-slate-900 py-1">
    <span className="text-slate-500">{label}</span>
    {children}
  </div>
);
