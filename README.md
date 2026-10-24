# Gutterwire (ETH)

Hourly scanner for new Ethereum tokens with a Telegram digest every 48 hours.
Eligibility rules, rate limits and budgets live in code. AI (Gemini free tier) only writes a short
note per shortlisted token, from the supplied data; a template note is used whenever AI is off,
over budget or returns anything unusable.

> **Running on Cloudflare?** The `worker/` folder has a TypeScript port for the Workers Free plan
> (cron trigger, D1, Telegram bot commands, photo call posts). See [worker/README.md](worker/README.md).

## Flow

```
cron (hourly) → discover → filter → check → shortlist (SQLite) → review
                                              └─ every 48h: re-verify → brief → Telegram digest
```

| Skill | What it does | Source |
|---|---|---|
| `discover` | New and trending ETH pools, deduplicated by token contract address | GeckoTerminal |
| `filter` | Reported market cap must be below $15k. Missing market cap → watchlist (rechecked hourly for 72h). FDV is never used as market cap | DEX Screener, CoinMarketCap as backup |
| `check` | GoPlus token security. API errors and missing fields are rejected; incomplete results are retried up to 3 runs, then rejected | GoPlus |
| `brief` | One or two sentence note per candidate, data-only | Gemini or template |
| `review` | Price, liquidity and outcome for every call at 1h, 6h, 24h, 48h, 4d, 7d and 14d | DEX Screener |

At digest time every shortlisted token is re-checked against the same rules with fresh data, so
nothing stale gets sent. If nothing passes, the digest says "No qualifying candidates this window."
Each digest also lists how earlier calls have done.

### Security rejects

Unverified source, honeypot, cannot buy / cannot sell all, upgradeable proxy, mintable, hidden owner,
reclaimable ownership, owner can change balances, self-destruct, pausable transfers, modifiable or
per-wallet tax, blacklist function, trading cooldown, buy or sell tax above 10%. Edit `RED_FLAGS` in
`gutterwire/skills/check.py` to change this.

### Rate limits and budgets

Every API call goes through `gutterwire/budget.py`, which records calls in SQLite so limits hold
across cron runs. Per-minute limits sit under the published ones (GeckoTerminal and GoPlus 25/min,
DEX Screener 250/min, CoinMarketCap 25/min). Daily caps stop runaway usage; Gemini defaults to 20
calls a day, and the digest uses one call. `python -m gutterwire status` shows today's usage.

## Setup

```bash
git clone <repo> /opt/gutterwire-eth && cd /opt/gutterwire-eth
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && chmod 600 .env   # then fill in TELEGRAM_BOT_TOKEN etc.
```

1. Open @Gutterwirebot in Telegram and send it any message (or add it to a group or channel).
2. `.venv/bin/python -m gutterwire chats` prints the chat id; put it in `TELEGRAM_CHAT_ID`.
3. Optional: add `GEMINI_API_KEY` (from Google AI Studio) and `CMC_API_KEY`.
4. Try it: `.venv/bin/python -m gutterwire scan` then `.venv/bin/python -m gutterwire digest --dry-run`.
5. Install the cron line from `deploy/crontab.txt` (`mkdir logs` first).

The first `run` starts the 48h clock; `python -m gutterwire digest` sends one immediately.

Secrets are read only from the environment or `.env`, which is gitignored. Do not commit them.

## Commands

```
python -m gutterwire run              # hourly job
python -m gutterwire scan             # pipeline without sending
python -m gutterwire digest [--dry-run]
python -m gutterwire status
python -m gutterwire chats
```

## Tests

```bash
pip install -r requirements-dev.txt && pytest -q
```

Tests mock every API with `httpx.MockTransport`; no network or keys needed.

Not financial advice. Sub-$15k tokens are extremely high risk and a clean GoPlus result does not
mean a token is safe.
