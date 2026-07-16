// Dev OPC UA server that MIMICS a Siemens S7-1500 address space, so the whole gateway + HMI
// pipeline runs with no PLC and no admin rights. When a real endpoint exists, nothing here is
// needed — the gateway just points at the real opc.tcp URL in config/tags.json.
//
// Faithful to S7 conventions: PLC data sits in a higher namespace (ns=3 here, like Siemens),
// tags use string NodeIds of the form  ns=3;s="MachineDB"."Machine1"."Temperature".
// Some tags are WRITABLE (Setpoint, Start) to exercise the write path.
//
// Run:   npm run sim        (Ctrl+C to stop)
// Env:   SIM_PORT   (default 4840, the S7 default)
// Security is None + anonymous — matches how you'd first bring up PLCSIM for dev.
import { OPCUAServer, DataType, Variant, StatusCodes } from 'node-opcua';

const PORT = Number(process.env.SIM_PORT ?? 4840);

// One clock for the whole sim. Date.now() is fine here — this is a plain Node script.
const t = () => Date.now() / 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

// Writable values live in memory — the write path writes these back.
const setpoints: Record<string, number> = { Machine1: 62, Machine2: 58 };
const started: Record<string, boolean> = { Machine1: false, Machine2: false };

const server = new OPCUAServer({
	port: PORT,
	resourcePath: '/UA/VisuKitSim',
	buildInfo: { productName: 'VisuKit-Sim-S7-1500', buildNumber: '1', buildDate: new Date() }
});

async function main() {
	await server.initialize();

	const addressSpace = server.engine.addressSpace!;
	// Pad the namespace table so our PLC data lands at ns=3, like a real S7-1500.
	addressSpace.registerNamespace('urn:visukit:sim:_filler'); // ns=2
	const ns = addressSpace.registerNamespace('urn:visukit:sim:s7'); // ns=3
	const objects = addressSpace.rootFolder.objects;

	// "DataBlock" root, mirroring an S7 optimized DB exposed to OPC UA.
	const db = ns.addObject({
		organizedBy: objects,
		nodeId: `ns=${ns.index};s="MachineDB"`,
		browseName: 'MachineDB'
	});

	// Each simulated machine gets a small process model with a slow phase cycle.
	const addMachine = (machine: string, baseTemp: number, phaseOffset: number) => {
		const folder = ns.addObject({
			componentOf: db,
			nodeId: `ns=${ns.index};s="MachineDB"."${machine}"`,
			browseName: machine
		});
		const sid = (leaf: string) => `ns=${ns.index};s="MachineDB"."${machine}"."${leaf}"`;

		// Phase cycles 0..6 slowly (0 = stopped). Running while a phase is active OR when started
		// manually via the writable Start tag.
		const phase = () => Math.floor(((t() + phaseOffset) / 20) % 7);
		const running = () => started[machine] || phase() !== 0;

		const analog = (leaf: string, compute: () => number) =>
			ns.addVariable({
				componentOf: folder,
				nodeId: sid(leaf),
				browseName: leaf,
				dataType: 'Double',
				minimumSamplingInterval: 200,
				value: { get: () => new Variant({ dataType: DataType.Double, value: round1(compute()) }) }
			});

		analog('Temperature', () => baseTemp + 5 * Math.sin(t() / 30));
		analog('Humidity', () => 45 + 10 * Math.sin(t() / 50 + phaseOffset));
		analog('FanSpeed', () => (running() ? 1450 + 40 * Math.sin(t() / 8) : 0));

		ns.addVariable({
			componentOf: folder,
			nodeId: sid('Phase'),
			browseName: 'Phase',
			dataType: 'Int32',
			minimumSamplingInterval: 200,
			value: { get: () => new Variant({ dataType: DataType.Int32, value: phase() }) }
		});

		ns.addVariable({
			componentOf: folder,
			nodeId: sid('Running'),
			browseName: 'Running',
			dataType: 'Boolean',
			minimumSamplingInterval: 200,
			value: { get: () => new Variant({ dataType: DataType.Boolean, value: running() }) }
		});

		// WRITABLE — a numeric setpoint (exercises TagSetpoint).
		ns.addVariable({
			componentOf: folder,
			nodeId: sid('Setpoint'),
			browseName: 'Setpoint',
			dataType: 'Double',
			minimumSamplingInterval: 200,
			value: {
				get: () => new Variant({ dataType: DataType.Double, value: setpoints[machine] }),
				set: (variant: Variant) => {
					setpoints[machine] = variant.value as number;
					console.log(`  ← write: ${machine}.Setpoint = ${setpoints[machine]}`);
					return StatusCodes.Good;
				}
			}
		});

		// WRITABLE — a boolean command (exercises TagButton).
		ns.addVariable({
			componentOf: folder,
			nodeId: sid('Start'),
			browseName: 'Start',
			dataType: 'Boolean',
			minimumSamplingInterval: 200,
			value: {
				get: () => new Variant({ dataType: DataType.Boolean, value: started[machine] }),
				set: (variant: Variant) => {
					started[machine] = variant.value as boolean;
					console.log(`  ← write: ${machine}.Start = ${started[machine]}`);
					return StatusCodes.Good;
				}
			}
		});
	};

	addMachine('Machine1', 62, 0);
	addMachine('Machine2', 58, 7);

	await server.start();
	const endpoint = server.getEndpointUrl();
	console.log('VisuKit sim S7-1500 OPC UA server started.');
	console.log(`  endpoint: ${endpoint}`);
	console.log('  security: None + anonymous');
	console.log(
		'  tags:     ns=3;s="MachineDB"."Machine1|Machine2"."Temperature|Humidity|FanSpeed|Phase|Running|Setpoint|Start"'
	);
	console.log('  Ctrl+C to stop.');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, async () => {
		console.log(`\n${sig} — shutting down sim server…`);
		await server.shutdown();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error('sim server failed to start:', err);
	process.exit(1);
});
