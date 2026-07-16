// Client-side live gateway: one WebSocket to the OPC UA gateway, exposing a REACTIVE catalog +
// live values + link status for the HMI. Components read this via Svelte context (getLiveGateway)
// and look up their own tag by id. Browser-only — connect() runs from onMount and auto-reconnects
// with backoff. This is the browser mirror of the gateway's wsServer: same message protocol.
import { SvelteMap } from 'svelte/reactivity';
import { getContext, setContext } from 'svelte';
import type { TagDef, TagUpdate, ConnStatus, ServerMsg, ClientMsg } from './types.ts';

export type WriteResult = { ok: boolean; status: string };

export class LiveGateway {
	// Reactive collections — components reading these re-render on change.
	readonly catalog = new SvelteMap<string, TagDef>();
	readonly values = new SvelteMap<string, TagUpdate>();
	readonly statuses = new SvelteMap<string, ConnStatus>(); // per-server gateway↔PLC link, over WS
	socketOpen = $state(false); // our browser↔gateway WebSocket

	#url: string | undefined;
	#ws: WebSocket | null = null;
	#retry = 0;
	#closed = false;
	#pending = new Map<string, (r: WriteResult) => void>();

	constructor(url?: string) {
		this.#url = url;
	}

	// True when the socket is up and EVERY known server's link is healthy.
	get online(): boolean {
		if (!this.socketOpen || this.statuses.size === 0) return false;
		for (const s of this.statuses.values()) if (s !== 'connected' && s !== 'reconnected') return false;
		return true;
	}

	connect(): void {
		if (typeof WebSocket === 'undefined') return; // SSR guard
		this.#closed = false;
		const url = this.#url ?? `ws://${location.hostname}:4900`;
		const ws = new WebSocket(url);
		this.#ws = ws;
		ws.onopen = () => {
			this.socketOpen = true;
			this.#retry = 0;
		};
		ws.onmessage = (ev) => this.#handle(JSON.parse(ev.data) as ServerMsg);
		ws.onerror = () => ws.close();
		ws.onclose = () => {
			this.socketOpen = false;
			this.#ws = null;
			if (!this.#closed) this.#reconnect();
		};
	}

	#handle(msg: ServerMsg): void {
		switch (msg.type) {
			case 'catalog':
				this.catalog.clear();
				for (const t of msg.tags) this.catalog.set(t.id, t);
				break;
			case 'snapshot':
				this.values.clear();
				for (const u of msg.tags) this.values.set(u.id, u);
				break;
			case 'update':
				for (const u of msg.tags) this.values.set(u.id, u);
				break;
			case 'status':
				this.statuses.set(msg.server, msg.status);
				break;
			case 'writeResult': {
				const resolve = this.#pending.get(msg.id);
				if (resolve) {
					resolve({ ok: msg.ok, status: msg.status });
					this.#pending.delete(msg.id);
				}
				break;
			}
		}
	}

	#reconnect(): void {
		const delay = Math.min(1000 * 2 ** this.#retry, 10_000);
		this.#retry++;
		setTimeout(() => {
			if (!this.#closed) this.connect();
		}, delay);
	}

	// Write a writable tag; resolves with the gateway's writeResult (or a local failure).
	write(id: string, value: number | boolean): Promise<WriteResult> {
		return new Promise((resolve) => {
			if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
				resolve({ ok: false, status: 'not connected' });
				return;
			}
			this.#pending.set(id, resolve);
			const msg: ClientMsg = { type: 'write', id, value };
			this.#ws.send(JSON.stringify(msg));
			setTimeout(() => {
				const pending = this.#pending.get(id);
				if (pending) {
					pending({ ok: false, status: 'timeout' });
					this.#pending.delete(id);
				}
			}, 5000);
		});
	}

	close(): void {
		this.#closed = true;
		this.#ws?.close();
	}
}

const KEY = Symbol('live-gateway');
export function setLiveGateway(g: LiveGateway): void {
	setContext(KEY, g);
}
export function getLiveGateway(): LiveGateway {
	return getContext(KEY);
}
