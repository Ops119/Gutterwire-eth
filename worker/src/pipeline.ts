// Operating flow: hourly discover -> filter -> check -> shortlist -> review; digest every 48h.

import { Budget, BudgetExceeded, type Sleep, realSleep } from "./budget";
import {
  ApiError, CoinMarketCap, DexScreener, type Fetch, GeckoTerminal, Gemini, GoPlus, Http, Telegram,
} from "./clients";
import { type Env, type Settings, getSettings } from "./config";
import {
  acquireLock, candidatesWithStatus, iso, kvGet, kvSet, releaseLock, runBatch, securityStmt, setStatusStmt, snapshotStmt,
} from "./db";
import { archiveText, type CallPost, layout, type Qualified } from "./render";
import { brief } from "./skills/brief";
import { fetchVerdict, check } from "./skills/check";
import { discover } from "./skills/discover";
import { cmcFill, evaluate, filter } from "./skills/filter";
import { latestOutcomes, review } from "./skills/review";

export const LAST_DIGEST_KEY = "last_digest_at";
// Each call is its own photo post; this keeps a digest well inside the free plan's per-run call cap.
export const MAX_CALLS_PER_DIGEST = 8;

export interface App {
  db: D1Database;
  settings: Settings;
  budget: Budget;
  gecko: GeckoTerminal;
  dex: DexScreener;
  goplus: GoPlus;
  cmc: CoinMarketCap | null;
  gemini: Gemini | null;
  telegram: Telegram | null;
  now: () => number;
}

export async function build(env: Env, opts: { fetcher?: Fetch; sleep?: Sleep; now?: () => number } = {}): Promise<App> {
  const settings = getSettings(env);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const budget = new Budget(env.DB, settings, sleep, now);
  await budget.load();
  const http = new Http(budget, opts.fetcher, sleep);
  return {
    db: env.DB, settings, budget, now,
    gecko: new GeckoTerminal(http),
    dex: new DexScreener(http),
    goplus: new GoPlus(http),
    cmc: settings.cmcApiKey ? new CoinMarketCap(http, settings.cmcApiKey) : null,
    gemini: settings.geminiApiKey ? new Gemini(http, settings.geminiApiKey, settings.geminiModel) : null,
    telegram: settings.telegramToken ? new Telegram(http, settings.telegramToken) : null,
  };
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | { skipped: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BudgetExceeded || e instanceof ApiError) {
      console.warn(`${name} skipped: ${e.message}`);
      return { skipped: e.message };
    }
    throw e;
  }
}

export async function scan(app: App) {
  const s = app.settings;
  const t = app.now();
  // Order matters on the free plan's 50-subrequest cap: review is cheap and protects call tracking,
  // discovery and filtering feed the queue, and security checks use whatever budget is left.
  return {
    review: await step("review", () => review(app.db, app.dex, s.reviewDays, t)),
    discover: await step("discover", () => discover(app.db, app.gecko, s.discoveryPages, t)),
    filter: await step("filter", () => filter(app.db, app.dex, app.cmc, s, t)),
    check: await step("check", () => check(app.db, app.goplus, s, t)),
  };
}

export async function digestDue(app: App): Promise<boolean> {
  const now = app.now();
  const last = await kvGet(app.db, LAST_DIGEST_KEY);
  if (last === null) {
    // First run starts the clock; the first digest goes out one interval later.
    // POST /digest (with ADMIN_TOKEN) sends one immediately.
    await kvSet(app.db, LAST_DIGEST_KEY, String(now));
    return false;
  }
  return now - Number(last) >= app.settings.digestIntervalHours * 3_600_000;
}


/** Re-apply the fixed rules to the shortlist with fresh data right before sending. */
async function requalify(app: App): Promise<Qualified[]> {
  const s = app.settings;
  const t = app.now();
  const rows = await candidatesWithStatus(app.db, ["shortlisted"], MAX_CALLS_PER_DIGEST + 4);
  if (!rows.length) return [];
  const pairs = await app.dex.tokenPairs(rows.map((r) => r.address));
  const out: Qualified[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const snap = DexScreener.bestSnapshot(r.address, pairs.get(r.address) ?? []);
    if (snap && snap.market_cap_usd === null && app.cmc) await cmcFill(app.db, app.cmc, r.address, snap, 0, t);
    if (snap) stmts.push(snapshotStmt(app.db, r.address, snap, t));
    const [status, reason] = evaluate(snap, s.maxMarketCapUsd, s.minLiquidityUsd);
    if (status !== "check_pending" || !snap) {
      stmts.push(setStatusStmt(app.db, r.address, status, `dropped at digest: ${reason}`, t));
      continue;
    }
    const v = await fetchVerdict(app.goplus, r.address, s); // BudgetExceeded aborts the digest; retried next hour
    stmts.push(securityStmt(app.db, r.address, v, t));
    if (!v.passed) {
      stmts.push(setStatusStmt(app.db, r.address, "rejected_security", `dropped at digest: ${v.reason}`, t));
      continue;
    }
    out.push({
      address: r.address, symbol: r.symbol, name: r.name, pool_created_at: r.pool_created_at,
      market_cap_usd: snap.market_cap_usd, liquidity_usd: snap.liquidity_usd, volume_24h_usd: snap.volume_24h_usd,
      price_usd: snap.price_usd, security: v.reason, holder_count: v.flags.holder_count,
      url: snap.url, pair_address: snap.pair_address, mcap_source: snap.mcap_source,
      image_url: snap.image_url ?? r.image_url,
    });
  }
  await runBatch(app.db, stmts);
  // Deepest liquidity relative to market cap first; the rest stay shortlisted for the next digest.
  const depth = (c: Qualified) => (c.liquidity_usd ?? 0) / (c.market_cap_usd || 1);
  return out.sort((a, b) => depth(b) - depth(a)).slice(0, MAX_CALLS_PER_DIGEST);
}

/** Post one call: the first photo that Telegram accepts, else a text post. Returns false if nothing was sent. */
async function postCall(app: App, chatId: string, post: CallPost): Promise<boolean> {
  for (const photo of post.photos) {
    try {
      await app.telegram!.sendPhoto(chatId, photo, post.caption);
      return true;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e; // BudgetExceeded propagates
      console.warn(`digest: photo rejected for ${post.address}: ${e.message}`);
    }
  }
  try {
    await app.telegram!.send(chatId, post.caption, true);
    return true;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    console.error(`digest: call post failed for ${post.address}: ${e.message}`);
    return false;
  }
}

export async function sendDigest(app: App) {
  const s = app.settings;
  const now = app.now();
  const last = await kvGet(app.db, LAST_DIGEST_KEY);
  const since = last ? Number(last) : now - s.digestIntervalHours * 3_600_000;

  const candidates = await requalify(app);
  const { notes, aiUsed } = await brief(candidates, app.gemini);
  const past = await latestOutcomes(app.db, now - s.reviewDays * 86_400_000);
  const scanned =
    (await app.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE first_seen >= ?").bind(since).first<{ n: number }>())?.n ?? 0;
  const digest = layout(candidates, notes, scanned, past, since, now, s.maxMarketCapUsd);
  const text = archiveText(digest);

  let delivered = false;
  const posted: Qualified[] = [];
  if (app.telegram && s.telegramChatId) {
    try {
      await app.telegram.send(s.telegramChatId, digest.header, true);
      delivered = true;
    } catch (e) {
      if (!(e instanceof ApiError || e instanceof BudgetExceeded)) throw e;
      console.error(`digest: Telegram send failed: ${e.message}`);
    }
    if (delivered) {
      // Once the header is out the digest counts as sent; a failure below must not cause a resend.
      try {
        for (const [i, post] of digest.posts.entries()) {
          if (await postCall(app, s.telegramChatId, post)) posted.push(candidates[i]);
        }
        await app.telegram.send(s.telegramChatId, digest.footer, true);
      } catch (e) {
        if (!(e instanceof ApiError || e instanceof BudgetExceeded)) throw e;
        console.error(`digest: incomplete after header: ${e.message}`);
      }
    }
  } else {
    console.warn("digest: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; not sending");
  }

  const res = await app.db
    .prepare("INSERT INTO digests(sent_at, n_candidates, ai_used, delivered, text) VALUES (?, ?, ?, ?, ?)")
    .bind(now, candidates.length, aiUsed ? 1 : 0, delivered ? 1 : 0, text)
    .run();
  const digestId = res.meta.last_row_id;
  if (delivered) {
    const stmts: D1PreparedStatement[] = posted.flatMap((c) => [
      app.db
        .prepare(
          `INSERT INTO calls(address, digest_id, called_at, price_usd, liquidity_usd, market_cap_usd, pair_address)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(c.address, digestId, now, c.price_usd, c.liquidity_usd, c.market_cap_usd, c.pair_address),
      setStatusStmt(app.db, c.address, "called", "sent in digest", now),
    ]);
    stmts.push(
      app.db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(LAST_DIGEST_KEY, String(now)),
    );
    await runBatch(app.db, stmts);
  }
  return { digestId, candidates: candidates.length, posted: posted.length, aiUsed, delivered, text };
}

/** The hourly job. A due digest goes first so it always gets budget; the scan uses the rest. */
export const RUN_LOCK_TTL_MS = 15 * 60_000; // cron runs end within 15 minutes

export async function runHourly(app: App, forceDigest = false) {
  const out: Record<string, unknown> = {};
  if (!(await acquireLock(app.db, "run", app.now(), RUN_LOCK_TTL_MS))) {
    return { skipped: "another run is in progress" };
  }
  try {
    if (forceDigest || (await digestDue(app))) {
      try {
        const { text: _text, ...rest } = await sendDigest(app);
        out.digest = rest;
      } catch (e) {
        if (!(e instanceof ApiError || e instanceof BudgetExceeded)) throw e;
        // Timestamp untouched, so the next hourly run retries.
        console.error(`digest failed, will retry next run: ${e.message}`);
        out.digest = { error: e.message };
      }
    }
    out.scan = await scan(app);
  } finally {
    await app.budget.flush();
    await releaseLock(app.db, "run");
    out.subrequests = app.budget.usedThisRun;
  }
  return out;
}

/** Scan only (no digest), for the /scan command. */
export async function runScanNow(app: App) {
  if (!(await acquireLock(app.db, "run", app.now(), RUN_LOCK_TTL_MS))) return null;
  try {
    return await scan(app);
  } finally {
    await app.budget.flush();
    await releaseLock(app.db, "run");
  }
}

export async function status(app: App) {
  const { results } = await app.db
    .prepare("SELECT status, COUNT(*) AS n FROM candidates GROUP BY status")
    .all<{ status: string; n: number }>();
  const calls = (await app.db.prepare("SELECT COUNT(*) AS n FROM calls").first<{ n: number }>())?.n ?? 0;
  const last = await kvGet(app.db, LAST_DIGEST_KEY);
  return {
    candidates: Object.fromEntries(results.map((r) => [r.status, r.n])),
    calls,
    last_digest: last ? iso(Number(last)) : "never",
    budget_today: app.budget.report(),
    gemini: app.gemini ? "on" : "off (template notes)",
    coinmarketcap: app.cmc ? "on" : "off",
    telegram: app.telegram && app.settings.telegramChatId ? "ready" : "not configured",
  };
}
