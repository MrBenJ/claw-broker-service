# claw-broker-service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, rambly-compatible WebRTC signaling broker (Node + TypeScript, zero runtime deps) that self-hosts on a Mac mini behind `tailscale serve` so a phone on the same tailnet can run clawkie-talkie against it.

**Architecture:** A small HTTP server (`node:http`) exposing `/health`, `/subscribe` (SSE), and `/signal` (POST). All state is in-memory. The reference's single ~350-line file is split into focused units: `config` (env → typed config), `validation` (pure validators), `sse` (wire framing), `rooms` (the subscriber registry + announce/fan-out), `app` (routing), and `server` (bootstrap + graceful shutdown). HTTPS and tailnet reach are handled by `tailscale serve`, not by the broker.

**Tech Stack:** Node 20+ (developed on 22), TypeScript (ESM, NodeNext), vitest 4, tsx (dev), launchd + tailscale (deploy). No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-25-claw-broker-service-design.md`. The wire contract's source of truth is `~/code/_forks/clawkie-talkie/signaling/src/app.ts`.

**Conventions for every task:** ESM with `.js` import specifiers in `src/` (required for `node dist/server.js`; vitest resolves them to `.ts`). Commit after each task. Run the named test/command and confirm the stated expected output before checking a step off.

---

## File structure

```
claw-broker-service/
├── package.json              # scripts + devDeps; zero runtime deps
├── tsconfig.json             # base, noEmit (editor/typecheck/vitest)
├── tsconfig.build.json       # extends base, emits to dist/
├── vitest.config.ts          # include test/**/*.test.ts
├── .env.example              # documents the env vars
├── src/
│   ├── config.ts             # loadConfig(env) → Config
│   ├── validation.ts         # validatePeerAndRoom / validateRoom / validateSignalEnvelope
│   ├── sse.ts                # writeSse / setCorsHeaders / sendJson
│   ├── rooms.ts              # RoomRegistry
│   ├── app.ts                # createSignalingService() → { handler, closeAllSubscribers, subscriberCount }
│   └── server.ts             # start(config) + main() bootstrap + graceful shutdown
├── test/
│   ├── helpers/fakeRes.ts    # fake ServerResponse for unit tests
│   ├── helpers/sseClient.ts  # SSE subscribe/nextEvent/noEvent over real HTTP
│   ├── config.test.ts
│   ├── validation.test.ts
│   ├── sse.test.ts
│   ├── rooms.test.ts
│   └── integration.test.ts
├── deploy/
│   ├── local.claw-broker.plist   # launchd template (tokens substituted by install.sh)
│   ├── install.sh                # build + render plist + load service
│   └── tailscale-serve.sh        # front broker with HTTPS on the tailnet
└── README.md
```

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "claw-broker-service",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Standalone rambly-compatible WebRTC signaling broker for clawkie-talkie",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx --env-file-if-exists=.env src/server.ts",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (base — used by editor, `typecheck`, and vitest)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write `tsconfig.build.json`** (emits compiled JS to `dist/`)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: completes with exit code 0; creates `node_modules/` and `package-lock.json`. (`.gitignore` already excludes `node_modules/`, `dist/`, `.env`, `*.log`.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts
git commit -m "chore: scaffold claw-broker-service project"
```

---

## Task 1: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, DEFAULTS } from '../src/config.js';

describe('loadConfig', () => {
  it('returns defaults for an empty env', () => {
    expect(loadConfig({})).toEqual({
      port: 8787,
      host: '127.0.0.1',
      pingIntervalMs: 30_000,
      maxIdLength: 128,
      maxRoomLength: 256,
      maxSubscribersPerRoom: 128,
      maxSubscribersTotal: 2048,
    });
  });

  it('reads PORT', () => {
    expect(loadConfig({ PORT: '9000' }).port).toBe(9000);
  });

  it('accepts CT_SIGNALING_PORT as an alias for PORT', () => {
    expect(loadConfig({ CT_SIGNALING_PORT: '9001' }).port).toBe(9001);
  });

  it('lets PORT win when both are set', () => {
    expect(loadConfig({ PORT: '9000', CT_SIGNALING_PORT: '9001' }).port).toBe(9000);
  });

  it.each(['0', '70000', 'abc', '-5', '80.5'])('throws on invalid port %s', (bad) => {
    expect(() => loadConfig({ PORT: bad })).toThrow(/Invalid port/);
  });

  it('reads the bind host', () => {
    expect(loadConfig({ CT_SIGNALING_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('allows overriding ping interval and caps', () => {
    const cfg = loadConfig({
      CT_PING_INTERVAL_MS: '25',
      CT_MAX_ID_LENGTH: '8',
      CT_MAX_ROOM_LENGTH: '16',
      CT_MAX_SUBSCRIBERS_PER_ROOM: '2',
      CT_MAX_SUBSCRIBERS_TOTAL: '4',
    });
    expect(cfg).toMatchObject({
      pingIntervalMs: 25,
      maxIdLength: 8,
      maxRoomLength: 16,
      maxSubscribersPerRoom: 2,
      maxSubscribersTotal: 4,
    });
  });

  it('exposes DEFAULTS', () => {
    expect(DEFAULTS.port).toBe(8787);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write the implementation**

```ts
export interface Config {
  port: number;
  host: string;
  pingIntervalMs: number;
  maxIdLength: number;
  maxRoomLength: number;
  maxSubscribersPerRoom: number;
  maxSubscribersTotal: number;
}

export const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  pingIntervalMs: 30_000,
  maxIdLength: 128,
  maxRoomLength: 256,
  maxSubscribersPerRoom: 128,
  maxSubscribersTotal: 2048,
} as const;

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portRaw = env.PORT ?? env.CT_SIGNALING_PORT;
  return {
    port: parsePositiveInt(portRaw, DEFAULTS.port, 'port', 65_535),
    host: env.CT_SIGNALING_HOST?.trim() || DEFAULTS.host,
    pingIntervalMs: parsePositiveInt(env.CT_PING_INTERVAL_MS, DEFAULTS.pingIntervalMs, 'CT_PING_INTERVAL_MS'),
    maxIdLength: parsePositiveInt(env.CT_MAX_ID_LENGTH, DEFAULTS.maxIdLength, 'CT_MAX_ID_LENGTH'),
    maxRoomLength: parsePositiveInt(env.CT_MAX_ROOM_LENGTH, DEFAULTS.maxRoomLength, 'CT_MAX_ROOM_LENGTH'),
    maxSubscribersPerRoom: parsePositiveInt(env.CT_MAX_SUBSCRIBERS_PER_ROOM, DEFAULTS.maxSubscribersPerRoom, 'CT_MAX_SUBSCRIBERS_PER_ROOM'),
    maxSubscribersTotal: parsePositiveInt(env.CT_MAX_SUBSCRIBERS_TOTAL, DEFAULTS.maxSubscribersTotal, 'CT_MAX_SUBSCRIBERS_TOTAL'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add typed config loader"
```

---

## Task 2: Validators

**Files:**
- Create: `src/validation.ts`
- Test: `test/validation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  validatePeerAndRoom,
  validateRoom,
  validateSignalEnvelope,
} from '../src/validation.js';

describe('validatePeerAndRoom', () => {
  it('passes for valid values', () => {
    expect(validatePeerAndRoom('peer', 'room', 128, 256)).toBeNull();
  });
  it('flags missing id or room', () => {
    expect(validatePeerAndRoom('', 'room', 128, 256)).toEqual({ status: 400, message: 'Missing id or room' });
    expect(validatePeerAndRoom('peer', '', 128, 256)).toEqual({ status: 400, message: 'Missing id or room' });
    expect(validatePeerAndRoom(undefined, undefined, 128, 256)).toEqual({ status: 400, message: 'Missing id or room' });
  });
  it('flags an over-long id', () => {
    expect(validatePeerAndRoom('x'.repeat(9), 'room', 8, 256)).toEqual({ status: 413, message: 'id is too long' });
  });
  it('flags an over-long room', () => {
    expect(validatePeerAndRoom('peer', 'x'.repeat(9), 128, 8)).toEqual({ status: 413, message: 'room is too long' });
  });
});

describe('validateRoom', () => {
  it('passes for a valid room', () => {
    expect(validateRoom('room', 256)).toBeNull();
  });
  it('flags a missing room', () => {
    expect(validateRoom('', 256)).toEqual({ status: 400, message: 'Missing room' });
    expect(validateRoom(undefined, 256)).toEqual({ status: 400, message: 'Missing room' });
  });
  it('flags an over-long room', () => {
    expect(validateRoom('x'.repeat(9), 8)).toEqual({ status: 413, message: 'room is too long' });
  });
});

describe('validateSignalEnvelope', () => {
  it('returns the trimmed envelope and defaults data to {}', () => {
    expect(validateSignalEnvelope({ from: ' a ', to: ' b ' }, 128)).toEqual({ from: 'a', to: 'b', data: {} });
  });
  it('preserves data when present', () => {
    const data = { type: 'offer', sdp: 'v=0' };
    expect(validateSignalEnvelope({ from: 'a', to: 'b', data }, 128)).toEqual({ from: 'a', to: 'b', data });
  });
  it.each([null, 'hi', 42])('rejects non-object body %p', (body) => {
    expect(() => validateSignalEnvelope(body, 128)).toThrow('Signal body must be a JSON object');
  });
  it('treats an array as an object (matching the reference) and then fails on missing from', () => {
    // typeof [] === 'object', so the reference falls through to the from-check.
    expect(() => validateSignalEnvelope([], 128)).toThrow('Signal body missing from');
  });
  it('rejects a missing/empty from', () => {
    expect(() => validateSignalEnvelope({ to: 'b' }, 128)).toThrow('Signal body missing from');
    expect(() => validateSignalEnvelope({ from: '  ', to: 'b' }, 128)).toThrow('Signal body missing from');
  });
  it('rejects a missing/empty to', () => {
    expect(() => validateSignalEnvelope({ from: 'a' }, 128)).toThrow('Signal body missing to');
    expect(() => validateSignalEnvelope({ from: 'a', to: '  ' }, 128)).toThrow('Signal body missing to');
  });
  it('rejects an over-long from', () => {
    expect(() => validateSignalEnvelope({ from: 'x'.repeat(9), to: 'b' }, 8)).toThrow('Signal body from is too long');
  });
  it('rejects an over-long to', () => {
    expect(() => validateSignalEnvelope({ from: 'a', to: 'x'.repeat(9) }, 8)).toThrow('Signal body to is too long');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validation.test.ts`
Expected: FAIL — cannot resolve `../src/validation.js`.

- [ ] **Step 3: Write the implementation**

```ts
export interface ValidationError {
  status: number;
  message: string;
}

export interface SignalEnvelope {
  from: string;
  to: string;
  data: unknown;
}

export function validateRoom(room: string | undefined, maxRoomLength: number): ValidationError | null {
  if (!room) return { status: 400, message: 'Missing room' };
  if (room.length > maxRoomLength) return { status: 413, message: 'room is too long' };
  return null;
}

export function validatePeerAndRoom(
  peerId: string | undefined,
  room: string | undefined,
  maxIdLength: number,
  maxRoomLength: number,
): ValidationError | null {
  if (!peerId || !room) return { status: 400, message: 'Missing id or room' };
  if (peerId.length > maxIdLength) return { status: 413, message: 'id is too long' };
  return validateRoom(room, maxRoomLength);
}

export function validateSignalEnvelope(value: unknown, maxIdLength: number): SignalEnvelope {
  // Mirror the reference exactly: typeof null/string/number !== 'object', but
  // arrays ARE objects and fall through to the from/to checks below.
  if (!value || typeof value !== 'object') {
    throw new Error('Signal body must be a JSON object');
  }
  const body = value as { from?: unknown; to?: unknown; data?: unknown };
  if (typeof body.from !== 'string' || !body.from.trim()) {
    throw new Error('Signal body missing from');
  }
  if (typeof body.to !== 'string' || !body.to.trim()) {
    throw new Error('Signal body missing to');
  }
  const from = body.from.trim();
  const to = body.to.trim();
  if (from.length > maxIdLength) throw new Error('Signal body from is too long');
  if (to.length > maxIdLength) throw new Error('Signal body to is too long');
  return { from, to, data: body.data ?? {} };
}
```

> Note: we match the reference's exact edge-case behavior — an array body passes the `typeof value === 'object'` check and is then rejected with `Signal body missing from` (not `Signal body must be a JSON object`). The spec designates the reference as the source of truth for ambiguity, so we do not "improve" this message.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validation.ts test/validation.test.ts
git commit -m "feat: add request/envelope validators"
```

---

## Task 3: SSE + response helpers

**Files:**
- Create: `src/sse.ts`, `test/helpers/fakeRes.ts`
- Test: `test/sse.test.ts`

- [ ] **Step 1: Write the fake response helper**

```ts
// test/helpers/fakeRes.ts
import type { ServerResponse } from 'node:http';

export class FakeRes {
  chunks: string[] = [];
  headers: Record<string, string | number> = {};
  statusCode = 0;
  ended = false;

  setHeader(key: string, value: string | number): void {
    this.headers[key.toLowerCase()] = value;
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    }
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): void {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }

  get body(): string {
    return this.chunks.join('');
  }

  /** Cast to ServerResponse for code that only uses the methods above. */
  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { sendJson, setCorsHeaders, writeSse } from '../src/sse.js';
import { FakeRes } from './helpers/fakeRes.js';

describe('writeSse', () => {
  it('frames a single-line event', () => {
    const res = new FakeRes();
    writeSse(res.asResponse(), 'announce', 'peer-a');
    expect(res.body).toBe('event: announce\ndata: peer-a\n\n');
  });

  it('emits one data line per source line for multi-line payloads', () => {
    const res = new FakeRes();
    writeSse(res.asResponse(), 'signal', 'a\nb');
    expect(res.body).toBe('event: signal\ndata: a\ndata: b\n\n');
  });
});

describe('setCorsHeaders', () => {
  it('sets the wide CORS policy', () => {
    const res = new FakeRes();
    setCorsHeaders(res.asResponse());
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type,Accept');
  });
});

describe('sendJson', () => {
  it('writes status, content-type, and serialized body', () => {
    const res = new FakeRes();
    sendJson(res.asResponse(), 200, { ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body).toBe('{"ok":true}');
    expect(res.ended).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/sse.test.ts`
Expected: FAIL — cannot resolve `../src/sse.js`.

- [ ] **Step 4: Write the implementation**

```ts
import type { ServerResponse } from 'node:http';

export function writeSse(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\n`);
  for (const line of data.split('\n')) res.write(`data: ${line}\n`);
  res.write('\n');
}

export function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/sse.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sse.ts test/sse.test.ts test/helpers/fakeRes.ts
git commit -m "feat: add SSE framing and response helpers"
```

---

## Task 4: Room registry

**Files:**
- Create: `src/rooms.ts`
- Test: `test/rooms.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rooms.test.ts`
Expected: FAIL — cannot resolve `../src/rooms.js`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rooms.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rooms.ts test/rooms.test.ts
git commit -m "feat: add in-memory room registry"
```

---

## Task 5: Routing + server bootstrap (HTTP contract tests)

**Files:**
- Create: `src/app.ts`, `src/server.ts`
- Test: `test/integration.test.ts`

- [ ] **Step 1: Write the failing test** (non-SSE contract behaviors over real HTTP)

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { start, type RunningServer } from '../src/server.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Write `src/app.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { RoomRegistry } from './rooms.js';
import { sendJson, setCorsHeaders } from './sse.js';
import { validatePeerAndRoom, validateRoom, validateSignalEnvelope } from './validation.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface SignalingService {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  closeAllSubscribers: () => void;
  readonly subscriberCount: number;
}

export function createSignalingService(config: Config): SignalingService {
  const registry = new RoomRegistry(
    config.maxSubscribersPerRoom,
    config.maxSubscribersTotal,
    config.pingIntervalMs,
  );

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/subscribe') {
      handleSubscribe(req, res, url, registry, config);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/signal') {
      void handleSignal(req, res, url, registry, config);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  };

  return {
    handler,
    closeAllSubscribers: () => registry.closeAll(),
    get subscriberCount() {
      return registry.subscriberCount;
    },
  };
}

function handleSubscribe(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  registry: RoomRegistry,
  config: Config,
): void {
  const peerId = url.searchParams.get('id')?.trim();
  const room = url.searchParams.get('room')?.trim();

  const paramError = validatePeerAndRoom(peerId, room, config.maxIdLength, config.maxRoomLength);
  if (paramError) {
    sendJson(res, paramError.status, { error: paramError.message });
    return;
  }
  const capError = registry.checkCapacity(room!);
  if (capError) {
    sendJson(res, capError.status, { error: capError.message });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders?.();

  const connId = registry.add(peerId!, room!, res);
  res.once('close', () => registry.remove(room!, connId));
}

async function handleSignal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  registry: RoomRegistry,
  config: Config,
): Promise<void> {
  const room = url.searchParams.get('room')?.trim();
  const roomError = validateRoom(room, config.maxRoomLength);
  if (roomError) {
    sendJson(res, roomError.status, { error: roomError.message });
    return;
  }

  let envelope;
  try {
    envelope = validateSignalEnvelope(await readJsonBody(req), config.maxIdLength);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));

  registry.fanOutSignal(room!, envelope);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_JSON_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new Error('Missing JSON body');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body');
  }
}
```

- [ ] **Step 4: Write `src/server.ts`**

```ts
#!/usr/bin/env node
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSignalingService, type SignalingService } from './app.js';
import { loadConfig, type Config } from './config.js';

export interface RunningServer {
  server: http.Server;
  service: SignalingService;
  shutdown: () => Promise<void>;
}

export async function start(config: Config): Promise<RunningServer> {
  const service = createSignalingService(config);
  const server = http.createServer(service.handler);
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

  let closed = false;
  const shutdown = (): Promise<void> => {
    if (closed) return Promise.resolve(); // idempotent: safe to call from a signal and from test teardown
    closed = true;
    return new Promise<void>((resolve, reject) => {
      service.closeAllSubscribers();
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    });
  };

  return { server, service, shutdown };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, shutdown } = await start(config);
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  console.log(`[broker] listening on http://${config.host}:${port}`);
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    console.log('[broker] localhost-only; front with `tailscale serve` for tailnet HTTPS');
  }

  let shuttingDown = false;
  const onSignal = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[broker] ${sig} received, shutting down`);
    shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[broker] shutdown failed', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/integration.test.ts`
Expected: PASS (all HTTP contract cases green).

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/server.ts test/integration.test.ts
git commit -m "feat: add routing and server bootstrap"
```

---

## Task 6: SSE behavior tests (announce, fan-out, heartbeat, shutdown)

**Files:**
- Create: `test/helpers/sseClient.ts`
- Modify: `test/integration.test.ts` (append a new `describe` block)

- [ ] **Step 1: Write the SSE client helper**

```ts
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
```

- [ ] **Step 2: Append the failing SSE test block to `test/integration.test.ts`**

Add these imports to the top of the file (alongside the existing imports):

```ts
import { once } from 'node:events';
import { noEvent, sendSignal, subscribe, type SseStream } from './helpers/sseClient.js';
```

Append this block after the existing `describe('HTTP contract', ...)` block. The shared `boot`, `running`, `baseUrl`, and `afterEach` from Task 5 are reused; `openStreams` is aborted in an added afterEach:

```ts
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
```

- [ ] **Step 3: Run test to verify the new block fails first, then implementation already exists**

Run: `npx vitest run test/integration.test.ts`
Expected: PASS. (The implementation from Task 5 already satisfies these behaviors; this task adds the SSE-level coverage. If any case fails, fix `src/rooms.ts` or `src/app.ts` to match the assertion, re-run, and confirm green before committing.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all five test files green.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/sseClient.ts test/integration.test.ts
git commit -m "test: cover SSE announce, fan-out, heartbeat, and shutdown"
```

---

## Task 7: Build verification + deploy kit

**Files:**
- Create: `deploy/local.claw-broker.plist`, `deploy/install.sh`, `deploy/uninstall.sh`, `deploy/tailscale-serve.sh`

- [ ] **Step 1: Verify the production build compiles and runs**

Run: `npm run build && node dist/server.js & sleep 1 && curl -s http://127.0.0.1:8787/health && kill %1`
Expected: prints the `[broker] listening...` log lines and `{"ok":true}`. (If `dist/server.js` is missing, the build is misconfigured — check `tsconfig.build.json`.)

- [ ] **Step 2: Write the launchd plist template**

```xml
<!-- deploy/local.claw-broker.plist
     Template. install.sh substitutes __REPO_DIR__, __NODE_BIN__, and __PORT__. -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.claw-broker</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE_BIN__</string>
    <string>__REPO_DIR__/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>__REPO_DIR__</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>__PORT__</string>
    <key>CT_SIGNALING_HOST</key>
    <string>127.0.0.1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>__REPO_DIR__/../claw-broker-logs/out.log</string>
  <key>StandardErrorPath</key>
  <string>__REPO_DIR__/../claw-broker-logs/err.log</string>
</dict>
</plist>
```

> The log paths are placeholders; `install.sh` rewrites `StandardOutPath`/`StandardErrorPath` to `~/Library/Logs/claw-broker/`. They are written as tokens here only so the template is valid XML.

- [ ] **Step 3: Write `deploy/install.sh`**

```bash
#!/usr/bin/env bash
# Build the broker and install it as a launchd user agent on macOS.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"  # `|| true`: under set -e, a bare command -v miss would exit before our message
PORT="${PORT:-8787}"
LABEL="local.claw-broker"
DOMAIN="gui/$(id -u)"
LOG_DIR="${HOME}/Library/Logs/claw-broker"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ -z "${NODE_BIN}" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

echo "==> Building (${REPO_DIR})"
cd "${REPO_DIR}"
npm ci
npm run build

echo "==> Preparing log dir ${LOG_DIR}"
mkdir -p "${LOG_DIR}"
mkdir -p "${HOME}/Library/LaunchAgents"

echo "==> Rendering plist -> ${PLIST_DEST}"
sed \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" \
  -e "s#__REPO_DIR__#${REPO_DIR}#g" \
  -e "s#__PORT__#${PORT}#g" \
  "${REPO_DIR}/deploy/${LABEL}.plist" \
  | sed \
    -e "s#${REPO_DIR}/../claw-broker-logs/out.log#${LOG_DIR}/out.log#g" \
    -e "s#${REPO_DIR}/../claw-broker-logs/err.log#${LOG_DIR}/err.log#g" \
  > "${PLIST_DEST}"

echo "==> (Re)loading launchd service ${LABEL}"
launchctl bootout "${DOMAIN}" "${PLIST_DEST}" 2>/dev/null || true   # modern unload; ok if not loaded
launchctl bootstrap "${DOMAIN}" "${PLIST_DEST}"                     # modern load

echo "==> Waiting for health check on http://127.0.0.1:${PORT}/health"
for attempt in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "==> Healthy. Service ${LABEL} is up."
    echo "    Status:  launchctl list | grep ${LABEL}"
    echo "    Logs:    tail -f ${LOG_DIR}/out.log"
    exit 0
  fi
  sleep 0.5
done

echo "error: service did not pass health check within ~10s." >&2
echo "  Inspect: tail -n 50 ${LOG_DIR}/err.log" >&2
exit 1
```

- [ ] **Step 4: Write `deploy/tailscale-serve.sh`**

```bash
#!/usr/bin/env bash
# Front the local broker with HTTPS on this machine's tailnet name, on a
# DEDICATED port (8443) so the frontend can own :443 (/). See the bring-up
# doc for the full topology.
#
# Prerequisites:
#   - Tailscale installed and logged in (`tailscale status` works).
#   - HTTPS certificates enabled for the tailnet:
#     admin console -> DNS -> "Enable HTTPS".
#   - Syntax requires Tailscale >= 1.52 (current `serve` CLI).
set -euo pipefail

PORT="${PORT:-8787}"          # local broker (loopback)
HTTPS_PORT="${HTTPS_PORT:-8443}"  # tailnet-facing HTTPS port for the broker

# Resolve the tailscale CLI. On macOS the GUI app ships it at a non-PATH path.
TS="$(command -v tailscale || true)"
if [[ -z "${TS}" && -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
if [[ -z "${TS}" ]]; then
  echo "error: tailscale CLI not found." >&2
  echo "  Install the macOS app from https://tailscale.com/download/mac and either" >&2
  echo "  add it to PATH or run: /Applications/Tailscale.app/Contents/MacOS/Tailscale" >&2
  exit 1
fi

# Preflight: must be logged in. (`serve` has no --yes; cert provisioning needs
# HTTPS enabled in the admin console, which we cannot toggle from here.)
if ! "${TS}" status >/dev/null 2>&1; then
  echo "error: tailscale is not logged in / not running. Run: ${TS} up" >&2
  exit 1
fi

echo "==> Proxying https://<machine>.<tailnet>.ts.net:${HTTPS_PORT}  ->  http://127.0.0.1:${PORT}"
# --bg returns promptly; capture failure (the usual cause is HTTPS not enabled).
if ! "${TS}" serve --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${PORT}"; then
  echo "error: 'tailscale serve' failed." >&2
  echo "  Most likely HTTPS certificates are not enabled for this tailnet." >&2
  echo "  Enable them in the admin console (DNS -> Enable HTTPS), then re-run." >&2
  echo "  Docs: https://tailscale.com/kb/1153/enabling-https" >&2
  exit 1
fi

echo "==> Current serve config:"
"${TS}" serve status

echo
echo "Broker URL = https://<machine>.<tailnet>.ts.net:${HTTPS_PORT}"
echo "Use it as VITE_SIGNAL_SERVER (frontend build) and CT_SIGNAL_SERVER (daemon)."
echo "To stop: ${TS} serve --https=${HTTPS_PORT} off"
```

- [ ] **Step 5: Write `deploy/uninstall.sh`** (so a remote bounce/teardown is boring)

```bash
#!/usr/bin/env bash
# Stop and remove the broker launchd service. Idempotent.
set -euo pipefail

LABEL="local.claw-broker"
DOMAIN="gui/$(id -u)"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "${PLIST_DEST}" ]]; then
  echo "==> Booting out ${LABEL}"
  launchctl bootout "${DOMAIN}" "${PLIST_DEST}" 2>/dev/null || true
  rm -f "${PLIST_DEST}"
  echo "==> Removed ${PLIST_DEST}"
else
  echo "==> ${LABEL} not installed (no plist at ${PLIST_DEST})"
fi

echo "==> Done. Logs (if any) remain in ${HOME}/Library/Logs/claw-broker"
echo "    Tailscale serve, if configured, is separate: tailscale serve --https=8443 off"
```

Status / restart (documented in the README; no script needed — these are the boring remote-bounce commands):

```bash
launchctl list | grep local.claw-broker                                   # status
launchctl kickstart -k "gui/$(id -u)/local.claw-broker"                   # restart
launchctl bootout "gui/$(id -u)/local.claw-broker" 2>/dev/null || true    # stop
```

- [ ] **Step 6: Make scripts executable and lint them**

Run: `chmod +x deploy/install.sh deploy/uninstall.sh deploy/tailscale-serve.sh && for s in install uninstall tailscale-serve; do bash -n "deploy/$s.sh"; done && plutil -lint deploy/local.claw-broker.plist`
Expected: no syntax errors from `bash -n`; `plutil` prints `deploy/local.claw-broker.plist: OK`.

- [ ] **Step 7: Commit**

```bash
git add deploy/
git commit -m "feat: add launchd + tailscale serve deploy kit"
```

---

## Task 8: Runbook + env example

**Files:**
- Create: `README.md`, `.env.example`

- [ ] **Step 1: Write `.env.example`**

```bash
# claw-broker-service configuration. Copy to .env for local dev (npm run dev
# loads it via tsx). The launchd service sets PORT and CT_SIGNALING_HOST in the
# plist instead. All values are optional; defaults are the rambly contract.

# TCP port to bind (default 8787). CT_SIGNALING_PORT is an alias; PORT wins.
# PORT=8787

# Bind address. Keep 127.0.0.1 — tailscale serve fronts it for the tailnet.
# Only set 0.0.0.0 if you are intentionally exposing it behind your own proxy.
# CT_SIGNALING_HOST=127.0.0.1

# Heartbeat interval in ms (default 30000).
# CT_PING_INTERVAL_MS=30000

# Limits (defaults shown). All must be positive integers.
# CT_MAX_ID_LENGTH=128
# CT_MAX_ROOM_LENGTH=256
# CT_MAX_SUBSCRIBERS_PER_ROOM=128
# CT_MAX_SUBSCRIBERS_TOTAL=2048
```

- [ ] **Step 2: Write `README.md`**

````markdown
# claw-broker-service

A standalone, [rambly](https://rambly.app)-compatible WebRTC **signaling broker**
— a self-hosted replacement for `api.rambly.app` for running
[clawkie-talkie](https://github.com/davidguttman/clawkie-talkie) on your own
machine.

It is a rendezvous relay only: two peers (your phone browser and the local
clawkie-talkie daemon) join a room and exchange SDP/ICE JSON through it until
WebRTC connects, after which media flows peer-to-peer and the broker is idle. It
carries no audio, no auth, and no persistence — all state is in-memory.

## API

- `GET /health` → `{"ok":true}`
- `GET /subscribe?id=<peerId>&room=<room>` → Server-Sent Events (`announce`, `signal`, `ping`)
- `POST /signal?room=<room>` with `{"from","to","data"}` → `201 {"ok":true}`
- `OPTIONS *` → `204` (wide CORS for browser clients)

Full wire contract: `docs/superpowers/specs/2026-05-25-claw-broker-service-design.md`.

## Develop

```bash
npm install
npm test          # vitest: contract + integration suite
npm run dev       # tsx --env-file-if-exists=.env src/server.ts (loads .env if present)
npm run build     # tsc -> dist/
npm start         # node dist/server.js
```

Requires Node 20+.

## Deploy on a Mac mini over tailnet

This is the intended setup: the broker runs on the Mac mini (alongside
OpenClaw), and your phone reaches it over your tailnet. The broker takes a
**dedicated HTTPS port (8443)** so the clawkie-talkie frontend can own `/` on
:443. (See `docs/superpowers/specs/2026-05-25-clawkie-talkie-bringup.md` for the
full system bring-up: frontend, daemon, and the OpenClaw skill edit.)

```text
phone (tailnet) ──HTTPS :443──► tailscale serve ─► frontend  http://127.0.0.1:<fe-port>   (/voice)
phone (tailnet) ──HTTPS :8443─► tailscale serve ─► broker    http://127.0.0.1:8787        (/subscribe,/signal,/health)
                          (same <machine>.<tailnet>.ts.net cert; broker is cross-origin, CORS *)
```

1. **Install + start the service** (builds, installs a launchd user agent that
   auto-starts, restarts on crash, and self-checks health):

   ```bash
   ./deploy/install.sh          # exits non-zero if /health never comes up
   launchctl list | grep local.claw-broker
   ```

   Logs: `~/Library/Logs/claw-broker/{out,err}.log`.
   Restart: `launchctl kickstart -k "gui/$(id -u)/local.claw-broker"`.
   Remove: `./deploy/uninstall.sh`.

2. **Expose it over HTTPS on the tailnet.** The broker binds `127.0.0.1`;
   `tailscale serve` gives it a real HTTPS cert on your MagicDNS name (port
   8443):

   ```bash
   ./deploy/tailscale-serve.sh
   tailscale serve status   # shows https://<machine>.<tailnet>.ts.net:8443
   ```

   HTTPS is required, not optional: phone browsers only grant microphone access
   in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
   (HTTPS or localhost), and SSE will not load from an HTTPS page over plain
   HTTP (mixed content). `tailscale serve` solves both with a valid cert.

   Tailscale must be installed, logged in, and have HTTPS certificates enabled
   (admin console → DNS → Enable HTTPS). On macOS the CLI ships inside the app
   at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; the script falls
   back to that path if `tailscale` is not on `PATH`. Requires Tailscale ≥ 1.52.

### The broker alone is not a working handoff

Two more pieces are required, both **outside this repo** (specified in the
bring-up doc):

1. **A custom frontend build.** The hosted `clawkietalkie.app` bakes
   `VITE_SIGNAL_SERVER=https://api.rambly.app` at build time and can **never**
   reach your broker. Build the clawkie-talkie frontend against your broker and
   serve it on :443, and point the daemon at the broker:

   ```bash
   # frontend build (in the clawkie-talkie repo) — note the ICE override (see below)
   VITE_ICE_SERVERS_JSON='[]' \
     VITE_SIGNAL_SERVER=https://<machine>.<tailnet>.ts.net:8443 npm run build
   # daemon
   CT_ICE_SERVERS_JSON='[]' \
     CT_SIGNAL_SERVER=https://<machine>.<tailnet>.ts.net:8443 npm run daemon
   ```

2. **An edit to the OpenClaw handoff skill.** `clawkie-voice-handoff/SKILL.md`
   hardcodes `https://clawkietalkie.app/voice#…` (it is *not* driven by
   `CT_CLIENT_ORIGIN`). Until that origin is changed to your frontend's
   `https://<machine>.<tailnet>.ts.net/voice`, "switch to voice" links keep
   pointing at the hosted stack and never touch your broker.

See `docs/superpowers/specs/2026-05-25-clawkie-talkie-bringup.md` for the exact
steps and the end-to-end verification.

### TURN: you don't run one — but you must drop Rambly's

You do **not** need to run coturn: Tailscale already provides direct
connectivity between the phone and the Mac mini, so WebRTC host candidates over
the tailnet connect without a relay.

But self-hosting signaling does **not** by itself remove the dependency on
Rambly. The clawkie-talkie defaults still set ICE to Google STUN +
`turn:api.rambly.app:3478` unless you override them (verified at
`clawkie-talkie@75398eb`: `client/src/rtc/client.ts:41`, `daemon/src/peer.ts:41`).
So if the goal is "no hosted Rambly dependency," you must set **both**
`VITE_ICE_SERVERS_JSON` and `CT_ICE_SERVERS_JSON` explicitly:

- `'[]'` — pure tailnet, no external STUN/TURN (host candidates only). Preferred.
- STUN-only, e.g. `'[{"urls":"stun:stun.l.google.com:19302"}]'` — fallback if
  `[]` fails to connect (depends on Google STUN, still not Rambly).

## Manual end-to-end smoke test

After the broker is up and a frontend build + daemon are pointed at it:

1. The daemon connects and stays connected through at least one 30s heartbeat
   without reconnecting.
2. Open the daemon's Join URL on the phone; the browser joins that room.
3. The daemon receives an `announce` for the browser's peer ID.
4. SDP/ICE exchange completes; the WebRTC connection reaches `connected`.
5. Kill the broker process — audio is **not** disrupted, confirming the broker
   is not in the media path.

### "No hosted Rambly dependency" check

Run alongside the above to catch the silent-fallback failure mode:

- The built frontend bundle contains your `…ts.net:8443` URL and **no**
  `api.rambly.app` (`grep -r api.rambly.app client/dist` → no hits).
- Daemon logs/flags show `CT_SIGNAL_SERVER=https://<machine>.<tailnet>.ts.net:8443`.
- ICE config is `[]` or STUN-only on both sides (no `turn:api.rambly.app`).
- The phone browser's network panel shows **zero** requests to `api.rambly.app`
  (signaling and ICE both stay self-hosted/tailnet).

## Configuration

All optional; defaults are the rambly contract. See `.env.example`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` / `CT_SIGNALING_PORT` | `8787` | Bind port (`PORT` wins if both set). |
| `CT_SIGNALING_HOST` | `127.0.0.1` | Bind address; keep loopback behind tailscale serve. |
| `CT_PING_INTERVAL_MS` | `30000` | SSE heartbeat interval. |
| `CT_MAX_ID_LENGTH` | `128` | Max peer id length. |
| `CT_MAX_ROOM_LENGTH` | `256` | Max room name length. |
| `CT_MAX_SUBSCRIBERS_PER_ROOM` | `128` | Per-room subscriber cap. |
| `CT_MAX_SUBSCRIBERS_TOTAL` | `2048` | Process-wide subscriber cap. |

## Security

- **Tailnet-only by design.** This broker has no auth — that is acceptable
  *only* because the tailnet is the trust boundary. **Do not use Tailscale
  Funnel** and do not otherwise expose it to the public internet. `tailscale
  serve` is tailnet-private; Funnel is public — they are different features.
- **Bearer routing material.** Peer IDs, room names, host, and session IDs are
  secrets: anyone who knows a room can signal into it. Generate them with
  enough entropy (UUID v4).
- **CORS is `*` (threat model).** This matches Rambly so arbitrary frontend
  origins work. The consequence: any web page open on a tailnet-connected phone
  can issue requests to the broker URL. That is tolerable on a private tailnet;
  if you later serve frontend and broker from one origin, consider narrowing
  CORS.
- **Log redaction.** The broker does not log request bodies. Keep it that way,
  and also do not log routing identifiers (room, host, session) or any SDP/ICE
  — these reveal who is talking and expose network topology.

## References

- MDN — [Using Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) (event/data framing, keepalives)
- MDN — [`getUserMedia` secure-context requirement](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- MDN — [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) (the localhost exception)
- Tailscale — [Serve overview](https://tailscale.com/docs/features/tailscale-serve) and [`serve` CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
- Wire contract source of truth: `davidguttman/clawkie-talkie@75398eb` — `signaling/src/app.ts`
````

- [ ] **Step 3: Final full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests PASS, typecheck reports no errors, `dist/` is produced.

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example
git commit -m "docs: add runbook and env example"
```

---

## Self-review notes (for the implementer)

- **Wire-compat anchors:** event names (`announce`/`signal`/`ping`), the raw-string `announce` payload, compact-JSON `signal` payload, the exact error messages/status codes, and the SSE header set must match `clawkie-talkie/signaling/src/app.ts` exactly. If anything diverges, the reference wins.
- **The one spec disagreement:** body-over-1MiB returns **`400 Request body too large`** (reference + the spec's §4 table), not `413`. Task 5 asserts this.
- **`announce` ordering** is the subtle rule: snapshot existing subscribers, announce to them, *then* add the joiner — the joiner is never announced to. Covered in Tasks 4 and 6.
- **Type names to keep consistent across tasks:** `Config`, `ValidationError`, `SignalEnvelope`, `Subscriber`, `SignalingService`, `RunningServer`; `RoomRegistry` methods `add`/`remove`/`fanOutSignal`/`checkCapacity`/`closeAll`/`subscriberCount`.
- **ESM specifiers:** every intra-`src` import uses a `.js` suffix (e.g. `./rooms.js`) so `node dist/server.js` resolves; vitest resolves these to the `.ts` sources automatically.
