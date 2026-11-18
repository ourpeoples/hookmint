import { fullAccess } from "./core/context.js";
import { createLogger } from "./core/logger.js";
import { AdService } from "./core/service.js";
import { createProviders, serviceOptions } from "./providers/index.js";
import { PgStore } from "./db/pg-store.js";
import { migrate } from "./db/migrate.js";
import { createApp, Lifecycle } from "./server/app.js";
import { OAuthVerifier } from "./server/oauth.js";
import { SafeFetcher } from "./net/safe-fetch.js";
import { loadConfig } from "./server/config.js";

function start() {
  try {
    return loadConfig(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
const config = start();
const log = createLogger({ level: config.logLevel, base: { service: "hookmint" } });
for (const w of config.warnings) log.warn(w);
const setup = createProviders();
if (config.migrateOnStart) {
  try {
    const applied = await migrate(config.migrateOnStart.adminUrl, { log: (l) => log.info("migration", { detail: l }) });
    log.info("database is up to date", { applied: applied.length });
  } catch (e) {
    log.error("migration failed", { error: e });
    process.exit(1);
  }
}
const store = config.database ? new PgStore({ appUrl: config.database.appUrl, workerUrl: config.database.workerUrl, onError: (m) => log.error("database", { detail: m }) }) : undefined;
const options = serviceOptions(setup, process.env, { port: config.port });
const service = new AdService(setup.providers, options, store);
if (store) {
  try {
    await store.ping();
  } catch {
    log.error("cannot reach the database with HOOKMINT_DATABASE_URL. Check the address, the hookmint_app password, and that migrations have been applied (npm run db:migrate).");
    process.exit(1);
  }
}
log.info("providers", { summary: setup.summary });
if (service.downloads.ephemeral) log.warn("HOOKMINT_URL_SECRET is not set, so download links stop working when the server restarts.");
if (!store) log.warn("Running with in-memory state. Every ad and credit is lost on restart. Set HOOKMINT_DATABASE_URL to keep them.");

// Stand-in for billing until there is a real one: each account gets a starting balance.
const devCtx = fullAccess("acct_dev");
// Accounts that sign in with OAuth are invite-only and get credits from an operator: npm run credits:grant.
const accounts = new Set(config.apiKeys ? config.apiKeys.accountIds() : config.oauth ? [] : [devCtx.accountId]);
for (const a of accounts) await service.grantStarterCredits(a, config.initialCredits, "initial grant");
service.start();

const lifecycle = new Lifecycle();
const oauth = config.oauth ? new OAuthVerifier({ ...config.oauth, fetcher: new SafeFetcher() }) : undefined;
const server = createApp(service, { apiKeys: config.apiKeys, oauth, devCtx, logger: log, maxBodyBytes: config.maxBodyBytes, corsOrigins: config.corsOrigins, hsts: config.hsts, lifecycle });
server.listen(config.port, () => {
  const addr = server.address();
  log.info("listening", { port: typeof addr === "object" && addr ? addr.port : config.port, open: !config.apiKeys && !config.oauth, mcp: "/mcp", rest: "/v1/ads", health: "/healthz", ready: "/readyz" });
});

// Graceful shutdown: report not-ready, stop taking connections, let in-flight requests finish, then exit.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  lifecycle.draining = true;
  log.info("shutting down", { signal, grace_ms: config.shutdownGraceMs });
  const force = setTimeout(() => {
    log.warn("grace period over, closing remaining connections");
    server.closeAllConnections();
    process.exit(1);
  }, config.shutdownGraceMs);
  force.unref();
  server.close(() => {
    // New requests are refused; now let background work (scripts, generation, renders) finish before the process ends.
    void service.drain(Math.max(1000, config.shutdownGraceMs - 2000)).then((clean) => {
      log.info(clean ? "stopped" : "stopped with work unfinished; it will be picked up again after restart");
      void service.store.close().finally(() => process.exit(clean ? 0 : 1));
    });
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));
