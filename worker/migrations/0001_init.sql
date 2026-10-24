-- Gutterwire D1 schema. Apply with: npx wrangler d1 migrations apply gutterwire --remote
CREATE TABLE IF NOT EXISTS candidates (
    address         TEXT PRIMARY KEY,         -- lowercase token contract
    symbol          TEXT,
    name            TEXT,
    pool_address    TEXT,
    dex             TEXT,
    pool_created_at TEXT,
    image_url       TEXT,                     -- token logo from GeckoTerminal, if any
    first_seen      INTEGER NOT NULL,         -- unix ms
    updated_at      INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'new',
        -- new | watchlist | rejected_filter | check_pending | rejected_security | shortlisted | called | expired
    reason          TEXT,
    check_attempts  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_cand_status ON candidates(status, first_seen);

CREATE TABLE IF NOT EXISTS snapshots (
    id             INTEGER PRIMARY KEY,
    address        TEXT NOT NULL,
    ts             INTEGER NOT NULL,
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
    ts       INTEGER NOT NULL,
    passed   INTEGER NOT NULL,
    complete INTEGER NOT NULL,
    reason   TEXT,
    flags    TEXT
);

CREATE TABLE IF NOT EXISTS digests (
    id           INTEGER PRIMARY KEY,
    sent_at      INTEGER NOT NULL,
    n_candidates INTEGER NOT NULL,
    ai_used      INTEGER NOT NULL,
    delivered    INTEGER NOT NULL,
    text         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
    id             INTEGER PRIMARY KEY,
    address        TEXT NOT NULL,
    digest_id      INTEGER NOT NULL REFERENCES digests(id),
    called_at      INTEGER NOT NULL,
    price_usd      REAL,
    liquidity_usd  REAL,
    market_cap_usd REAL,
    pair_address   TEXT
);

CREATE TABLE IF NOT EXISTS outcomes (
    id                   INTEGER PRIMARY KEY,
    call_id              INTEGER NOT NULL REFERENCES calls(id),
    checkpoint_h         INTEGER NOT NULL,
    ts                   INTEGER NOT NULL,
    price_usd            REAL,
    liquidity_usd        REAL,
    market_cap_usd       REAL,
    price_change_pct     REAL,
    liquidity_change_pct REAL,
    outcome              TEXT NOT NULL,
    UNIQUE(call_id, checkpoint_h)
);

-- Daily API usage per service, for budget tracking.
CREATE TABLE IF NOT EXISTS api_usage (
    api   TEXT NOT NULL,
    day   TEXT NOT NULL,                      -- YYYY-MM-DD (UTC)
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (api, day)
);

CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT
);
