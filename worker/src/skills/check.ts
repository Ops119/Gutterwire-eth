// check: GoPlus token security. Failed or incomplete checks are rejected.

import { ApiError, BudgetExceeded, type GoPlus } from "../clients";
import { candidatesWithStatus, runBatch, securityStmt, setStatusStmt } from "../db";
import type { Settings } from "../config";

// Every one of these must be present in the GoPlus result, or the check is incomplete.
export const REQUIRED_FIELDS = [
  "is_open_source", "is_honeypot", "buy_tax", "sell_tax", "cannot_buy", "cannot_sell_all",
  "is_proxy", "is_mintable", "hidden_owner", "can_take_back_ownership", "owner_change_balance",
  "selfdestruct", "transfer_pausable", "slippage_modifiable",
] as const;

// "1" on any of these is a hard reject.
export const RED_FLAGS: Record<string, string> = {
  is_honeypot: "honeypot",
  cannot_buy: "cannot buy",
  cannot_sell_all: "cannot sell all",
  is_proxy: "upgradeable proxy",
  is_mintable: "owner can mint",
  hidden_owner: "hidden owner",
  can_take_back_ownership: "ownership can be reclaimed",
  owner_change_balance: "owner can change balances",
  selfdestruct: "self-destruct",
  transfer_pausable: "transfers can be paused",
  slippage_modifiable: "tax can be changed",
  personal_slippage_modifiable: "per-wallet tax",
  is_blacklisted: "blacklist function",
  trading_cooldown: "trading cooldown",
};

export interface Verdict {
  passed: boolean;
  complete: boolean;
  reason: string;
  flags: Record<string, unknown>;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Pure rule check on a raw GoPlus response. */
export function evaluate(response: any, address: string, maxBuyTax: number, maxSellTax: number): Verdict {
  address = address.toLowerCase();
  if (!response || typeof response !== "object" || response.code !== 1) {
    return { passed: false, complete: false, reason: `GoPlus error: ${response?.message ?? "bad response"}`, flags: {} };
  }
  const resultMap: Record<string, any> = {};
  for (const [k, v] of Object.entries(response.result ?? {})) resultMap[k.toLowerCase()] = v;
  const result = resultMap[address];
  if (!result) return { passed: false, complete: false, reason: "GoPlus has no data for token", flags: {} };

  const flags: Record<string, unknown> = {};
  for (const f of [...REQUIRED_FIELDS, ...Object.keys(RED_FLAGS), "holder_count", "lp_holder_count", "creator_percent"]) {
    if (f in result) flags[f] = result[f];
  }
  const missing = REQUIRED_FIELDS.filter((f) => result[f] === undefined || result[f] === null || result[f] === "");
  if (missing.length) return { passed: false, complete: false, reason: `incomplete check, missing: ${missing.join(", ")}`, flags };
  if (String(result.is_open_source) !== "1") return { passed: false, complete: true, reason: "contract not verified", flags };
  const hits = Object.entries(RED_FLAGS).filter(([f]) => String(result[f] ?? "0") === "1").map(([, label]) => label);
  if (hits.length) return { passed: false, complete: true, reason: hits.join("; "), flags };
  const buy = Number(result.buy_tax);
  const sell = Number(result.sell_tax);
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) {
    return { passed: false, complete: false, reason: "unparseable tax values", flags };
  }
  if (buy > maxBuyTax || sell > maxSellTax) {
    return { passed: false, complete: true, reason: `tax too high (buy ${pct(buy)}, sell ${pct(sell)})`, flags };
  }
  return { passed: true, complete: true, reason: `clean (buy ${pct(buy)}, sell ${pct(sell)})`, flags };
}

export async function fetchVerdict(goplus: GoPlus, address: string, s: Settings): Promise<Verdict> {
  let raw: any;
  try {
    raw = await goplus.tokenSecurity(address);
  } catch (e) {
    if (e instanceof ApiError) raw = { code: null, message: e.message };
    else throw e; // BudgetExceeded propagates so the caller stops
  }
  return evaluate(raw, address, s.maxBuyTax, s.maxSellTax);
}

export async function check(db: D1Database, goplus: GoPlus, s: Settings, now: number) {
  const counts = { checked: 0, shortlisted: 0, rejected_security: 0, retry_later: 0 };
  const rows = await candidatesWithStatus(db, ["check_pending"], 100);
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    let v: Verdict;
    try {
      v = await fetchVerdict(goplus, r.address, s);
    } catch (e) {
      if (e instanceof BudgetExceeded) break; // remaining tokens wait for the next hourly run
      throw e;
    }
    const attempts = r.check_attempts + 1;
    stmts.push(securityStmt(db, r.address, v, now));
    stmts.push(db.prepare("UPDATE candidates SET check_attempts = ? WHERE address = ?").bind(attempts, r.address));
    counts.checked++;
    if (v.passed) {
      stmts.push(setStatusStmt(db, r.address, "shortlisted", v.reason, now));
      counts.shortlisted++;
    } else if (!v.complete && attempts < s.securityRetryLimit) {
      // Not shortlisted; GoPlus often lags on brand-new tokens, so look again next hour.
      stmts.push(setStatusStmt(db, r.address, "check_pending", v.reason, now));
      counts.retry_later++;
    } else {
      stmts.push(setStatusStmt(db, r.address, "rejected_security", v.reason, now));
      counts.rejected_security++;
    }
  }
  await runBatch(db, stmts);
  return counts;
}
