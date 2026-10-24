"""filter: reported market cap must be below the cap. Missing market cap goes to the watchlist.

FDV is never substituted for market cap.
"""
from __future__ import annotations

import logging
import time

from .. import db
from ..budget import BudgetExceeded
from ..clients import ApiError, CoinMarketCap, DexScreener

log = logging.getLogger(__name__)


def evaluate(snap: dict | None, max_mcap: float, min_liquidity: float) -> tuple[str, str]:
    """Pure rule check. Returns (status, reason)."""
    if snap is None:
        return "watchlist", "no DEX Screener pair yet"
    mcap = snap.get("market_cap_usd")
    if mcap is None or mcap <= 0:
        return "watchlist", "market cap not reported"
    if mcap >= max_mcap:
        return "rejected_filter", f"market cap ${mcap:,.0f} >= ${max_mcap:,.0f}"
    liq = snap.get("liquidity_usd")
    if min_liquidity > 0 and (liq is None or liq < min_liquidity):
        return "rejected_filter", f"liquidity ${liq or 0:,.0f} below ${min_liquidity:,.0f}"
    return "check_pending", f"market cap ${mcap:,.0f} < ${max_mcap:,.0f}"


def _cmc_fill(conn, cmc: CoinMarketCap, address: str, snap: dict, recheck_h: float) -> None:
    """Fill a missing reported market cap from CoinMarketCap, at most once per `recheck_h` per token."""
    key = f"cmc_checked:{address}"
    last = db.kv_get(conn, key)
    if last and time.time() - float(last) < recheck_h * 3600:
        return
    try:
        mcap = cmc.market_cap(address)
    except (ApiError, BudgetExceeded) as e:
        log.warning("filter: coinmarketcap %s", e)
        return
    db.kv_set(conn, key, str(time.time()))
    if mcap:
        snap["market_cap_usd"] = mcap
        snap["mcap_source"] = "coinmarketcap"


def run(conn, dex: DexScreener, max_mcap: float, min_liquidity: float, watchlist_max_age_h: float,
        cmc: CoinMarketCap | None = None, cmc_recheck_h: float = 6.0) -> dict:
    rows = db.candidates_with_status(conn, "new", "watchlist")
    counts = {"checked": 0, "watchlist": 0, "rejected_filter": 0, "check_pending": 0, "expired": 0}
    if not rows:
        return counts
    try:
        pairs = dex.token_pairs([r["address"] for r in rows])
    except ApiError as e:
        log.warning("filter: %s", e)
        return counts
    for r in rows:
        snap = DexScreener.best_snapshot(r["address"], pairs.get(r["address"], []))
        if snap and snap.get("market_cap_usd") is None and cmc:
            _cmc_fill(conn, cmc, r["address"], snap, cmc_recheck_h)
        if snap:
            db.save_snapshot(conn, r["address"], snap)
        status, reason = evaluate(snap, max_mcap, min_liquidity)
        if status == "watchlist" and time.time() - r["first_seen"] > watchlist_max_age_h * 3600:
            status, reason = "expired", f"no reported market cap after {watchlist_max_age_h:.0f}h"
        db.set_status(conn, r["address"], status, reason)
        counts["checked"] += 1
        counts[status] += 1
    log.info("filter: %s", counts)
    return counts
