// SQLite historian for the gateway. Buffers tag samples in memory and flushes them in batched
// transactions to a local SQLite file via Node's built-in node:sqlite — no native module, so it's
// safe with no admin / build tools (see the no-admin constraint). WAL mode lets the SvelteKit app
// read the same file concurrently (openHistorianReader) while the gateway writes. Only numeric and
// boolean values are historized (trends); each tag is sampled at most once per minIntervalMs. A
// retention job trims rows older than retentionDays.
//
// node:sqlite is still flagged experimental and prints an ExperimentalWarning on import — harmless.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TagUpdate } from '../../opcua/types.ts';

const DEFAULT_DB = 'data/historian.sqlite';

export type HistorianWriter = {
	record: (u: TagUpdate) => void;
	flush: () => void;
	stop: () => void;
};

export type HistorianOptions = {
	dbPath?: string;
	logTagIds?: ReadonlySet<string>; // only these tag ids are historized; omit = log all
	flushIntervalMs?: number; // batch flush cadence (default 5000)
	minIntervalMs?: number; // per-tag min spacing between recorded samples (default 1000)
	retentionDays?: number; // rows older than this are trimmed (default 30)
	onLog?: (msg: string) => void;
};

// Only numeric/boolean values make sense to trend; strings etc. are skipped.
function coerce(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	return null;
}

function initSchema(db: DatabaseSync): void {
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec(
		`CREATE TABLE IF NOT EXISTS samples (
			tag_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			value REAL NOT NULL,
			quality TEXT NOT NULL
		)`
	);
	db.exec('CREATE INDEX IF NOT EXISTS idx_samples_tag_ts ON samples (tag_id, ts)');
}

export function openHistorian(opts: HistorianOptions = {}): HistorianWriter {
	const log = opts.onLog ?? (() => {});
	const path = resolve(opts.dbPath ?? process.env.HISTORIAN_DB ?? DEFAULT_DB);
	mkdirSync(dirname(path), { recursive: true });

	const db = new DatabaseSync(path);
	initSchema(db);
	const insert = db.prepare('INSERT INTO samples (tag_id, ts, value, quality) VALUES (?, ?, ?, ?)');

	const flushMs = opts.flushIntervalMs ?? 5000;
	const minMs = opts.minIntervalMs ?? 1000;
	const retentionDays = opts.retentionDays ?? 30;
	const logTagIds = opts.logTagIds;

	const buffer: { tag: string; ts: number; value: number; quality: string }[] = [];
	const lastRec = new Map<string, number>(); // per-tag last recorded ts (throttle)

	function record(u: TagUpdate): void {
		if (logTagIds && !logTagIds.has(u.id)) return; // only historize opted-in tags
		const value = coerce(u.value);
		if (value == null) return;
		const ts = Date.parse(u.ts) || Date.now();
		const last = lastRec.get(u.id) ?? 0;
		if (ts - last < minMs) return; // throttle to at most 1 sample/tag/minMs
		lastRec.set(u.id, ts);
		buffer.push({ tag: u.id, ts, value, quality: u.quality });
	}

	function flush(): void {
		if (buffer.length === 0) return;
		const rows = buffer.splice(0, buffer.length);
		try {
			db.exec('BEGIN');
			for (const r of rows) insert.run(r.tag, r.ts, r.value, r.quality);
			db.exec('COMMIT');
			log(`flushed ${rows.length} samples`);
		} catch (err) {
			try {
				db.exec('ROLLBACK');
			} catch {
				/* ignore */
			}
			log(`flush failed: ${(err as Error).message}`);
		}
	}

	function retain(): void {
		const cutoff = Date.now() - retentionDays * 86_400_000;
		try {
			const info = db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
			if (info.changes)
				log(`retention: removed ${info.changes} rows older than ${retentionDays}d`);
		} catch (err) {
			log(`retention failed: ${(err as Error).message}`);
		}
	}

	const flushTimer = setInterval(flush, flushMs);
	const retainTimer = setInterval(retain, 86_400_000);
	retain(); // trim once on startup

	const scope = logTagIds ? `${logTagIds.size} logged tag(s)` : 'all tags';
	log(
		`historian open at ${path} — ${scope} (flush ${flushMs}ms, min ${minMs}ms/tag, retention ${retentionDays}d)`
	);

	return {
		record,
		flush,
		stop() {
			clearInterval(flushTimer);
			clearInterval(retainTimer);
			flush();
			db.close();
		}
	};
}

// ---- Reader: used by the SvelteKit app (a separate process); opens the same file read-only. ----

export type SeriesPoint = { t: number; avg: number; min: number; max: number; n: number };

export type HistorianReader = {
	series: (tagId: string, fromMs: number, toMs: number, buckets?: number) => SeriesPoint[];
	count: (tagId?: string) => number;
	close: () => void;
};

export function openHistorianReader(dbPath?: string): HistorianReader {
	const path = resolve(dbPath ?? process.env.HISTORIAN_DB ?? DEFAULT_DB);
	const db = new DatabaseSync(path, { readOnly: true });

	return {
		// Downsample to ~buckets points via time-bucketed AVG/MIN/MAX (good for trend charts).
		series(tagId, fromMs, toMs, buckets = 300) {
			const span = Math.max(1, toMs - fromMs);
			const bucketMs = Math.max(1, Math.floor(span / Math.max(1, buckets)));
			const stmt = db.prepare(
				`SELECT (ts / ${bucketMs}) * ${bucketMs} AS t,
				        AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS n
				 FROM samples
				 WHERE tag_id = ? AND ts >= ? AND ts <= ?
				 GROUP BY t ORDER BY t`
			);
			return stmt.all(tagId, fromMs, toMs) as unknown as SeriesPoint[];
		},
		count(tagId) {
			const row = tagId
				? (db.prepare('SELECT COUNT(*) AS n FROM samples WHERE tag_id = ?').get(tagId) as {
						n: number;
					})
				: (db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number });
			return row?.n ?? 0;
		},
		close() {
			db.close();
		}
	};
}
