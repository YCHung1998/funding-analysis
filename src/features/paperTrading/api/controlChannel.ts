/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paper Trading UI — Kill Switch control channel (design.md Decision 8,
 * blocked-by C-16). This module defines the request shape only. It MUST
 * NOT be called anywhere in `src/` outside its own unit test — the command
 * set, confirmation flow and button layout are themselves the open C-16
 * decision (openspec/changes/.../design.md Open Question 3).
 *
 * `202` only means the server forwarded the command to the Runtime; actual
 * effect is reported later via `KILL_SWITCH_*` events / the Health panel.
 * This client MUST NOT be used to optimistically update any UI state.
 */
import type { ControlAck, ControlCommand } from './contracts';

export async function sendControlCommand(cmd: ControlCommand, signal: AbortSignal): Promise<ControlAck> {
  const res = await fetch('/api/paper/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal,
  });
  if (res.status !== 202) {
    throw new Error(`control channel: unexpected status ${res.status}`);
  }
  return (await res.json()) as ControlAck;
}
