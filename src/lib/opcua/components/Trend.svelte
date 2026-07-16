<script lang="ts">
	// Multi-pen trend — a WinCC-Unified-style trend control. Define several tags ("pens") and they
	// share ONE time axis; Y axes are grouped automatically by unit (all °C pens share one axis, all
	// % pens another, …). Each pen is one avg line (the single-tag min/max band lives in TagChart).
	//
	//   <Trend tags={['machine1.temp', 'machine1.humidity', 'machine1.fanspeed']} rangeMs={3_600_000} />
	//
	// History (for `log` tags) is loaded from /api/history?tags=… on ONE aligned time grid; live data
	// is a *synchronized cyclic sample* — a ~1s timer reads every pen's current value into one aligned
	// row [now, v1, v2, …] (WinCC cyclic acquisition), NOT a per-tag append. A non-`log` pen has no
	// scrollback (live-only). Pen identity is never colour-alone: the legend below is a direct-labelled
	// pen table (swatch + label + unit + live cursor value), satisfying the palette's relief rule.
	import { onMount } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { getLiveGateway } from '../liveStore.svelte.ts';
	import type { TagDef } from '../types.ts';

	let { tags, rangeMs = 3_600_000 }: { tags: string[]; rangeMs?: number } = $props();
	const g = getLiveGateway();

	// Categorical pen palette (validated CVD-safe; see dataviz skill). CSS vars carry the light/dark
	// steps; we resolve the active value at chart-build time. Fallbacks mirror --pen-* below.
	const PEN_VARS = ['--pen-1', '--pen-2', '--pen-3', '--pen-4', '--pen-5', '--pen-6', '--pen-7', '--pen-8'];
	const PEN_FALLBACK = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];

	type Pen = { id: string; def: TagDef; unit: string; color: string; colorVar: string; slot: number };

	// Pens = the configured tags that are present in the live catalog, in order. Colour slot is by
	// position (fixed order, never cycled beyond 8 — extras fold onto the palette but v1 expects ≤8).
	const pens = $derived.by<Pen[]>(() => {
		const out: Pen[] = [];
		let i = 0;
		for (const id of tags) {
			const def = g.catalog.get(id);
			if (!def) continue;
			out.push({
				id,
				def,
				unit: def.unit ?? '',
				color: PEN_FALLBACK[i % PEN_FALLBACK.length],
				colorVar: PEN_VARS[i % PEN_VARS.length],
				slot: i
			});
			i++;
		}
		return out;
	});
	// Pens with no historian scrollback (not `log`) — surfaced as a footnote.
	const liveOnly = $derived(pens.filter((p) => !p.def.log));
	// Structural signature: rebuild the chart when the pen set OR their units change (new axis layout).
	const signature = $derived(pens.map((p) => `${p.id}:${p.unit}`).join('|'));

	let host: HTMLDivElement;
	let chart: uPlot | null = null;
	// Data columns: cols[0] = x (seconds), cols[k+1] = pen k's values. Driven imperatively.
	let cols: (number | null)[][] = [[]];
	let mounted = $state(false);
	let err = $state('');
	let loading = $state(false);

	const HEIGHT = 360;
	const scaleKey = (unit: string) => `y_${unit || 'none'}`;

	function cssVar(name: string, fallback: string): string {
		const v = getComputedStyle(host).getPropertyValue(name).trim();
		return v || fallback;
	}
	function fmt(def: TagDef | undefined, v: number | null): string {
		if (v == null) return '—';
		const d = def?.decimals;
		const s = d != null ? v.toFixed(d) : String(Math.round(v * 100) / 100);
		return def?.unit ? `${s} ${def.unit}` : s;
	}

	function buildOpts(width: number): uPlot.Options {
		const gridc = cssVar('--wx-border-color', '#e6e6e6');
		const ink = cssVar('--wx-color-font-alt', '#8a8a8a');

		// Distinct units in first-appearance order → one scale + one axis each, sides alternating.
		const unitOrder: string[] = [];
		const penCountByUnit = new Map<string, number>();
		for (const p of pens) {
			if (!unitOrder.includes(p.unit)) unitOrder.push(p.unit);
			penCountByUnit.set(p.unit, (penCountByUnit.get(p.unit) ?? 0) + 1);
		}

		const scales: uPlot.Scales = { x: { time: true } };
		for (const u of unitOrder) scales[scaleKey(u)] = { auto: true };

		const xAxis: uPlot.Axis = {
			stroke: ink,
			grid: { stroke: gridc, width: 1 },
			ticks: { stroke: gridc, width: 1 }
		};
		const yAxes: uPlot.Axis[] = unitOrder.map((u, idx) => {
			// Axis colour === the pen's colour when it's the sole pen on this axis, else neutral ink.
			const solePen = penCountByUnit.get(u) === 1 ? pens.find((p) => p.unit === u) : undefined;
			const axisColor = solePen ? cssVar(solePen.colorVar, solePen.color) : ink;
			return {
				scale: scaleKey(u),
				side: idx % 2 === 0 ? 3 : 1, // 3 = left, 1 = right — alternate as axes are added
				label: u || 'value',
				labelSize: 14,
				stroke: axisColor,
				size: 52,
				grid: { show: idx === 0, stroke: gridc, width: 1 }, // only the first axis draws the grid
				ticks: { stroke: gridc, width: 1 }
			};
		});

		const series: uPlot.Series[] = [{}];
		for (const p of pens) {
			series.push({
				label: p.unit ? `${p.def.label} (${p.unit})` : p.def.label,
				scale: scaleKey(p.unit),
				stroke: cssVar(p.colorVar, p.color),
				width: 2,
				points: { show: false },
				value: (_u, v) => fmt(p.def, v as number | null)
			});
		}

		return {
			width,
			height: HEIGHT,
			scales,
			legend: { show: true, live: true },
			cursor: { points: { size: 6 }, focus: { prox: 24 } },
			axes: [xAxis, ...yAxes],
			series
		};
	}

	function rebuild() {
		if (!host) return;
		chart?.destroy();
		cols = [[], ...pens.map(() => [])];
		chart = new uPlot(buildOpts(host.clientWidth || 700), cols as uPlot.AlignedData, host);
		load();
	}

	async function load() {
		if (!chart) return;
		err = '';
		const logged = pens.filter((p) => p.def.log);
		// Nothing to backfill (all pens live-only) — start empty; live sampling fills forward.
		if (logged.length === 0) {
			cols = [[], ...pens.map(() => [])];
			chart.setData(cols as uPlot.AlignedData);
			return;
		}
		loading = true;
		const to = Date.now();
		const from = to - rangeMs;
		const buckets = Math.max(60, Math.min(1000, Math.floor(host?.clientWidth ?? 700)));
		try {
			const qs = logged.map((p) => p.id).join(',');
			const res = await fetch(
				`/api/history?tags=${encodeURIComponent(qs)}&from=${from}&to=${to}&buckets=${buckets}`
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { t: number[]; series: Record<string, (number | null)[]> };
			const xs = data.t.map((ms) => ms / 1000);
			cols = [xs, ...pens.map((p) => (p.def.log ? (data.series[p.id] ?? xs.map(() => null)) : xs.map(() => null)))];
			chart.setData(cols as uPlot.AlignedData);
		} catch (e) {
			err = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	// Synchronized cyclic sample: one aligned row across ALL pens (WinCC cyclic acquisition).
	function sample() {
		if (!chart || pens.length === 0 || cols.length !== pens.length + 1) return;
		cols[0].push(Date.now() / 1000);
		pens.forEach((p, k) => {
			const u = g.values.get(p.id);
			const v =
				u && typeof u.value === 'number'
					? u.value
					: u && typeof u.value === 'boolean'
						? u.value
							? 1
							: 0
						: null;
			cols[k + 1].push(v);
		});
		// Trim to the visible window.
		const cutoff = (Date.now() - rangeMs) / 1000;
		while (cols[0].length && (cols[0][0] as number) < cutoff) for (const c of cols) c.shift();
		chart.setData(cols as uPlot.AlignedData);
	}

	onMount(() => {
		mounted = true;
		const ro = new ResizeObserver(() => chart?.setSize({ width: host.clientWidth, height: HEIGHT }));
		ro.observe(host);
		const timer = setInterval(sample, 1000);
		return () => {
			ro.disconnect();
			clearInterval(timer);
			chart?.destroy();
			chart = null;
		};
	});

	// Rebuild the chart (new axes/series) when the pen set or units change.
	$effect(() => {
		signature;
		if (mounted) rebuild();
	});

	// Reload history when the range changes (chart already exists with the same pens).
	$effect(() => {
		rangeMs;
		if (mounted && chart) load();
	});
</script>

<div class="trend">
	{#if pens.length === 0}
		<p class="empty">Waiting for the gateway catalog… (no pens available yet)</p>
	{/if}
	<div class="plot" bind:this={host} class:loading></div>
	{#if liveOnly.length}
		<p class="note">
			Live-only (no history): {liveOnly.map((p) => p.def.label).join(', ')} — these pens fill
			forward from now; they aren't historized.
		</p>
	{/if}
	{#if err}<p class="err">history unavailable: {err}</p>{/if}
</div>

<style>
	/* Categorical pen palette — validated CVD-safe (dataviz skill). Both modes selected;
	   the dark column is the same eight hues stepped for the dark surface. */
	.trend {
		--pen-1: #2a78d6;
		--pen-2: #1baf7a;
		--pen-3: #eda100;
		--pen-4: #008300;
		--pen-5: #4a3aa7;
		--pen-6: #e34948;
		--pen-7: #e87ba4;
		--pen-8: #eb6834;
	}
	@media (prefers-color-scheme: dark) {
		.trend {
			--pen-1: #3987e5;
			--pen-2: #199e70;
			--pen-3: #c98500;
			--pen-4: #008300;
			--pen-5: #9085e9;
			--pen-6: #e66767;
			--pen-7: #d55181;
			--pen-8: #d95926;
		}
	}
	.plot {
		width: 100%;
		min-height: 360px;
	}
	.plot.loading {
		opacity: 0.6;
	}
	.empty {
		color: var(--wx-color-font-alt, #999);
	}
	.note {
		font-size: 0.75rem;
		color: var(--wx-color-font-alt, #999);
		margin: 0.4rem 0 0;
	}
	.err {
		font-size: 0.78rem;
		color: var(--wx-color-danger, #d03b3b);
		margin: 0.4rem 0 0;
	}
	/* uPlot legend styled as a vertical pen table: swatch + label + live cursor value; the marker
	   is the pen swatch, clicking a row toggles that pen's visibility (uPlot default). */
	.plot :global(.u-legend) {
		font-size: 0.8rem;
		text-align: left;
		margin-top: 0.6rem;
	}
	.plot :global(.u-legend .u-series) {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.1rem 0;
		cursor: pointer;
	}
	.plot :global(.u-legend .u-marker) {
		width: 12px;
		height: 12px;
		border-radius: 2px;
	}
	.plot :global(.u-legend .u-value) {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		color: var(--wx-color-font, #222);
	}
</style>
