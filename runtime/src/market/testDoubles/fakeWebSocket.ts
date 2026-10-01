/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 假 WebSocket 測試替身（design.md Decision 6）：可控制開啟、訊息、關閉、錯誤，
 * 不連真實網路。供 wsConnection / connectionPool 測試使用。
 */
import type { MinimalWebSocket, WebSocketFactory } from '../types';

export const FAKE_WS_CONNECTING = 0;
export const FAKE_WS_OPEN = 1;
export const FAKE_WS_CLOSING = 2;
export const FAKE_WS_CLOSED = 3;

export class FakeWebSocket implements MinimalWebSocket {
  readyState: number = FAKE_WS_CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /** 測試驅動：模擬握手完成。 */
  simulateOpen(): void {
    this.readyState = FAKE_WS_OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  simulateClose(code = 1006, reason = ''): void {
    this.readyState = FAKE_WS_CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateError(err: unknown): void {
    this.onerror?.(err);
  }

  send(data: string): void {
    if (this.readyState !== FAKE_WS_OPEN) {
      throw new Error('FakeWebSocket: send() called while not OPEN');
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FAKE_WS_CLOSED;
    // 由呼叫端決定是否視為「預期中斷」；此處仍觸發 onclose 讓狀態機收斂。
    this.onclose?.({ code, reason });
  }
}

/** 建立一個記錄每次建線（url → FakeWebSocket）的 factory，供測試取用與驅動。 */
export function createFakeWebSocketFactory(): { factory: WebSocketFactory; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  const factory: WebSocketFactory = (url: string) => {
    const ws = new FakeWebSocket(url);
    sockets.push(ws);
    return ws;
  };
  return { factory, sockets };
}
