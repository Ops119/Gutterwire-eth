// Minimal D1 stand-in over Node's built-in SQLite, enough for the queries this Worker makes.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

class Stmt {
  constructor(private db: any, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : p)));
  }
  private isQuery() {
    return /^\s*(SELECT|PRAGMA|WITH)/i.test(this.sql);
  }
  async all() {
    return this.exec();
  }
  async first(col?: string) {
    const row = this.db.prepare(this.sql).get(...this.params) ?? null;
    return col && row ? row[col] : row;
  }
  async run() {
    return this.exec();
  }
  exec() {
    const s = this.db.prepare(this.sql);
    if (this.isQuery()) return { results: s.all(...this.params), success: true, meta: { changes: 0, last_row_id: 0 } };
    const r = s.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class FakeD1 {
  db: any;
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.exec());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.db.exec(sql);
  }
}
