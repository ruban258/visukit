<script lang="ts">
	// Generic numeric/text readout for any tag. Usage: <TagValue tag="machine1.phase" />
	import { getLiveGateway } from '../liveStore.svelte.ts';

	let { tag }: { tag: string } = $props();
	const g = getLiveGateway();
	const def = $derived(g.catalog.get(tag));
	const live = $derived(g.values.get(tag));
	const good = $derived(live?.quality === 'Good');

	function fmt(v: unknown, decimals?: number): string {
		if (typeof v === 'number') return decimals != null ? v.toFixed(decimals) : String(v);
		if (typeof v === 'boolean') return v ? 'On' : 'Off';
		return v == null ? '—' : String(v);
	}
</script>

<div class="tv" class:stale={!good}>
	<span class="label">{def?.label ?? tag}</span>
	<span class="val"
		>{fmt(live?.value, def?.decimals)}{#if def?.unit}<span class="unit">{def.unit}</span>{/if}</span
	>
</div>

<style>
	.tv {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.label {
		font-size: 0.8rem;
		color: var(--wx-color-font-alt, #888);
	}
	.val {
		font-size: 1.3rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.unit {
		font-size: 0.85rem;
		font-weight: 400;
		color: var(--wx-color-font-alt, #888);
		margin-left: 0.15rem;
	}
	.stale .val {
		opacity: 0.45;
	}
</style>
