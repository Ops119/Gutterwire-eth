# Gutterwire on Cloudflare Workers (Free plan)

The same pipeline as the Python app, ported to a TypeScript Worker so it fits the Workers Free plan:
an hourly Cron Trigger, D1 for storage, and Telegram bot commands over a webhook.

```
cron (hourly) → [digest if 48h passed] → review → discover → filter → check   (max 45 API calls per run)
Telegram webhook → /scan /shortlist /watchlist /check /calls /lastdigest /status /help
```

The rules are identical: reported market cap under $15k (FDV is never used in its place, and a missing
market cap goes to the watchlist), GoPlus failures and incomplete results are rejected, AI only writes
the notes, and the digest says "No qualifying candidates" when nothing passes.

## Digest layout

Each digest posts to the channel as:

1. A header with the window, tokens scanned and how many qualified.
2. One photo post per call (up to 8). The picture is the token's DEX Screener banner or logo, or the
   GeckoTerminal logo; if a token has none, or Telegram rejects it, a QuickChart stats card is used
   (market cap, liquidity and 24h volume). The caption holds the contract (tap to copy), market cap,
   liquidity and its share of market cap, 24h volume, price, pool age, the GoPlus result and holder
   count, the note, and DEX Screener / GeckoTerminal / Etherscan links.
3. A footer with how earlier calls did (🚀 2x+, 🟢 up, ⚪️ flat, 🟠 down, 🔴 down big, ☠️ liquidity
   pulled) and the disclaimer.

## Free plan limits and how the Worker stays inside them

| Limit (Workers Free) | How it's handled |
|---|---|
| 50 external subrequests per run | Every API call goes through `Budget`; runs stop at 45 and leftover work waits for the next hour. A due digest runs first so it always gets budget. |
| 10 ms CPU per run | Waiting on APIs and D1 doesn't count as CPU; the work per run is small JSON parsing. |
| 15 min wall time per cron run | Per-minute rate-limit waits (GoPlus 25/min) fit easily. |
| 30 s after a webhook reply | `/scan` from Telegram uses a 16-call budget so it finishes in time. |

Daily budgets per API (Gemini defaults to 20 a day) are stored in D1. A D1 lock stops the cron run and
`/scan` from overlapping, and redelivered Telegram updates are ignored.

## Bot commands

| Command | Who | What it does |
|---|---|---|
| `/scan` | admins | Runs discover, filter, check and review now |
| `/shortlist` | anyone | Tokens that passed every rule, waiting for the next digest |
| `/watchlist` | anyone | Tokens waiting for a reported market cap |
| `/check 0x…` | admins | Runs the market cap rule and GoPlus on one contract |
| `/calls` | anyone | Recent calls and their latest outcome |
| `/lastdigest` | anyone | Re-sends the last digest's text |
| `/status` | anyone | Pipeline counts, API use today, next digest time |
| `/help` | anyone | Lists the commands |

`/scan` and `/check` spend API budget, so only Telegram user ids in `TELEGRAM_ADMIN_IDS` can use them.
Anyone else gets a reply that shows their user id, which is the easy way to find yours.

`POST /setup` registers the webhook and the command menu automatically. To set the menu by hand,
send BotFather `/setcommands`, pick @Gutterwirebot and paste:

```
scan - Run a scan now (admin)
shortlist - Tokens waiting for the next digest
watchlist - Tokens waiting for a reported market cap
check - Check one contract: /check 0x... (admin)
calls - Recent calls and how they have done
lastdigest - Show the last digest
status - Pipeline counts, API budget and next digest
help - List commands
```

## Deploy

You need Node 20+ and a Cloudflare account (free).

```bash
cd worker
npm install
npx wrangler login

# 1. Database: copy the printed database_id into wrangler.toml
npx wrangler d1 create gutterwire
npm run migrate

# 2. Secrets (prompted, never stored in the repo)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN               # any long random string, e.g. `openssl rand -hex 24`
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # another random string, letters/digits only
npx wrangler secret put GEMINI_API_KEY            # optional
npx wrangler secret put CMC_API_KEY               # optional

# 3. Ship it
npm run deploy
```

Then, using the `*.workers.dev` URL that deploy prints:

```bash
URL=https://gutterwire-eth.<your-subdomain>.workers.dev
curl -X POST "$URL/setup" -H "Authorization: Bearer $ADMIN_TOKEN"     # webhook + command menu
```

4. Make @Gutterwirebot an admin of the @Gutterwire_eth channel with permission to post.
5. Send `/scan` to the bot. It replies "admin only" with your user id. Put that id in
   `TELEGRAM_ADMIN_IDS` in `wrangler.toml` and run `npm run deploy` again.
6. Optional: send a digest right away with
   `curl -X POST "$URL/digest" -H "Authorization: Bearer $ADMIN_TOKEN"`.
   Otherwise the first one goes out 48 hours after the first cron run.

`GET $URL/status` (same header) shows counts and today's API use. Logs are under
Workers & Pages → gutterwire-eth → Logs in the Cloudflare dashboard.

## Develop

```bash
npm test          # vitest; D1 is stood in by Node's built-in SQLite, every API is faked
npm run typecheck
npm run dev       # local Worker; trigger cron with curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

Not financial advice. A clean GoPlus result does not mean a token is safe.
