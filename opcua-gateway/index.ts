// VisuKit OPC UA gateway — the long-running SINGLETON that connects to the OPC UA server(s)
// defined in config/tags.json (one session per server), subscribes to their tags, keeps an
// in-memory snapshot, streams it over WebSocket, and persists flagged tags to a SQLite historian.
// Machine-agnostic: it streams whatever the config defines. Run exactly one instance (it owns
// the WS port and the historian file); clean shutdown on SIGINT/SIGTERM.
//
// Run:   npm run gateway
// Env:   TAGS_CONFIG         (path to config; default config/tags.json — defines servers + tags)
//        OPCUA_ENDPOINT      (override the endpoint ONLY when config has a single server)
//        OPCUA_USER / OPCUA_PASS   (single-server override; omit for anonymous)
//        OPCUA_SECURITY      (single-server override: None | Sign | SignAndEncrypt)
//        OPCUA_SECURITY_POLICY (single-server override: Basic256Sha256 | Aes128_Sha256_RsaOaep | Aes256_Sha256_RsaPss)
//        OPCUA_PKI_ROOT      (certificate store; default data/pki)
//        OPCUA_STRICT_CERTS  (=1: reject unknown SERVER certs instead of trust-on-first-use)
//        GATEWAY_WS_PORT     (WebSocket port for HMI clients, default 4900)
//        HISTORIAN_DB        (SQLite file path; default data/historian.sqlite)
//        GATEWAY_PRINT_MS    (console snapshot interval, default 1000)
import {
	startGateway,
	ensureClientCertificate,
	type ConnStatus
} from '../src/lib/server/opcua/client.ts';
import { startWsServer } from '../src/lib/server/opcua/wsServer.ts';
import { openHistorian } from '../src/lib/server/opcua/historian.ts';
import {
	loadConfig,
	tagsByGroup,
	SECURITY_MODES,
	SECURITY_POLICIES,
	type SecurityMode,
	type SecurityPolicyName
} from '../src/lib/server/opcua/tags.ts';
import type { TagUpdate } from '../src/lib/opcua/types.ts';

const WS_PORT = Number(process.env.GATEWAY_WS_PORT ?? 4900);
const PRINT_MS = Number(process.env.GATEWAY_PRINT_MS ?? 1000);
const stamp = () => new Date().toISOString().slice(11, 19);

// Latest value per tag id — the in-memory snapshot (Phase 3 streams this; Phase 4 persists it).
const snapshot = new Map<string, TagUpdate>();

function printSnapshot() {
	if (snapshot.size === 0) return;
	const lines: string[] = [];
	for (const [group, tags] of tagsByGroup()) {
		const cells = tags.map((t) => {
			const v = snapshot.get(t.id)?.value;
			return `${t.label}=${v}${t.unit ?? ''}`;
		});
		lines.push(`  ${group || '(ungrouped)'}: ${cells.join('  ')}`);
	}
	console.log(`[${stamp()}] live:\n${lines.join('\n')}`);
}

async function main() {
	const { servers, tags: catalog } = loadConfig();

	// Convenience for the common single-server case: OPCUA_ENDPOINT/USER/PASS/SECURITY override
	// it, so you can point at a real PLC without editing config. Ignored with multiple servers.
	if (servers.length === 1 && process.env.OPCUA_ENDPOINT) {
		servers[0].endpoint = process.env.OPCUA_ENDPOINT;
		servers[0].user = process.env.OPCUA_USER ?? servers[0].user;
		servers[0].pass = process.env.OPCUA_PASS ?? servers[0].pass;
	}
	if (servers.length === 1 && process.env.OPCUA_SECURITY) {
		const mode = process.env.OPCUA_SECURITY;
		if (!SECURITY_MODES.includes(mode as SecurityMode))
			throw new Error(`OPCUA_SECURITY must be one of ${SECURITY_MODES.join(', ')}`);
		servers[0].security = mode as SecurityMode;
	}
	if (servers.length === 1 && process.env.OPCUA_SECURITY_POLICY) {
		const policy = process.env.OPCUA_SECURITY_POLICY;
		if (!SECURITY_POLICIES.includes(policy as SecurityPolicyName))
			throw new Error(`OPCUA_SECURITY_POLICY must be one of ${SECURITY_POLICIES.join(', ')}`);
		servers[0].securityPolicy = policy as SecurityPolicyName;
	}

	console.log(
		`VisuKit OPC UA gateway starting — ${servers.length} server(s), tags=${catalog.length}, ws=:${WS_PORT}. Ctrl+C to stop.`
	);
	for (const s of servers) {
		const sec = s.security === 'None' ? 'None' : `${s.security} / ${s.securityPolicy}`;
		console.log(`  server "${s.id}" → ${s.endpoint}  [security: ${sec}]`);
	}

	// With security on, both sides must trust each other's certificate. Ours is created here
	// (first run) and its path printed — import it into the server's trust list (TIA Portal:
	// OPC UA > Security > trusted clients; or enable auto-accept for bring-up). The SERVER's
	// cert is trusted on first use unless OPCUA_STRICT_CERTS=1 (then: move it from
	// pki/rejected to pki/trusted/certs).
	if (servers.some((s) => s.security !== 'None')) {
		const certPath = await ensureClientCertificate();
		const strict = process.env.OPCUA_STRICT_CERTS === '1';
		console.log(`  client certificate: ${certPath}`);
		console.log(`    → the PLC/server must trust this file (TIA Portal: add as trusted client)`);
		console.log(
			`    → unknown server certs: ${strict ? 'REJECTED (strict) — trust them via data/pki' : 'trusted on first use'}`
		);
	}

	// The write path isn't ready until the OPC UA session is up; the WS server holds this ref and
	// calls through it, so it exists before startGateway wires the real conn.write below.
	let write: (id: string, value: number | boolean) => Promise<string> = async () => {
		throw new Error('gateway not connected yet');
	};

	const hub = startWsServer({
		port: WS_PORT,
		catalog,
		write: (id, v) => write(id, v),
		onLog: (m) => console.log(`[${stamp()}] ws: ${m}`)
	});

	// Only tags flagged `log` in config/tags.json are historized.
	const logTagIds = new Set(catalog.filter((t) => t.log).map((t) => t.id));
	const historian = openHistorian({
		logTagIds,
		onLog: (m) => console.log(`[${stamp()}] historian: ${m}`)
	});

	const onStatus = (server: string, s: ConnStatus, detail?: string) => {
		console.log(`[${stamp()}] [${server}] connection: ${s}${detail ? ` (${detail})` : ''}`);
		hub.onStatus(server, s, detail);
	};

	const onChange = (u: TagUpdate) => {
		snapshot.set(u.id, u);
		// Surface any non-Good quality immediately; values themselves print on the interval.
		if (u.quality !== 'Good') console.log(`[${stamp()}] ${u.id} quality=${u.quality}`);
		hub.onChange(u);
		historian.record(u);
	};

	const conn = await startGateway({ servers, tags: catalog, onChange, onStatus });
	write = conn.write;

	const printer = setInterval(printSnapshot, PRINT_MS);

	const shutdown = async (sig: string) => {
		console.log(`\n${sig} received — stopping gateway…`);
		clearInterval(printer);
		historian.stop(); // flushes the buffer before closing
		await hub.stop();
		await conn.stop();
		console.log('gateway stopped.');
		process.exit(0);
	};
	for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(sig));
}

main().catch((err) => {
	console.error('gateway failed:', err);
	process.exit(1);
});
