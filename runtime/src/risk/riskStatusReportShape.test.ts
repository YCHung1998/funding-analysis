import { describe, expect, it } from 'vitest';
import type { RiskCheckItem, RiskStatusReport } from '../types/risk';

/**
 * Task 1.1 characterization test: locks the `RiskStatusReport` /
 * `RiskCheckItem` field shapes (moved verbatim from
 * `src/types/systemSpec.ts` into `runtime/src/types/risk.ts`) before any
 * Risk Engine code maps into them, so an accidental shape change in
 * `trading-schema-types` is caught here rather than silently breaking
 * `riskReport.ts`'s mapping.
 */
describe('RiskStatusReport / RiskCheckItem shape (characterization)', () => {
  it('RiskCheckItem has exactly the v0.1 fields', () => {
    const item: RiskCheckItem = {
      id: 'CAPITAL',
      name: 'Capital',
      category: 'Capital',
      status: 'PASS',
      value: '100',
      threshold: '50',
      details: '',
    };
    expect(Object.keys(item).sort()).toEqual(
      ['category', 'details', 'id', 'name', 'status', 'threshold', 'value'].sort(),
    );
    const categories: RiskCheckItem['category'][] = ['Connection', 'Execution', 'Market', 'Capital'];
    expect(categories).toContain(item.category);
    const statuses: RiskCheckItem['status'][] = ['PASS', 'WARN', 'FAIL'];
    expect(statuses).toContain(item.status);
  });

  it('RiskStatusReport has exactly the v0.1 fields', () => {
    const report: RiskStatusReport = {
      overall_status: 'PASS',
      checks: [],
      failed_reasons: [],
      leg_imbalance_detected: false,
      action_recommendation: 'PROCEED_TRADE',
    };
    expect(Object.keys(report).sort()).toEqual(
      ['action_recommendation', 'checks', 'failed_reasons', 'leg_imbalance_detected', 'overall_status'].sort(),
    );
    const overall: RiskStatusReport['overall_status'][] = ['PASS', 'ABORT', 'EMERGENCY_EXIT'];
    expect(overall).toContain(report.overall_status);
    const actions: RiskStatusReport['action_recommendation'][] = [
      'PROCEED_TRADE',
      'ABORT_PRE_FLIGHT',
      'EMERGENCY_CLOSE_FILLED_LEG',
    ];
    expect(actions).toContain(report.action_recommendation);
  });
});
