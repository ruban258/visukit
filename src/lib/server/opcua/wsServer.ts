// WebSocket server hosted by the gateway. Streams the tag catalog + live values to any client
// (browser HMI, test harness). On connect a client gets the full catalog, a snapshot of current
// values, and the current PLC link status; thereafter it receives batched `update` deltas
// (~250ms). Inbound `write` messages drive writable tags (read-now / write-later). It runs on
// its own port so the single OPC UA session is preserved no matter how many clients connect.
import { WebSocketServer, WebSocket } from 'ws';
import type { TagDef, TagUpdate, ConnStatus, ServerMsg, ClientMsg } from '../../opcua/types.ts';

export type WsHub = {
	onChange: (u: TagUpdate) => void; // feed each monitored-item change in
	onStatus: (server: string, s: ConnStatus, detail?: string) => void; // feed per-server link transitions
	clientCount: () => number;
	stop: () => Promise<void>;
};

export type WsServerOptions = {
	port: number;
	catalog: TagDef[];
	write: (id: string, value: number | boolean) => Promise<string>;
	broadcastIntervalMs?: number;
	onLog?: (msg: string) => void;
};

export function startWsServer(opts: WsServerOptions): WsHub {
	const log = opts.onLog ?? (() => {});
	const wss = new WebSocketServer({ port: opts.port });

	const snapshot = new Map<string, TagUpdate>();
	const pending = new Map<string, TagUpdate>(); // deltas since last broadcast, deduped by id
	const statuses = new Map<string, { status: ConnStatus; detail?: string }>(); // per server

	const send = (ws: WebSocket, msg: ServerMsg) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
	};
	const broadcast = (msg: ServerMsg) => {
		const data = JSON.stringify(msg);
		for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
	};

	wss.on('connection', (ws) => {
		log(`client connected (${wss.clients.size} total)`);
		// Bring the new client fully up to date: catalog, current values, link status.
		send(ws, { type: 'catalog', tags: opts.catalog });
		send(ws, { type: 'snapshot', tags: [...snapshot.values()] });
		for (const [server, st] of statuses)
			send(ws, { type: 'status', server, status: st.status, detail: st.detail });

		ws.on('message', async (raw) => {
			let msg: ClientMsg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return; // ignore malformed frames
			}
			if (msg.type === 'write') {
				try {
					const status = await opts.write(msg.id, msg.value);
					send(ws, { type: 'writeResult', id: msg.id, ok: status === 'Good', status });
					log(`write ${msg.id}=${msg.value} → ${status}`);
				} catch (err) {
					const status = (err as Error).message;
					send(ws, { type: 'writeResult', id: msg.id, ok: false, status });
					log(`write ${msg.id} failed: ${status}`);
				}
			}
		});
		ws.on('close', () => log(`client disconnected (${wss.clients.size} total)`));
		ws.on('error', () => {}); // a dropped client must not crash the gateway
	});

	// Batch deltas so a burst of changes becomes one frame per interval, not one frame per change.
	const interval = setInterval(() => {
		if (pending.size === 0) return;
		broadcast({ type: 'update', tags: [...pending.values()] });
		pending.clear();
	}, opts.broadcastIntervalMs ?? 250);

	return {
		onChange: (u) => {
			snapshot.set(u.id, u);
			pending.set(u.id, u);
		},
		onStatus: (server, status, detail) => {
			statuses.set(server, { status, detail });
			broadcast({ type: 'status', server, status, detail });
		},
		clientCount: () => wss.clients.size,
		stop: () =>
			new Promise<void>((resolve) => {
				clearInterval(interval);
				for (const ws of wss.clients) ws.terminate();
				wss.close(() => resolve());
			})
	};
}
