"""SQLite storage: candidates, snapshots, security checks, calls, outcomes, digests, API usage."""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS candidates (
    address        TEXT PRIMARY KEY,          -- lowercase token contract
    symbol         TEXT,
    name           TEXT,
    pool_address   TEXT,
    dex            TEXT,
    pool_created_at TEXT,
    first_seen     REAL NOT NULL,
    updated_at     REAL NOT NULL,
    status         TEXT NOT NULL DEFAULT 'new',
        -- new | watchlist | rejected_filter | check_pending | rejected_security | shortlisted | called | expired
    reason         TEXT,
    check_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snapshots (
    id             INTEGER PRIMARY KEY,
    address        TEXT NOT NULL,
    ts             REAL NOT NULL,
    source         TEXT NOT NULL,
    price_usd      REAL,
    liquidity_usd  REAL,
    volume_24h_usd REAL,
    market_cap_usd REAL,                      -- reported market cap only
    mcap_source    TEXT,                      -- dexscreener | coinmarketcap
    fdv_usd        REAL,                      -- stored for reference, never used as market cap
    pair_address   TEXT,
    url            TEXT
);
CREATE INDEX IF NOT EXISTS ix_snap_addr ON snapshots(address, ts);
CREATE TABLE IF NOT EXISTS security_checks (
    id       INTEGER PRIMARY KEY,
    address  TEXT NOT NULL,
    ts       REAL NOT NULL,
    passed   INTEGER NOT NULL,
    complete INTEGER NOT NULL,
    reason   TEXT,
    flags    TEXT,                            -- JSON of the fields we evaluated
    raw      TEXT
);
CREATE TABLE IF NOT EXISTS digests (
    id           INTEGER PRIMARY KEY,
    sent_at      REAL NOT NULL,
    n_candidates INTEGER NOT NULL,
    ai_used      INTEGER NOT NULL,
    delivered    INTEGER NOT NULL,
    text         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
    id             INTEGER PRIMARY KEY,
    address        TEXT NOT NULL,
    digest_id      INTEGER NOT NULL REFERENCES digests(id),
    called_at      REAL NOT NULL,
    price_usd      REAL,
    liquidity_usd  REAL,
    market_cap_usd REAL,
    pair_address   TEXT
);
CREATE TABLE IF NOT EXISTS outcomes (
    id             INTEGER PRIMARY KEY,
    call_id        INTEGER NOT NULL REFERENCES calls(id),
    checkpoint_h   INTEGER NOT NULL,
    ts             REAL NOT NULL,
    price_usd      REAL,
    liquidity_usd  REAL,
    market_cap_usd REAL,
    price_change_pct REAL,
    liquidity_change_pct REAL,
    outcome        TEXT NOT NULL,
    UNIQUE(call_id, checkpoint_h)
);
CREATE TABLE IF NOT EXISTS api_calls (
    api TEXT NOT NULL,
    ts  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_api_calls ON api_calls(api, ts);
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


def now() -> float:
    return time.time()


def iso(ts: float | None) -> str:
    if ts is None:
        return "-"
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def kv_get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def kv_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()


def upsert_candidate(conn: sqlite3.Connection, c: dict) -> bool:
    """Insert a newly discovered token. Returns True if it was new (dedup by contract address)."""
    ts = now()
    cur = conn.execute(
        """INSERT OR IGNORE INTO candidates
           (address, symbol, name, pool_address, dex, pool_created_at, first_seen, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')""",
        (c["address"], c.get("symbol"), c.get("name"), c.get("pool_address"), c.get("dex"),
         c.get("pool_created_at"), ts, ts),
    )
    conn.commit()
    return cur.rowcount == 1


def set_status(conn: sqlite3.Connection, address: str, status: str, reason: str | None = None) -> None:
    conn.execute(
        "UPDATE candidates SET status=?, reason=?, updated_at=? WHERE address=?",
        (status, reason, now(), address),
    )
    conn.commit()


def candidates_with_status(conn: sqlite3.Connection, *statuses: str) -> list[sqlite3.Row]:
    q = ",".join("?" * len(statuses))
    return conn.execute(
        f"SELECT * FROM candidates WHERE status IN ({q}) ORDER BY first_seen", statuses
    ).fetchall()


def save_snapshot(conn: sqlite3.Connection, address: str, snap: dict) -> None:
    conn.execute(
        """INSERT INTO snapshots(address, ts, source, price_usd, liquidity_usd, volume_24h_usd,
                                 market_cap_usd, mcap_source, fdv_usd, pair_address, url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (address, now(), snap.get("source", "dexscreener"), snap.get("price_usd"),
         snap.get("liquidity_usd"), snap.get("volume_24h_usd"), snap.get("market_cap_usd"),
         snap.get("mcap_source"), snap.get("fdv_usd"), snap.get("pair_address"), snap.get("url")),
    )
    conn.commit()


def latest_snapshot(conn: sqlite3.Connection, address: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM snapshots WHERE address=? ORDER BY ts DESC, id DESC LIMIT 1", (address,)
    ).fetchone()


def latest_security(conn: sqlite3.Connection, address: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM security_checks WHERE address=? ORDER BY ts DESC, id DESC LIMIT 1", (address,)
    ).fetchone()
