import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, parseCommand } from "../src/bot";
import { splitMessage } from "../src/clients";
import type { Env } from "../src/config";
import { kvGet } from "../src/db";
import { build, digestDue, LAST_DIGEST_KEY, runHourly, scan, sendDigest } from "../src/pipeline";
import { evaluate as checkEval, REQUIRED_FIELDS } from "../src/skills/check";
import { evaluate as filterEval } from "../src/skills/filter";
import { FakeD1 } from "./fakeD1";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const GOOD = "0x" + "a".repeat(40); // mcap 9k, clean
const BIG = "0x" + "b".repeat(40); // mcap 50k
const NOMCAP = "0x" + "c".repeat(40); // fdv only -> watchlist
const HONEY = "0x" + "d".repeat(40); // mcap 5k, honeypot
const GAP = "0x" + "e".repeat(40); // mcap 7k, GoPlus has no data
const TOKENS: Record<string, string> = { [GOOD]: "GOOD", [BIG]: "BIG", [NOMCAP]: "NOM", [HONEY]: "HONEY", [GAP]: "GAP" };

const pool = (token: string, sym: string, baseIsWeth = false) => {
  const [base, quote] = baseIsWeth ? [WETH, token] : [token, WETH];
  return {
    id: `eth_0xpool${sym}`,
    type: "pool",
    attributes: { address: `0xpool${sym}`, name: `${sym} / WETH`, pool_created_at: "2026-10-24T10:00:00Z" },
    relationships: {
      base_token: { data: { id: `eth_${base}`, type: "token" } },
      quote_token: { data: { id: `eth_${quote}`, type: "token" } },
      dex: { data: { id: "uniswap_v2", type: "dex" } },
    },
  };
};

const geckoPayload = () => ({
  data: [pool(GOOD, "GOOD"), pool(BIG, "BIG", true), pool(NOMCAP, "NOM"), pool(HONEY, "HONEY"), pool(GAP, "GAP"),
    pool(GOOD, "GOOD")], // duplicate contract
  included: Object.entries(TOKENS).map(([a, s]) => ({ id: `eth_${a}`, type: "token", attributes: { address: a, symbol: s, name: `${s} Token` } })),
});

let MARKET: Record<string, { marketCap: number | null; fdv: number; liq: number; price: string }>;

const dsPair = (addr: string) => {
  const m = MARKET[addr];
  const p: any = {
    chainId: "ethereum", dexId: "uniswap", url: `https://dexscreener.com/ethereum/${addr}`,
    pairAddress: "0xpair" + addr.slice(2, 8), baseToken: { address: addr, symbol: TOKENS[addr] },
    quoteToken: { address: WETH, symbol: "WETH" }, priceUsd: m.price, liquidity: { usd: m.liq },
    volume: { h24: 1234 }, fdv: m.fdv,
  };
  if (m.marketCap !== null) p.marketCap = m.marketCap;
  if (addr === GOOD) p.info = { header: "https://img.example/good-banner.png" };
  return p;
};

const CLEAN: Record<string, string> = Object.fromEntries(REQUIRED_FIELDS.map((f) => [f, "0"]));
Object.assign(CLEAN, { is_open_source: "1", buy_tax: "0", sell_tax: "0.02", holder_count: "57" });

class FakeApis {
  sent: { chat: unknown; text: string; photo?: string; html?: boolean }[] = [];
  badPhotos = new Set<string>();
  calls: Record<string, number> = {};
  geminiReply: string | null = null;
  telegramOk = true;
  methods: string[] = [];

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    this.calls[u.host] = (this.calls[u.host] ?? 0) + 1;
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    switch (u.host) {
      case "api.geckoterminal.com":
        return json(u.searchParams.get("page") === "1" ? geckoPayload() : { data: [], included: [] });
      case "api.dexscreener.com": {
        const addrs = u.pathname.split("/").pop()!.split(",");
        return json(addrs.filter((a) => a in MARKET).map(dsPair));
      }
      case "api.gopluslabs.io": {
        const a = u.searchParams.get("contract_addresses")!;
        if (a === GAP) return json({ code: 1, message: "OK", result: {} });
        const res = { ...CLEAN, ...(a === HONEY ? { is_honeypot: "1" } : {}) };
        return json({ code: 1, message: "OK", result: { [a]: res } });
      }
      case "generativelanguage.googleapis.com":
        return json({ candidates: [{ content: { parts: [{ text: this.geminiReply }] } }] });
      case "api.telegram.org": {
        expect(u.pathname.startsWith("/botTESTTOKEN/")).toBe(true);
        const method = u.pathname.split("/").pop()!;
        this.methods.push(method);
        if (!this.telegramOk) return json({ ok: false, description: "Unauthorized" }, 401);
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (method === "sendPhoto") {
          if (this.badPhotos.has(body.photo)) return json({ ok: false, description: "Bad Request: wrong file" }, 400);
          this.sent.push({ chat: body.chat_id, text: body.caption, photo: body.photo, html: body.parse_mode === "HTML" });
        }
        if (method === "sendMessage") this.sent.push({ chat: body.chat_id, text: body.text, html: body.parse_mode === "HTML" });
        return json({ ok: true, result: true });
      }
    }
    return new Response("not found", { status: 404 });
  };
}

let db: FakeD1;
let apis: FakeApis;
let clock: number;

const env = (extra: Partial<Env> = {}): Env => ({
  DB: db as unknown as D1Database,
  TELEGRAM_BOT_TOKEN: "TESTTOKEN",
  TELEGRAM_CHAT_ID: "@Gutterwire_eth",
  TELEGRAM_ADMIN_IDS: "111",
  ...extra,
});
const makeApp = (extra: Partial<Env> = {}) =>
  build(env(extra), { fetcher: apis.fetch, sleep: async () => {}, now: () => clock });

const allText = () => apis.sent.map((m) => m.text).join("\n");
const statuses = () =>
  Object.fromEntries(
    db.db.prepare("SELECT address, status FROM candidates").all().map((r: any) => [r.address, r.status]),
  ) as Record<string, string>;

beforeEach(() => {
  db = new FakeD1();
  apis = new FakeApis();
  clock = Date.UTC(2026, 9, 24, 12);
  MARKET = {
    [GOOD]: { marketCap: 9000, fdv: 9000, liq: 6000, price: "0.000009" },
    [BIG]: { marketCap: 50000, fdv: 50000, liq: 20000, price: "0.00005" },
    [NOMCAP]: { marketCap: null, fdv: 3000, liq: 2000, price: "0.000003" },
    [HONEY]: { marketCap: 5000, fdv: 5000, liq: 4000, price: "0.000005" },
    [GAP]: { marketCap: 7000, fdv: 7000, liq: 3000, price: "0.000007" },
  };
});

describe("pipeline", () => {
  it("applies the rules", async () => {
    await scan(await makeApp());
    const st = statuses();
    expect(Object.keys(st)).toHaveLength(5); // duplicate pool deduped, WETH never a candidate
    expect(st[GOOD]).toBe("shortlisted");
    expect(st[BIG]).toBe("rejected_filter");
    expect(st[NOMCAP]).toBe("watchlist"); // FDV present but never used as market cap
    expect(st[HONEY]).toBe("rejected_security");
    expect(st[GAP]).toBe("check_pending"); // incomplete: not shortlisted, retried next run
    await scan(await makeApp());
    await scan(await makeApp());
    expect(statuses()[GAP]).toBe("rejected_security");
  });

  it("starts the 48h clock on the first run", async () => {
    const out = await runHourly(await makeApp());
    expect(out.digest).toBeUndefined();
    expect(apis.sent).toHaveLength(0);
    const app = await makeApp();
    clock += 47 * 3_600_000;
    expect(await digestDue(app)).toBe(false);
    clock += 3_600_000;
    expect(await digestDue(app)).toBe(true);
  });

  it("sends a template digest to the channel and records calls", async () => {
    await scan(await makeApp());
    const out = await sendDigest(await makeApp());
    expect(out.delivered).toBe(true);
    expect(out.aiUsed).toBe(false);
    expect(out.posted).toBe(1);
    // header, one photo post per call, footer
    expect(apis.sent.map((m) => (m.photo ? "photo" : "text"))).toEqual(["text", "photo", "text"]);
    expect(apis.sent.every((m) => m.chat === "@Gutterwire_eth" && m.html)).toBe(true);
    const [header, call, footer] = apis.sent;
    expect(header.text).toContain("GUTTERWIRE · ETH DIGEST");
    expect(header.text).toContain("Qualified: <b>1</b>");
    expect(call.photo).toBe("https://img.example/good-banner.png");
    expect(call.text).toContain(`<code>${GOOD}</code>`);
    expect(call.text).toContain("💰 MCap <b>$9,000</b>");
    expect(call.text).toContain("Reported market cap $9,000");
    expect(call.text.length).toBeLessThanOrEqual(1024);
    expect(footer.text).toContain("Not financial advice");
    expect(allText()).not.toContain(HONEY);
    expect(allText()).not.toContain(BIG);
    expect(statuses()[GOOD]).toBe("called");
    expect(db.db.prepare("SELECT market_cap_usd FROM calls").get().market_cap_usd).toBe(9000);
  });

  it('says "no qualifying candidates" when nothing passes', async () => {
    await sendDigest(await makeApp());
    expect(apis.sent[0].text).toContain("No qualifying candidates");
    expect(apis.sent.filter((m) => m.photo)).toHaveLength(0);
  });

  it("keeps the shortlist when Telegram fails", async () => {
    await scan(await makeApp());
    apis.telegramOk = false;
    const out = await sendDigest(await makeApp());
    expect(out.delivered).toBe(false);
    expect(statuses()[GOOD]).toBe("shortlisted");
    expect(await kvGet(db as unknown as D1Database, LAST_DIGEST_KEY)).toBeNull();
  });

  it("uses Gemini notes when valid", async () => {
    await scan(await makeApp());
    apis.geminiReply = JSON.stringify({ [GOOD]: "Small pool with liquidity near two thirds of market cap." });
    const out = await sendDigest(await makeApp({ GEMINI_API_KEY: "k" }));
    expect(out.aiUsed).toBe(true);
    expect(allText()).toContain("two thirds");
  });

  it("falls back to template notes on bad AI output", async () => {
    await scan(await makeApp());
    apis.geminiReply = "Sure! Here is your summary.";
    const out = await sendDigest(await makeApp({ GEMINI_API_KEY: "k" }));
    expect(out.aiUsed).toBe(false);
    expect(allText()).toContain("Reported market cap");
  });

  it("drops AI notes that mention addresses it was not given", async () => {
    await scan(await makeApp());
    apis.geminiReply = JSON.stringify({ [GOOD]: "Similar to 0x" + "9".repeat(40) });
    await sendDigest(await makeApp({ GEMINI_API_KEY: "k" }));
    expect(allText()).not.toContain("9".repeat(40));
  });

  it("enforces the Gemini daily budget", async () => {
    await scan(await makeApp());
    const out = await sendDigest(await makeApp({ GEMINI_API_KEY: "k", GEMINI_DAILY_BUDGET: "0" }));
    expect(out.aiUsed).toBe(false);
    expect(apis.calls["generativelanguage.googleapis.com"]).toBeUndefined();
  });

  it("never exceeds the per-run subrequest cap", async () => {
    const app = await makeApp({ SUBREQUESTS_PER_RUN: "4" });
    await runHourly(app);
    const total = Object.values(apis.calls).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(4);
    // Usage is persisted for daily budgets
    const used = db.db.prepare("SELECT SUM(count) AS n FROM api_usage").get().n;
    expect(used).toBe(total);
  });

  it("records outcomes for calls at checkpoints", async () => {
    await scan(await makeApp());
    await sendDigest(await makeApp());
    clock += 25 * 3_600_000;
    MARKET[GOOD].price = "0.000018";
    await scan(await makeApp());
    const rows = db.db.prepare("SELECT checkpoint_h, outcome, price_change_pct FROM outcomes ORDER BY checkpoint_h").all();
    expect(rows.map((r: any) => r.checkpoint_h)).toEqual([1, 6, 24]);
    expect(rows[2].outcome).toBe("2x+");
    expect(Math.round(rows[2].price_change_pct)).toBe(100);
    await sendDigest(await makeApp());
    expect(apis.sent.at(-1)!.text).toContain("Previous calls");
    expect(apis.sent.at(-1)!.text).toContain("🚀");
    expect(apis.sent.at(-1)!.text).toContain("+100%");
  });

  it("uses CoinMarketCap for a missing reported market cap, never FDV", async () => {
    const base = apis.fetch;
    apis.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.host !== "pro-api.coinmarketcap.com") return base(url, init);
      if (u.pathname.endsWith("/info")) {
        return u.searchParams.get("address") === NOMCAP
          ? Response.json({ data: { "999": { id: 999 } } })
          : Response.json({ status: {} }, { status: 400 });
      }
      return Response.json({ data: { "999": { quote: { USD: { market_cap: 0, fully_diluted_market_cap: 3000 } }, self_reported_market_cap: 4000 } } });
    };
    await scan(await makeApp({ CMC_API_KEY: "cmc" }));
    expect(statuses()[NOMCAP]).toBe("shortlisted");
    const snap = db.db.prepare("SELECT market_cap_usd, mcap_source FROM snapshots WHERE address = ? ORDER BY id DESC").get(NOMCAP);
    expect(snap).toEqual({ market_cap_usd: 4000, mcap_source: "coinmarketcap" });
  });

  it("falls back to a stats card when the token picture is rejected", async () => {
    await scan(await makeApp());
    apis.badPhotos.add("https://img.example/good-banner.png");
    await sendDigest(await makeApp());
    const call = apis.sent.find((m) => m.photo)!;
    expect(call.photo).toMatch(/^https:\/\/quickchart\.io\/chart\?/);
    expect(decodeURIComponent(call.photo!)).toContain("$GOOD · Gutterwire");
  });

  it("escapes token names in the HTML layout", async () => {
    TOKENS[GOOD] = "<b>X&Y";
    try {
      await scan(await makeApp());
      await sendDigest(await makeApp());
    } finally {
      TOKENS[GOOD] = "GOOD";
    }
    const call = apis.sent.find((m) => m.photo)!;
    expect(call.text).toContain("$&lt;b&gt;X&amp;Y");
  });

  it("does not overlap runs", async () => {
    db.db.prepare("INSERT INTO kv(key, value) VALUES ('lock:run', ?)").run(String(clock));
    expect(await runHourly(await makeApp())).toEqual({ skipped: "another run is in progress" });
    clock += 16 * 60_000; // stale lock is taken over
    expect((await runHourly(await makeApp())).scan).toBeDefined();
  });
});

describe("rules", () => {
  it("never uses FDV as market cap", () => {
    const snap = (m: number | null) => ({ market_cap_usd: m, fdv_usd: 1000 }) as any;
    expect(filterEval(snap(null), 15000, 0)[0]).toBe("watchlist");
    expect(filterEval(snap(14999), 15000, 0)[0]).toBe("check_pending");
    expect(filterEval(snap(15000), 15000, 0)[0]).toBe("rejected_filter");
  });

  it("rejects failed and incomplete security checks", () => {
    expect(checkEval({ code: 2020, message: "rate" }, GOOD, 0.1, 0.1).passed).toBe(false);
    const { sell_tax: _, ...partial } = CLEAN;
    const v = checkEval({ code: 1, result: { [GOOD]: partial } }, GOOD, 0.1, 0.1);
    expect(v.passed).toBe(false);
    expect(v.complete).toBe(false);
    expect(checkEval({ code: 1, result: { [GOOD]: { ...CLEAN, sell_tax: "0.25" } } }, GOOD, 0.1, 0.1).reason).toContain("tax too high");
    expect(checkEval({ code: 1, result: { [GOOD]: CLEAN } }, GOOD, 0.1, 0.1).passed).toBe(true);
  });

  it("splits long Telegram messages", () => {
    const chunks = splitMessage(Array(100).fill("x".repeat(100)).join("\n"), 4000);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
    expect(chunks).toHaveLength(3);
  });
});

describe("bot commands", () => {
  let updateId = 1;
  const send = async (text: string, from = 111) => {
    const later = await handleUpdate(env(), { update_id: updateId++, message: { text, chat: { id: 5 }, from: { id: from } } });
    if (later) await later();
    return apis.sent.at(-1)!.text;
  };
  // handleUpdate builds its own app with the real fetch; route it through the fakes instead.
  beforeEach(() => {
    (globalThis as any).fetch = (url: string, init?: RequestInit) => apis.fetch(url, init);
  });

  it("parses commands with a bot suffix", () => {
    expect(parseCommand("/scan@Gutterwirebot now")).toEqual({ cmd: "scan", args: ["now"] });
    expect(parseCommand("hello")).toBeNull();
  });

  it("/help lists all eight commands", async () => {
    const text = await send("/help");
    for (const c of ["/scan", "/shortlist", "/watchlist", "/check", "/calls", "/lastdigest", "/status", "/help"]) {
      expect(text).toContain(c);
    }
  });

  it("/scan runs the pipeline for admins only", async () => {
    expect(await send("/scan", 999)).toContain("admin only");
    expect(statuses()).toEqual({});
    const text = await send("/scan");
    expect(text).toContain("Scan finished.");
    expect(statuses()[GOOD]).toBe("shortlisted");
  });

  it("/shortlist, /watchlist, /status, /calls, /lastdigest", async () => {
    await send("/scan");
    expect(await send("/shortlist")).toContain(GOOD);
    expect(await send("/watchlist")).toContain(NOMCAP);
    expect(await send("/status")).toContain("shortlisted 1");
    expect(await send("/calls")).toContain("No calls");
    expect(await send("/lastdigest")).toContain("No digest has been sent yet");
  });

  it("/check reports both rules", async () => {
    expect(await send(`/check ${GOOD}`)).toContain("Verdict: qualifies.");
    const honey = await send(`/check ${HONEY}`);
    expect(honey).toContain("Security: FAIL – honeypot");
    expect(await send("/check nope")).toContain("Usage");
  });

  it("ignores redelivered updates", async () => {
    await handleUpdate(env(), { update_id: 500, message: { text: "/help", chat: { id: 5 }, from: { id: 111 } } });
    const n = apis.sent.length;
    await handleUpdate(env(), { update_id: 500, message: { text: "/help", chat: { id: 5 }, from: { id: 111 } } });
    expect(apis.sent.length).toBe(n);
  });
});
