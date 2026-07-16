<script lang="ts">
	// Generic radial gauge for any numeric tag with min/max. Usage: <TagGauge tag="machine1.temp" />
	// A 270° arc drawn with stroke-dasharray on two circles (robust, no path math): a full-span
	// track plus a value arc scaled to (value-min)/(max-min).
	import { getLiveGateway } from '../liveStore.svelte.ts';

	let { tag }: { tag: string } = $props();
	const g = getLiveGateway();
	const def = $derived(g.catalog.get(tag));
	const live = $derived(g.values.get(tag));
	const good = $derived(live?.quality === 'Good');

	const R = 40;
	const C = 2 * Math.PI * R;
	const SPAN = 0.75; // 270° of the circle
	const track = `${SPAN * C} ${C}`;

	const num = $derived(typeof live?.value === 'number' ? (live.value as number) : null);
	const min = $derived(def?.min ?? 0);
	const max = $derived(def?.max ?? 100);
	const frac = $derived(
		num == null || max <= min ? 0 : Math.max(0, Math.min(1, (num - min) / (max - min)))
	);
	const dash = $derived(`${frac * SPAN * C} ${C}`);

	function fmt(v: number | null, d?: number): string {
		if (v == null) return '—';
		return d != null ? v.toFixed(d) : String(v);
	}
</script>

<div class="gauge" class:stale={!good}>
	<svg viewBox="0 0 100 100" role="img" aria-label={def?.label ?? tag}>
		<g transform="rotate(135 50 50)">
			<circle class="track" cx="50" cy="50" r={R} fill="none" stroke-dasharray={track} />
			<circle
				class="value"
				cx="50"
				cy="50"
				r={R}
				fill="none"
				stroke-dasharray={dash}
				stroke-linecap="round"
			/>
		</g>
		<text class="num" x="50" y="50" text-anchor="middle" dominant-baseline="middle">
			{fmt(num, def?.decimals)}
		</text>
		{#if def?.unit}
			<text class="unit" x="50" y="66" text-anchor="middle">{def.unit}</text>
		{/if}
	</svg>
	<div class="label">{def?.label ?? tag}</div>
</div>

<style>
	.gauge {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 120px;
	}
	svg {
		width: 100%;
		height: auto;
	}
	.track {
		stroke: var(--wx-background-alt, #e6e6e6);
		stroke-width: 8;
	}
	.value {
		stroke: var(--wx-color-primary, #3498db);
		stroke-width: 8;
		transition: stroke-dasharray 0.3s ease;
	}
	.num {
		font-size: 20px;
		font-weight: 600;
		fill: var(--wx-color-font, #222);
		font-variant-numeric: tabular-nums;
	}
	.unit {
		font-size: 9px;
		fill: var(--wx-color-font-alt, #888);
	}
	.label {
		margin-top: 0.1rem;
		font-size: 0.85rem;
		color: var(--wx-color-font-alt, #666);
	}
	.stale .value {
		opacity: 0.35;
	}
	.stale .num {
		opacity: 0.5;
	}
</style>
