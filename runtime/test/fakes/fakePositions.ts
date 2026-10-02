/**
 * runtime/test/fakes/fakePositions.ts
 *
 * Fake `PositionReader` (stands in for `position-accounting`). Tests set the
 * open quantity per leg directly to exercise reduce-only validation
 * (`REDUCE_ONLY_EXCEEDS_POSITION`) without a real Position engine.
 */
import type { PositionReader } from '../../src/execution/executionInterface';

export class FakePositionReader implements PositionReader {
  private quantities = new Map<string, number>();

  setOpenQuantity(legId: string, quantity: number): void {
    this.quantities.set(legId, quantity);
  }

  getOpenQuantity(legId: string): number {
    return this.quantities.get(legId) ?? 0;
  }
}
