// Rate limits and budgets. Every outbound API call goes through Budget.take().
//
// Three limits apply:
//  - per run: Workers Free allows 50 external subrequests per invocation
//  - per minute: under each API's published limit (waiting costs wall time, not CPU time)
//  - per day: persisted in D1 so runaway usage stops until the next UTC day

import type { Api, Settings } from "./config";

export class BudgetExceeded extends Error {}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class Budget {
  usedThisRun = 0;
  private usedToday: Partial<Record<Api, number>> = {};
  private addedThisRun: Partial<Record<Api, number>> = {};
  private recent: Partial<Record<Api, number[]>> = {};
  private day: string;

  constructor(
    private db: D1Database,
    private settings: Settings,
    private sleep: Sleep = realSleep,
    private now: () => number = Date.now,
  ) {
    this.day = utcDay(now());
  }

  async load(): Promise<void> {
    const { results } = await this.db
      .prepare("SELECT api, count FROM api_usage WHERE day = ?")
      .bind(this.day)
      .all<{ api: Api; count: number }>();
    for (const r of results) this.usedToday[r.api] = r.count;
  }

  remainingThisRun(): number {
    return this.settings.subrequestsPerRun - this.usedThisRun;
  }

  remainingToday(api: Api): number {
    return this.settings.perDay[api] - (this.usedToday[api] ?? 0);
  }

  async take(api: Api): Promise<void> {
    if (this.usedThisRun >= this.settings.subrequestsPerRun) {
      throw new BudgetExceeded(`run limit of ${this.settings.subrequestsPerRun} subrequests reached`);
    }
    if (this.remainingToday(api) <= 0) {
      throw new BudgetExceeded(`${api}: daily budget of ${this.settings.perDay[api]} used`);
    }
    const limit = this.settings.perMinute[api];
    const times = (this.recent[api] ??= []);
    for (;;) {
      const cutoff = this.now() - 60_000;
      while (times.length && times[0] < cutoff) times.shift();
      if (times.length < limit) break;
      await this.sleep(Math.max(500, times[0] + 60_000 - this.now()));
    }
    times.push(this.now());
    this.usedThisRun++;
    this.usedToday[api] = (this.usedToday[api] ?? 0) + 1;
    this.addedThisRun[api] = (this.addedThisRun[api] ?? 0) + 1;
  }

  /** Write this run's usage to D1 in one batch. */
  async flush(): Promise<void> {
    const stmts = Object.entries(this.addedThisRun).map(([api, n]) =>
      this.db
        .prepare(
          `INSERT INTO api_usage(api, day, count) VALUES (?, ?, ?)
           ON CONFLICT(api, day) DO UPDATE SET count = count + excluded.count`,
        )
        .bind(api, this.day, n),
    );
    if (stmts.length) await this.db.batch(stmts);
    this.addedThisRun = {};
  }

  report(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const api of Object.keys(this.settings.perDay) as Api[]) {
      out[api] = `${this.usedToday[api] ?? 0}/${this.settings.perDay[api]}`;
    }
    return out;
  }
}
