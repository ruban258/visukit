<script lang="ts">
	// Dedicated multi-pen trend page. Owns its own LiveGateway (there is no /hmi/+layout that shares
	// context), then renders one Trend control over a default pen set with a shared range picker.
	// v1: pens are auto-derived from the tag catalog (auto axes by unit); a runtime pen picker,
	// saved views, and drag-zoom are deferred (see HANDOFF).
	import { onMount, onDestroy } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { LiveGateway, setLiveGateway } from '$lib/opcua/liveStore.svelte.ts';
	import type { TagDef } from '$lib/opcua/types.ts';
	import Trend from '$lib/opcua/components/Trend.svelte';

	const g = new LiveGateway(env.PUBLIC_GATEWAY_WS || undefined);
	setLiveGateway(g);
	onMount(() => g.connect());
	onDestroy(() => g.close());

	// Preferred default pens (exercise shared + solo axes + a live-only pen); fall back to the first
	// group's numeric tags if this config doesn't have them.
	const PREFERRED = ['machine1.temp', 'machine1.setpoint', 'machine1.humidity', 'machine1.fanspeed'];
	const isNumeric = (t: TagDef) => t.dataType === 'Double' || t.dataType === 'Float' || t.dataType === 'Int32';

	const pens = $derived.by(() => {
		const present = PREFERRED.filter((id) => g.catalog.has(id));
		if (present.length) return present;
		// Fallback: the first group's numeric tags (up to 6).
		const first = [...g.catalog.values()].find((t) => t.group)?.group;
		return [...g.catalog.values()]
			.filter((t) => t.group === first && isNumeric(t))
			.slice(0, 6)
			.map((t) => t.id);
	});

	const RANGES = [
		{ label: '15m', ms: 900_000 },
		{ label: '1h', ms: 3_600_000 },
		{ label: '6h', ms: 21_600_000 },
		{ label: '24h', ms: 86_400_000 }
	];
	let rangeMs = $state(3_600_000);

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

<div class="trends-page">
	<header class="bar">
		<h1>Trends</h1>
		<span class="status" class:ok={g.online}>● {statusText}</span>
		<div class="ranges">
			{#each RANGES as r (r.ms)}
				<button class:active={rangeMs === r.ms} onclick={() => (rangeMs = r.ms)}>{r.label}</button>
			{/each}
		</div>
	</header>

	{#if g.catalog.size === 0}
		<p class="empty">Waiting for the gateway… make sure it's running (WebSocket on :4900).</p>
	{:else if pens.length === 0}
		<p class="empty">No numeric tags to trend.</p>
	{:else}
		<div class="card">
			<Trend tags={pens} {rangeMs} />
		</div>
	{/if}
</div>

<style>
	.trends-page {
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
	.ranges {
		display: flex;
		gap: 0.25rem;
		margin-left: auto;
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
	.empty {
		margin-top: 1.5rem;
		color: var(--wx-color-font-alt, #999);
	}
	.card {
		margin-top: 1rem;
		padding: 1rem 1.1rem 0.8rem;
		border: 1px solid var(--wx-border-color, #eaeaea);
		border-radius: 8px;
		background: var(--wx-background, #fff);
	}
</style>
