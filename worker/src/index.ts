// Cloudflare Worker entry: hourly cron runs the pipeline; a small HTTP API for status and manual digests.

import { handleUpdate, setup } from "./bot";
import type { Env } from "./config";
import { build, runHourly, sendDigest, status } from "./pipeline";

function authorized(request: Request, env: Env): boolean {
  const token = env.ADMIN_TOKEN;
  return !!token && request.headers.get("Authorization") === `Bearer ${token}`;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const app = await build(env);
    console.log(JSON.stringify(await runHourly(app)));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") {
      // Telegram sends the secret we registered with setWebhook in this header.
      const secret = env.TELEGRAM_WEBHOOK_SECRET;
      if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
        return new Response("unauthorized", { status: 401 });
      }
      try {
        const later = await handleUpdate(env, await request.json());
        if (later) ctx.waitUntil(later());
      } catch (e) {
        console.error(`telegram update failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return new Response("ok"); // always 200 so Telegram does not redeliver
    }
    if (request.method === "POST" && url.pathname === "/setup") {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      return Response.json(await setup(env, url.origin));
    }
    if (request.method === "GET" && url.pathname === "/status") {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      return Response.json(await status(await build(env)));
    }
    if (request.method === "POST" && url.pathname === "/digest") {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      const app = await build(env);
      try {
        const out = await sendDigest(app);
        return Response.json({ ...out, subrequests: app.budget.usedThisRun });
      } finally {
        await app.budget.flush();
      }
    }
    if (request.method === "POST" && url.pathname === "/run") {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      return Response.json(await runHourly(await build(env)));
    }
    return new Response("gutterwire-eth\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
