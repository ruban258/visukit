<script lang="ts">
	// Generic boolean indicator for any tag. Usage: <TagLED tag="machine1.running" />
	import { getLiveGateway } from '../liveStore.svelte.ts';

	let { tag }: { tag: string } = $props();
	const g = getLiveGateway();
	const def = $derived(g.catalog.get(tag));
	const live = $derived(g.values.get(tag));
	const on = $derived(Boolean(live?.value));
	const good = $derived(live?.quality === 'Good');
</script>

<div class="led" class:stale={!good}>
	<span class="dot" class:on></span>
	<span class="label">{def?.label ?? tag}</span>
</div>

<style>
	.led {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.dot {
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 50%;
		background: var(--wx-background-alt, #d0d0d0);
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
	}
	.dot.on {
		background: var(--wx-color-success, #2f9e6f);
		box-shadow: 0 0 7px var(--wx-color-success, #2f9e6f);
	}
	.label {
		font-size: 0.95rem;
	}
	.stale {
		opacity: 0.45;
	}
</style>
