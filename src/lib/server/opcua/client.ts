// OPC UA connection manager for the gateway. The gateway may talk to SEVERAL servers (one per
// PLC): startGateway() opens ONE connection per server, each owning its own session + subscription
// for that server's tags. Connections are brought up independently and non-blockingly — a server
// that's down keeps retrying (maxRetry:-1) without stalling the others. Monitored-item changes
// become TagUpdates (keyed by TagDef.id) via onChange; link transitions surface per-server via
// onStatus. Writes are routed to the session that owns the tag.
import {
	OPCUAClient,
	AttributeIds,
	TimestampsToReturn,
	MessageSecurityMode,
	SecurityPolicy,
	DataType,
	Variant
} from 'node-opcua';
import type { ClientSession, ClientSubscription, DataValue } from 'node-opcua';
import type { TagDef, TagUpdate, ConnStatus } from '../../opcua/types.ts';
import type { ServerDef } from './tags.ts';

export type { ConnStatus } from '../../opcua/types.ts';

export type GatewayOptions = {
	servers: ServerDef[];
	tags: TagDef[];
	onChange: (u: TagUpdate) => void;
	onStatus?: (server: string, s: ConnStatus, detail?: string) => void;
	publishingIntervalMs?: number;
	samplingIntervalMs?: number;
};

export type GatewayConnection = {
	// Write path (read-now / write-later): only writable tags; routed to the owning server.
	write: (id: string, value: number | boolean) => Promise<string>;
	stop: () => Promise<void>;
};

type ServerConnection = {
	write: (id: string, value: number | boolean) => Promise<string>;
	stop: () => Promise<void>;
};

type ServerConnectionArgs = {
	server: ServerDef;
	tags: TagDef[];
	onChange: (u: TagUpdate) => void;
	onStatus: (s: ConnStatus, detail?: string) => void;
	publishingIntervalMs?: number;
	samplingIntervalMs?: number;
};

// Connect ONE server. Returns immediately; the connect/session/subscription happen in the
// background (so a down server never blocks the caller) and progress is reported via onStatus.
function connectServer(args: ServerConnectionArgs): ServerConnection {
	const { server, tags, onChange, onStatus } = args;
	const byId = new Map(tags.map((t) => [t.id, t]));

	const client = OPCUAClient.create({
		applicationName: 'visukit-gateway',
		securityMode: MessageSecurityMode.None,
		securityPolicy: SecurityPolicy.None,
		endpointMustExist: false,
		keepSessionAlive: true,
		connectionStrategy: { maxRetry: -1, initialDelay: 1000, maxDelay: 10_000 }
	});
	client.on('backoff', (retry: number, delay: number) =>
		onStatus('connecting', `retry #${retry}, next in ${Math.round(delay / 1000)}s`)
	);
	client.on('connection_lost', () => onStatus('lost'));
	client.on('connection_reestablished', () => onStatus('reconnected'));

	let session: ClientSession | null = null;
	let subscription: ClientSubscription | null = null;
	let stopped = false;

	(async () => {
		onStatus('connecting');
		await client.connect(server.endpoint);
		if (stopped) return;
		const userIdentity =
			server.user && server.pass ? { userName: server.user, password: server.pass } : undefined;
		session = await client.createSession(userIdentity as never);
		onStatus('connected');
		subscription = await session.createSubscription2({
			requestedPublishingInterval: args.publishingIntervalMs ?? 500,
			requestedMaxKeepAliveCount: 10,
			requestedLifetimeCount: 100,
			maxNotificationsPerPublish: 1000,
			publishingEnabled: true,
			priority: 10
		});
		const sampling = args.samplingIntervalMs ?? 250;
		for (const tag of tags) {
			const item = await subscription.monitor(
				{ nodeId: tag.nodeId, attributeId: AttributeIds.Value },
				{ samplingInterval: sampling, discardOldest: true, queueSize: 10 },
				TimestampsToReturn.Both
			);
			item.on('changed', (dv: DataValue) => onChange(toUpdate(tag, dv)));
		}
	})().catch((err) => onStatus('lost', (err as Error).message));

	async function write(id: string, value: number | boolean): Promise<string> {
		const tag = byId.get(id);
		if (!tag) throw new Error(`unknown tag: ${id}`);
		if (!tag.writable) throw new Error(`tag not writable: ${id}`);
		if (!session) throw new Error(`server "${server.id}" not connected`);
		const dataType =
			tag.dataType === 'Boolean'
				? DataType.Boolean
				: tag.dataType === 'Int32'
					? DataType.Int32
					: tag.dataType === 'Float'
						? DataType.Float
						: DataType.Double;
		const statusCode = await session.write({
			nodeId: tag.nodeId,
			attributeId: AttributeIds.Value,
			value: { value: new Variant({ dataType, value }) }
		});
		return statusCode.name ?? statusCode.toString();
	}

	async function stop(): Promise<void> {
		stopped = true;
		try {
			if (subscription) await subscription.terminate();
		} catch {
			/* may already be gone after a drop */
		}
		try {
			if (session) await session.close();
		} catch {
			/* may already be gone after a drop */
		}
		await client.disconnect();
	}

	return { write, stop };
}

export async function startGateway(opts: GatewayOptions): Promise<GatewayConnection> {
	// Group tags by their server (they were resolved to a valid server id at load time).
	const byServer = new Map<string, TagDef[]>();
	for (const t of opts.tags) {
		if (!t.server) continue;
		const list = byServer.get(t.server) ?? [];
		list.push(t);
		byServer.set(t.server, list);
	}

	const conns: ServerConnection[] = [];
	const writeRouter = new Map<string, ServerConnection['write']>();
	for (const server of opts.servers) {
		const serverTags = byServer.get(server.id) ?? [];
		if (serverTags.length === 0) continue; // a server with no tags: nothing to subscribe
		const conn = connectServer({
			server,
			tags: serverTags,
			onChange: opts.onChange,
			onStatus: (s, d) => opts.onStatus?.(server.id, s, d),
			publishingIntervalMs: opts.publishingIntervalMs,
			samplingIntervalMs: opts.samplingIntervalMs
		});
		conns.push(conn);
		for (const t of serverTags) writeRouter.set(t.id, conn.write);
	}

	return {
		write: (id, value) => {
			const w = writeRouter.get(id);
			return w ? w(id, value) : Promise.reject(new Error(`unknown tag: ${id}`));
		},
		stop: async () => {
			await Promise.all(conns.map((c) => c.stop()));
		}
	};
}

function toUpdate(tag: TagDef, dv: DataValue): TagUpdate {
	return {
		id: tag.id,
		value: dv.value?.value,
		quality: dv.statusCode?.name ?? 'Unknown',
		ts: (dv.sourceTimestamp ?? dv.serverTimestamp ?? new Date()).toISOString()
	};
}
