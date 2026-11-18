/**
 * Checks a database is locked down and intact. Read-only. Run it after restoring a backup, after a deploy, or on a schedule.
 *
 *   HOOKMINT_DATABASE_ADMIN_URL=... HOOKMINT_DATABASE_URL=... HOOKMINT_DATABASE_WORKER_URL=... npm run db:verify
 *
 * Exits 1 if any check fails, so it can gate a deploy or a restore drill.
 */
import { verifyDatabase } from "../src/db/verify.js";

const adminUrl = process.env.HOOKMINT_DATABASE_ADMIN_URL?.trim();
const appUrl = process.env.HOOKMINT_DATABASE_URL?.trim();
const workerUrl = process.env.HOOKMINT_DATABASE_WORKER_URL?.trim();
if (!adminUrl || !appUrl || !workerUrl) {
  console.error("Set HOOKMINT_DATABASE_ADMIN_URL, HOOKMINT_DATABASE_URL and HOOKMINT_DATABASE_WORKER_URL.");
  process.exit(2);
}
try {
  const r = await verifyDatabase({ adminUrl, appUrl, workerUrl });
  for (const c of r.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  console.log(r.ok ? "\nThe database is locked down and intact." : "\nThe database FAILED verification. Do not put it into service until this is fixed.");
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(`Could not verify: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
