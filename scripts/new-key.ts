/**
 * Makes a new API key. The key is printed once and never stored; only its digest goes in the keys file.
 *
 *   npm run keys:new -- --account acct_acme --label "acme production" --expires 2027-06-30 --scopes ads:read,ads:create
 */
import { ApiKeys } from "../src/server/api-keys.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const account = arg("account");
if (!account) {
  console.error('Usage: npm run keys:new -- --account <account id> [--label "text"] [--expires YYYY-MM-DD] [--scopes a,b]');
  process.exit(2);
}
const expires = arg("expires");
const scopes = arg("scopes")?.split(",").map((s) => s.trim()).filter(Boolean);
try {
  const { token, record } = ApiKeys.generate(account, { label: arg("label"), expires_at: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : undefined, scopes });
  console.log("API key (shown once, store it somewhere safe, it cannot be recovered):\n");
  console.log(`  ${token}\n`);
  console.log("Add this record to your keys file (HOOKMINT_API_KEYS_FILE). It holds only a digest, not the key:\n");
  console.log(JSON.stringify(record, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
