import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** The folder of numbered .sql files, found from either src/ (development) or dist/ (built). */
export function migrationsDir(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "migrations");
    if (existsSync(candidate) && existsSync(path.join(dir, "package.json"))) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("Could not find the migrations folder. Is it missing from the install?");
}

export interface MigrateOptions {
  /** Install into this schema instead of the default. Tests use it to get a private copy of the database. */
  schema?: string;
  dir?: string;
  log?: (line: string) => void;
}

const LOCK_ID = 7_274_001;
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Applies each numbered migration once, in order, each in its own transaction. A migration that was already applied
 * must not have changed since: editing history is an error, because other databases would no longer match. Only one
 * migrator runs at a time (an advisory lock), so starting several instances together is safe.
 */
export async function migrate(adminUrl: string, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? migrationsDir();
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    if (opts.schema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(opts.schema)}`);
      await client.query(`SET search_path TO ${quote(opts.schema)}`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const before = done.get(file);
      if (before !== undefined) {
        if (before !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead of editing an old one.`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
      opts.log?.(`applied ${file}`);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}
