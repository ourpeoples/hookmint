/**
 * Explains an OAuth access token against this server's settings, to debug a refused sign-in.
 *
 *   npm run oauth:inspect -- <token>        (or: echo $TOKEN | npm run oauth:inspect)
 *
 * It decodes the token on this machine and sends it nowhere. It does NOT verify the signature. Treat a token like a
 * password: do not paste it into chat or an online decoder.
 */
import { readFileSync } from "node:fs";
import { inspectToken } from "../src/server/oauth-inspect.js";
import { loadConfig } from "../src/server/config.js";

const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const token = (arg ?? (process.stdin.isTTY ? "" : readFileSync(0, "utf8"))).trim().replace(/^Bearer\s+/i, "");
if (!token) {
  console.error("Usage: npm run oauth:inspect -- <access token>");
  process.exit(2);
}
let config;
try {
  config = loadConfig({ ...process.env, HOOKMINT_ENV: "" });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
}
if (!config.oauth) {
  console.error("OAuth is not configured here. Set HOOKMINT_OAUTH_ISSUER and HOOKMINT_PUBLIC_URL (for example in .env).");
  process.exit(2);
}
const { lines, problems } = inspectToken(token, config.oauth);
console.log(lines.join("\n"));
console.log("\n(The signature was not checked. This shows what the token claims, not that it is genuine.)\n");
if (problems.length) {
  console.log("Problems:");
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log("No problems found in the claims.");
