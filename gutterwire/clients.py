"""Thin httpx clients for GeckoTerminal, DEX Screener, GoPlus, Gemini and Telegram."""
from __future__ import annotations

import logging
import time

import httpx

from .budget import Budget

log = logging.getLogger(__name__)

GECKO_BASE = "https://api.geckoterminal.com/api/v2"
DEXSCREENER_BASE = "https://api.dexscreener.com"
GOPLUS_BASE = "https://api.gopluslabs.io/api/v1"
CMC_BASE = "https://pro-api.coinmarketcap.com"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
TELEGRAM_BASE = "https://api.telegram.org"

ETH_CHAIN_ID = "1"


class ApiError(Exception):
    pass


class Http:
    """Shared client: budget-gated requests with retry on 429/5xx."""

    def __init__(self, budget: Budget, client: httpx.Client | None = None, retries: int = 3,
                 sleep=time.sleep):
        self.budget = budget
        self.client = client or httpx.Client(timeout=20, headers={"User-Agent": "gutterwire-eth/1.0"})
        self.retries = retries
        self.sleep = sleep

    def request(self, api: str, method: str, url: str, **kw) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self.retries):
            self.budget.acquire(api)
            try:
                resp = self.client.request(method, url, **kw)
            except httpx.HTTPError as e:
                last = e
                self.sleep(2 ** attempt)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                retry_after = resp.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** (attempt + 1)
                log.warning("%s %s -> %s, retrying in %ss", api, method, resp.status_code, wait)
                last = ApiError(f"{api}: HTTP {resp.status_code}")
                self.sleep(min(wait, 60))
                continue
            return resp
        raise ApiError(f"{api}: request failed after {self.retries} attempts: {last}")


def _num(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class GeckoTerminal:
    def __init__(self, http: Http):
        self.http = http

    def pools(self, kind: str = "new_pools", page: int = 1) -> dict:
        resp = self.http.request(
            "geckoterminal", "GET", f"{GECKO_BASE}/networks/eth/{kind}",
            params={"page": page, "include": "base_token,quote_token,dex"},
            headers={"Accept": "application/json;version=20230302"},
        )
        if resp.status_code != 200:
            raise ApiError(f"geckoterminal {kind} page {page}: HTTP {resp.status_code}")
        return resp.json()


class DexScreener:
    def __init__(self, http: Http):
        self.http = http

    def token_pairs(self, addresses: list[str]) -> dict[str, list[dict]]:
        """Pairs per token address (lowercase), up to 30 addresses per request."""
        out: dict[str, list[dict]] = {a.lower(): [] for a in addresses}
        for i in range(0, len(addresses), 30):
            chunk = addresses[i:i + 30]
            resp = self.http.request(
                "dexscreener", "GET", f"{DEXSCREENER_BASE}/tokens/v1/ethereum/{','.join(chunk)}"
            )
            if resp.status_code != 200:
                raise ApiError(f"dexscreener tokens: HTTP {resp.status_code}")
            data = resp.json()
            pairs = data if isinstance(data, list) else data.get("pairs") or []
            for p in pairs:
                if p.get("chainId") != "ethereum":
                    continue
                base = (p.get("baseToken") or {}).get("address", "").lower()
                quote = (p.get("quoteToken") or {}).get("address", "").lower()
                for addr in (base, quote):
                    if addr in out:
                        out[addr].append(p)
        return out

    @staticmethod
    def best_snapshot(token: str, pairs: list[dict]) -> dict | None:
        """Snapshot from the deepest-liquidity pair where `token` is the base token."""
        token = token.lower()
        own = [p for p in pairs if (p.get("baseToken") or {}).get("address", "").lower() == token]
        if not own:
            return None
        best = max(own, key=lambda p: _num((p.get("liquidity") or {}).get("usd")) or 0)
        return {
            "source": "dexscreener",
            "price_usd": _num(best.get("priceUsd")),
            "liquidity_usd": _num((best.get("liquidity") or {}).get("usd")),
            "volume_24h_usd": _num((best.get("volume") or {}).get("h24")),
            "market_cap_usd": _num(best.get("marketCap")),
            "mcap_source": "dexscreener" if _num(best.get("marketCap")) else None,
            "fdv_usd": _num(best.get("fdv")),
            "pair_address": best.get("pairAddress"),
            "url": best.get("url"),
        }


class GoPlus:
    def __init__(self, http: Http):
        self.http = http

    def token_security(self, address: str) -> dict:
        """Raw GoPlus response for one Ethereum token. One address per call keeps the free tier happy."""
        resp = self.http.request(
            "goplus", "GET", f"{GOPLUS_BASE}/token_security/{ETH_CHAIN_ID}",
            params={"contract_addresses": address.lower()},
        )
        if resp.status_code != 200:
            raise ApiError(f"goplus: HTTP {resp.status_code}")
        return resp.json()


class CoinMarketCap:
    """Backup source of *reported* market cap, used only when DEX Screener reports none.

    Fully diluted values are ignored. Most sub-$15k tokens are not listed on CMC, so a miss is normal.
    """

    def __init__(self, http: Http, api_key: str):
        self.http = http
        self.headers = {"X-CMC_PRO_API_KEY": api_key, "Accept": "application/json"}

    def market_cap(self, address: str) -> float | None:
        resp = self.http.request("coinmarketcap", "GET", f"{CMC_BASE}/v2/cryptocurrency/info",
                                 params={"address": address.lower()}, headers=self.headers)
        if resp.status_code == 400:
            return None  # address not listed
        if resp.status_code != 200:
            raise ApiError(f"coinmarketcap info: HTTP {resp.status_code}")
        ids = [str(k) for k in (resp.json().get("data") or {})]
        if not ids:
            return None
        resp = self.http.request("coinmarketcap", "GET", f"{CMC_BASE}/v2/cryptocurrency/quotes/latest",
                                 params={"id": ids[0], "convert": "USD"}, headers=self.headers)
        if resp.status_code != 200:
            raise ApiError(f"coinmarketcap quotes: HTTP {resp.status_code}")
        entry = (resp.json().get("data") or {}).get(ids[0]) or {}
        if isinstance(entry, list):
            entry = entry[0] if entry else {}
        mcap = _num(((entry.get("quote") or {}).get("USD") or {}).get("market_cap"))
        if not mcap:
            mcap = _num(entry.get("self_reported_market_cap"))
        return mcap if mcap and mcap > 0 else None


class Gemini:
    def __init__(self, http: Http, api_key: str, model: str):
        self.http = http
        self.api_key = api_key
        self.model = model

    def generate(self, prompt: str) -> str:
        resp = self.http.request(
            "gemini", "POST", f"{GEMINI_BASE}/models/{self.model}:generateContent",
            headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
            json={
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1200},
            },
        )
        if resp.status_code != 200:
            raise ApiError(f"gemini: HTTP {resp.status_code}")
        data = resp.json()
        try:
            parts = data["candidates"][0]["content"]["parts"]
        except (KeyError, IndexError, TypeError):
            raise ApiError("gemini: no candidates in response")
        text = "".join(p.get("text", "") for p in parts).strip()
        if not text:
            raise ApiError("gemini: empty response")
        return text


class Telegram:
    MAX_LEN = 4000  # Bot API limit is 4096 characters

    def __init__(self, http: Http, token: str):
        self.http = http
        self.token = token

    def _url(self, method: str) -> str:
        return f"{TELEGRAM_BASE}/bot{self.token}/{method}"

    def send(self, chat_id: str, text: str) -> None:
        for chunk in split_message(text, self.MAX_LEN):
            resp = self.http.request(
                "telegram", "POST", self._url("sendMessage"),
                json={"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True},
            )
            body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            if resp.status_code != 200 or not body.get("ok"):
                raise ApiError(f"telegram sendMessage: HTTP {resp.status_code} {body.get('description', '')}")

    def recent_chats(self) -> list[dict]:
        resp = self.http.request("telegram", "GET", self._url("getUpdates"))
        body = resp.json()
        if not body.get("ok"):
            raise ApiError(f"telegram getUpdates: {body.get('description')}")
        chats = {}
        for upd in body.get("result", []):
            msg = upd.get("message") or upd.get("channel_post") or upd.get("my_chat_member") or {}
            chat = msg.get("chat")
            if chat:
                chats[chat["id"]] = chat
        return list(chats.values())


def split_message(text: str, limit: int) -> list[str]:
    chunks, current = [], ""
    for line in text.split("\n"):
        while len(line) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:limit])
            line = line[limit:]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > limit:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or [""]
