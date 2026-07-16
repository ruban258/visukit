import { json, error } from '@sveltejs/kit';
import { openHistorianReader } from '$lib/server/opcua/historian.ts';

// Downsampled trend series from the gateway's SQLite historian.
// Reads the same SQLite file the gateway writes (WAL → safe concurrent read from this process).
//
// Two shapes:
//   Single tag (legacy — used by TagChart's avg + min/max band):
//     GET /api/history?tag=machine1.temp&from=<ms>&to=<ms>&buckets=300
//       → { tag, from, to, points: [{ t, avg, min, max, n }] }
//   Multi tag (used by the multi-pen Trend — one shared, aligned time grid):
//     GET /api/history?tags=machine1.temp,machine1.humidity&from=<ms>&to=<ms>&buckets=300
//       → { tags, from, to, bucketMs, t: [ms…], series: { <tag>: [avg|null…] } }
//   All pens are bucketed with the SAME bucketMs (span/buckets), and the historian buckets on
//   (ts/bucketMs)*bucketMs, so every pen's bucket timestamps land on one grid — we union those
//   timestamps into a single `t` array and null-fill each pen where it has no sample.
export async function GET({ url }) {
	const single = url.searchParams.get('tag');
	const multi = url.searchParams.get('tags');
	if (!single && !multi) throw error(400, 'tag or tags query parameter is required');

	const to = Number(url.searchParams.get('to') ?? Date.now());
	const from = Number(url.searchParams.get('from') ?? to - 3_600_000); // default: last hour
	const buckets = Number(url.searchParams.get('buckets') ?? 300);
	if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
		throw error(400, 'invalid from/to range');

	try {
		const reader = openHistorianReader();
		try {
			if (multi) {
				const ids = [...new Set(multi.split(',').map((s) => s.trim()).filter(Boolean))];
				const bucketMs = Math.max(1, Math.floor(Math.max(1, to - from) / Math.max(1, buckets)));
				// Query each pen, then union bucket timestamps into one aligned grid.
				const perTag = new Map<string, Map<number, number>>();
				const grid = new Set<number>();
				for (const id of ids) {
					const byT = new Map<number, number>();
					for (const p of reader.series(id, from, to, buckets)) {
						byT.set(p.t, p.avg);
						grid.add(p.t);
					}
					perTag.set(id, byT);
				}
				const t = [...grid].sort((a, b) => a - b);
				const series: Record<string, (number | null)[]> = {};
				for (const id of ids) {
					const byT = perTag.get(id)!;
					series[id] = t.map((ts) => byT.get(ts) ?? null);
				}
				return json({ tags: ids, from, to, bucketMs, t, series });
			}

			return json({ tag: single, from, to, points: reader.series(single!, from, to, buckets) });
		} finally {
			reader.close();
		}
	} catch (err) {
		// e.g. the historian file doesn't exist yet because the gateway hasn't run.
		throw error(503, `historian unavailable: ${(err as Error).message}`);
	}
}
