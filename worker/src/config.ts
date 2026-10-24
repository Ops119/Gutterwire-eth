// Settings come from wrangler.toml [vars] and secrets (`wrangler secret put`). Nothing secret lives in code.

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_DAILY_BUDGET?: string;
  CMC_API_KEY?: string;
  ADMIN_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ADMIN_IDS?: string;
  MAX_MARKET_CAP_USD?: string;
  MIN_LIQUIDITY_USD?: string;
  MAX_BUY_TAX?: string;
  MAX_SELL_TAX?: string;
  DIGEST_INTERVAL_HOURS?: string;
  SUBREQUESTS_PER_RUN?: string;
}

export type Api = "geckoterminal" | "dexscreener" | "goplus" | "coinmarketcap" | "gemini" | "telegram";

export interface Settings {
  telegramToken?: string;
  telegramChatId?: string;
  geminiApiKey?: string;
  geminiModel: string;
  cmcApiKey?: string;
  adminToken?: string;
  webhookSecret?: string;
  telegramAdminIds: Set<string>;

  // Eligibility rules (code, not AI)
  maxMarketCapUsd: number;
  minLiquidityUsd: number;
  maxBuyTax: number;
  maxSellTax: number;
  securityRetryLimit: number;
  watchlistMaxAgeHours: number;

  discoveryPages: number;
  cmcLookupsPerRun: number;
  cmcRecheckHours: number;
  digestIntervalHours: number;
  reviewDays: number;

  // Workers Free allows 50 external subrequests per invocation; keep a margin.
  subrequestsPerRun: number;
  perMinute: Record<Api, number>;
  perDay: Record<Api, number>;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettings(env: Env): Settings {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiModel: env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    cmcApiKey: env.CMC_API_KEY || undefined,
    adminToken: env.ADMIN_TOKEN || undefined,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    telegramAdminIds: new Set((env.TELEGRAM_ADMIN_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean)),
    maxMarketCapUsd: num(env.MAX_MARKET_CAP_USD, 15_000),
    minLiquidityUsd: num(env.MIN_LIQUIDITY_USD, 0),
    maxBuyTax: num(env.MAX_BUY_TAX, 0.1),
    maxSellTax: num(env.MAX_SELL_TAX, 0.1),
    securityRetryLimit: 3,
    watchlistMaxAgeHours: 72,
    discoveryPages: 2,
    cmcLookupsPerRun: 3,
    cmcRecheckHours: 6,
    digestIntervalHours: num(env.DIGEST_INTERVAL_HOURS, 48),
    reviewDays: 14,
    subrequestsPerRun: num(env.SUBREQUESTS_PER_RUN, 45),
    perMinute: {
      geckoterminal: 25, // published 30/min
      goplus: 25, // published 30/min
      dexscreener: 250, // published 300/min
      coinmarketcap: 25, // Basic plan 30/min
      gemini: 10,
      telegram: 20,
    },
    perDay: {
      geckoterminal: 2_000,
      goplus: 2_000,
      dexscreener: 10_000,
      coinmarketcap: 300, // Basic plan ~10k credits/month
      gemini: num(env.GEMINI_DAILY_BUDGET, 20),
      telegram: 200,
    },
  };
}
