import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { start, type RunningServer } from '../src/server.js';
import { noEvent, sendSignal, subscribe, type SseStream } from './helpers/sseClient.js';

function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    pingIntervalMs: 1_000_000,
    maxIdLength: 128,
    maxRoomLength: 256,
    maxSubscribersPerRoom: 128,
    maxSubscribersTotal: 2048,
    ...over,
  };
}

let running: RunningServer;
let baseUrl: string;

async function boot(over: Partial<Config> = {}): Promise<void> {
  running = await start(testConfig(over));
  const addr = running.server.address();
  if (!addr || typeof addr === 'string') throw new Error('missing server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  await running?.shutdown();
});

describe('HTTP contract', () => {
  it('serves health and CORS preflight', async () => {
    await boot();
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const preflight = await fetch(`${baseUrl}/signal?room=r`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
  });

  it('returns 404 JSON for unknown routes without echoing the path', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Not Found' });
  });

  it('rejects subscribe without id or room', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/subscribe?id=peer-a`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Missing id or room' });
  });

  it('rejects an over-long subscribe id', async () => {
    await boot({ maxIdLength: 8 });
    const res = await fetch(`${baseUrl}/subscribe?id=${'x'.repeat(9)}&room=room-a`);
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: 'id is too long' });
  });

  it('rejects signal without a room', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'a', to: 'b', data: {} }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Missing room' });
  });

  it.each([
    ['', 'Missing JSON body'],
    ['not json', 'Invalid JSON body'],
    ['"a string"', 'Signal body must be a JSON object'],
    ['{"to":"b"}', 'Signal body missing from'],
    ['{"from":"a"}', 'Signal body missing to'],
  ])('rejects signal body %j with %s', async (body, message) => {
    await boot();
    const res = await fetch(`${baseUrl}/signal?room=room-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: message });
  });

  it('rejects a body larger than 1 MiB with 400', async () => {
    await boot();
    const huge = JSON.stringify({ from: 'a', to: 'b', data: { blob: 'x'.repeat(1024 * 1024 + 16) } });
    const res = await fetch(`${baseUrl}/signal?room=room-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge,
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Request body too large' });
  });

  it('accepts a valid signal with no recipient and returns 201', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/signal?room=room-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'a', to: 'ghost', data: {} }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe('SSE behavior', () => {
  const openStreams: SseStream[] = [];
  afterEach(() => {
    for (const s of openStreams.splice(0)) s.controller.abort();
  });

  it('announces a joiner to existing peers in the same room only', async () => {
    await boot();
    const a = await subscribe(baseUrl, 'peer-a', 'room-a');
    const b = await subscribe(baseUrl, 'peer-b', 'room-a');
    const c = await subscribe(baseUrl, 'peer-c', 'room-b');
    openStreams.push(a, b, c);

    await expect(a.nextEvent()).resolves.toEqual({ event: 'announce', data: 'peer-b' });
    await noEvent(b); // the joiner is announced to nobody, including itself
    await noEvent(c); // different room
  });

  it('relays a signal only to the matching peer in the same room', async () => {
    await boot();
    const a = await subscribe(baseUrl, 'peer-a', 'room-a');
    const b = await subscribe(baseUrl, 'peer-b', 'room-a');
    const bElsewhere = await subscribe(baseUrl, 'peer-b', 'room-b');
    openStreams.push(a, b, bElsewhere);
    await a.nextEvent(); // consume the announce for peer-b

    const envelope = { from: 'peer-a', to: 'peer-b', data: { type: 'offer', sdp: 'v=0' } };
    const post = await sendSignal(baseUrl, 'room-a', envelope);
    expect(post.status).toBe(201);

    await expect(b.nextEvent()).resolves.toEqual({ event: 'signal', data: JSON.stringify(envelope) });
    await noEvent(a);
    await noEvent(bElsewhere);
  });

  it('delivers a signal to two connections sharing one peerId', async () => {
    await boot();
    const b1 = await subscribe(baseUrl, 'peer-b', 'room-a');
    const b2 = await subscribe(baseUrl, 'peer-b', 'room-a');
    openStreams.push(b1, b2);
    await b1.nextEvent(); // b1 saw an announce when b2 joined

    const envelope = { from: 'peer-a', to: 'peer-b', data: {} };
    await sendSignal(baseUrl, 'room-a', envelope);
    await expect(b1.nextEvent()).resolves.toEqual({ event: 'signal', data: JSON.stringify(envelope) });
    await expect(b2.nextEvent()).resolves.toEqual({ event: 'signal', data: JSON.stringify(envelope) });
  });

  it('enforces the per-room subscriber cap with 429', async () => {
    await boot({ maxSubscribersPerRoom: 1 });
    const first = await subscribe(baseUrl, 'peer-a', 'room-a');
    openStreams.push(first);
    const capped = await fetch(`${baseUrl}/subscribe?id=peer-b&room=room-a`);
    expect(capped.status).toBe(429);
    await expect(capped.json()).resolves.toEqual({ error: 'Too many subscribers in room' });
  });

  it('emits periodic ping heartbeats', async () => {
    await boot({ pingIntervalMs: 25 });
    const a = await subscribe(baseUrl, 'peer-a', 'room-a');
    openStreams.push(a);
    const event = await a.nextEvent(250);
    expect(event.event).toBe('ping');
    expect(Number(event.data)).toBeGreaterThan(0);
  });

  it('closes open SSE streams on shutdown and zeroes the count', async () => {
    await boot();
    const a = await subscribe(baseUrl, 'peer-a', 'room-a');
    openStreams.push(a);
    expect(running.service.subscriberCount).toBe(1);

    const closed = once(running.server, 'close');
    await running.shutdown();
    await closed;
    expect(running.service.subscriberCount).toBe(0);
  });
});
