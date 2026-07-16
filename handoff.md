# VisuKit — Handoff / Status

_Last updated: 2026-07-16. Branch: `main`._

This doc is the portable summary of where VisuKit stands — readable by a contributor or by a
fresh AI coding session on any machine. Code is the source of truth; this is the map.

## TL;DR

A machine-agnostic OPC UA → WebSocket → SvelteKit visualization pipeline: live HMI, multi-pen
trends, SQLite historian, and a write path back to the PLC. Everything in the initial commit is
**done and verified end-to-end** against the bundled S7-1500 simulator (typechecks clean, write
round-trip confirmed, historian samples read back). The code was extracted from a private
project where the same pipeline runs against real Siemens hardware (S7-1500 via PLCSIM
Advanced).

## Architecture

```
OPC UA server(s)  ──opc.tcp──▶  GATEWAY (Node, singleton)  ──WebSocket :4900──▶  Browser
  (sim or PLC)                    - one session PER server                        (Svelte 5 runes)
                                  - subscriptions (push ~250ms)
                                  - hosts the WS server
                                  - writes the SQLite historian
                                        │
                                        └── data/historian.sqlite (WAL)
                                                  ▲ read-only
                        SvelteKit /api/history ───┘  (separate process; WAL concurrent read)
```

The **gateway is the OPC UA client AND the WS server** — one process, deliberately NOT inside
SvelteKit: it holds exactly one OPC UA session per server no matter how many browser tabs
connect, and keeps collecting history while the web app restarts during development. The **tag
`id`** is the contract tying config → gateway subscription → WS stream → HMI component prop.

## Files

**Config** — `config/tags.json`: object `{ servers, tags }`. `servers` maps name → endpoint (URL
string or `{ endpoint, user, pass }`). Each tag: `id, label, nodeId, server, dataType, writable?,
log?, unit?, group?, min?, max?, decimals?`. `server` optional if only one server. `log: true` =
historize.

**Server (`src/lib/server/opcua/`)**

- `tags.ts` — loads/validates config: `loadConfig()`, `loadServers()`, `loadTags()`, `tagsById()`,
  `tagsByGroup()`, `reloadConfig()`. Swap `loadConfig`'s body to move to a DB source later.
- `client.ts` — `startGateway({ servers, tags, onChange, onStatus })`: ONE session per server via
  internal non-blocking `connectServer()` (a down server retries forever without stalling others);
  `write()` routes to the owning session and maps `dataType` → OPC UA type (note: `Float` ≠
  `Double` — an S7 `Real` write as Double fails with `BadTypeMismatch`).
- `wsServer.ts` — `startWsServer({ port, catalog, write })` → `WsHub`: sends catalog + snapshot +
  per-server status on connect; batches deltas into `update` frames (~250ms); handles `write`.
- `historian.ts` — `openHistorian({ logTagIds })` writer (WAL, ~5s batched flush, ~1s/tag throttle,
  30d retention, numeric/bool only) + `openHistorianReader()` (read-only): `series(tag, from, to,
  buckets)` bucketed AVG/MIN/MAX + `count()`. Uses built-in **`node:sqlite`** (no native compile,
  no admin rights needed anywhere).

**Shared types** — `src/lib/opcua/types.ts` (client-safe): `TagDef`, `TagUpdate`, `ConnStatus`,
`ServerMsg` (catalog/snapshot/update/status/writeResult), `ClientMsg` (write).

**Browser (`src/lib/opcua/`)**

- `liveStore.svelte.ts` — `LiveGateway` (runes): reactive `catalog`, `values`, per-server
  `statuses` (SvelteMaps), `socketOpen`, `online` getter, `write()`, auto-reconnect; context
  helpers `setLiveGateway`/`getLiveGateway`.
- `components/` — `TagValue`, `TagLED`, `TagGauge` (270° SVG arc), `TagSetpoint` (writable
  numeric), `TagButton` (writable boolean — click writes `true`, LED mirrors the PLC read-back),
  `TagChart` (uPlot single-tag trend: avg + min/max band, live-append), `Trend` (multi-pen,
  axes auto-grouped by unit, synchronized ~1s live sampling, pen-table legend). Each takes a
  `tag` id prop (Trend takes `tags`).

**Routes**

- `/` (`src/routes/+page.svelte`) — the HMI: groups the catalog by `group`, auto-picks a
  component per tag (`writable Boolean→button`, `writable→setpoint`, `Boolean→led`,
  `min&max→gauge`, else `value`), per-server status chips, single-tag Trends section for `log`
  tags.
- `/trends` — the multi-pen trend page (own `LiveGateway`, 15m/1h/6h/24h range picker; default
  pens = first group's numeric tags).
- `/api/history` — `GET ?tag=&from=&to=&buckets=` (single, avg+min/max) or `?tags=a,b,c&…`
  (multi — one aligned time grid, null-filled). Opens the historian read-only per request; 503
  until the gateway has created the file.

**Dev scripts (`scripts/`)** — `opcua-sim-server.ts` (S7-1500-style address space:
`ns=3;s="MachineDB"."Machine1|2"."…"`, writable `Setpoint` + `Start`; `SIM_PORT`),
`opcua-probe.ts` (walk any server, dump NodeIds/types/values — how you discover NodeIds for the
config).

## How to run (dev)

Three terminals (order doesn't matter — the gateway retries forever):

```bash
npm run sim        # simulated PLC  (opc.tcp://localhost:4840/UA/VisuKitSim)
npm run gateway    # OPC UA client + WS :4900 + historian
npm run dev        # web app → http://localhost:5173
```

**Real PLC:** put the endpoint(s) in `config/tags.json` and restart the gateway. Single-server
shortcut: `OPCUA_ENDPOINT` (+ `OPCUA_USER`/`OPCUA_PASS`) overrides the config endpoint without
editing it. Discover NodeIds with `npm run probe -- opc.tcp://<ip>:4840`.

## Gotchas (don't relearn)

- **Port 4840 may be taken on dev machines** — Windows boxes with Siemens tooling often have the
  OPC UA Local Discovery Server (`opcualds`) or PLCSIM holding it. Fix: `SIM_PORT=4841 npm run
  sim` + `OPCUA_ENDPOINT=opc.tcp://localhost:4841/UA/VisuKitSim npm run gateway`.
- **S7 `Real` is a 4-byte `Float`**, not `Double`. Use `"dataType": "Float"` for S7 Reals or
  writes come back `BadTypeMismatch`. (Reads don't care.)
- **S7 NodeId strings include the quotes**: `ns=3;s="MyDB"."MyTag"` — in JSON that's
  `"ns=3;s=\"MyDB\".\"MyTag\""`.
- Siemens: OPC UA must be **activated in the CPU properties** (TIA Portal, + pick any runtime
  license) and the hardware config downloaded — port 102 answering does NOT mean 4840 is on.
  PLCSIM Advanced: use online access *PLCSIM Virtual Eth. Adapter `<Local>`* — no physical NIC
  or cable involved.
- `node:sqlite` prints a harmless `ExperimentalWarning`; node-opcua's `NODE-OPCUA-W06` cert
  warning is harmless under security `None`.
- Security is `None` + anonymous everywhere right now — see roadmap.

## Verification pattern

Typecheck: `npm run check` (app) + `npm run check:node` (gateway/scripts). Runtime: run the
three processes, then verify the full loop — a WS client that writes a writable tag and waits
for the subscription read-back (write `true` → update `true` → write `false` → update `false`),
plus `GET /api/history?tag=…` returning bucketed points after ~30s of collection.

## Roadmap / not yet done

1. **OPC UA security** — certificate-based `Sign & Encrypt` (Basic256Sha256) + the TIA-Portal
   two-way cert-trust handshake. The biggest gap for real-plant use; README carries a warning.
2. **README screenshot/GIF** of the HMI with the sim running (+ GitHub social preview).
3. **Trend phase 2** — runtime pen picker, saved/named trend views in config, drag-zoom/pan,
   scrolling live tail, manual per-axis scaling, optional min/max band per pen.
4. **TagButton variants** — momentary-on is hardcoded; a toggle mode and a "Turn off" affordance
   are a two-line change when needed.
5. **Config hot-reload** — `reloadConfig()` exists but nothing calls it; gateway restart is the
   current answer to config edits.
6. **Tests** — the e2e pattern above is manual; a scripted version (start sim+gateway, run the
   WS round-trip, assert) would make CI possible.
