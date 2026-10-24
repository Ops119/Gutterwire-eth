"""check: GoPlus token security. Failed or incomplete checks are rejected."""
from __future__ import annotations

import json
import logging

from .. import db
from ..budget import BudgetExceeded
from ..clients import ApiError, GoPlus

log = logging.getLogger(__name__)

# Every one of these must be present in the GoPlus result, or the check is incomplete.
REQUIRED_FIELDS = (
    "is_open_source", "is_honeypot", "buy_tax", "sell_tax", "cannot_buy", "cannot_sell_all",
    "is_proxy", "is_mintable", "hidden_owner", "can_take_back_ownership", "owner_change_balance",
    "selfdestruct", "transfer_pausable", "slippage_modifiable",
)

# "1" on any of these is a hard reject.
RED_FLAGS = {
    "is_honeypot": "honeypot",
    "cannot_buy": "cannot buy",
    "cannot_sell_all": "cannot sell all",
    "is_proxy": "upgradeable proxy",
    "is_mintable": "owner can mint",
    "hidden_owner": "hidden owner",
    "can_take_back_ownership": "ownership can be reclaimed",
    "owner_change_balance": "owner can change balances",
    "selfdestruct": "self-destruct",
    "transfer_pausable": "transfers can be paused",
    "slippage_modifiable": "tax can be changed",
    "personal_slippage_modifiable": "per-wallet tax",
    "is_blacklisted": "blacklist function",
    "trading_cooldown": "trading cooldown",
}


def evaluate(response: dict, address: str, max_buy_tax: float, max_sell_tax: float) -> dict:
    """Pure rule check on a raw GoPlus response. Returns passed/complete/reason/flags."""
    address = address.lower()
    if not isinstance(response, dict) or response.get("code") != 1:
        msg = response.get("message") if isinstance(response, dict) else "bad response"
        return {"passed": False, "complete": False, "reason": f"GoPlus error: {msg}", "flags": {}}
    result = {k.lower(): v for k, v in (response.get("result") or {}).items()}.get(address)
    if not result:
        return {"passed": False, "complete": False, "reason": "GoPlus has no data for token", "flags": {}}
    missing = [f for f in REQUIRED_FIELDS if result.get(f) in (None, "")]
    flags = {f: result.get(f) for f in REQUIRED_FIELDS + tuple(RED_FLAGS) if f in result}
    for extra in ("holder_count", "lp_holder_count", "creator_percent", "owner_address"):
        if extra in result:
            flags[extra] = result[extra]
    if missing:
        return {"passed": False, "complete": False,
                "reason": "incomplete check, missing: " + ", ".join(missing), "flags": flags}
    if str(result["is_open_source"]) != "1":
        return {"passed": False, "complete": True, "reason": "contract not verified", "flags": flags}
    hits = [label for field, label in RED_FLAGS.items() if str(result.get(field, "0")) == "1"]
    if hits:
        return {"passed": False, "complete": True, "reason": "; ".join(hits), "flags": flags}
    try:
        buy, sell = float(result["buy_tax"]), float(result["sell_tax"])
    except (TypeError, ValueError):
        return {"passed": False, "complete": False, "reason": "unparseable tax values", "flags": flags}
    if buy > max_buy_tax or sell > max_sell_tax:
        return {"passed": False, "complete": True,
                "reason": f"tax too high (buy {buy:.0%}, sell {sell:.0%})", "flags": flags}
    return {"passed": True, "complete": True, "reason": f"clean (buy {buy:.0%}, sell {sell:.0%})",
            "flags": flags}


def run(conn, goplus: GoPlus, max_buy_tax: float, max_sell_tax: float, retry_limit: int) -> dict:
    counts = {"checked": 0, "shortlisted": 0, "rejected_security": 0, "retry_later": 0}
    for r in db.candidates_with_status(conn, "check_pending"):
        addr = r["address"]
        try:
            raw = goplus.token_security(addr)
        except BudgetExceeded as e:
            log.warning("check: %s", e)
            break
        except ApiError as e:
            raw = {"code": None, "message": str(e)}
        verdict = evaluate(raw, addr, max_buy_tax, max_sell_tax)
        conn.execute(
            "INSERT INTO security_checks(address, ts, passed, complete, reason, flags, raw) VALUES (?,?,?,?,?,?,?)",
            (addr, db.now(), int(verdict["passed"]), int(verdict["complete"]), verdict["reason"],
             json.dumps(verdict["flags"]), json.dumps(raw)[:20000]),
        )
        attempts = r["check_attempts"] + 1
        conn.execute("UPDATE candidates SET check_attempts=? WHERE address=?", (attempts, addr))
        conn.commit()
        counts["checked"] += 1
        if verdict["passed"]:
            db.set_status(conn, addr, "shortlisted", verdict["reason"])
            counts["shortlisted"] += 1
        elif not verdict["complete"] and attempts < retry_limit:
            # Rejected for this run; GoPlus often lags on brand-new tokens, so look again next hour.
            db.set_status(conn, addr, "check_pending", verdict["reason"])
            counts["retry_later"] += 1
        else:
            db.set_status(conn, addr, "rejected_security", verdict["reason"])
            counts["rejected_security"] += 1
    log.info("check: %s", counts)
    return counts
