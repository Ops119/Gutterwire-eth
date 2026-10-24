"""brief: one short note per qualifying candidate, using only the supplied data.

The numbers in the digest are always formatted by code. Gemini (when configured and within budget)
only writes the free-text note; any failure falls back to a template note.
"""
from __future__ import annotations

import json
import logging
import re

from ..budget import BudgetExceeded
from ..clients import ApiError, Gemini

log = logging.getLogger(__name__)

PROMPT = """You write short notes for a token-scanner digest. Use ONLY the JSON data below.
Do not add facts, prices, predictions, price targets or advice to buy or sell. Do not invent numbers.
For each token, write one or two plain sentences (max 45 words) describing what the data shows:
size, liquidity relative to market cap, trading activity, and the security result.
Return ONLY a JSON object mapping each "address" to its note, nothing else.

DATA:
{data}
"""

ADDRESS_RE = re.compile(r"0x[a-fA-F0-9]{40}")


def money(v: float | None) -> str:
    if v is None:
        return "n/a"
    if v >= 1_000_000:
        return f"${v / 1_000_000:,.2f}M"
    if v >= 1_000:
        return f"${v:,.0f}"
    return f"${v:,.2f}"


def price(v: float | None) -> str:
    if v is None:
        return "n/a"
    if v >= 1:
        return f"${v:,.4f}"
    return f"${v:.3g}"


def template_note(c: dict) -> str:
    liq, mcap, vol = c.get("liquidity_usd"), c.get("market_cap_usd"), c.get("volume_24h_usd")
    parts = [f"Reported market cap {money(mcap)} with {money(liq)} liquidity"]
    if liq and mcap:
        parts[0] += f" ({liq / mcap:.0%} of market cap)"
    parts.append(f"24h volume {money(vol)}" if vol is not None else "no 24h volume reported")
    note = "; ".join(parts) + f". Security check: {c.get('security', 'n/a')}."
    return note


def _ai_notes(gemini: Gemini, candidates: list[dict]) -> dict[str, str]:
    payload = [{k: c.get(k) for k in ("address", "symbol", "name", "market_cap_usd", "liquidity_usd",
                                      "volume_24h_usd", "price_usd", "security", "holder_count",
                                      "pool_created_at")} for c in candidates]
    text = gemini.generate(PROMPT.format(data=json.dumps(payload, indent=1)))
    text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    notes = json.loads(text)
    if not isinstance(notes, dict):
        raise ValueError("AI output is not a JSON object")
    allowed = {c["address"].lower() for c in candidates}
    clean = {}
    for addr, note in notes.items():
        addr = str(addr).lower()
        if addr not in allowed or not isinstance(note, str):
            continue
        # Guardrail: reject notes that mention addresses we did not supply.
        if any(a.lower() not in allowed for a in ADDRESS_RE.findall(note)):
            continue
        clean[addr] = note.strip()[:400]
    return clean


def run(candidates: list[dict], gemini: Gemini | None) -> tuple[dict[str, str], bool]:
    """Returns ({address: note}, ai_used)."""
    notes: dict[str, str] = {}
    ai_used = False
    if gemini and candidates:
        try:
            notes = _ai_notes(gemini, candidates)
            ai_used = bool(notes)
        except (ApiError, BudgetExceeded, ValueError, json.JSONDecodeError) as e:
            log.warning("brief: AI unavailable, using template (%s)", e)
            notes = {}
    for c in candidates:
        notes.setdefault(c["address"].lower(), template_note(c))
    return notes, ai_used
