// discover: collect Ethereum pools from GeckoTerminal and deduplicate by token contract address.

import { ApiError, BudgetExceeded, type GeckoTerminal } from "../clients";
import { insertCandidates, type NewCandidate } from "../db";

// Quote-side assets. When one of these is the pool's base token, the other side is the candidate.
export const QUOTE_TOKENS = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
]);

// GeckoTerminal ids look like "eth_0xabc..."
const tokenAddr = (id?: string | null) => (id ? id.split("_").slice(1).join("_").toLowerCase() || null : null);

export function parsePools(payload: any): NewCandidate[] {
  const included = new Map<string, any>();
  for (const i of payload?.included ?? []) if (i?.id) included.set(i.id, i.attributes ?? {});
  const found: NewCandidate[] = [];
  for (const pool of payload?.data ?? []) {
    const attrs = pool?.attributes ?? {};
    const rel = pool?.relationships ?? {};
    const baseId: string | undefined = rel?.base_token?.data?.id;
    const quoteId: string | undefined = rel?.quote_token?.data?.id;
    const base = tokenAddr(baseId);
    const quote = tokenAddr(quoteId);
    let tokenId = baseId;
    let token = base;
    if (base && QUOTE_TOKENS.has(base) && quote && !QUOTE_TOKENS.has(quote)) {
      tokenId = quoteId;
      token = quote;
    }
    if (!token || QUOTE_TOKENS.has(token) || !/^0x[0-9a-f]{40}$/.test(token)) continue;
    const meta = (tokenId && included.get(tokenId)) || {};
    found.push({
      address: token,
      symbol: meta.symbol ?? null,
      name: meta.name ?? attrs.name ?? null,
      pool_address: attrs.address ? String(attrs.address).toLowerCase() : null,
      dex: rel?.dex?.data?.id ?? null,
      pool_created_at: attrs.pool_created_at ?? null,
      image_url: meta.image_url && !String(meta.image_url).includes("missing") ? String(meta.image_url) : null,
    });
  }
  return found;
}

export async function discover(db: D1Database, gecko: GeckoTerminal, pages: number, now: number) {
  const seen = new Map<string, NewCandidate>();
  let errors = 0;
  outer: for (const kind of ["new_pools", "trending_pools"] as const) {
    for (let page = 1; page <= (kind === "new_pools" ? pages : 1); page++) {
      try {
        const pools = parsePools(await gecko.pools(kind, page));
        for (const p of pools) if (!seen.has(p.address)) seen.set(p.address, p); // dedupe within this run
        if (!pools.length) break;
      } catch (e) {
        if (e instanceof BudgetExceeded) break outer;
        if (!(e instanceof ApiError)) throw e;
        console.warn(`discover: ${e.message}`);
        errors++;
        break;
      }
    }
  }
  const added = await insertCandidates(db, [...seen.values()], now); // dedupe across runs
  return { unique: seen.size, new: added, errors };
}
