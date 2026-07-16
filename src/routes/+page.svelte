<script lang="ts">
	// Live tag-based HMI. Connects to the OPC UA gateway's WebSocket, then renders the tag catalog
	// grouped by `group`, auto-picking a component per tag shape. Entirely driven by config/tags.json
	// via the gateway — this page has no machine-specific knowledge.
	import { onMount, onDestroy } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { LiveGateway, setLiveGateway } from '$lib/opcua/liveStore.svelte.ts';
	import type { TagDef } from '$lib/opcua/types.ts';
	import TagGauge from '$lib/opcua/components/TagGauge.svelte';
	import TagValue from '$lib/opcua/components/TagValue.svelte';
	import TagLED from '$lib/opcua/components/TagLED.svelte';
	import TagSetpoint from '$lib/opcua/components/TagSetpoint.svelte';
	import TagButton from '$lib/opcua/components/TagButton.svelte';
	import TagChart from '$lib/opcua/components/TagChart.svelte';

	// PUBLIC_GATEWAY_WS overrides the WS URL; otherwise the store uses ws://<host>:4900.
	const g = new LiveGateway(env.PUBLIC_GATEWAY_WS || undefined);
	setLiveGateway(g);
	onMount(() => g.connect());
	onDestroy(() => g.close());

	// Group the catalog by TagDef.group for display.
	const groups = $derived.by(() => {
		const m = new Map<string, TagDef[]>();
		for (const t of g.catalog.values()) {
			const key = t.group ?? 'Ungrouped';
			if (!m.has(key)) m.set(key, []);
			m.get(key)!.push(t);
		}
		return [...m.entries()];
	});

	// Choose a component from a tag's shape — the generic dispatch.
	function role(t: TagDef): 'gauge' | 'led' | 'setpoint' | 'button' | 'value' {
		if (t.writable && t.dataType === 'Boolean') return 'button';
		if (t.writable) return 'setpoint';
		if (t.dataType === 'Boolean') return 'led';
		if (typeof t.min === 'number' && typeof t.max === 'number') return 'gauge';
		return 'value';
	}

	// Trends: only tags flagged `log` (they're the ones with historian data).
	const logged = $derived([...g.catalog.values()].filter((t) => t.log));
	const RANGES = [
		{ label: '15m', ms: 900_000 },
		{ label: '1h', ms: 3_600_000 },
		{ label: '6h', ms: 21_600_000 },
		{ label: '24h', ms: 86_400_000 }
	];
	let rangeMs = $state(3_600_000);

	// Per-server link states for the banner detail.
	const serverStates = $derived([...g.statuses.entries()]);
	const healthy = $derived(
		serverStates.filter(([, s]) => s === 'connected' || s === 'reconnected').length
	);
	const statusText = $derived(
		!g.socketOpen
			? 'gateway offline'
			: serverStates.length === 0
				? 'connecting…'
				: healthy === serverStates.length
					? 'live'
					: `${healthy}/${serverStates.length} servers live`
	);
</script>

<div class="hmi">
	<header class="bar">
		<h1>HMI</h1>
		<span class="status" class:ok={g.online}>● {statusText}</span>
	</header>

	{#if serverStates.length}
		<div class="servers">
			{#each serverStates as [server, s] (server)}
				<span class="chip" class:ok={s === 'connected' || s === 'reconnected'}>{server}: {s}</span>
			{/each}
		</div>
	{/if}

	{#if g.catalog.size === 0}
		<p class="empty">Waiting for the gateway… make sure it's running (WebSocket on :4900).</p>
	{:else}
		{#each groups as [group, tags] (group)}
			<section class="group">
				<h2>{group}</h2>
				<div class="tiles">
					{#each tags as t (t.id)}
						<div class="tile">
							{#if role(t) === 'gauge'}
								<TagGauge tag={t.id} />
							{:else if role(t) === 'led'}
								<TagLED tag={t.id} />
							{:else if role(t) === 'setpoint'}
								<TagSetpoint tag={t.id} />
							{:else if role(t) === 'button'}
								<TagButton tag={t.id} />
							{:else}
								<TagValue tag={t.id} />
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/each}

		{#if logged.length}
			<section class="trends">
				<div class="trends-head">
					<h2>Trends</h2>
					<div class="ranges">
						{#each RANGES as r (r.ms)}
							<button class:active={rangeMs === r.ms} onclick={() => (rangeMs = r.ms)}>
								{r.label}
							</button>
						{/each}
					</div>
				</div>
				<div class="charts">
					{#each logged as t (t.id)}
						<div class="chartcard">
							<div class="cap">
								{#if t.group}<span class="grp">{t.group}</span>{/if}
								{t.label}{#if t.unit}<span class="u"> ({t.unit})</span>{/if}
							</div>
							<TagChart tag={t.id} {rangeMs} />
						</div>
					{/each}
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	.hmi {
		padding: 1rem 1.25rem;
	}
	.bar {
		display: flex;
		align-items: baseline;
		gap: 1rem;
	}
	h1 {
		margin: 0;
		font-size: 1.4rem;
	}
	.status {
		font-size: 0.85rem;
		color: var(--wx-color-font-alt, #999);
	}
	.status.ok {
		color: var(--wx-color-success, #2f9e6f);
	}
	.servers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	.chip {
		font-size: 0.72rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--wx-border-color, #ddd);
		color: var(--wx-color-font-alt, #999);
	}
	.chip.ok {
		color: var(--wx-color-success, #2f9e6f);
		border-color: var(--wx-color-success, #2f9e6f);
	}
	.empty {
		margin-top: 1.5rem;
		color: var(--wx-color-font-alt, #999);
	}
	.group {
		margin-top: 1.5rem;
	}
	h2 {
		margin: 0 0 0.6rem;
		font-size: 1rem;
		color: var(--wx-color-font-alt, #666);
		border-bottom: 1px solid var(--wx-border-color, #eaeaea);
		padding-bottom: 0.3rem;
	}
	.tiles {
		display: flex;
		flex-wrap: wrap;
		gap: 1.25rem;
		align-items: flex-start;
	}
	.tile {
		min-width: 120px;
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--wx-border-color, #eaeaea);
		border-radius: 8px;
		background: var(--wx-background, #fff);
	}
	.trends {
		margin-top: 2rem;
	}
	.trends-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--wx-border-color, #eaeaea);
		padding-bottom: 0.3rem;
	}
	.trends-head h2 {
		border: 0;
		margin: 0;
		padding: 0;
	}
	.ranges {
		display: flex;
		gap: 0.25rem;
	}
	.ranges button {
		font-size: 0.78rem;
		padding: 0.15rem 0.6rem;
		border: 1px solid var(--wx-border-color, #ddd);
		border-radius: 999px;
		background: transparent;
		color: var(--wx-color-font-alt, #888);
		cursor: pointer;
	}
	.ranges button.active {
		background: var(--wx-color-primary, #3b82f6);
		border-color: var(--wx-color-primary, #3b82f6);
		color: #fff;
	}
	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
		gap: 1rem;
		margin-top: 0.9rem;
	}
	.chartcard {
		padding: 0.6rem 0.75rem 0.3rem;
		border: 1px solid var(--wx-border-color, #eaeaea);
		border-radius: 8px;
		background: var(--wx-background, #fff);
	}
	.cap {
		font-size: 0.85rem;
		margin-bottom: 0.2rem;
	}
	.cap .grp {
		color: var(--wx-color-font-alt, #999);
	}
	.cap .grp::after {
		content: ' · ';
		color: var(--wx-color-font-alt, #bbb);
	}
	.cap .u {
		color: var(--wx-color-font-alt, #999);
		font-size: 0.8rem;
	}
</style>
