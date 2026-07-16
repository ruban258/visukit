<script lang="ts">
	// Generic trend chart for one logged tag. Loads the downsampled history from /api/history
	// (avg line + min/max band) and live-appends new values from the WS store so the line extends
	// in real time. uPlot on canvas — fast with many points. Usage: <TagChart tag="machine1.temp" />
	import { onMount } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { getLiveGateway } from '../liveStore.svelte.ts';

	let { tag, rangeMs = 3_600_000 }: { tag: string; rangeMs?: number } = $props();
	const g = getLiveGateway();
	const def = $derived(g.catalog.get(tag));

	let host: HTMLDivElement;
	let chart: uPlot | null = null;
	// Chart columns: [time(s), avg, min, max]. Plain lets — we drive uPlot imperatively.
	let xs: number[] = [];
	let avg: (number | null)[] = [];
	let lo: (number | null)[] = [];
	let hi: (number | null)[] = [];
	let lastAppend = 0;
	let mounted = $state(false);
	let err = $state('');

	const HEIGHT = 160;

	function cssVar(name: string, fallback: string): string {
		const v = getComputedStyle(host).getPropertyValue(name).trim();
		return v || fallback;
	}
	function withAlpha(color: string, a: number): string {
		const m = /^([0-9a-f]{6})$/i.exec(color.replace('#', ''));
		if (m) {
			const n = parseInt(m[1], 16);
			return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
		}
		return `rgba(80, 120, 220, ${a})`;
	}
	function fmt(v: number | null): string {
		if (v == null) return '—';
		const d = def?.decimals;
		return d != null ? v.toFixed(d) : String(v);
	}

	function opts(width: number): uPlot.Options {
		const accent = cssVar('--wx-color-primary', '#3b82f6');
		const gridc = cssVar('--wx-border-color', '#e6e6e6');
		const ink = cssVar('--wx-color-font-alt', '#8a8a8a');
		return {
			width,
			height: HEIGHT,
			scales: { x: { time: true } },
			legend: { show: true },
			cursor: { points: { size: 6 } },
			axes: [
				{ stroke: ink, grid: { stroke: gridc, width: 1 }, ticks: { stroke: gridc, width: 1 } },
				{ stroke: ink, grid: { stroke: gridc, width: 1 }, ticks: { stroke: gridc, width: 1 }, size: 46 }
			],
			series: [
				{},
				{ label: def?.label ?? tag, stroke: accent, width: 2, value: (_u, v) => fmt(v as number | null) },
				{ label: 'min', stroke: 'transparent', points: { show: false }, value: (_u, v) => fmt(v as number | null) },
				{ label: 'max', stroke: 'transparent', points: { show: false }, value: (_u, v) => fmt(v as number | null) }
			],
			// Fill the band between max (series 3) and min (series 2).
			bands: [{ series: [3, 2], fill: withAlpha(accent, 0.15) }]
		};
	}

	async function load() {
		err = '';
		const to = Date.now();
		const from = to - rangeMs;
		const buckets = Math.max(60, Math.min(1000, Math.floor(host?.clientWidth ?? 600)));
		try {
			const res = await fetch(
				`/api/history?tag=${encodeURIComponent(tag)}&from=${from}&to=${to}&buckets=${buckets}`
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				points: { t: number; avg: number; min: number; max: number }[];
			};
			xs = data.points.map((p) => p.t / 1000);
			avg = data.points.map((p) => p.avg);
			lo = data.points.map((p) => p.min);
			hi = data.points.map((p) => p.max);
			chart?.setData([xs, avg, lo, hi]);
		} catch (e) {
			err = (e as Error).message;
		}
	}

	onMount(() => {
		chart = new uPlot(opts(host.clientWidth || 600), [xs, avg, lo, hi], host);
		const ro = new ResizeObserver(() => chart?.setSize({ width: host.clientWidth, height: HEIGHT }));
		ro.observe(host);
		mounted = true;
		return () => {
			ro.disconnect();
			chart?.destroy();
			chart = null;
		};
	});

	// (Re)load history whenever the range changes (and once the chart exists).
	$effect(() => {
		rangeMs;
		if (mounted) load();
	});

	// Live tail: append the latest value (≤ 1/s) so the line extends in real time.
	$effect(() => {
		const u = g.values.get(tag);
		if (!u || !chart) return;
		const t = Date.parse(u.ts);
		if (t - lastAppend < 1000) return;
		const v = typeof u.value === 'number' ? u.value : typeof u.value === 'boolean' ? (u.value ? 1 : 0) : null;
		if (v == null) return;
		lastAppend = t;
		xs.push(t / 1000);
		avg.push(v);
		lo.push(v);
		hi.push(v);
		const cutoff = (Date.now() - rangeMs) / 1000;
		while (xs.length && xs[0] < cutoff) {
			xs.shift();
			avg.shift();
			lo.shift();
			hi.shift();
		}
		chart.setData([xs, avg, lo, hi]);
	});
</script>

<div class="chart" bind:this={host}></div>
{#if err}<div class="err">history unavailable: {err}</div>{/if}

<style>
	.chart {
		width: 100%;
	}
	.err {
		font-size: 0.75rem;
		color: var(--wx-color-font-alt, #999);
		padding: 0.25rem 0;
	}
	/* Recessive uPlot chrome to match the Willow surface. */
	.chart :global(.u-legend) {
		font-size: 0.75rem;
	}
	.chart :global(.u-legend .u-marker) {
		display: none;
	}
</style>
