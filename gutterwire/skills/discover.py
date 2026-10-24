"""discover: collect Ethereum pools from GeckoTerminal and deduplicate by token contract address."""
from __future__ import annotations

import logging

from .. import db
from ..clients import ApiError, GeckoTerminal

log = logging.getLogger(__name__)

# Quote-side assets. When one of these is the pool's base token, the other side is the candidate.
QUOTE_TOKENS = {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",  # WETH
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",  # USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7",  # USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f",  # DAI
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",  # WBTC
}


def _token_addr(token_id: str | None) -> str | None:
    # GeckoTerminal ids look like "eth_0xabc..."
    if not token_id:
        return None
    return token_id.split("_", 1)[-1].lower()


def parse_pools(payload: dict) -> list[dict]:
    included = {i["id"]: i.get("attributes", {}) for i in payload.get("included", []) if "id" in i}
    found = []
    for pool in payload.get("data", []):
        attrs = pool.get("attributes", {})
        rel = pool.get("relationships", {})
        base_id = (rel.get("base_token", {}).get("data") or {}).get("id")
        quote_id = (rel.get("quote_token", {}).get("data") or {}).get("id")
        dex_id = (rel.get("dex", {}).get("data") or {}).get("id")
        base, quote = _token_addr(base_id), _token_addr(quote_id)
        token_id, token = base_id, base
        if base in QUOTE_TOKENS and quote and quote not in QUOTE_TOKENS:
            token_id, token = quote_id, quote
        if not token or token in QUOTE_TOKENS:
            continue
        meta = included.get(token_id, {})
        found.append({
            "address": token,
            "symbol": meta.get("symbol"),
            "name": meta.get("name") or attrs.get("name"),
            "pool_address": (attrs.get("address") or "").lower() or None,
            "dex": dex_id,
            "pool_created_at": attrs.get("pool_created_at"),
        })
    return found


def run(conn, gecko: GeckoTerminal, pages: int = 3) -> dict:
    seen: dict[str, dict] = {}
    errors = 0
    for kind in ("new_pools", "trending_pools"):
        for page in range(1, pages + 1):
            try:
                payload = gecko.pools(kind, page)
            except ApiError as e:
                log.warning("discover: %s", e)
                errors += 1
                break
            pools = parse_pools(payload)
            for p in pools:
                seen.setdefault(p["address"], p)  # dedupe within this run
            if not pools:
                break
    new = sum(1 for p in seen.values() if db.upsert_candidate(conn, p))  # dedupe across runs
    log.info("discover: %d unique tokens, %d new, %d errors", len(seen), new, errors)
    return {"unique": len(seen), "new": new, "errors": errors}
