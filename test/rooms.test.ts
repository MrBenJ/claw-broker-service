import { afterEach, describe, expect, it } from 'vitest';
import { RoomRegistry } from '../src/rooms.js';
import { FakeRes } from './helpers/fakeRes.js';

// Large ping interval so the heartbeat never fires during these unit tests.
const PING = 1_000_000;

function makeRegistry(perRoom = 128, total = 2048) {
  return new RoomRegistry(perRoom, total, PING);
}

describe('RoomRegistry', () => {
  let registry: RoomRegistry;
  afterEach(() => registry?.closeAll());

  it('adds a subscriber and tracks the count', () => {
    registry = makeRegistry();
    const res = new FakeRes();
    const connId = registry.add('peer-a', 'room-a', res.asResponse());
    expect(typeof connId).toBe('string');
    expect(registry.subscriberCount).toBe(1);
    expect(res.body).toBe(''); // a lone joiner is announced to nobody and not to itself
  });

  it('announces a new joiner to existing peers only, never to the joiner', () => {
    registry = makeRegistry();
    const a = new FakeRes();
    const b = new FakeRes();
    registry.add('peer-a', 'room-a', a.asResponse());
    registry.add('peer-b', 'room-a', b.asResponse());
    expect(a.body).toBe('event: announce\ndata: peer-b\n\n');
    expect(b.body).toBe(''); // joiner stays silent; learns of peer-a via inbound signal
  });

  it('does not announce across rooms', () => {
    registry = makeRegistry();
    const a = new FakeRes();
    const c = new FakeRes();
    registry.add('peer-a', 'room-a', a.asResponse());
    registry.add('peer-c', 'room-b', c.asResponse());
    expect(a.body).toBe('');
    expect(c.body).toBe('');
  });

  it('fans out a signal only to subscribers whose peerId matches "to"', () => {
    registry = makeRegistry();
    const a = new FakeRes();
    const b = new FakeRes();
    registry.add('peer-a', 'room-a', a.asResponse());
    registry.add('peer-b', 'room-a', b.asResponse());
    a.chunks.length = 0; // drop the announce frame
    const envelope = { from: 'peer-a', to: 'peer-b', data: { sdp: 'x' } };
    registry.fanOutSignal('room-a', envelope);
    expect(b.body).toBe(`event: signal\ndata: ${JSON.stringify(envelope)}\n\n`);
    expect(a.body).toBe('');
  });

  it('delivers a signal to every connection sharing the target peerId', () => {
    registry = makeRegistry();
    const b1 = new FakeRes();
    const b2 = new FakeRes();
    registry.add('peer-b', 'room-a', b1.asResponse());
    registry.add('peer-b', 'room-a', b2.asResponse());
    b1.chunks.length = 0; // b1 got an announce when b2 joined
    const envelope = { from: 'peer-a', to: 'peer-b', data: {} };
    registry.fanOutSignal('room-a', envelope);
    const frame = `event: signal\ndata: ${JSON.stringify(envelope)}\n\n`;
    expect(b1.body).toBe(frame);
    expect(b2.body).toBe(frame);
  });

  it('silently drops a signal for an unknown room or unmatched recipient', () => {
    registry = makeRegistry();
    const a = new FakeRes();
    registry.add('peer-a', 'room-a', a.asResponse());
    expect(() => registry.fanOutSignal('no-such-room', { from: 'x', to: 'y', data: {} })).not.toThrow();
    registry.fanOutSignal('room-a', { from: 'x', to: 'nobody', data: {} });
    expect(a.body).toBe('');
  });

  it('removes a subscriber, decrements the count, and drops empty rooms', () => {
    registry = makeRegistry();
    const a = new FakeRes();
    const connId = registry.add('peer-a', 'room-a', a.asResponse());
    registry.remove('room-a', connId);
    expect(registry.subscriberCount).toBe(0);
    // room dropped: a later signal reaches nobody and does not throw
    expect(() => registry.fanOutSignal('room-a', { from: 'x', to: 'peer-a', data: {} })).not.toThrow();
  });

  it('reports capacity errors for global then per-room limits', () => {
    registry = makeRegistry(1, 2);
    registry.add('p1', 'room-a', new FakeRes().asResponse());
    expect(registry.checkCapacity('room-a')).toEqual({ status: 429, message: 'Too many subscribers in room' });
    expect(registry.checkCapacity('room-b')).toBeNull();
    registry.add('p2', 'room-b', new FakeRes().asResponse());
    expect(registry.checkCapacity('room-c')).toEqual({ status: 429, message: 'Too many subscribers' });
  });

  it('closeAll ends every stream and resets the count', () => {
    registry = makeRegistry();
    const a = new FakeRes();
    const b = new FakeRes();
    registry.add('peer-a', 'room-a', a.asResponse());
    registry.add('peer-b', 'room-b', b.asResponse());
    registry.closeAll();
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(registry.subscriberCount).toBe(0);
  });
});
