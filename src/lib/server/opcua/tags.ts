// Loads + validates the config from config/tags.json (override the path with TAGS_CONFIG). The
// config is an object: { servers, tags }. `servers` maps a name to an OPC UA endpoint (URL string,
// or { endpoint, user?, pass? }); each tag names which server it lives on. This is the ONLY place
// that knows config comes from a file — the gateway/WS/app consume loadTags()/loadServers(). To
// move to a DB source later, swap the body here. Server-only (node:fs); the browser gets the tag
// catalog over the WS stream, never by reading this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TagDef, TagDataType } from '../../opcua/types.ts';

export type { TagDef, TagDataType } from '../../opcua/types.ts';

// One OPC UA server the gateway connects to. `id` is the config.servers key.
export type ServerDef = { id: string; endpoint: string; user?: string; pass?: string };

const VALID_TYPES: TagDataType[] = ['Double', 'Float', 'Int32', 'Boolean', 'String'];
const CONFIG_PATH = resolve(process.env.TAGS_CONFIG ?? 'config/tags.json');

function parseServers(raw: unknown): ServerDef[] {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new Error('config.servers must be an object map: name -> endpoint');
	const out: ServerDef[] = [];
	for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === 'string') {
			if (!v) throw new Error(`server "${id}": empty endpoint`);
			out.push({ id, endpoint: v });
		} else if (v && typeof v === 'object') {
			const o = v as Record<string, unknown>;
			if (typeof o.endpoint !== 'string' || !o.endpoint)
				throw new Error(`server "${id}": missing "endpoint"`);
			out.push({
				id,
				endpoint: o.endpoint,
				user: typeof o.user === 'string' ? o.user : undefined,
				pass: typeof o.pass === 'string' ? o.pass : undefined
			});
		} else {
			throw new Error(`server "${id}": must be a URL string or { endpoint, user?, pass? }`);
		}
	}
	if (out.length === 0) throw new Error('config.servers is empty');
	return out;
}

function parseTags(raw: unknown, servers: ServerDef[]): TagDef[] {
	if (!Array.isArray(raw)) throw new Error('config.tags must be an array');
	const serverIds = new Set(servers.map((s) => s.id));
	const onlyServer = servers.length === 1 ? servers[0].id : undefined;
	const ids = new Set<string>();
	return raw.map((entry, i) => {
		const where = `tag[${i}]`;
		if (!entry || typeof entry !== 'object') throw new Error(`${where}: not an object`);
		const t = entry as Record<string, unknown>;
		for (const f of ['id', 'label', 'nodeId', 'dataType'] as const) {
			if (typeof t[f] !== 'string' || !(t[f] as string).length)
				throw new Error(`${where}: missing/invalid "${f}"`);
		}
		const id = t.id as string;
		if (ids.has(id)) throw new Error(`${where}: duplicate id "${id}"`);
		ids.add(id);
		if (!VALID_TYPES.includes(t.dataType as TagDataType))
			throw new Error(`${where} ("${id}"): dataType must be one of ${VALID_TYPES.join(', ')}`);

		// Resolve which server this tag lives on: explicit, or the sole server if only one.
		let server = typeof t.server === 'string' && t.server ? t.server : onlyServer;
		if (!server)
			throw new Error(`${where} ("${id}"): "server" is required when multiple servers are defined`);
		if (!serverIds.has(server)) throw new Error(`${where} ("${id}"): unknown server "${server}"`);

		return {
			id,
			label: t.label as string,
			nodeId: t.nodeId as string,
			server,
			dataType: t.dataType as TagDataType,
			writable: Boolean(t.writable),
			log: Boolean(t.log),
			unit: typeof t.unit === 'string' && t.unit ? t.unit : undefined,
			group: typeof t.group === 'string' && t.group ? t.group : undefined,
			min: typeof t.min === 'number' ? t.min : undefined,
			max: typeof t.max === 'number' ? t.max : undefined,
			decimals: typeof t.decimals === 'number' ? t.decimals : undefined
		};
	});
}

let cache: { servers: ServerDef[]; tags: TagDef[] } | null = null;

// Load + validate the whole config (cached). Call reloadConfig() after editing the file.
export function loadConfig(): { servers: ServerDef[]; tags: TagDef[] } {
	if (!cache) {
		let text: string;
		try {
			text = readFileSync(CONFIG_PATH, 'utf8');
		} catch (err) {
			throw new Error(`cannot read config at ${CONFIG_PATH}: ${(err as Error).message}`);
		}
		const raw = JSON.parse(text);
		if (Array.isArray(raw))
			throw new Error(
				`${CONFIG_PATH} must be an object { servers, tags } (the bare-array format is no longer supported)`
			);
		if (!raw || typeof raw !== 'object')
			throw new Error(`${CONFIG_PATH} must be an object { servers, tags }`);
		const servers = parseServers(raw.servers);
		const tags = parseTags(raw.tags, servers);
		cache = { servers, tags };
	}
	return cache;
}

export function reloadConfig(): { servers: ServerDef[]; tags: TagDef[] } {
	cache = null;
	return loadConfig();
}

export function loadServers(): ServerDef[] {
	return loadConfig().servers;
}

export function loadTags(): TagDef[] {
	return loadConfig().tags;
}

export function tagsById(): Map<string, TagDef> {
	return new Map(loadTags().map((t) => [t.id, t]));
}

// Tags grouped by TagDef.group (display grouping), preserving file order. '' bucket = ungrouped.
export function tagsByGroup(): Map<string, TagDef[]> {
	const groups = new Map<string, TagDef[]>();
	for (const t of loadTags()) {
		const g = t.group ?? '';
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g)!.push(t);
	}
	return groups;
}
