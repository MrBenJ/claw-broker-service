# claw-broker-service — Design

**Status:** Approved (design phase)
**Date:** 2026-05-25
**Source docs (public):** `davidguttman/clawkie-talkie@75398eb` — `docs/custom-stack.md` (describes the custom signaling stack / routes)
**Reference implementation / wire-contract tiebreaker:** `davidguttman/clawkie-talkie@75398eb` — `signaling/src/{app,server}.ts`
**Detailed spec used for this design:** `rambly-broker-spec.md`, provided locally at `~/code/_forks/clawkie-talkie/docs/` — **not** committed upstream (do not cite as a public path), reproduced in this design where it matters.

## 1. Purpose

A standalone, [rambly](https://rambly.app)-compatible WebRTC **signaling broker**. It is the
self-hosted replacement for `api.rambly.app` in a [clawkie-talkie](https://github.com/davidguttman/clawkie-talkie)
stack, built for one deployment: running on a Mac mini (alongside an OpenClaw
instance) so a phone on the same tailnet can open a voice lane into an OpenClaw
session.

The broker is a rendezvous relay only. Two peers — the phone browser and the
local daemon — join the same room, exchange small JSON envelopes (SDP/ICE)
until WebRTC negotiation completes, then media flows peer-to-peer and the
broker goes idle. It carries no audio, no auth, no persistence; all state is
in-memory and ephemeral.

```text
phone browser ─ SSE/POST ─► broker ◄─ SSE/POST ─ Mac mini daemon
phone browser ◄═══════ WebRTC media (P2P over tailnet) ═══════► daemon
```

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | **Node + TypeScript**, zero runtime deps (`node:http` + `node:crypto`) | Mirrors the reference exactly → lowest wire-compatibility risk. Reference TS clients available as harnesses if ever needed. |
| Deploy scope | **Full deploy kit**: launchd plist + `tailscale serve` script + runbook | Personal service that must "just run" on the Mac mini. |
| Test depth | **Contract unit tests + self-contained HTTP integration test**; manual e2e in runbook | High confidence without coupling the test suite to the clawkie-talkie repo. |
| Structure | Split the reference's single ~350-line file into small, independently-testable units | Same behavior, clearer boundaries, more reliable to work with. |

## 3. Deployment architecture (the part specific to this setup)

The broker code stays simple (plain HTTP, binds `127.0.0.1`). HTTPS and reach
are handled by the tailscale layer.

The broker takes a **dedicated HTTPS port (8443)** via `tailscale serve` so the
frontend can own `/` on :443. Same MagicDNS cert covers both ports; the browser
calls the broker cross-origin (hence CORS `*`).

```text
phone (tailnet) ──HTTPS :443 ──► tailscale serve ─► frontend http://127.0.0.1:<fe>   (/voice)
phone (tailnet) ──HTTPS :8443──► tailscale serve ─► broker   http://127.0.0.1:8787   (/subscribe,/signal,/health)
```

Four setup facts that determine whether the end-to-end actually works. They are
**specified in the companion bring-up doc** (`2026-05-25-clawkie-talkie-bringup.md`)
and the runbook; only the broker is built in this repo:

1. **Microphone requires a secure context.** Browsers only allow
   `getUserMedia` over HTTPS or `localhost`. A phone hitting a plain
   `http://100.x.x.x` tailscale IP is not a secure context — the mic silently
   fails. Because of SSE mixed-content rules, an HTTPS frontend also forces an
   HTTPS broker. `tailscale serve` provides valid HTTPS on the `*.ts.net`
   MagicDNS name, solving both. **This repo builds around `tailscale serve`;
   the broker itself never terminates TLS.**
2. **The frontend is configured at build time** (`VITE_SIGNAL_SERVER`). The
   hosted `clawkietalkie.app` is baked to `api.rambly.app` and can never reach
   a custom broker. Using this broker requires a self-built frontend pointed at
   `https://<machine>.<tailnet>.ts.net:8443`. Out of scope for this repo.
3. **The OpenClaw handoff skill hardcodes the frontend origin.**
   `clawkie-voice-handoff/SKILL.md` emits `https://clawkietalkie.app/voice#…`
   and is **not** overridable by `CT_CLIENT_ORIGIN` (that env var only feeds the
   daemon's separate `/dashboard` URL builder). The skill must be edited to emit
   the self-hosted frontend origin, or "switch to voice" never touches this
   broker. Out of scope for this repo; specified in the bring-up doc.
4. **You don't run TURN — but you must drop Rambly's.** Tailscale provides
   direct connectivity, so no coturn is needed (host candidates connect over the
   tailnet). However, the clawkie-talkie defaults still point ICE at
   `turn:api.rambly.app:3478` unless overridden (`client/src/rtc/client.ts:41`,
   `daemon/src/peer.ts:41`), so self-hosting signaling alone does **not** remove
   the Rambly dependency. The bring-up doc sets `VITE_ICE_SERVERS_JSON` /
   `CT_ICE_SERVERS_JSON` to `[]` (or STUN-only). Out of scope for the broker.

## 4. Repository layout

```
claw-broker-service/
├── src/
│   ├── config.ts        # parse + validate env → typed Config; fail loud on bad input
│   ├── validation.ts    # pure validators for id/room params + signal envelope
│   ├── sse.ts           # SSE framing, CORS headers, JSON response helpers
│   ├── rooms.ts         # RoomRegistry: subscribers, caps, announce/signal fan-out
│   ├── app.ts           # createSignalingService(): routing → { handler, closeAllSubscribers, subscriberCount }
│   └── server.ts        # bootstrap: http.createServer, bind, graceful shutdown
├── test/
│   ├── validation.test.ts   # every §4 error row
│   ├── rooms.test.ts        # announce / signal / lifecycle unit rules
│   └── integration.test.ts  # boots real server on a loopback port, speaks SSE/POST over real HTTP
├── deploy/
│   ├── local.claw-broker.plist           # launchd user agent
│   ├── install.sh                        # build + install + load + health-check the service
│   ├── uninstall.sh                      # stop + remove the launchd service (idempotent)
│   └── tailscale-serve.sh                # front the broker with HTTPS on :8443
├── package.json   # zero runtime deps; dev: typescript, vitest, @types/node, tsx
├── tsconfig.json
└── README.md      # runbook (install, manual e2e), frontend-build note, no-TURN note
```

### Module boundaries

- **`config.ts`** — `loadConfig(env): Config`. Reads `PORT` / `CT_SIGNALING_PORT`
  (PORT wins), `CT_SIGNALING_HOST`, optional ping-interval and cap overrides.
  Throws on an invalid port (≤0, >65535, non-integer). Pure function of its env
  argument so it is testable without touching `process.env`.
- **`validation.ts`** — pure functions returning either a validated value or a
  `{ status, message }` error. `validatePeerAndRoom`, `validateRoom`,
  `validateSignalEnvelope`. No HTTP knowledge.
- **`sse.ts`** — `writeSse(res, event, data)` (one `data:` line per source line),
  `setCorsHeaders(res)`, `sendJson(res, status, body)`. No business logic.
- **`rooms.ts`** — `RoomRegistry` owning `Map<room, Map<connId, Subscriber>>`.
  Methods: `add` (returns connId, performs announce-to-existing), `remove`,
  `fanOutSignal`, `closeAll`, `subscriberCount`, cap checks. Takes `writeSse`
  as a collaborator so it can be unit-tested with fake response objects.
- **`app.ts`** — `createSignalingService(opts)` wires config + validation + sse +
  rooms into the request handler and route table. Returns
  `{ handler, closeAllSubscribers, subscriberCount }`.
- **`server.ts`** — the only OS-touching module: `loadConfig`, create the HTTP
  server, bind to host/port, log the listen line + the localhost-only hint,
  install `SIGINT`/`SIGTERM` graceful shutdown (close all SSE streams so clients
  see EOF and reconnect, stop accepting, exit).

## 5. Wire behavior (the contract — mirrors the reference exactly)

### Routes
- `GET /health` → `200 {"ok":true}`.
- `GET /subscribe?id=<peerId>&room=<room>` → SSE stream (see below).
- `POST /signal?room=<room>` → `201 {"ok":true}`.
- `OPTIONS` (any path) → `204` with CORS headers.
- Anything else → `404 {"error":"Not Found"}` (do not echo the path).

### CORS (every response, including errors and SSE)
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Allow-Headers: Content-Type,Accept
```

### `/subscribe`
1. Trim + validate `id` and `room` (§7). On failure return JSON error; **do not
   open the stream**.
2. Enforce global cap then per-room cap; over cap → `429`.
3. Write SSE headers and flush immediately:
   ```
   Content-Type: text/event-stream
   Cache-Control: no-cache, no-transform
   Connection: keep-alive
   X-Accel-Buffering: no
   Access-Control-Allow-Origin: *
   ```
4. **Announce:** snapshot the room's existing subscribers *before* adding the
   joiner; send `announce` (raw peerId string) to each; **never echo to the
   joiner**.
5. Generate `connId = randomUUID()`, start the `ping` interval (`unref`'d),
   register the subscriber, increment the count.
6. On `res` `close`: clear the ping timer, remove the subscriber, decrement the
   count, and drop the room if it is now empty.

### `/signal`
1. Trim + validate `room` (§7).
2. Read body with a 1 MiB cap; parse + validate the envelope (§7).
3. Respond `201 {"ok":true}` **before/independent of** fan-out.
4. Look up the room; for each subscriber whose `peerId === to`, emit a `signal`
   event carrying the compact JSON envelope `{from,to,data}`. Deliver to **all**
   matches. Do not filter on `from`. Do not mutate `data`. No room / no match →
   silently dropped (still `201`); no queueing.

### SSE events emitted
| event | when | data |
|-------|------|------|
| `announce` | a peer subscribes — to all already-connected peers in the room | the joiner's `peerId` (raw string) |
| `signal` | a `/signal` envelope's `to` matches this subscriber's `peerId` | compact JSON `{"from":...,"to":...,"data":...}` |
| `ping` | heartbeat, every 30s default | `String(Date.now())` |

SSE framing: `event:` line, then one `data:` line per source line, then a blank
line. UTF-8.

## 6. State model

```
rooms: Map<roomName, Map<connId, Subscriber>>

Subscriber {
  connId: string   // server-side randomUUID(), never on the wire
  peerId: string   // the `id` query param from /subscribe
  room:   string
  res:    ServerResponse
  ping:   timer handle
}
```

- `connId` exists only so a specific connection can be deregistered when
  multiple connections share a `peerId`.
- Removing the last subscriber drops the room entry (no zombie rooms).
- Concurrent subscribes from the same `peerId` are allowed; each gets its own
  `connId`; all receive `signal` events addressed to that `peerId`.

## 7. Validation, limits, errors

All errors: `Content-Type: application/json`, body `{"error":"<message>"}`.
Trim `id`, `room`, `from`, `to` before validating/matching; empty-after-trim is
treated as missing.

| Condition | Status | Message |
|-----------|--------|---------|
| Missing `id` or `room` on `/subscribe` | 400 | `Missing id or room` |
| Missing `room` on `/signal` | 400 | `Missing room` |
| `id` exceeds max length | 413 | `id is too long` |
| `room` exceeds max length | 413 | `room is too long` |
| POST body missing/empty | 400 | `Missing JSON body` |
| POST body not valid JSON | 400 | `Invalid JSON body` |
| POST body not a JSON object | 400 | `Signal body must be a JSON object` |
| POST body missing `from` / not non-empty string | 400 | `Signal body missing from` |
| POST body missing `to` / not non-empty string | 400 | `Signal body missing to` |
| POST `from` exceeds max id length | 400 | `Signal body from is too long` |
| POST `to` exceeds max id length | 400 | `Signal body to is too long` |
| POST body exceeds 1 MiB | 400 | `Request body too large` |
| Subscriber would exceed per-room cap | 429 | `Too many subscribers in room` |
| Subscriber would exceed global cap | 429 | `Too many subscribers` |
| Unknown route | 404 | `Not Found` |

> Note: the source spec is internally inconsistent here — its §2.3 prose says
> "reject bodies larger than 1 MiB with `413`", but its §4 error table lists
> `400 Request body too large`. The reference enforces the cap in the body
> reader, which throws a 400-class validation error → **`400`**, matching the
> §4 table. We follow the reference and the table: `400 Request body too large`.

### Defaults (treated as the contract)
| Setting | Default |
|---------|---------|
| Max `id` length | 128 |
| Max `room` length | 256 |
| Max subscribers per room | 128 |
| Max subscribers total | 2048 |
| Max JSON body | 1 MiB |
| Ping interval | 30000 ms |

All configurable; defaults are the contract.

## 8. Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8787` | TCP port (takes precedence over the alias). |
| `CT_SIGNALING_PORT` | alias for `PORT` | Same as `PORT`; `PORT` wins if both set. |
| `CT_SIGNALING_HOST` | `127.0.0.1` | Bind address. Stays loopback — tailscale serve fronts it. |
| `CT_PING_INTERVAL_MS` | `30000` | Heartbeat interval (optional override). |
| `CT_MAX_ID_LENGTH` | `128` | Optional. |
| `CT_MAX_ROOM_LENGTH` | `256` | Optional. |
| `CT_MAX_SUBSCRIBERS_PER_ROOM` | `128` | Optional. |
| `CT_MAX_SUBSCRIBERS_TOTAL` | `2048` | Optional. |

Invalid port fails startup loudly. Graceful shutdown on `SIGINT`/`SIGTERM`:
close all SSE streams, stop accepting connections, exit.

## 9. Deploy kit

- **`deploy/local.claw-broker.plist`** — launchd user agent:
  `RunAtLoad` + `KeepAlive` (restart on crash), `StandardOutPath` /
  `StandardErrorPath` to `~/Library/Logs/claw-broker/`, `EnvironmentVariables`
  for `PORT` and `CT_SIGNALING_HOST`. `ProgramArguments` runs
  `node <repo>/dist/server.js` — compiled output, no `tsx` at runtime.
- **`deploy/install.sh`** — `npm ci`, `npm run build` (tsc → `dist/`), copy the
  plist to `~/Library/LaunchAgents/`, modern `launchctl bootout` (if present)
  then `launchctl bootstrap gui/$(id -u)`, then **poll `curl -fsS /health`** and
  exit non-zero if it never comes up. Idempotent. (`command -v node` is guarded
  with `|| true` so the friendly error runs under `set -e`.)
- **`deploy/uninstall.sh`** — `launchctl bootout gui/$(id -u)` + remove the
  plist. Idempotent. The README also documents the bare `launchctl list`
  (status) / `kickstart -k` (restart) / `bootout` (stop) commands so a remote
  bounce is routine.
- **`deploy/tailscale-serve.sh`** — current-syntax (Tailscale ≥ 1.52)
  `tailscale serve --bg --https=8443 http://127.0.0.1:${PORT:-8787}`, exposing
  the broker as `https://<machine>.<tailnet>.ts.net:8443` on a dedicated port so
  the frontend keeps `/` on :443. Resolves the tailscale CLI from `PATH` or the
  macOS app path (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`) and
  fails with install guidance if absent. Prints the broker URL to use as
  `VITE_SIGNAL_SERVER` / `CT_SIGNAL_SERVER`.
- **`README.md`** — install steps; the security/threat-model and log-redaction
  notes (§11); the manual end-to-end smoke checklist (below); pointers to the
  bring-up doc for the frontend/skill pieces; references.

## 10. Testing

### Unit / contract (`validation.test.ts`, `rooms.test.ts`)
Cover every error row in §7, plus:
- `GET /health` → `{"ok":true}`, 200.
- A subscriber receives `announce` for peers that join *after* it, never for
  its own join.
- A subscriber does **not** receive `announce` for peers already present when it
  joined.
- `POST /signal` reaches only the subscriber whose `peerId === to`; others in
  the room get nothing.
- `POST /signal` with no matching recipient still returns `201`.
- Two concurrent subscriptions with the same `peerId` both receive `signal`
  events for that `peerId`.
- Closing a subscriber removes it; emptying a room removes the room.
- `OPTIONS` → `204` with CORS headers.

### Integration (`integration.test.ts`)
Boot the real server on an ephemeral loopback port. Drive it with `fetch` + a
small inline SSE parser (copy of the ~30-line parser shape used by the reference
clients). Open two real subscriptions and assert: announce ordering, signal
fan-out to the correct peer only, `201` with no recipient, and that a `ping`
arrives within a short window (test runs with `CT_PING_INTERVAL_MS` set low).
No dependency on the clawkie-talkie repo.

### Manual end-to-end (runbook checklist, spec §9.2)
1. Daemon (`CT_SIGNAL_SERVER=https://<machine>.<tailnet>.ts.net:8443`) connects
   and stays connected through ≥1 heartbeat without reconnecting.
2. Browser (custom build, `VITE_SIGNAL_SERVER=https://<machine>.<tailnet>.ts.net:8443`)
   joins the room from the (skill-emitted, self-hosted-origin) Join URL.
3. Daemon receives `announce` for the browser's peer ID.
4. SDP/ICE exchange completes; WebRTC reaches `connected`.
5. Kill the broker process — audio is **not** disrupted (broker is not in the
   media path).

## 11. Security & threat model

- **Tailnet-only by design.** No auth is acceptable *only* because the tailnet
  is the trust boundary. **Do not use Tailscale Funnel** and do not otherwise
  expose the broker publicly. `tailscale serve` is tailnet-private; Funnel is
  the public-internet feature — keep them distinct.
- **Bearer routing material.** Peer IDs, room names, host, and session IDs are
  secrets (anyone who knows a room can signal into it). Use high-entropy values
  (UUID v4).
- **CORS `*` consequence.** Matches Rambly so arbitrary frontend origins work;
  the cost is that any page open on a tailnet-connected phone can call the
  broker URL. Acceptable on a private tailnet. If frontend and broker later
  share one origin, narrowing CORS becomes an option.
- **Log redaction.** The broker logs no request bodies; it must also never log
  routing identifiers (room, host, session) or SDP/ICE, which reveal who is
  talking and expose network topology.

## 12. Out of scope (spec §7)

Auth/API keys/JWT, room ownership/ACLs, persistence, message queueing /
store-and-forward, media handling, TURN/STUN, clustering/shared-state. No
interpretation of `data` (opaque JSON). The frontend build, the OpenClaw
handoff-skill edit, and coturn are separate concerns — specified in the
companion bring-up doc (`2026-05-25-clawkie-talkie-bringup.md`), not built here.

## 13. Build / tooling

- TypeScript → `dist/` via `tsc` (`npm run build`). Service runs `node dist/server.js`.
- `npm run dev` runs `tsx --env-file-if-exists=.env src/server.ts` for local
  iteration (tsx does **not** auto-load `.env`; the flag is required).
- `npm test` runs vitest.
- Target Node 20+ (global `fetch` + `ReadableStream` for the integration test;
  `node:http` for the server; `--env-file-if-exists` needs ≥ 20.12).
- Zero runtime dependencies. Dev deps only: `typescript`, `vitest`,
  `@types/node`, `tsx`.

## 14. References

- Wire contract source of truth: `davidguttman/clawkie-talkie@75398eb` —
  `signaling/src/app.ts` (impl), `test/customSignalingServer.test.ts` (harness).
- MDN — [Using Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events),
  [`getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia),
  [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).
- Tailscale — [Serve overview](https://tailscale.com/docs/features/tailscale-serve),
  [`serve` CLI](https://tailscale.com/docs/reference/tailscale-cli/serve).
