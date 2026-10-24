"""review: record subsequent price, liquidity and outcome for every call at fixed checkpoints."""
from __future__ import annotations

import logging
import time

from .. import db
from ..clients import ApiError, DexScreener

log = logging.getLogger(__name__)

CHECKPOINTS_H = (1, 6, 24, 48, 96, 168, 336)


def pct(new: float | None, old: float | None) -> float | None:
    if new is None or not old:
        return None
    return (new - old) / old * 100


def label(snap: dict | None, call) -> tuple[str, float | None, float | None]:
    if snap is None:
        return "pair gone", None, None
    p = pct(snap.get("price_usd"), call["price_usd"])
    lq = pct(snap.get("liquidity_usd"), call["liquidity_usd"])
    if lq is not None and lq <= -80:
        return "liquidity pulled", p, lq
    if p is None:
        return "no price", p, lq
    if p >= 100:
        return "2x+", p, lq
    if p >= 25:
        return "up", p, lq
    if p <= -50:
        return "down big", p, lq
    if p <= -10:
        return "down", p, lq
    return "flat", p, lq


def run(conn, dex: DexScreener, review_days: int) -> dict:
    cutoff = time.time() - review_days * 86400
    calls = conn.execute("SELECT * FROM calls WHERE called_at >= ?", (cutoff,)).fetchall()
    counts = {"calls": len(calls), "outcomes": 0}
    if not calls:
        return counts
    addresses = sorted({c["address"] for c in calls})
    try:
        pairs = dex.token_pairs(addresses)
    except ApiError as e:
        log.warning("review: %s", e)
        return counts
    snaps = {}
    for a in addresses:
        snaps[a] = DexScreener.best_snapshot(a, pairs.get(a, []))
        if snaps[a]:
            db.save_snapshot(conn, a, snaps[a])
    now = time.time()
    for call in calls:
        elapsed_h = (now - call["called_at"]) / 3600
        done = {r["checkpoint_h"] for r in conn.execute(
            "SELECT checkpoint_h FROM outcomes WHERE call_id=?", (call["id"],))}
        due = [h for h in CHECKPOINTS_H if h <= elapsed_h and h not in done]
        if not due:
            continue
        snap = snaps.get(call["address"])
        outcome, p, lq = label(snap, call)
        for h in due:
            conn.execute(
                """INSERT OR IGNORE INTO outcomes(call_id, checkpoint_h, ts, price_usd, liquidity_usd,
                       market_cap_usd, price_change_pct, liquidity_change_pct, outcome)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (call["id"], h, now, snap and snap.get("price_usd"), snap and snap.get("liquidity_usd"),
                 snap and snap.get("market_cap_usd"), p, lq, outcome),
            )
            counts["outcomes"] += 1
    conn.commit()
    log.info("review: %s", counts)
    return counts


def latest_outcomes(conn, since: float) -> list:
    """Latest recorded outcome for each call made since `since`."""
    return conn.execute(
        """SELECT c.id, c.address, c.called_at, cand.symbol, o.checkpoint_h, o.price_change_pct,
                  o.liquidity_change_pct, o.outcome
           FROM calls c
           JOIN candidates cand ON cand.address = c.address
           LEFT JOIN outcomes o ON o.id = (
               SELECT id FROM outcomes WHERE call_id = c.id ORDER BY checkpoint_h DESC LIMIT 1)
           WHERE c.called_at >= ?
           ORDER BY c.called_at DESC""",
        (since,),
    ).fetchall()
