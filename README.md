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
