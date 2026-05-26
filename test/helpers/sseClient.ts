// test/helpers/sseClient.ts
// Drives a real /subscribe SSE stream over HTTP. Vendored from the
// clawkie-talkie reference test harness to keep this suite self-contained
// (no dependency on the upstream repo) while preserving wire parity.
//   upstream: davidguttman/clawkie-talkie @ 75398eb
//   file:     test/customSignalingServer.test.ts
// If you change the wire format, diff against that file/commit.
import { expect } from 'vitest';

export interface SseStream {
  controller: AbortController;
  nextEvent: (timeoutMs?: number) => Promise<{ event: string; data: string }>;
}

export async function subscribe(baseUrl: string, peerId: string, room: string): Promise<SseStream> {
  const controller = new AbortController();
  const res = await fetch(
    `${baseUrl}/subscribe?id=${encodeURIComponent(peerId)}&room=${encodeURIComponent(room)}`,
    { headers: { Accept: 'text/event-stream' }, signal: controller.signal },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  if (!res.body) throw new Error('subscribe response missing body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function nextEvent(timeoutMs = 500): Promise<{ event: string; data: string }> {
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (;;) {
        const idx = buffer.indexOf('\n\n');
        if (idx >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          return { event, data: data.join('\n') };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE closed before event');
        buffer += decoder.decode(value, { stream: true });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { controller, nextEvent };
}

/** Asserts that no event arrives within the window (the stream aborts on timeout). */
export async function noEvent(stream: SseStream, timeoutMs = 50): Promise<void> {
  await expect(stream.nextEvent(timeoutMs)).rejects.toThrow(/abort/i);
}

export async function sendSignal(
  baseUrl: string,
  room: string,
  envelope: { from: string; to: string; data: unknown },
): Promise<Response> {
  return fetch(`${baseUrl}/signal?room=${encodeURIComponent(room)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}
