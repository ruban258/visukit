// Connectivity probe. Connects to an OPC UA server, walks the address space, and prints every
// variable's NodeId + datatype + current value. Use it against the dev sim first, and against a
// real S7-1500 / PLCSIM endpoint later — it's endpoint-agnostic. Handy for discovering the exact
// NodeId strings to put in config/tags.json.
//
// Run:   npm run probe -- [endpoint]
// Env:   OPCUA_ENDPOINT   (default opc.tcp://localhost:4840/UA/VisuKitSim)
//        OPCUA_USER / OPCUA_PASS   (optional; omit for anonymous)
// Security is None here for first bring-up.
import {
	OPCUAClient,
	AttributeIds,
	NodeClass,
	DataType,
	MessageSecurityMode,
	SecurityPolicy
} from 'node-opcua';

const ENDPOINT =
	process.argv[2] ?? process.env.OPCUA_ENDPOINT ?? 'opc.tcp://localhost:4840/UA/VisuKitSim';
const USER = process.env.OPCUA_USER;
const PASS = process.env.OPCUA_PASS;

const client = OPCUAClient.create({
	applicationName: 'visukit-probe',
	securityMode: MessageSecurityMode.None,
	securityPolicy: SecurityPolicy.None,
	endpointMustExist: false,
	connectionStrategy: { maxRetry: 2, initialDelay: 500, maxDelay: 2000 }
});

type VarRow = { nodeId: string; browse: string; dataType: string; value: unknown };

async function main() {
	console.log(`connecting → ${ENDPOINT}`);
	await client.connect(ENDPOINT);

	const userIdentity = USER && PASS ? { userName: USER, password: PASS } : undefined; // undefined = anonymous
	const session = await client.createSession(userIdentity as never);
	console.log('session established.\n');

	// Recursive browse from Objects. Skip the standard ns=0 "Server" subtree (pure noise),
	// and guard against cycles with a visited set + a depth cap.
	const rootObjects = 'ns=0;i=85'; // Objects folder
	const visited = new Set<string>();
	const variables: VarRow[] = [];

	async function walk(nodeId: string, path: string, depth: number) {
		if (depth > 8 || visited.has(nodeId)) return;
		visited.add(nodeId);

		const result = await session.browse(nodeId);
		for (const ref of result.references ?? []) {
			const childId = ref.nodeId.toString();
			const name = ref.browseName.toString();
			const childPath = `${path}/${name}`;

			if (ref.nodeClass === NodeClass.Variable) {
				const dv = await session.read({ nodeId: childId, attributeId: AttributeIds.Value });
				const dt = dv.value?.dataType != null ? DataType[dv.value.dataType] : 'unknown';
				variables.push({
					nodeId: childId,
					browse: childPath.replace(/^\/Objects\//, ''),
					dataType: dt,
					value: dv.value?.value
				});
			} else if (ref.nodeClass === NodeClass.Object) {
				// Don't descend into the server diagnostics tree.
				if (name.endsWith('Server')) continue;
				await walk(childId, childPath, depth + 1);
			}
		}
	}

	await walk(rootObjects, '/Objects', 0);

	console.log(`discovered ${variables.length} variable(s):\n`);
	for (const v of variables) {
		console.log(`  ${v.nodeId}`);
		console.log(`      browse=${v.browse}  type=${v.dataType}  value=${JSON.stringify(v.value)}`);
	}

	await session.close();
	await client.disconnect();
	console.log('\ndisconnected. ✓');
}

main().catch(async (err) => {
	console.error('\nprobe failed:', err.message ?? err);
	try {
		await client.disconnect();
	} catch {
		/* already down */
	}
	process.exit(1);
});
