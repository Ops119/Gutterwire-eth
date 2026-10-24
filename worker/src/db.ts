// D1 helpers. The schema lives in migrations/0001_init.sql.

import type { Snapshot } from "./clients";

export interface Candidate {
  address: string;
  symbol: string | null;
  name: string | null;
  pool_address: string | null;
  dex: string | null;
  pool_created_at: string | null;
  image_url: string | null;
  first_seen: number;
  updated_at: number;
  status: string;
  reason: string | null;
  check_attempts: number;
}

export type NewCandidate = Pick<Candidate, "address" | "symbol" | "name" | "pool_address" | "dex" | "pool_created_at" | "image_url">;

export function iso(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "-";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function kvSet(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** Insert newly discovered tokens; existing addresses are ignored (dedup across runs). Returns how many were new. */
export async function insertCandidates(db: D1Database, items: NewCandidate[], now: number): Promise<number> {
  if (!items.length) return 0;
  const results = await db.batch(
    items.map((c) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO candidates
             (address, symbol, name, pool_address, dex, pool_created_at, image_url, first_seen, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
        )
        .bind(c.address, c.symbol, c.name, c.pool_address, c.dex, c.pool_created_at, c.image_url, now, now),
    ),
  );
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

export async function candidatesWithStatus(db: D1Database, statuses: string[], limit = 500): Promise<Candidate[]> {
  const q = statuses.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM candidates WHERE status IN (${q}) ORDER BY first_seen LIMIT ?`)
    .bind(...statuses, limit)
    .all<Candidate>();
  return results;
}

export function setStatusStmt(db: D1Database, address: string, status: string, reason: string | null, now: number) {
  return db
    .prepare("UPDATE candidates SET status = ?, reason = ?, updated_at = ? WHERE address = ?")
    .bind(status, reason, now, address);
}

export function snapshotStmt(db: D1Database, address: string, s: Snapshot, now: number) {
  return db
    .prepare(
      `INSERT INTO snapshots(address, ts, price_usd, liquidity_usd, volume_24h_usd, market_cap_usd,
                             mcap_source, fdv_usd, pair_address, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(address, now, s.price_usd, s.liquidity_usd, s.volume_24h_usd, s.market_cap_usd, s.mcap_source,
      s.fdv_usd, s.pair_address, s.url);
}

export function securityStmt(
  db: D1Database,
  address: string,
  v: { passed: boolean; complete: boolean; reason: string; flags: Record<string, unknown> },
  now: number,
) {
  return db
    .prepare("INSERT INTO security_checks(address, ts, passed, complete, reason, flags) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(address, now, v.passed ? 1 : 0, v.complete ? 1 : 0, v.reason, JSON.stringify(v.flags));
}

/** Run statements in one D1 round trip (D1 batches are transactions). */
export async function runBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length) await db.batch(stmts);
}

/** Take a named lock unless someone else holds a fresh one. Stops cron and /scan overlapping. */
export async function acquireLock(db: D1Database, name: string, now: number, ttlMs: number): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO kv(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(kv.value AS INTEGER) < ?`,
    )
    .bind(`lock:${name}`, String(now), now - ttlMs)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseLock(db: D1Database, name: string): Promise<void> {
  await db.prepare("DELETE FROM kv WHERE key = ?").bind(`lock:${name}`).run();
}
