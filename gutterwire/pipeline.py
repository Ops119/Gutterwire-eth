"""Operating flow: hourly discover -> filter -> check -> shortlist -> review, digest every 48h."""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

from . import db
from .budget import Budget, BudgetExceeded
from .clients import (ApiError, CoinMarketCap, DexScreener, GeckoTerminal, Gemini, GoPlus, Http,
                      Telegram)
from .config import Settings
from .skills import brief, check, discover, filter as filt, review

log = logging.getLogger(__name__)

LAST_DIGEST_KEY = "last_digest_at"


@dataclass
class App:
    settings: Settings
    conn: object
    budget: Budget
    gecko: GeckoTerminal
    dex: DexScreener
    goplus: GoPlus
    cmc: CoinMarketCap | None
    gemini: Gemini | None
    telegram: Telegram | None


def build(settings: Settings, http_client=None, sleep=time.sleep) -> App:
    conn = db.connect(settings.db_path)
    budget = Budget(conn, settings.rate_limits, settings.daily_budgets, sleep=sleep)
    http = Http(budget, client=http_client, sleep=sleep)
    return App(
        settings=settings, conn=conn, budget=budget,
        gecko=GeckoTerminal(http), dex=DexScreener(http), goplus=GoPlus(http),
        cmc=CoinMarketCap(http, settings.cmc_api_key) if settings.cmc_api_key else None,
        gemini=Gemini(http, settings.gemini_api_key, settings.gemini_model) if settings.gemini_api_key else None,
        telegram=Telegram(http, settings.telegram_token) if settings.telegram_token else None,
    )


def scan(app: App) -> dict:
    s = app.settings
    out = {}
    for name, step in (
        ("discover", lambda: discover.run(app.conn, app.gecko, s.discovery_pages)),
        ("filter", lambda: filt.run(app.conn, app.dex, s.max_market_cap_usd, s.min_liquidity_usd,
                                    s.watchlist_max_age_hours, app.cmc, s.cmc_recheck_hours)),
        ("check", lambda: check.run(app.conn, app.goplus, s.max_buy_tax, s.max_sell_tax,
                                    s.security_retry_limit)),
        ("review", lambda: review.run(app.conn, app.dex, s.review_days)),
    ):
        try:
            out[name] = step()
        except BudgetExceeded as e:
            log.warning("%s skipped: %s", name, e)
            out[name] = {"skipped": str(e)}
    app.budget.prune()
    return out


def digest_due(app: App, now: float | None = None) -> bool:
    now = now or time.time()
    last = db.kv_get(app.conn, LAST_DIGEST_KEY)
    if last is None:
        # First run starts the clock; the first digest goes out one interval later.
        # Use `python -m gutterwire digest` to send one immediately.
        db.kv_set(app.conn, LAST_DIGEST_KEY, str(now))
        return False
    return now - float(last) >= app.settings.digest_interval_hours * 3600


def _requalify(app: App) -> list[dict]:
    """Re-apply the fixed rules to the shortlist with fresh data right before sending."""
    s = app.settings
    rows = db.candidates_with_status(app.conn, "shortlisted")
    if not rows:
        return []
    pairs = app.dex.token_pairs([r["address"] for r in rows])
    qualified = []
    for r in rows:
        addr = r["address"]
        snap = DexScreener.best_snapshot(addr, pairs.get(addr, []))
        if snap and snap.get("market_cap_usd") is None and app.cmc:
            filt._cmc_fill(app.conn, app.cmc, addr, snap, 0)
        if snap:
            db.save_snapshot(app.conn, addr, snap)
        status, reason = filt.evaluate(snap, s.max_market_cap_usd, s.min_liquidity_usd)
        if status != "check_pending":
            db.set_status(app.conn, addr, status, f"dropped at digest: {reason}")
            continue
        try:
            raw = app.goplus.token_security(addr)
        except ApiError as e:
            raw = {"code": None, "message": str(e)}
        verdict = check.evaluate(raw, addr, s.max_buy_tax, s.max_sell_tax)
        app.conn.execute(
            "INSERT INTO security_checks(address, ts, passed, complete, reason, flags, raw) VALUES (?,?,?,?,?,?,?)",
            (addr, db.now(), int(verdict["passed"]), int(verdict["complete"]), verdict["reason"],
             json.dumps(verdict["flags"]), json.dumps(raw)[:20000]),
        )
        app.conn.commit()
        if not verdict["passed"]:
            db.set_status(app.conn, addr, "rejected_security", f"dropped at digest: {verdict['reason']}")
            continue
        qualified.append({
            "address": addr, "symbol": r["symbol"], "name": r["name"], "dex": r["dex"],
            "pool_created_at": r["pool_created_at"], **snap,
            "security": verdict["reason"], "holder_count": verdict["flags"].get("holder_count"),
        })
    qualified.sort(key=lambda c: c["market_cap_usd"])
    return qualified


def _window_stats(app: App, since: float) -> dict:
    rows = app.conn.execute(
        "SELECT status, COUNT(*) AS n FROM candidates WHERE first_seen >= ? GROUP BY status", (since,)
    ).fetchall()
    stats = {r["status"]: r["n"] for r in rows}
    stats["total"] = sum(stats.values())
    return stats


def compose(candidates: list[dict], notes: dict, stats: dict, past: list, since: float,
            sent_at: float, max_mcap: float = 15_000) -> str:
    lines = [f"GUTTERWIRE · ETH digest · {db.iso(sent_at)}",
             f"Window since {db.iso(since)}: {stats.get('total', 0)} new tokens scanned, "
             f"{len(candidates)} qualified (reported mcap < {brief.money(max_mcap)} + GoPlus clean).", ""]
    if not candidates:
        lines.append("No qualifying candidates this window.")
    for i, c in enumerate(candidates, 1):
        src = "" if c.get("mcap_source") == "dexscreener" else f" ({c.get('mcap_source')})"
        lines += [
            f"{i}) {c.get('symbol') or '?'} · {c.get('name') or ''}".rstrip(" ·"),
            f"   CA: {c['address']}",
            f"   MCap {brief.money(c.get('market_cap_usd'))}{src} · Liq {brief.money(c.get('liquidity_usd'))}"
            f" · Vol24h {brief.money(c.get('volume_24h_usd'))} · Price {brief.price(c.get('price_usd'))}",
            f"   Security: {c.get('security')}"
            + (f" · holders {c['holder_count']}" if c.get("holder_count") else ""),
            f"   Note: {notes.get(c['address'].lower(), '')}",
        ]
        if c.get("url"):
            lines.append(f"   {c['url']}")
        lines.append("")
    if past:
        lines.append("Previous calls (latest checkpoint):")
        for p in past:
            if p["outcome"] is None:
                lines.append(f"- {p['symbol'] or p['address'][:10]} (called {db.iso(p['called_at'])[:10]}): "
                             "no checkpoint yet")
                continue
            ch = f"{p['price_change_pct']:+.0f}%" if p["price_change_pct"] is not None else "n/a"
            lq = f"{p['liquidity_change_pct']:+.0f}%" if p["liquidity_change_pct"] is not None else "n/a"
            lines.append(f"- {p['symbol'] or p['address'][:10]} (called {db.iso(p['called_at'])[:10]}): "
                         f"price {ch}, liquidity {lq} at {p['checkpoint_h']}h → {p['outcome']}")
        lines.append("")
    lines.append("Rules are mechanical; notes only describe the data above. Not financial advice.")
    return "\n".join(lines)


def send_digest(app: App, now: float | None = None) -> dict:
    s = app.settings
    now = now or time.time()
    last = db.kv_get(app.conn, LAST_DIGEST_KEY)
    since = float(last) if last else now - s.digest_interval_hours * 3600

    candidates = _requalify(app)
    notes, ai_used = brief.run(candidates, app.gemini)
    past = review.latest_outcomes(app.conn, now - s.review_days * 86400)
    text = compose(candidates, notes, _window_stats(app, since), past, since, now,
                   s.max_market_cap_usd)

    delivered = False
    if app.telegram and s.telegram_chat_id:
        try:
            app.telegram.send(s.telegram_chat_id, text)
            delivered = True
        except (ApiError, BudgetExceeded) as e:
            log.error("digest: Telegram send failed: %s", e)
    else:
        log.warning("digest: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; not sending")

    cur = app.conn.execute(
        "INSERT INTO digests(sent_at, n_candidates, ai_used, delivered, text) VALUES (?,?,?,?,?)",
        (now, len(candidates), int(ai_used), int(delivered), text),
    )
    digest_id = cur.lastrowid
    if delivered:
        for c in candidates:
            app.conn.execute(
                """INSERT INTO calls(address, digest_id, called_at, price_usd, liquidity_usd,
                                     market_cap_usd, pair_address) VALUES (?,?,?,?,?,?,?)""",
                (c["address"], digest_id, now, c.get("price_usd"), c.get("liquidity_usd"),
                 c.get("market_cap_usd"), c.get("pair_address")),
            )
            db.set_status(app.conn, c["address"], "called", "sent in digest")
        db.kv_set(app.conn, LAST_DIGEST_KEY, str(now))
    app.conn.commit()
    return {"digest_id": digest_id, "candidates": len(candidates), "ai_used": ai_used,
            "delivered": delivered, "text": text}


def run_hourly(app: App, force_digest: bool = False) -> dict:
    out = {"scan": scan(app)}
    if force_digest or digest_due(app):
        try:
            out["digest"] = send_digest(app)
        except (ApiError, BudgetExceeded) as e:
            # Leave the timestamp alone so the next hourly run retries.
            log.error("digest failed, will retry next run: %s", e)
            out["digest"] = {"error": str(e)}
    return out
