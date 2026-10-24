// Telegram bot commands, delivered by webhook to POST /telegram.
//
// Read-only commands cost no external API calls beyond the reply. Commands that spend API budget
// (/scan, /check) are limited to the Telegram user ids in TELEGRAM_ADMIN_IDS.

import { ApiError, BudgetExceeded, DexScreener } from "./clients";
import type { Env } from "./config";
import { candidatesWithStatus, iso, kvGet, kvSet } from "./db";
import { type App, build, LAST_DIGEST_KEY, runScanNow, status } from "./pipeline";
import { fetchVerdict } from "./skills/check";
import { evaluate, money } from "./skills/filter";
import { latestOutcomes } from "./skills/review";

export const COMMANDS: [string, string][] = [
  ["scan", "Run a scan now (admin)"],
  ["shortlist", "Tokens that passed every rule, waiting for the next digest"],
  ["watchlist", "Tokens waiting for a reported market cap"],
  ["check", "Check one contract against the rules: /check 0x... (admin)"],
  ["calls", "Recent calls and how they have done"],
  ["lastdigest", "Show the last digest"],
  ["status", "Pipeline counts, API budget and next digest time"],
  ["help", "List commands"],
];

// /scan from Telegram runs inside the webhook's 30-second waitUntil window, so it gets a smaller
// call budget that never needs to wait on a per-minute rate limit.
const SCAN_SUBREQUESTS = 16;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Reply = (text: string, html?: boolean) => Promise<void>;

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function parseCommand(text: string | undefined): { cmd: string; args: string[] } | null {
  if (!text?.startsWith("/")) return null;
  const [head, ...args] = text.trim().split(/\s+/);
  const cmd = head.slice(1).split("@")[0].toLowerCase();
  return cmd ? { cmd, args } : null;
}

function helpText(): string {
  return ["Gutterwire commands:", ...COMMANDS.map(([c, d]) => `/${c} – ${d}`)].join("\n");
}

async function listText(app: App, status: "shortlisted" | "watchlist", title: string): Promise<string> {
  const rows = await candidatesWithStatus(app.db, [status], 20);
  if (!rows.length) return `${title}: none right now.`;
  const lines = [`${title} (${rows.length}${rows.length === 20 ? "+" : ""}):`];
  for (const r of rows) {
    const snap = await app.db
      .prepare("SELECT market_cap_usd, liquidity_usd FROM snapshots WHERE address = ? ORDER BY ts DESC, id DESC LIMIT 1")
      .bind(r.address)
      .first<{ market_cap_usd: number | null; liquidity_usd: number | null }>();
    lines.push(
      `• ${r.symbol ?? "?"} ${r.address}\n  MCap ${money(snap?.market_cap_usd)} · Liq ${money(snap?.liquidity_usd)}` +
        ` · seen ${iso(r.first_seen)}`,
    );
  }
  return lines.join("\n");
}

async function callsText(app: App): Promise<string> {
  const past = await latestOutcomes(app.db, app.now() - app.settings.reviewDays * 86_400_000);
  if (!past.length) return `No calls in the last ${app.settings.reviewDays} days.`;
  const pct = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${Math.round(v)}%`);
  return [
    "Recent calls (latest checkpoint):",
    ...past.map((p) =>
      p.outcome === null
        ? `• ${p.symbol ?? short(p.address)} (${iso(p.called_at).slice(0, 10)}): no checkpoint yet`
        : `• ${p.symbol ?? short(p.address)} (${iso(p.called_at).slice(0, 10)}): price ${pct(p.price_change_pct)}, ` +
          `liq ${pct(p.liquidity_change_pct)} at ${p.checkpoint_h}h → ${p.outcome}`,
    ),
  ].join("\n");
}

async function lastDigestText(app: App): Promise<string> {
  const row = await app.db
    .prepare("SELECT text FROM digests WHERE delivered = 1 ORDER BY sent_at DESC LIMIT 1")
    .first<{ text: string }>();
  return row?.text ?? "No digest has been sent yet.";
}

async function statusText(app: App): Promise<string> {
  const st = await status(app);
  const last = await kvGet(app.db, LAST_DIGEST_KEY);
  const next = last ? iso(Number(last) + app.settings.digestIntervalHours * 3_600_000) : "after the first scan";
  const counts = Object.entries(st.candidates).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet";
  const budget = Object.entries(st.budget_today).map(([k, v]) => `${k} ${v}`).join(", ");
  return [
    `Tokens: ${counts}`,
    `Calls tracked: ${st.calls}`,
    `Last digest: ${st.last_digest} · next: ${next}`,
    `API use today: ${budget}`,
    `Gemini: ${st.gemini} · CoinMarketCap: ${st.coinmarketcap}`,
  ].join("\n");
}

async function checkText(app: App, address: string): Promise<string> {
  const s = app.settings;
  const addr = address.toLowerCase();
  const pairs = await app.dex.tokenPairs([addr]);
  const snap = DexScreener.bestSnapshot(addr, pairs.get(addr) ?? []);
  const [fStatus, fReason] = evaluate(snap, s.maxMarketCapUsd, s.minLiquidityUsd);
  const lines = [`Check ${addr}`];
  if (snap) {
    lines.push(`MCap ${money(snap.market_cap_usd)} · Liq ${money(snap.liquidity_usd)} · Vol24h ${money(snap.volume_24h_usd)}`);
    if (snap.market_cap_usd === null && snap.fdv_usd !== null) lines.push(`(FDV ${money(snap.fdv_usd)} is not used as market cap)`);
  }
  lines.push(`Market cap rule: ${fStatus === "check_pending" ? "PASS" : fStatus === "watchlist" ? "WATCHLIST" : "FAIL"} – ${fReason}`);
  const v = await fetchVerdict(app.goplus, addr, s);
  lines.push(`Security: ${v.passed ? "PASS" : "FAIL"} – ${v.reason}`);
  lines.push(fStatus === "check_pending" && v.passed ? "Verdict: qualifies." : "Verdict: does not qualify.");
  if (snap?.url) lines.push(snap.url);
  return lines.join("\n");
}

function scanSummary(out: Awaited<ReturnType<typeof runScanNow>>): string {
  if (!out) return "A scan is already running; try again in a few minutes.";
  const fmt = (v: unknown) =>
    v && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${x}`).join(", ")
      : String(v);
  return [
    "Scan finished.",
    `discover: ${fmt(out.discover)}`,
    `filter: ${fmt(out.filter)}`,
    `check: ${fmt(out.check)}`,
    `review: ${fmt(out.review)}`,
  ].join("\n");
}

/** Handle one Telegram update. Returns work to continue after the webhook has answered. */
export async function handleUpdate(env: Env, update: any): Promise<(() => Promise<void>) | null> {
  const msg = update?.message ?? update?.channel_post;
  const parsed = parseCommand(msg?.text);
  if (!msg || !parsed) return null;

  const app = await build(env);
  if (!app.telegram) return null;
  const chatId = msg.chat.id;
  const fromId = msg.from?.id ? String(msg.from.id) : "";
  const reply: Reply = (text, html = false) => app.telegram!.send(chatId, text, html);
  const isAdmin = app.settings.telegramAdminIds.has(fromId);
  const adminOnly = async () =>
    reply(`That command is admin only. Your Telegram user id is ${fromId || "unknown"}; add it to TELEGRAM_ADMIN_IDS to allow it.`);

  // Telegram retries a webhook that fails or times out; skip updates we have already handled.
  const lastId = Number((await kvGet(app.db, "tg_last_update_id")) ?? 0);
  if (typeof update.update_id === "number") {
    if (update.update_id <= lastId) return null;
    await kvSet(app.db, "tg_last_update_id", String(update.update_id));
  }

  const run = async (fn: () => Promise<string>, html = false) => {
    try {
      await reply(await fn(), html);
    } catch (e) {
      if (!(e instanceof ApiError || e instanceof BudgetExceeded)) throw e;
      await reply(`Could not finish: ${e.message}`).catch(() => {});
    } finally {
      await app.budget.flush();
    }
  };

  switch (parsed.cmd) {
    case "start":
    case "help":
      await run(async () => helpText());
      return null;
    case "shortlist":
      await run(() => listText(app, "shortlisted", "Shortlist"));
      return null;
    case "watchlist":
      await run(() => listText(app, "watchlist", "Watchlist"));
      return null;
    case "calls":
      await run(() => callsText(app));
      return null;
    case "lastdigest":
      await run(() => lastDigestText(app), true); // archived digests are Telegram HTML
      return null;
    case "status":
      await run(() => statusText(app));
      return null;
    case "check":
      if (!isAdmin) return adminOnly().then(() => null);
      if (!parsed.args[0] || !ADDRESS.test(parsed.args[0])) {
        await run(async () => "Usage: /check 0x<40 hex characters>");
        return null;
      }
      await run(() => checkText(app, parsed.args[0]));
      return null;
    case "scan": {
      if (!isAdmin) return adminOnly().then(() => null);
      app.settings.subrequestsPerRun = SCAN_SUBREQUESTS;
      await reply("Scanning… results in under a minute.");
      // Continue after the webhook response; the run uses a small call budget to finish within waitUntil.
      return () => run(async () => scanSummary(await runScanNow(app)));
    }
    default:
      await run(async () => `Unknown command /${parsed.cmd}.\n\n${helpText()}`);
      return null;
  }
}

/** Register the webhook and the command menu with Telegram (POST /setup). */
export async function setup(env: Env, workerUrl: string) {
  const app = await build(env);
  if (!app.telegram) throw new ApiError("TELEGRAM_BOT_TOKEN is not set");
  if (!app.settings.webhookSecret) throw new ApiError("TELEGRAM_WEBHOOK_SECRET is not set");
  try {
    await app.telegram.call("setWebhook", {
      url: `${workerUrl}/telegram`,
      secret_token: app.settings.webhookSecret,
      allowed_updates: ["message", "channel_post"],
      drop_pending_updates: true,
    });
    await app.telegram.call("setMyCommands", {
      commands: COMMANDS.map(([command, description]) => ({ command, description: description.slice(0, 256) })),
    });
  } finally {
    await app.budget.flush();
  }
  return { webhook: `${workerUrl}/telegram`, commands: COMMANDS.map(([c]) => `/${c}`) };
}
