# VisuKit

**SvelteKit-native OPC UA visualization — live tags, trends, and a historian.**

VisuKit connects to one or more OPC UA servers (a Siemens S7-1500, PLCSIM Advanced, or any
other server), subscribes to the tags you declare in a single JSON file, and gives you:

- a **live HMI page** that auto-builds itself from the tag catalog — gauges, LEDs, value
  readouts, setpoint inputs, and command buttons picked automatically from each tag's shape
- a **multi-pen trend view** (uPlot on canvas — fast) that stitches historical data and the
  live stream into one seamless chart
- a **SQLite historian** for the tags you flag, with a downsampling read API
- a **write path** for setpoints and boolean commands, routed to the right server

No database server, no broker, no cloud. Two Node processes and a JSON file.

## Quickstart — no PLC required

Requires Node.js ≥ 24. Three terminals:

```bash
npm install

npm run sim        # 1. simulated S7-1500 OPC UA server (opc.tcp://localhost:4840)
npm run gateway    # 2. the gateway: OPC UA → WebSocket (:4900) + historian
npm run dev        # 3. the web app → http://localhost:5173
```

Open http://localhost:5173 — you'll see two simulated machines with live values. Change a
setpoint or hit **Turn on**, and watch the write go to the (simulated) PLC and the confirmed
value come back. The **Trends** page fills up as the historian collects samples.

## Architecture

```
                    ┌──────────────────────── gateway (Node, singleton) ───────────────┐
 OPC UA server(s)   │  client.ts      one session + subscription per server            │
 (PLC / PLCSIM /    │─►                                                                │
  npm run sim)      │  historian.ts   SQLite (node:sqlite), tags flagged `log`         │
                    │  wsServer.ts    WebSocket :4900 — catalog, snapshot, deltas,     │
                    └─────────────────writes ─────────────────┬────────────────────────┘
                                                              │
                    ┌──────────────────── SvelteKit app ──────▼────────────────────────┐
                    │  liveStore.svelte.ts   reactive mirror of the WS stream          │
                    │  /            live HMI, auto-built from the tag catalog          │
                    │  /trends      multi-pen trend (history API + live stream)        │
                    │  /api/history downsampled series from the historian SQLite       │
                    └───────────────────────────────────────────────────────────────────┘
```

The gateway is deliberately its own process: it holds exactly one OPC UA session per server
no matter how many browser tabs connect, and it keeps collecting history while the web app
restarts during development.

## Configuration — `config/tags.json`

One file defines everything: which servers to connect to, and which tags to subscribe to.

```jsonc
{
	"servers": {
		"sim-plc": "opc.tcp://localhost:4840/UA/VisuKitSim"
		// or with credentials: "plc2": { "endpoint": "opc.tcp://…", "user": "…", "pass": "…" }
	},
	"tags": [
		{
			"id": "machine1.temp", // unique key used everywhere (WS stream, components, historian)
			"label": "Temperature",
			"nodeId": "ns=3;s=\"MachineDB\".\"Machine1\".\"Temperature\"",
			"server": "sim-plc",
			"dataType": "Double", // Double | Float | Int32 | Boolean | String
			"unit": "°C",
			"group": "Machine 1", // display grouping on the HMI
			"log": true, // historize to SQLite
			"min": 0,
			"max": 120, // range hints → renders as a gauge
			"decimals": 1
		}
	]
}
```

How the HMI picks a component for each tag:

| Tag shape                | Component      |
| ------------------------ | -------------- |
| writable Boolean         | command button |
| writable numeric         | setpoint input |
| Boolean                  | LED            |
| numeric with `min`+`max` | radial gauge   |
| anything else            | value readout  |

## Pointing it at a real PLC

1. Find your NodeIds: `npm run probe -- opc.tcp://<plc-ip>:4840` walks the address space and
   prints every variable's NodeId, type, and value.
2. Put them in `config/tags.json`. S7-1500 note: PLC data lives in the PLC's own namespace
   (usually `ns=3`) with string NodeIds like `ns=3;s="MyDB"."MyTag"` — the quotes are part of
   the string. An S7 `Real` is a 4-byte **Float** (not Double) — this matters for writes.
3. Restart the gateway.

For Siemens: activate the OPC UA server in the CPU properties (TIA Portal) and download the
hardware config — port 102 being open does not mean OPC UA (port 4840) is on. With PLCSIM
Advanced, use the *PLCSIM Virtual Eth. Adapter `<Local>`* mode; no physical network needed.

Security note: the gateway currently connects with security `None` + anonymous (fine for
first bring-up and simulators). Certificate-based `Sign & Encrypt` is on the roadmap — don't
expose an unencrypted PLC connection across an untrusted network.

## Environment variables (all optional)

| Variable            | Default              | What it does                                 |
| ------------------- | -------------------- | -------------------------------------------- |
| `TAGS_CONFIG`       | `config/tags.json`   | path to the config file                      |
| `GATEWAY_WS_PORT`   | `4900`               | gateway WebSocket port                       |
| `HISTORIAN_DB`      | `data/historian.sqlite` | historian SQLite file                     |
| `OPCUA_ENDPOINT`    | —                    | override the endpoint (single-server config) |
| `OPCUA_USER`/`PASS` | —                    | credentials (single-server config)           |
| `PUBLIC_GATEWAY_WS` | `ws://<host>:4900`   | WS URL the browser connects to               |
| `SIM_PORT`          | `4840`               | sim server port                              |

## Deployment

`npm run build` emits a self-contained Node app in `./build` (adapter-node); run it with
`node build` (set `PORT`/`ORIGIN`). Run the gateway (`npm run gateway`) alongside it under
your process manager of choice (pm2, NSSM, systemd).

## License

[MIT](LICENSE)
