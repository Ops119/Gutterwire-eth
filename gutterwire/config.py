"""Settings. Secrets come from the environment or a gitignored .env file, never from code."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, existing env vars win."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def _f(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


def _i(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


@dataclass
class Settings:
    db_path: str = "gutterwire.db"
    telegram_token: str | None = None
    telegram_chat_id: str | None = None
    gemini_api_key: str | None = None
    cmc_api_key: str | None = None
    cmc_recheck_hours: float = 6.0
    gemini_model: str = "gemini-2.5-flash-lite"

    # Eligibility rules (code, not AI)
    max_market_cap_usd: float = 15_000.0
    min_liquidity_usd: float = 0.0
    max_buy_tax: float = 0.10
    max_sell_tax: float = 0.10
    security_retry_limit: int = 3
    watchlist_max_age_hours: int = 72

    # Discovery
    discovery_pages: int = 3

    # Schedule
    digest_interval_hours: float = 48.0
    review_days: int = 14

    # Per-minute rate limits (kept under the published limits) and daily budgets
    rate_limits: dict = field(default_factory=lambda: {
        "geckoterminal": 25,   # published 30/min
        "goplus": 25,          # published 30/min
        "dexscreener": 250,    # published 300/min on token endpoints
        "gemini": 10,
        "telegram": 20,
        "coinmarketcap": 25,   # Basic plan 30/min
    })
    daily_budgets: dict = field(default_factory=lambda: {
        "geckoterminal": 2_000,
        "goplus": 2_000,
        "dexscreener": 10_000,
        "gemini": 20,
        "telegram": 200,
        "coinmarketcap": 300,  # Basic plan ~10k credits/month
    })


def get_settings(env_file: str | os.PathLike | None = ".env") -> Settings:
    if env_file:
        load_dotenv(Path(env_file))
    s = Settings(
        db_path=os.environ.get("GUTTERWIRE_DB", "gutterwire.db"),
        telegram_token=os.environ.get("TELEGRAM_BOT_TOKEN") or None,
        telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID") or None,
        gemini_api_key=os.environ.get("GEMINI_API_KEY") or None,
        cmc_api_key=os.environ.get("CMC_API_KEY") or None,
        gemini_model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite"),
        max_market_cap_usd=_f("MAX_MARKET_CAP_USD", 15_000.0),
        min_liquidity_usd=_f("MIN_LIQUIDITY_USD", 0.0),
        max_buy_tax=_f("MAX_BUY_TAX", 0.10),
        max_sell_tax=_f("MAX_SELL_TAX", 0.10),
        discovery_pages=_i("DISCOVERY_PAGES", 3),
        digest_interval_hours=_f("DIGEST_INTERVAL_HOURS", 48.0),
        review_days=_i("REVIEW_DAYS", 14),
    )
    s.daily_budgets["gemini"] = _i("GEMINI_DAILY_BUDGET", s.daily_budgets["gemini"])
    return s
