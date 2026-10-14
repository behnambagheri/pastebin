import { DatabaseSync } from "node:sqlite";

// The subset of Cloudflare's D1 API that the Worker uses, over Node's built-in SQLite,
// so the same queries run on Cloudflare and in containers.

const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

class Statement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    // D1 binds booleans as integers; SQLite drivers reject them.
    return new Statement(this.database, this.sql, params.map((value) => (typeof value === "boolean" ? Number(value) : value)));
  }

  execute() {
    const statement = this.database.sqlite.prepare(this.sql);
    if (returnsRows(this.sql)) {
      const results = statement.all(...this.params).map((row) => ({ ...row }));
      return { success: true, results, meta: { changes: 0, rows_read: results.length } };
    }
    const info = statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async first(column) {
    const row = this.execute().results[0];
    if (!row) return null;
    return column === undefined ? row : row[column];
  }
}

export class SqliteD1 {
  constructor(path) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  prepare(sql) { return new Statement(this, sql); }

  /** Runs statements in one transaction, like D1 batches. */
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql) { this.sqlite.exec(sql); }

  close() { this.sqlite.close(); }
}

/** Applies pending migrations in order, recording them in d1_migrations like Wrangler does. */
export function migrate(database, migrations) {
  const sqlite = database.sqlite;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const applied = new Set(sqlite.prepare("SELECT name FROM d1_migrations").all().map((row) => row.name));
  const pending = migrations.filter(({ name }) => !applied.has(name));
  for (const { name, sql } of pending) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(sql);
      sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${error.message}`);
    }
  }
  return pending.map(({ name }) => name);
}
