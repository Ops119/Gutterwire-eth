// review: record subsequent price, liquidity and outcome for every call at fixed checkpoints.

import { ApiError, BudgetExceeded, DexScreener, type Snapshot } from "../clients";
import { runBatch, snapshotStmt } from "../db";

export const CHECKPOINTS_H = [1, 6, 24, 48, 96, 168, 336];

interface CallRow {
  id: number;
  address: string;
  called_at: number;
  price_usd: number | null;
  liquidity_usd: number | null;
}

const pct = (n: number | null, o: number | null) => (n === null || !o ? null : ((n - o) / o) * 100);

export function label(snap: Snapshot | null, call: CallRow): [string, number | null, number | null] {
  if (!snap) return ["pair gone", null, null];
  const p = pct(snap.price_usd, call.price_usd);
  const lq = pct(snap.liquidity_usd, call.liquidity_usd);
  if (lq !== null && lq <= -80) return ["liquidity pulled", p, lq];
  if (p === null) return ["no price", p, lq];
  if (p >= 100) return ["2x+", p, lq];
  if (p >= 25) return ["up", p, lq];
  if (p <= -50) return ["down big", p, lq];
  if (p <= -10) return ["down", p, lq];
  return ["flat", p, lq];
}

export async function review(db: D1Database, dex: DexScreener, reviewDays: number, now: number) {
  const { results: calls } = await db
    .prepare("SELECT id, address, called_at, price_usd, liquidity_usd FROM calls WHERE called_at >= ?")
    .bind(now - reviewDays * 86_400_000)
    .all<CallRow>();
  const counts = { calls: calls.length, outcomes: 0 };
  if (!calls.length) return counts;

  const { results: done } = await db
    .prepare(`SELECT call_id, checkpoint_h FROM outcomes WHERE call_id IN (${calls.map(() => "?").join(",")})`)
    .bind(...calls.map((c) => c.id))
    .all<{ call_id: number; checkpoint_h: number }>();
  const doneSet = new Set(done.map((d) => `${d.call_id}:${d.checkpoint_h}`));
  const due = calls.filter((c) =>
    CHECKPOINTS_H.some((h) => h <= (now - c.called_at) / 3_600_000 && !doneSet.has(`${c.id}:${h}`)),
  );
  if (!due.length) return counts; // nothing due: spend no API calls

  let pairs: Map<string, any[]>;
  try {
    pairs = await dex.tokenPairs([...new Set(due.map((c) => c.address))]);
  } catch (e) {
    if (e instanceof ApiError || e instanceof BudgetExceeded) {
      console.warn(`review: ${e.message}`);
      return counts;
    }
    throw e;
  }
  const stmts: D1PreparedStatement[] = [];
  const snaps = new Map<string, Snapshot | null>();
  for (const a of new Set(due.map((c) => c.address))) {
    const snap = DexScreener.bestSnapshot(a, pairs.get(a) ?? []);
    snaps.set(a, snap);
    if (snap) stmts.push(snapshotStmt(db, a, snap, now));
  }
  for (const call of due) {
    const snap = snaps.get(call.address) ?? null;
    const [outcome, p, lq] = label(snap, call);
    for (const h of CHECKPOINTS_H) {
      if (h > (now - call.called_at) / 3_600_000 || doneSet.has(`${call.id}:${h}`)) continue;
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO outcomes(call_id, checkpoint_h, ts, price_usd, liquidity_usd, market_cap_usd,
                                            price_change_pct, liquidity_change_pct, outcome)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(call.id, h, now, snap?.price_usd ?? null, snap?.liquidity_usd ?? null, snap?.market_cap_usd ?? null,
            p, lq, outcome),
      );
      counts.outcomes++;
    }
  }
  await runBatch(db, stmts);
  return counts;
}

export interface PastCall {
  address: string;
  symbol: string | null;
  called_at: number;
  checkpoint_h: number | null;
  price_change_pct: number | null;
  liquidity_change_pct: number | null;
  outcome: string | null;
}

/** Latest recorded outcome for each call made since `since`. */
export async function latestOutcomes(db: D1Database, since: number): Promise<PastCall[]> {
  const { results } = await db
    .prepare(
      `SELECT c.address, c.called_at, cand.symbol, o.checkpoint_h, o.price_change_pct,
              o.liquidity_change_pct, o.outcome
       FROM calls c
       JOIN candidates cand ON cand.address = c.address
       LEFT JOIN outcomes o ON o.id = (
           SELECT id FROM outcomes WHERE call_id = c.id ORDER BY checkpoint_h DESC LIMIT 1)
       WHERE c.called_at >= ?
       ORDER BY c.called_at DESC
       LIMIT 30`,
    )
    .bind(since)
    .all<PastCall>();
  return results;
}
