// Telegram layout for digests: a header post, one photo post per call, and a footer with past results.
// Uses Telegram HTML. Every tag opens and closes on one line, so line-based splitting stays valid.

import { iso } from "./db";
import type { BriefInput } from "./skills/brief";
import { money } from "./skills/filter";
import type { PastCall } from "./skills/review";

export type Qualified = BriefInput & {
  url: string | null;
  pair_address: string | null;
  mcap_source: string | null;
  image_url: string | null;
};

export interface CallPost {
  address: string;
  photos: string[]; // tried in order; text-only post if all fail
  caption: string;
}

export interface DigestLayout {
  header: string;
  posts: CallPost[];
  footer: string;
}

const RULE = "━━━━━━━━━━━━━━━━";
const CAPTION_LIMIT = 1024; // Telegram photo caption limit

export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function price(v: number | null): string {
  if (v === null) return "n/a";
  if (v >= 1) return `$${v.toFixed(4)}`;
  return `$${Number(v.toPrecision(3))}`;
}

const signed = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${Math.round(v)}%`);

function age(createdAt: string | null | undefined, now: number): string | null {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const h = Math.max(0, (now - t) / 3_600_000);
  return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}

const OUTCOME_ICON: Record<string, string> = {
  "2x+": "🚀", up: "🟢", flat: "⚪️", down: "🟠", "down big": "🔴",
  "liquidity pulled": "☠️", "pair gone": "☠️", "no price": "❔",
};

/** A stats card rendered by QuickChart, used when a token has no logo or banner. Telegram fetches it. */
export function statsCardUrl(c: Qualified): string {
  const config = {
    type: "bar",
    data: {
      labels: ["Market cap", "Liquidity", "Volume 24h"],
      datasets: [{
        data: [c.market_cap_usd ?? 0, c.liquidity_usd ?? 0, c.volume_24h_usd ?? 0].map((v) => Math.round(v)),
        backgroundColor: ["#7c5cff", "#22c55e", "#f59e0b"],
      }],
    },
    options: {
      legend: { display: false },
      title: { display: true, text: `$${c.symbol ?? "?"} · Gutterwire`, fontColor: "#e5e7eb", fontSize: 22 },
      scales: {
        yAxes: [{ ticks: { fontColor: "#9ca3af", beginAtZero: true }, gridLines: { color: "#1f2937" } }],
        xAxes: [{ ticks: { fontColor: "#e5e7eb", fontSize: 14 }, gridLines: { display: false } }],
      },
    },
  };
  return `https://quickchart.io/chart?w=800&h=420&bkg=%230b0f14&c=${encodeURIComponent(JSON.stringify(config))}`;
}

export function callCaption(c: Qualified, rank: number, note: string, now: number): string {
  const liqShare = c.liquidity_usd && c.market_cap_usd ? ` (${Math.round((c.liquidity_usd / c.market_cap_usd) * 100)}% of mcap)` : "";
  const mcapSrc = c.mcap_source && c.mcap_source !== "dexscreener" ? ` <i>via ${esc(c.mcap_source)}</i>` : "";
  const poolAge = age(c.pool_created_at, now);
  const holders = c.holder_count ? ` · ${esc(c.holder_count)} holders` : "";
  const links = [
    c.url ? `<a href="${esc(c.url)}">DEX Screener</a>` : null,
    `<a href="https://www.geckoterminal.com/eth/tokens/${c.address}">GeckoTerminal</a>`,
    `<a href="https://etherscan.io/token/${c.address}">Etherscan</a>`,
  ].filter(Boolean).join(" · ");
  const head = [
    `🟢 <b>CALL #${rank} · $${esc(c.symbol ?? "?")}</b>${c.name ? ` — ${esc(c.name)}` : ""}`,
    `<code>${c.address}</code>`,
    "",
    `💰 MCap <b>${money(c.market_cap_usd)}</b>${mcapSrc}`,
    `💧 Liquidity <b>${money(c.liquidity_usd)}</b>${liqShare}`,
    `📊 Vol 24h <b>${money(c.volume_24h_usd)}</b>`,
    `🏷 Price <b>${price(c.price_usd)}</b>${poolAge ? ` · ⏱ pool ${poolAge} old` : ""}`,
    `🛡 GoPlus: ${esc(c.security)}${holders}`,
    "",
  ];
  const tail = ["", links];
  const room = CAPTION_LIMIT - head.join("\n").length - tail.join("\n").length - 12;
  const trimmed = note.length > room ? `${note.slice(0, Math.max(0, room - 1))}…` : note;
  return [...head, `📝 <i>${esc(trimmed)}</i>`, ...tail].join("\n");
}

export function layout(
  candidates: Qualified[], notes: Map<string, string>, scanned: number, past: PastCall[],
  since: number, sentAt: number, maxMcap: number,
): DigestLayout {
  const header = [
    `⚡️ <b>GUTTERWIRE · ETH DIGEST</b>`,
    `🗓 ${iso(sentAt)}`,
    RULE,
    `🔎 Scanned since ${iso(since)}: <b>${scanned}</b> new tokens`,
    `✅ Qualified: <b>${candidates.length}</b>  (MCap &lt; ${money(maxMcap)} · GoPlus clean)`,
    RULE,
    candidates.length ? `👇 ${candidates.length === 1 ? "This window's call" : "This window's calls"}` : `😴 <b>No qualifying candidates this window.</b>`,
  ].join("\n");

  const posts = candidates.map((c, i) => ({
    address: c.address,
    photos: [c.image_url, statsCardUrl(c)].filter((u): u is string => !!u),
    caption: callCaption(c, i + 1, notes.get(c.address.toLowerCase()) ?? "", sentAt),
  }));

  const footerLines: string[] = [];
  if (past.length) {
    footerLines.push(`📈 <b>Previous calls</b>`);
    for (const p of past) {
      const who = `$${esc(p.symbol ?? p.address.slice(0, 10))} <i>(${iso(p.called_at).slice(0, 10)})</i>`;
      footerLines.push(
        p.outcome === null
          ? `⏳ ${who}: no checkpoint yet`
          : `${OUTCOME_ICON[p.outcome] ?? "•"} ${who}: price <b>${signed(p.price_change_pct)}</b> · liq ${signed(p.liquidity_change_pct)} @ ${p.checkpoint_h}h → ${esc(p.outcome)}`,
      );
    }
    footerLines.push(RULE);
  }
  footerLines.push(`⚠️ <i>Rules are mechanical; notes only describe the data above. Not financial advice.</i>`);
  return { header, posts, footer: footerLines.join("\n") };
}

/** One HTML string for the archive and /lastdigest. */
export function archiveText(l: DigestLayout): string {
  return [l.header, ...l.posts.map((p) => p.caption), l.footer].join("\n\n");
}
