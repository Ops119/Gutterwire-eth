// brief: one short note per qualifying candidate, using only the supplied data.
// Numbers in the digest are always formatted by code. Gemini (when configured and within budget)
// only writes the free-text note; any failure falls back to a template note.

import type { Gemini } from "../clients";
import { money } from "./filter";

export interface BriefInput {
  address: string;
  symbol: string | null;
  name: string | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  price_usd: number | null;
  security: string;
  holder_count?: unknown;
  pool_created_at?: string | null;
}

const PROMPT = `You write short notes for a token-scanner digest. Use ONLY the JSON data below.
Do not add facts, prices, predictions, price targets or advice to buy or sell. Do not invent numbers.
For each token, write one or two plain sentences (max 45 words) describing what the data shows:
size, liquidity relative to market cap, trading activity, and the security result.
Return ONLY a JSON object mapping each "address" to its note, nothing else.

DATA:
`;

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;

export function templateNote(c: BriefInput): string {
  let first = `Reported market cap ${money(c.market_cap_usd)} with ${money(c.liquidity_usd)} liquidity`;
  if (c.liquidity_usd && c.market_cap_usd) first += ` (${Math.round((c.liquidity_usd / c.market_cap_usd) * 100)}% of market cap)`;
  const second = c.volume_24h_usd !== null ? `24h volume ${money(c.volume_24h_usd)}` : "no 24h volume reported";
  return `${first}; ${second}. Security check: ${c.security}.`;
}

async function aiNotes(gemini: Gemini, candidates: BriefInput[]): Promise<Map<string, string>> {
  const payload = candidates.map((c) => ({
    address: c.address, symbol: c.symbol, name: c.name, market_cap_usd: c.market_cap_usd,
    liquidity_usd: c.liquidity_usd, volume_24h_usd: c.volume_24h_usd, price_usd: c.price_usd,
    security: c.security, holder_count: c.holder_count ?? null, pool_created_at: c.pool_created_at ?? null,
  }));
  let text = (await gemini.generate(PROMPT + JSON.stringify(payload, null, 1))).trim();
  text = text.replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  const notes = JSON.parse(text);
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) throw new Error("AI output is not a JSON object");
  const allowed = new Set(candidates.map((c) => c.address.toLowerCase()));
  const clean = new Map<string, string>();
  for (const [addr, note] of Object.entries(notes)) {
    const a = addr.toLowerCase();
    if (!allowed.has(a) || typeof note !== "string") continue;
    // Guardrail: drop notes that mention addresses we did not supply.
    if ((note.match(ADDRESS_RE) ?? []).some((x) => !allowed.has(x.toLowerCase()))) continue;
    clean.set(a, note.trim().slice(0, 400));
  }
  return clean;
}

export async function brief(candidates: BriefInput[], gemini: Gemini | null) {
  let notes = new Map<string, string>();
  let aiUsed = false;
  if (gemini && candidates.length) {
    try {
      notes = await aiNotes(gemini, candidates);
      aiUsed = notes.size > 0;
    } catch (e) {
      // Any AI failure (HTTP error, budget, unparseable output) falls back to template notes.
      console.warn(`brief: AI unavailable, using template (${e instanceof Error ? e.message : String(e)})`);
      notes = new Map();
    }
  }
  for (const c of candidates) if (!notes.has(c.address.toLowerCase())) notes.set(c.address.toLowerCase(), templateNote(c));
  return { notes, aiUsed };
}
