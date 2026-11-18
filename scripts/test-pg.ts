/**
 * Runs the whole offline suite against a real Postgres, plus the Postgres-only tests.
 *
 *   HOOKMINT_TEST_DATABASE_URL=postgres://postgres:...@localhost:5432/scratch npm run test:pg
 *
 * Use a scratch database and a superuser: the tests create two roles (hookmint_app, hookmint_worker) and one private
 * schema per service, and remove the schemas afterwards.
 */
import { spawnSync } from "node:child_process";
import pg from "pg";

const url = process.env.HOOKMINT_TEST_DATABASE_URL;
if (!url) {
  console.error("Set HOOKMINT_TEST_DATABASE_URL to a scratch database (superuser URL).");
  process.exit(2);
}
const suites = ["smoke", "foundations", "brand", "variants", "claude", "net", "limits", "hardening", "providers", "oauth", "stats", "insights", "results", "diff-properties", "contract/contract"];

async function dropTestSchemas() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'hk\\_test\\_%'");
    for (const r of rows) await c.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  } finally {
    await c.end();
  }
}

await dropTestSchemas();
let failed = 0;
for (const s of suites) {
  console.log(`\n=== ${s} (postgres) ===`);
  const r = spawnSync("npx", ["tsx", `tests/${s}.ts`], { stdio: "inherit", env: { ...process.env, HOOKMINT_TEST_STORE: "postgres" } });
  if (r.status !== 0) failed++;
}
console.log("\n=== postgres-only tests ===");
if (spawnSync("npx", ["tsx", "tests/postgres.ts"], { stdio: "inherit", env: process.env }).status !== 0) failed++;
await dropTestSchemas();
console.log(failed ? `\n${failed} suite(s) failed.` : "\nAll suites passed against Postgres.");
process.exit(failed ? 1 : 0);
