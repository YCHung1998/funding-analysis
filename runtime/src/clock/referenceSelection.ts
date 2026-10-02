import type { ExchangeId } from './types';

/**
 * Pure reference-timeline selection shared by `VirtualClock` and `RealClock`
 * (trading-clock spec "Reference timeline with fallback").
 */
export function selectReference(
  priority: ExchangeId[],
  isHealthy: (ex: ExchangeId) => boolean,
  previous: ExchangeId | null,
): { reference: ExchangeId; changed: boolean } {
  const healthy = priority.find((ex) => isHealthy(ex));
  const reference = healthy ?? priority[0];
  return { reference, changed: previous !== null && previous !== reference };
}
