import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendControlCommand } from './controlChannel';

describe('controlChannel (blocked-by C-16, no call sites in src/ outside this test)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      status: 202,
      ok: true,
      json: async () => ({ request_id: 'req-1', forwarded_at: 123 }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the command JSON to /api/paper/control', async () => {
    const controller = new AbortController();
    const ack = await sendControlCommand({ command: 'STOP_ENTRY', request_id: 'req-1' }, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/paper/control',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ command: 'STOP_ENTRY', request_id: 'req-1' }),
      }),
    );
    expect(ack.request_id).toBe('req-1');
  });

  it('throws when the server does not respond with 202 (forwarded)', async () => {
    fetchMock.mockResolvedValueOnce({ status: 500, ok: false, json: async () => ({}) } as unknown as Response);
    const controller = new AbortController();
    await expect(
      sendControlCommand({ command: 'STOP_ENTRY', request_id: 'req-2' }, controller.signal),
    ).rejects.toThrow();
  });
});
