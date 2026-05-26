# Clawkie Talkie self-hosted bring-up (companion to the broker spec)

**Status:** Companion reference (not built in this repo)
**Date:** 2026-05-25
**Relates to:** `2026-05-25-claw-broker-service-design.md`

The broker in this repo is necessary but **not sufficient** to make "switch to
voice" work against your own machine. This doc specifies the other pieces — the
frontend build, the Tailscale topology, the OpenClaw handoff-skill edit, and the
daemon config — and the end-to-end check that ties them together.

None of this is built in `claw-broker-service`. It lives in the
[`clawkie-talkie`](https://github.com/davidguttman/clawkie-talkie) repo and your
OpenClaw install. This doc exists so the path is fully defined before the broker
is coded, and so the deployment is reproducible.

## Why the broker alone isn't enough

```text
"switch to voice" (OpenClaw)
        │  emits a URL from clawkie-voice-handoff/SKILL.md
        ▼
phone opens  https://<frontend-origin>/voice#host=…&session=…
        │  the FRONTEND BUILD decides which signaling broker it talks to
        ▼
frontend ──SSE/POST──► signaling broker ◄──SSE/POST── local daemon
```

Two values are baked at points you don't control by default:

1. **`VITE_SIGNAL_SERVER`** is compiled into the frontend at build time. The
   hosted `clawkietalkie.app` is built against `https://api.rambly.app`, so it
   can never talk to your broker — you need your own build.
2. **The frontend origin** in the handoff URL is **hardcoded** in
   `clawkie-voice-handoff/SKILL.md` (verified at `clawkie-talkie@75398eb`,
   `SKILL.md:117`: ``const url = `https://clawkietalkie.app/voice#${params}` ``).
   It is *not* read from `CT_CLIENT_ORIGIN` — that env var only changes the
   daemon's separate `/dashboard#host=` URL (`daemon/src/dashboardUrl.ts`). So
   the skill text itself must be edited.

## Topology (matches the broker's deploy kit)

One Mac mini, one MagicDNS name, two HTTPS ports via `tailscale serve` (the
cert covers all ports on the name):

| Service | Local | Tailnet-facing | Path |
|---------|-------|----------------|------|
| Frontend (static build) | `http://127.0.0.1:<fe-port>` | `https://<machine>.<tailnet>.ts.net` (:443) | `/voice` |
| Broker (this repo) | `http://127.0.0.1:8787` | `https://<machine>.<tailnet>.ts.net:8443` | `/subscribe`, `/signal`, `/health` |

Two ports keeps it simple (no path-routing collisions). The broker is reached
cross-origin from the frontend page — that is why broker CORS is `*`.

> Alternative: a single :443 with `tailscale serve --set-path` mounts
> (`/` → frontend, `/subscribe`,`/signal`,`/health` → broker). More fiddly and
> easy to get wrong; the two-port layout above is the recommended default.

## Steps

### 1. Build + serve the frontend against your broker

In the `clawkie-talkie` repo on the Mac mini:

```bash
VITE_ICE_SERVERS_JSON='[]' \
  VITE_SIGNAL_SERVER=https://<machine>.<tailnet>.ts.net:8443 npm run build
```

**Set `VITE_ICE_SERVERS_JSON` — do not omit it.** The frontend's default ICE is
Google STUN + `turn:api.rambly.app:3478` (`client/src/rtc/client.ts:41` @
`clawkie-talkie@75398eb`), so omitting the override leaves a silent dependency
on Rambly's TURN even though signaling is self-hosted. Use `'[]'` for pure
tailnet (host candidates only); fall back to STUN-only
(`'[{"urls":"stun:stun.l.google.com:19302"}]'`) only if `[]` fails to connect.

Serve the static build output on a loopback port (any static server is fine,
e.g. `npx serve -l 127.0.0.1:5180 client/dist`). Note the `<fe-port>`.

### 2. Expose both over HTTPS on the tailnet

```bash
# broker (from this repo)
./deploy/tailscale-serve.sh                                  # -> :8443

# frontend (the static server from step 1)
tailscale serve --bg http://127.0.0.1:<fe-port>              # -> :443 (/)
tailscale serve status                                       # confirm both
```

Prerequisite: Tailscale installed, logged in, HTTPS certs enabled (admin
console → DNS → Enable HTTPS), version ≥ 1.52. On macOS the CLI is at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` if not on `PATH`.

### 3. Point the daemon at the broker

In the daemon `.env` (or CLI flags):

```bash
CT_SIGNAL_SERVER=https://<machine>.<tailnet>.ts.net:8443
CT_CLIENT_ORIGIN=https://<machine>.<tailnet>.ts.net   # keeps the daemon's own
                                                      # /dashboard URL on-origin
CT_ICE_SERVERS_JSON='[]'   # REQUIRED to drop Rambly's TURN; daemon default is
                           # Google STUN + turn:api.rambly.app:3478 (peer.ts:41).
                           # Match whatever you chose for the frontend in step 1.
```

### 4. Edit the OpenClaw handoff skill origin

In your installed OpenClaw skill `clawkie-voice-handoff/SKILL.md`, replace the
hardcoded `https://clawkietalkie.app` origin with your frontend origin
`https://<machine>.<tailnet>.ts.net`. As of `clawkie-talkie@75398eb` this
appears at:

- `SKILL.md:117` — the constructed `const url = …/voice#…` (the operative one)
- `SKILL.md:41` and `SKILL.md:151` — the documented URL shape/examples

After editing, restart the OpenClaw session/agent so the updated skill text is
in effect.

### 5. End-to-end verification

1. In OpenClaw, "switch to voice" → the emitted link starts with
   `https://<machine>.<tailnet>.ts.net/voice#…` (your origin, **not**
   clawkietalkie.app).
2. Open it on the phone (on the tailnet). The page loads over HTTPS (mic permission
   is grantable — secure context) and the frontend subscribes to the broker at
   `:8443`.
3. The daemon receives `announce` for the browser's peer ID
   (`curl -s https://<machine>.<tailnet>.ts.net:8443/health` → `{"ok":true}` as a
   pre-check).
4. SDP/ICE exchange completes; WebRTC reaches `connected`; audio flows both ways.
   With the broker killed (next step) the call survives — but to prove there is
   **no hosted Rambly dependency**, also confirm the phone's browser network
   panel made **zero** requests to `api.rambly.app` during setup.
5. Kill the broker (`launchctl bootout "gui/$(id -u)/local.claw-broker"`) — audio
   is **not** disrupted, confirming the broker is out of the media path.

## Verification checklist (quick)

- [ ] `curl -fsS https://<machine>.<tailnet>.ts.net:8443/health` → `{"ok":true}`
- [ ] Frontend loads at `https://<machine>.<tailnet>.ts.net/voice` over valid HTTPS
- [ ] `tailscale serve status` shows both :443 (frontend) and :8443 (broker)
- [ ] Skill-emitted link uses the self-hosted origin (not clawkietalkie.app)
- [ ] Daemon stays connected across ≥1 heartbeat (30s) without reconnecting
- [ ] WebRTC reaches `connected`; killing the broker mid-call doesn't drop audio
- [ ] **No Rambly:** built bundle has no `api.rambly.app` (`grep -r api.rambly.app client/dist`),
      ICE is `[]`/STUN-only on both sides, and the browser network panel shows no
      `api.rambly.app` requests
