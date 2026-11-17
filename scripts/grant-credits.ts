/**
 * Gives an account credits. Accounts are invite-only, so an operator does this by hand (there is no billing yet).
 *
 *   HOOKMINT_DATABASE_URL=... HOOKMINT_DATABASE_WORKER_URL=... npm run credits:grant -- --account acct_acme --amount 500 --reason "pilot"
 *
 * Without a database URL it would only change a throwaway in-memory copy, so it refuses to run.
 */
import { AdService } from "../src/core/service.js";
import { PgStore } from "../src/db/pg-store.js";
import { createStubProviders } from "../src/providers/stub.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const account = arg("account");
const amount = Number(arg("amount"));
const reason = arg("reason") ?? "operator grant";
const appUrl = process.env.HOOKMINT_DATABASE_URL?.trim();
const workerUrl = process.env.HOOKMINT_DATABASE_WORKER_URL?.trim();
if (!account || !/^[A-Za-z0-9_-]{1,64}$/.test(account) || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
  console.error('Usage: npm run credits:grant -- --account <id> --amount <whole number, negative to remove> [--reason "text"]');
  process.exit(2);
}
if (!appUrl || !workerUrl) {
  console.error("Set HOOKMINT_DATABASE_URL and HOOKMINT_DATABASE_WORKER_URL. Credits in a throwaway in-memory store would be lost at once.");
  process.exit(2);
}
const store = new PgStore({ appUrl, workerUrl, onError: (m) => console.error(m) });
try {
  const service = new AdService(createStubProviders(), {}, store);
  await service.grantCredits(account, amount, reason);
  const bal = await service.getBalance({ accountId: account, scopes: new Set() });
  console.log(`${amount > 0 ? "Granted" : "Removed"} ${Math.abs(amount)} credits. ${account} now has ${bal.available} available (${bal.held} held).`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await store.close();
}
