<script lang="ts">
	// Generic command button for a writable boolean tag: click writes `true` (turn on). The LED
	// mirrors the live value read back from the PLC, so it only lights once the PLC confirms.
	// Usage: <TagButton tag="plcsim.command_start" />
	import { getLiveGateway } from '../liveStore.svelte.ts';

	let { tag }: { tag: string } = $props();
	const g = getLiveGateway();
	const def = $derived(g.catalog.get(tag));
	const live = $derived(g.values.get(tag));
	const on = $derived(Boolean(live?.value));
	const good = $derived(live?.quality === 'Good');

	let busy = $state(false);
	let result = $state('');

	async function turnOn() {
		busy = true;
		result = '';
		const r = await g.write(tag, true);
		busy = false;
		result = r.ok ? '' : `✗ ${r.status}`;
	}
</script>

<div class="cmd" class:stale={!good}>
	<span class="label">{def?.label ?? tag}</span>
	<div class="row">
		<span class="dot" class:on></span>
		<button onclick={turnOn} disabled={busy || !g.socketOpen}>Turn on</button>
	</div>
	{#if result}<span class="res">{result}</span>{/if}
</div>

<style>
	.cmd {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.label {
		font-size: 0.8rem;
		color: var(--wx-color-font-alt, #888);
	}
	.row {
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
	button {
		padding: 0.2rem 0.7rem;
		border: 0;
		border-radius: 4px;
		background: var(--wx-color-primary, #3498db);
		color: #fff;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.res {
		font-size: 0.8rem;
		color: var(--wx-color-font-alt, #888);
	}
	.stale {
		opacity: 0.45;
	}
</style>
