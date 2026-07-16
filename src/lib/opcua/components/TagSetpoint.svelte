<script lang="ts">
	// Generic writable-tag control (read-now / write-later). Shows the current value and writes a
	// new one through the WebSocket. Usage: <TagSetpoint tag="machine1.setpoint" />
	import { getLiveGateway } from '../liveStore.svelte.ts';

	let { tag }: { tag: string } = $props();
	const g = getLiveGateway();
	const def = $derived(g.catalog.get(tag));
	const live = $derived(g.values.get(tag));

	let input = $state('');
	let busy = $state(false);
	let result = $state('');

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const v = Number(input);
		if (input === '' || Number.isNaN(v)) {
			result = 'enter a number';
			return;
		}
		busy = true;
		result = '';
		const r = await g.write(tag, v);
		busy = false;
		result = r.ok ? '✓ written' : `✗ ${r.status}`;
		if (r.ok) input = '';
	}
</script>

<form class="sp" onsubmit={submit}>
	<span class="label">{def?.label ?? tag}</span>
	<div class="row">
		<span class="cur">{live?.value ?? '—'}{def?.unit ?? ''}</span>
		<input type="number" step="any" placeholder="new…" bind:value={input} disabled={busy} />
		<button type="submit" disabled={busy || !g.socketOpen}>Set</button>
	</div>
	{#if result}<span class="res">{result}</span>{/if}
</form>

<style>
	.sp {
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
		gap: 0.4rem;
	}
	.cur {
		min-width: 3.5rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	input {
		width: 5rem;
		padding: 0.2rem 0.35rem;
		border: 1px solid var(--wx-border-color, #ccc);
		border-radius: 4px;
		background: var(--wx-background, #fff);
		color: var(--wx-color-font, #222);
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
</style>
