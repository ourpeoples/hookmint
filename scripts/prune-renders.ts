/**
 * Removes old finished videos from disk and forgets them in the database, to give an account its storage back.
 *
 *   npm run renders:prune -- --older-than-days 90                 (shows what it would remove)
 *   npm run renders:prune -- --older-than-days 90 --yes           (removes it)
 *   npm run renders:prune -- --older-than-days 90 --account acct_x --yes
 *
 * Needs HOOKMINT_DATABASE_ADMIN_URL: the application's own role is not allowed to delete. A video's age is the age of its
 * file on disk. After pruning, a download link for that video answers "not found". The ad and its history are kept.
 */
import { promises as fs } from "node:fs";
import pg from "pg";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const days = Number(arg("older-than-days"));
const account = arg("account");
const apply = process.argv.includes("--yes");
const url = process.env.HOOKMINT_DATABASE_ADMIN_URL?.trim();
if (!url || !Number.isFinite(days) || days < 1) {
  console.error("Usage: HOOKMINT_DATABASE_ADMIN_URL=... npm run renders:prune -- --older-than-days <1 or more> [--account <id>] [--yes]");
  process.exit(2);
}
const client = new pg.Client({ connectionString: url, ...(process.env.HOOKMINT_DATABASE_SCHEMA ? { options: `-c search_path=${process.env.HOOKMINT_DATABASE_SCHEMA}` } : {}) });
await client.connect();
try {
  const rows = (await client.query<{ id: string; account_id: string; path: string; bytes: string }>(account ? "SELECT id, account_id, path, bytes FROM renders WHERE account_id = $1" : "SELECT id, account_id, path, bytes FROM renders", account ? [account] : [])).rows;
  const cutoff = Date.now() - days * 86_400_000;
  let count = 0;
  let bytes = 0;
  for (const r of rows) {
    const st = await fs.stat(r.path).catch(() => undefined);
    const old = !st || st.mtimeMs < cutoff; // a missing file is cleaned up too
    if (!old) continue;
    count++;
    bytes += Number(r.bytes);
    console.log(`${apply ? "removing" : "would remove"} ${r.id} (${r.account_id}, ${Math.round(Number(r.bytes) / 1024)} KB${st ? "" : ", file already gone"})`);
    if (apply) {
      await fs.rm(r.path, { force: true });
      await client.query("DELETE FROM renders WHERE id = $1 AND account_id = $2", [r.id, r.account_id]);
    }
  }
  console.log(`${apply ? "Removed" : "Would remove"} ${count} video(s), ${Math.round(bytes / 1048576)} MB.${apply ? "" : " Add --yes to do it."}`);
} finally {
  await client.end();
}
