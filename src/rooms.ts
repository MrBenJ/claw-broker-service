import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { writeSse } from './sse.js';
import type { SignalEnvelope, ValidationError } from './validation.js';

export interface Subscriber {
  connId: string;
  peerId: string;
  room: string;
  res: ServerResponse;
  ping: ReturnType<typeof setInterval>;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Map<string, Subscriber>>();
  private count = 0;

  constructor(
    private readonly maxSubscribersPerRoom: number,
    private readonly maxSubscribersTotal: number,
    private readonly pingIntervalMs: number,
  ) {}

  get subscriberCount(): number {
    return this.count;
  }

  /** Returns a 429 error to send, or null when the room has capacity. */
  checkCapacity(room: string): ValidationError | null {
    if (this.count >= this.maxSubscribersTotal) {
      return { status: 429, message: 'Too many subscribers' };
    }
    const roomSize = this.rooms.get(room)?.size ?? 0;
    if (roomSize >= this.maxSubscribersPerRoom) {
      return { status: 429, message: 'Too many subscribers in room' };
    }
    return null;
  }

  /** Announce the joiner to existing peers, then register it. Returns its connId. */
  add(peerId: string, room: string, res: ServerResponse): string {
    let subscribers = this.rooms.get(room);
    if (subscribers) {
      for (const subscriber of subscribers.values()) writeSse(subscriber.res, 'announce', peerId);
    } else {
      subscribers = new Map();
      this.rooms.set(room, subscribers);
    }

    const connId = randomUUID();
    const ping = setInterval(() => writeSse(res, 'ping', String(Date.now())), this.pingIntervalMs);
    ping.unref?.();
    subscribers.set(connId, { connId, peerId, room, res, ping });
    this.count += 1;
    return connId;
  }

  remove(room: string, connId: string): void {
    const subscribers = this.rooms.get(room);
    const subscriber = subscribers?.get(connId);
    if (!subscribers || !subscriber) return;
    clearInterval(subscriber.ping);
    subscribers.delete(connId);
    this.count -= 1;
    if (subscribers.size === 0) this.rooms.delete(room);
  }

  fanOutSignal(room: string, envelope: SignalEnvelope): void {
    const subscribers = this.rooms.get(room);
    if (!subscribers) return;
    const encoded = JSON.stringify(envelope);
    for (const subscriber of subscribers.values()) {
      if (subscriber.peerId === envelope.to) writeSse(subscriber.res, 'signal', encoded);
    }
  }

  closeAll(): void {
    for (const subscribers of this.rooms.values()) {
      for (const subscriber of subscribers.values()) {
        clearInterval(subscriber.ping);
        subscriber.res.end();
      }
    }
    this.rooms.clear();
    this.count = 0;
  }
}
