// filter: reported market cap must be below the cap. Missing market cap goes to the watchlist.
// FDV is never substituted for market cap.

import { ApiError, BudgetExceeded, type CoinMarketCap, DexScreener, type Snapshot } from "../clients";
import { candidatesWithStatus, kvGet, kvSet, runBatch, setStatusStmt, snapshotStmt } from "../db";
import type { Settings } from "../config";

export type FilterStatus = "watchlist" | "rejected_filter" | "check_pending";

export const money = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return "n/a";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(2)}`;
};

/** Pure rule check. */
export function evaluate(snap: Snapshot | null, maxMcap: number, minLiquidity: number): [FilterStatus, string] {
  if (!snap) return ["watchlist", "no DEX Screener pair yet"];
  const mcap = snap.market_cap_usd;
  if (mcap === null || mcap <= 0) return ["watchlist", "market cap not reported"];
  if (mcap >= maxMcap) return ["rejected_filter", `market cap ${money(mcap)} >= ${money(maxMcap)}`];
  const liq = snap.liquidity_usd;
  if (minLiquidity > 0 && (liq === null || liq < minLiquidity)) {
    return ["rejected_filter", `liquidity ${money(liq ?? 0)} below ${money(minLiquidity)}`];
  }
  return ["check_pending", `market cap ${money(mcap)} < ${money(maxMcap)}`];
}

/** Fill a missing reported market cap from CoinMarketCap, at most once per `recheckHours` per token. */
export async function cmcFill(db: D1Database, cmc: CoinMarketCap, address: string, snap: Snapshot,
                              recheckHours: number, now: number): Promise<void> {
  const key = `cmc_checked:${address}`;
  const last = await kvGet(db, key);
  if (last && now - Number(last) < recheckHours * 3_600_000) return;
  let mcap: number | null;
  try {
    mcap = await cmc.marketCap(address);
  } catch (e) {
    if (e instanceof ApiError || e instanceof BudgetExceeded) {
      console.warn(`filter: coinmarketcap ${e.message}`);
      return;
    }
    throw e;
  }
  await kvSet(db, key, String(now));
  if (mcap) {
    snap.market_cap_usd = mcap;
    snap.mcap_source = "coinmarketcap";
  }
}

export async function filter(db: D1Database, dex: DexScreener, cmc: CoinMarketCap | null, s: Settings, now: number) {
  const rows = await candidatesWithStatus(db, ["new", "watchlist"], 300);
  const counts = { checked: 0, watchlist: 0, rejected_filter: 0, check_pending: 0, expired: 0 };
  if (!rows.length) return counts;
  let pairs: Map<string, any[]>;
  try {
    pairs = await dex.tokenPairs(rows.map((r) => r.address));
  } catch (e) {
    if (e instanceof ApiError || e instanceof BudgetExceeded) {
      console.warn(`filter: ${e.message}`);
      return counts;
    }
    throw e;
  }
  let cmcLeft = s.cmcLookupsPerRun;
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const snap = DexScreener.bestSnapshot(r.address, pairs.get(r.address) ?? []);
    if (snap && snap.market_cap_usd === null && cmc && cmcLeft > 0) {
      cmcLeft--;
      await cmcFill(db, cmc, r.address, snap, s.cmcRecheckHours, now);
    }
    if (snap) stmts.push(snapshotStmt(db, r.address, snap, now));
    let [status, reason]: [string, string] = evaluate(snap, s.maxMarketCapUsd, s.minLiquidityUsd);
    if (status === "watchlist" && now - r.first_seen > s.watchlistMaxAgeHours * 3_600_000) {
      status = "expired";
      reason = `no reported market cap after ${s.watchlistMaxAgeHours}h`;
    }
    stmts.push(setStatusStmt(db, r.address, status, reason, now));
    counts.checked++;
    counts[status as keyof typeof counts]++;
  }
  await runBatch(db, stmts);
  return counts;
}
