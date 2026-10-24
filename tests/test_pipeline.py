import json
import time

import httpx
import pytest

from gutterwire import db
from gutterwire.config import Settings
from gutterwire.pipeline import LAST_DIGEST_KEY, build, digest_due, run_hourly, scan, send_digest
from gutterwire.skills import check, filter as filt
from gutterwire.clients import split_message

WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
GOOD = "0x" + "a" * 40      # mcap 9k, clean
BIG = "0x" + "b" * 40       # mcap 50k
NOMCAP = "0x" + "c" * 40    # fdv only -> watchlist
HONEY = "0x" + "d" * 40     # mcap 5k, honeypot
GAP = "0x" + "e" * 40       # mcap 7k, GoPlus has no data


def gecko_pool(token, symbol, base_is_weth=False):
    base, quote = (WETH, token) if base_is_weth else (token, WETH)
    return {
        "id": f"eth_0xpool{symbol}",
        "type": "pool",
        "attributes": {"address": f"0xpool{symbol}", "name": f"{symbol} / WETH",
                       "pool_created_at": "2026-10-24T10:00:00Z"},
        "relationships": {
            "base_token": {"data": {"id": f"eth_{base}", "type": "token"}},
            "quote_token": {"data": {"id": f"eth_{quote}", "type": "token"}},
            "dex": {"data": {"id": "uniswap_v2", "type": "dex"}},
        },
    }


TOKENS = {GOOD: "GOOD", BIG: "BIG", NOMCAP: "NOM", HONEY: "HONEY", GAP: "GAP"}


def gecko_payload():
    pools = [gecko_pool(GOOD, "GOOD"), gecko_pool(BIG, "BIG", base_is_weth=True),
             gecko_pool(NOMCAP, "NOM"), gecko_pool(HONEY, "HONEY"), gecko_pool(GAP, "GAP"),
             gecko_pool(GOOD, "GOOD")]  # duplicate contract
    included = [{"id": f"eth_{a}", "type": "token", "attributes": {"address": a, "symbol": s, "name": s + " Token"}}
                for a, s in TOKENS.items()]
    return {"data": pools, "included": included}


MARKET = {
    GOOD: {"marketCap": 9000, "fdv": 9000, "liq": 6000, "price": "0.000009"},
    BIG: {"marketCap": 50000, "fdv": 50000, "liq": 20000, "price": "0.00005"},
    NOMCAP: {"marketCap": None, "fdv": 3000, "liq": 2000, "price": "0.000003"},
    HONEY: {"marketCap": 5000, "fdv": 5000, "liq": 4000, "price": "0.000005"},
    GAP: {"marketCap": 7000, "fdv": 7000, "liq": 3000, "price": "0.000007"},
}


def ds_pair(addr):
    m = MARKET[addr]
    pair = {"chainId": "ethereum", "dexId": "uniswap", "url": f"https://dexscreener.com/ethereum/{addr}",
            "pairAddress": "0xpair" + addr[2:8], "baseToken": {"address": addr, "symbol": TOKENS[addr]},
            "quoteToken": {"address": WETH, "symbol": "WETH"}, "priceUsd": m["price"],
            "liquidity": {"usd": m["liq"]}, "volume": {"h24": 1234}, "fdv": m["fdv"]}
    if m["marketCap"] is not None:
        pair["marketCap"] = m["marketCap"]
    return pair


CLEAN = {k: "0" for k in check.REQUIRED_FIELDS}
CLEAN.update({"is_open_source": "1", "buy_tax": "0", "sell_tax": "0.02", "holder_count": "57"})


class FakeApis:
    def __init__(self):
        self.sent = []
        self.gemini_reply = None
        self.telegram_ok = True
        self.calls = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        host, path = request.url.host, request.url.path
        self.calls[host] = self.calls.get(host, 0) + 1
        if host == "api.geckoterminal.com":
            if request.url.params.get("page") == "1":
                return httpx.Response(200, json=gecko_payload())
            return httpx.Response(200, json={"data": [], "included": []})
        if host == "api.dexscreener.com":
            addrs = path.rsplit("/", 1)[-1].split(",")
            return httpx.Response(200, json=[ds_pair(a) for a in addrs if a in MARKET])
        if host == "api.gopluslabs.io":
            a = request.url.params["contract_addresses"]
            if a == GAP:
                return httpx.Response(200, json={"code": 1, "message": "OK", "result": {}})
            res = dict(CLEAN)
            if a == HONEY:
                res["is_honeypot"] = "1"
            return httpx.Response(200, json={"code": 1, "message": "OK", "result": {a: res}})
        if host == "generativelanguage.googleapis.com":
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": self.gemini_reply}]}}]})
        if host == "api.telegram.org":
            assert "/botTESTTOKEN/" in path
            if not self.telegram_ok:
                return httpx.Response(401, json={"ok": False, "description": "Unauthorized"})
            self.sent.append(json.loads(request.content)["text"])
            return httpx.Response(200, json={"ok": True, "result": {}})
        return httpx.Response(404)


@pytest.fixture
def fake():
    return FakeApis()


def make_app(tmp_path, fake, **kw):
    s = Settings(db_path=str(tmp_path / "t.db"), telegram_token="TESTTOKEN", telegram_chat_id="42", **kw)
    return build(s, http_client=httpx.Client(transport=httpx.MockTransport(fake)), sleep=lambda _: None)


def statuses(app):
    return {r["address"]: r["status"] for r in app.conn.execute("SELECT address, status FROM candidates")}


def test_scan_applies_rules(tmp_path, fake):
    app = make_app(tmp_path, fake)
    scan(app)
    st = statuses(app)
    assert len(st) == 5  # duplicate pool deduped, WETH never a candidate
    assert st[GOOD] == "shortlisted"
    assert st[BIG] == "rejected_filter"
    assert st[NOMCAP] == "watchlist"       # FDV present but never used as market cap
    assert st[HONEY] == "rejected_security"
    assert st[GAP] == "check_pending"      # incomplete: not shortlisted, retried next run
    scan(app); scan(app)
    assert statuses(app)[GAP] == "rejected_security"


def test_first_run_starts_clock_then_digest_after_48h(tmp_path, fake):
    app = make_app(tmp_path, fake)
    out = run_hourly(app)
    assert "digest" not in out and fake.sent == []
    last = float(db.kv_get(app.conn, LAST_DIGEST_KEY))
    assert not digest_due(app, now=last + 47 * 3600)
    assert digest_due(app, now=last + 48 * 3600)


def test_digest_template_and_calls(tmp_path, fake):
    app = make_app(tmp_path, fake)
    scan(app)
    out = send_digest(app)
    assert out["delivered"] and not out["ai_used"]
    text = fake.sent[0]
    assert GOOD in text and HONEY not in text and BIG not in text
    assert "MCap $9,000" in text and "Note: Reported market cap $9,000" in text
    assert statuses(app)[GOOD] == "called"
    call = app.conn.execute("SELECT * FROM calls").fetchone()
    assert call["market_cap_usd"] == 9000


def test_no_qualifying_candidates_message(tmp_path, fake):
    app = make_app(tmp_path, fake)
    send_digest(app)
    assert "No qualifying candidates" in fake.sent[0]


def test_failed_telegram_keeps_shortlist(tmp_path, fake):
    app = make_app(tmp_path, fake)
    scan(app)
    fake.telegram_ok = False
    out = send_digest(app)
    assert not out["delivered"]
    assert statuses(app)[GOOD] == "shortlisted"
    assert db.kv_get(app.conn, LAST_DIGEST_KEY) is None


def test_gemini_notes_used_and_guarded(tmp_path, fake):
    app = make_app(tmp_path, fake, gemini_api_key="k")
    scan(app)
    fake.gemini_reply = json.dumps({GOOD: "Small pool with liquidity near two thirds of market cap."})
    out = send_digest(app)
    assert out["ai_used"] and "two thirds" in fake.sent[0]


def test_gemini_bad_output_falls_back(tmp_path, fake):
    app = make_app(tmp_path, fake, gemini_api_key="k")
    scan(app)
    fake.gemini_reply = "Sure! Here is your summary."
    out = send_digest(app)
    assert not out["ai_used"] and "Note: Reported market cap" in fake.sent[0]


def test_gemini_note_with_foreign_address_rejected(tmp_path, fake):
    app = make_app(tmp_path, fake, gemini_api_key="k")
    scan(app)
    fake.gemini_reply = json.dumps({GOOD: "Similar to 0x" + "9" * 40})
    send_digest(app)
    assert "0x" + "9" * 40 not in fake.sent[0]


def test_gemini_daily_budget_enforced(tmp_path, fake):
    app = make_app(tmp_path, fake, gemini_api_key="k")
    app.budget.per_day["gemini"] = 0
    scan(app)
    out = send_digest(app)
    assert not out["ai_used"] and fake.calls.get("generativelanguage.googleapis.com") is None


def test_review_records_outcomes(tmp_path, fake):
    app = make_app(tmp_path, fake)
    scan(app)
    send_digest(app)
    app.conn.execute("UPDATE calls SET called_at = called_at - 25*3600")
    MARKET[GOOD]["price"] = "0.000018"
    try:
        scan(app)
    finally:
        MARKET[GOOD]["price"] = "0.000009"
    rows = app.conn.execute("SELECT checkpoint_h, outcome, price_change_pct FROM outcomes ORDER BY checkpoint_h").fetchall()
    assert [r["checkpoint_h"] for r in rows] == [1, 6, 24]
    assert rows[-1]["outcome"] == "2x+" and round(rows[-1]["price_change_pct"]) == 100
    send_digest(app)
    assert "Previous calls" in fake.sent[-1] and "2x+" in fake.sent[-1]


def test_filter_never_uses_fdv():
    assert filt.evaluate({"market_cap_usd": None, "fdv_usd": 1000}, 15000, 0)[0] == "watchlist"
    assert filt.evaluate({"market_cap_usd": 14999}, 15000, 0)[0] == "check_pending"
    assert filt.evaluate({"market_cap_usd": 15000}, 15000, 0)[0] == "rejected_filter"


def test_check_rejects_failed_and_incomplete():
    a = GOOD
    assert not check.evaluate({"code": 2020, "message": "rate"}, a, .1, .1)["passed"]
    partial = {k: v for k, v in CLEAN.items() if k != "sell_tax"}
    v = check.evaluate({"code": 1, "result": {a: partial}}, a, .1, .1)
    assert not v["passed"] and not v["complete"]
    high = dict(CLEAN, sell_tax="0.25")
    assert "tax too high" in check.evaluate({"code": 1, "result": {a: high}}, a, .1, .1)["reason"]
    assert check.evaluate({"code": 1, "result": {a: CLEAN}}, a, .1, .1)["passed"]


def test_rate_limiter_waits(tmp_path, fake):
    app = make_app(tmp_path, fake)
    waits = []
    app.budget.sleep = lambda s: (waits.append(s), app.conn.execute("DELETE FROM api_calls"))
    app.budget.per_minute["goplus"] = 2
    for _ in range(3):
        app.budget.acquire("goplus")
    assert waits  # third call had to wait


def test_split_message():
    chunks = split_message("\n".join(["x" * 100] * 100), 4000)
    assert all(len(c) <= 4000 for c in chunks) and len(chunks) == 3


def test_cmc_fills_missing_market_cap(tmp_path, fake):
    inner = fake

    def router(request):
        if request.url.host == "pro-api.coinmarketcap.com":
            assert request.headers["X-CMC_PRO_API_KEY"] == "cmckey"
            if request.url.path.endswith("/info"):
                if request.url.params["address"] != NOMCAP:
                    return httpx.Response(400, json={"status": {"error_message": "invalid"}})
                return httpx.Response(200, json={"data": {"999": {"id": 999}}})
            return httpx.Response(200, json={"data": {"999": {
                "quote": {"USD": {"market_cap": 0, "fully_diluted_market_cap": 3000}},
                "self_reported_market_cap": 4000}}})
        return inner(request)

    s = Settings(db_path=str(tmp_path / "t.db"), cmc_api_key="cmckey")
    app = build(s, http_client=httpx.Client(transport=httpx.MockTransport(router)), sleep=lambda _: None)
    scan(app)
    assert statuses(app)[NOMCAP] == "shortlisted"
    snap = db.latest_snapshot(app.conn, NOMCAP)
    assert snap["market_cap_usd"] == 4000 and snap["mcap_source"] == "coinmarketcap"
