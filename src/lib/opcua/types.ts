// Shared, framework-agnostic OPC UA tag types. Safe to import from BOTH the server (gateway,
// loader) and the browser (HMI components) — there is deliberately no fs / node-opcua here, so
// nothing drags Node-only code into the client bundle. The tag `id` is the contract that ties
// the config file, the gateway subscription, the WS stream, and the HMI components together.

export type TagDataType = 'Double' | 'Float' | 'Int32' | 'Boolean' | 'String';

export type TagDef = {
	id: string; // unique stable key used EVERYWHERE (config, WS, component prop)
	label: string; // human label for the HMI, e.g. "Temperature"
	nodeId: string; // OPC UA NodeId on its server
	server?: string; // which OPC UA server (config.servers key) this tag lives on
	dataType: TagDataType;
	writable?: boolean;
	log?: boolean; // opt-in: historize this tag to the SQLite historian (default off)
	unit?: string; // "°C", "bar", "rpm"…
	group?: string; // free-form grouping: "Machine 1", "Compressor A", "Line 3"…
	min?: number; // optional range hints for gauges / bars
	max?: number;
	decimals?: number; // optional display precision
};

// A live value for one tag, streamed to the HMI keyed by TagDef.id. Kept lean because it flows
// often; the display metadata (label/unit/min/max) lives in the TagDef catalog, sent once.
export type TagUpdate = {
	id: string;
	value: unknown;
	quality: string; // OPC UA StatusCode name, e.g. "Good"
	ts: string; // ISO timestamp
};

// The gateway's connection to the OPC UA server, as observed by the browser.
export type ConnStatus = 'connecting' | 'connected' | 'lost' | 'reconnected';

// WebSocket wire protocol between the gateway and HMI clients.
// Gateway → client:
export type ServerMsg =
	| { type: 'catalog'; tags: TagDef[] } // sent once on connect
	| { type: 'snapshot'; tags: TagUpdate[] } // full current values on connect
	| { type: 'update'; tags: TagUpdate[] } // batched deltas thereafter
	| { type: 'status'; server: string; status: ConnStatus; detail?: string } // per-server link state
	| { type: 'writeResult'; id: string; ok: boolean; status: string };

// Client → gateway (read-now / write-later):
export type ClientMsg = { type: 'write'; id: string; value: number | boolean };
