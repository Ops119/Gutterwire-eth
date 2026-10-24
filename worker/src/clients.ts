// Thin fetch clients for GeckoTerminal, DEX Screener, GoPlus, CoinMarketCap, Gemini and Telegram.

import { Budget, BudgetExceeded, type Sleep, realSleep } from "./budget";
import type { Api } from "./config";

export class ApiError extends Error {}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const CMC_BASE = "https://pro-api.coinmarketcap.com";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const TELEGRAM_BASE = "https://api.telegram.org";

export class Http {
  constructor(
    readonly budget: Budget,
    private fetcher: Fetch = (url, init) => fetch(url, init),
    private sleep: Sleep = realSleep,
    private retries = 2,
  ) {}

  /** Budget-gated request; retries 429/5xx. Every attempt counts against the run's subrequests. */
  async request(api: Api, url: string, init: RequestInit = {}): Promise<Response> {
    let last = "";
    for (let attempt = 0; attempt < this.retries; attempt++) {
      await this.budget.take(api);
      let resp: Response;
      try {
        resp = await this.fetcher(url, {
          ...init,
          headers: { "User-Agent": "gutterwire-eth/1.0", ...(init.headers ?? {}) },
        });
      } catch (e) {
        last = String(e);
        await this.sleep(2 ** attempt * 1000);
        continue;
      }
      if (resp.status === 429 || resp.status >= 500) {
        last = `HTTP ${resp.status}`;
        const retryAfter = Number(resp.headers.get("Retry-After"));
        await this.sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** (attempt + 1) * 1000, 60_000));
        continue;
      }
      return resp;
    }
    // Never include the URL: the Telegram token is part of it.
    throw new ApiError(`${api}: request failed after ${this.retries} attempts (${last})`);
  }
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- GeckoTerminal ----------

export class GeckoTerminal {
  constructor(private http: Http) {}

  async pools(kind: "new_pools" | "trending_pools", page: number): Promise<any> {
    const url = `${GECKO_BASE}/networks/eth/${kind}?page=${page}&include=base_token,quote_token,dex`;
    const resp = await this.http.request("geckoterminal", url, {
      headers: { Accept: "application/json;version=20230302" },
    });
    if (resp.status !== 200) throw new ApiError(`geckoterminal ${kind} page ${page}: HTTP ${resp.status}`);
    return resp.json();
  }
}

// ---------- DEX Screener ----------

export interface Snapshot {
  price_usd: number | null;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  market_cap_usd: number | null; // reported market cap only
  mcap_source: string | null;
  fdv_usd: number | null; // reference only, never used as market cap
  pair_address: string | null;
  url: string | null;
  image_url: string | null; // banner or logo from DEX Screener token info, when the project set one
}

export class DexScreener {
  constructor(private http: Http) {}

  /** Pairs per lowercase token address, 30 addresses per request. */
  async tokenPairs(addresses: string[]): Promise<Map<string, any[]>> {
    const out = new Map<string, any[]>(addresses.map((a) => [a.toLowerCase(), []]));
    for (let i = 0; i < addresses.length; i += 30) {
      const chunk = addresses.slice(i, i + 30);
      const resp = await this.http.request("dexscreener", `${DEXSCREENER_BASE}/tokens/v1/ethereum/${chunk.join(",")}`);
      if (resp.status !== 200) throw new ApiError(`dexscreener tokens: HTTP ${resp.status}`);
      const data: any = await resp.json();
      const pairs: any[] = Array.isArray(data) ? data : (data?.pairs ?? []);
      for (const p of pairs) {
        if (p?.chainId !== "ethereum") continue;
        for (const side of [p.baseToken, p.quoteToken]) {
          const addr = String(side?.address ?? "").toLowerCase();
          out.get(addr)?.push(p);
        }
      }
    }
    return out;
  }

  /** Snapshot from the deepest-liquidity pair where `token` is the base token. */
  static bestSnapshot(token: string, pairs: any[]): Snapshot | null {
    const own = pairs.filter((p) => String(p?.baseToken?.address ?? "").toLowerCase() === token.toLowerCase());
    if (!own.length) return null;
    const best = own.reduce((a, b) => ((num(b?.liquidity?.usd) ?? 0) > (num(a?.liquidity?.usd) ?? 0) ? b : a));
    const mcap = num(best.marketCap);
    return {
      price_usd: num(best.priceUsd),
      liquidity_usd: num(best?.liquidity?.usd),
      volume_24h_usd: num(best?.volume?.h24),
      market_cap_usd: mcap,
      mcap_source: mcap ? "dexscreener" : null,
      fdv_usd: num(best.fdv),
      pair_address: best.pairAddress ?? null,
      url: best.url ?? null,
      image_url: own.map((p) => p?.info?.header || p?.info?.imageUrl).find(Boolean) ?? null,
    };
  }
}

// ---------- GoPlus ----------

export class GoPlus {
  constructor(private http: Http) {}

  /** Raw GoPlus response for one Ethereum token. */
  async tokenSecurity(address: string): Promise<any> {
    const resp = await this.http.request(
      "goplus",
      `${GOPLUS_BASE}/token_security/1?contract_addresses=${address.toLowerCase()}`,
    );
    if (resp.status !== 200) throw new ApiError(`goplus: HTTP ${resp.status}`);
    return resp.json();
  }
}

// ---------- CoinMarketCap ----------

/** Backup source of *reported* market cap, used only when DEX Screener reports none. FDV is ignored. */
export class CoinMarketCap {
  private headers: Record<string, string>;
  constructor(private http: Http, apiKey: string) {
    this.headers = { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" };
  }

  async marketCap(address: string): Promise<number | null> {
    let resp = await this.http.request(
      "coinmarketcap",
      `${CMC_BASE}/v2/cryptocurrency/info?address=${address.toLowerCase()}`,
      { headers: this.headers },
    );
    if (resp.status === 400) return null; // not listed
    if (resp.status !== 200) throw new ApiError(`coinmarketcap info: HTTP ${resp.status}`);
    const ids = Object.keys(((await resp.json()) as any)?.data ?? {});
    if (!ids.length) return null;
    resp = await this.http.request(
      "coinmarketcap",
      `${CMC_BASE}/v2/cryptocurrency/quotes/latest?id=${ids[0]}&convert=USD`,
      { headers: this.headers },
    );
    if (resp.status !== 200) throw new ApiError(`coinmarketcap quotes: HTTP ${resp.status}`);
    let entry: any = ((await resp.json()) as any)?.data?.[ids[0]] ?? {};
    if (Array.isArray(entry)) entry = entry[0] ?? {};
    const mcap = num(entry?.quote?.USD?.market_cap) || num(entry?.self_reported_market_cap);
    return mcap && mcap > 0 ? mcap : null;
  }
}

// ---------- Gemini ----------

export class Gemini {
  constructor(private http: Http, private apiKey: string, private model: string) {}

  async generate(prompt: string): Promise<string> {
    const resp = await this.http.request("gemini", `${GEMINI_BASE}/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
      }),
    });
    if (resp.status !== 200) throw new ApiError(`gemini: HTTP ${resp.status}`);
    const data: any = await resp.json();
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p?.text ?? "").join("").trim();
    if (!text) throw new ApiError("gemini: empty response");
    return text;
  }
}

// ---------- Telegram ----------

export class Telegram {
  static MAX_LEN = 4000; // Bot API limit is 4096 characters

  constructor(private http: Http, private token: string) {}

  async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const resp = await this.http.request("telegram", `${TELEGRAM_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let body: any = {};
    try {
      body = await resp.json();
    } catch {
      /* non-JSON error page */
    }
    if (resp.status !== 200 || !body?.ok) {
      throw new ApiError(`telegram ${method}: HTTP ${resp.status} ${body?.description ?? ""}`.trim());
    }
    return body.result;
  }

  async send(chatId: string | number, text: string, html = false): Promise<void> {
    for (const chunk of splitMessage(text, Telegram.MAX_LEN)) {
      await this.call("sendMessage", {
        chat_id: chatId, text: chunk, disable_web_page_preview: true, ...(html ? { parse_mode: "HTML" } : {}),
      });
    }
  }

  /** Photo post with an HTML caption (max 1024 characters). Telegram downloads the photo from `url`. */
  async sendPhoto(chatId: string | number, url: string, caption: string): Promise<void> {
    await this.call("sendPhoto", { chat_id: chatId, photo: url, caption, parse_mode: "HTML" });
  }
}

export function splitMessage(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (let line of text.split("\n")) {
    while (line.length > limit) {
      if (current) chunks.push(current);
      current = "";
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

export { BudgetExceeded };
