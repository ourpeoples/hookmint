import { fullAccess } from "./core/context.js";
import { createLogger } from "./core/logger.js";
import { AdService } from "./core/service.js";
import { createProviders, serviceOptions } from "./providers/index.js";
import { createApp, Lifecycle } from "./server/app.js";
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
const setup = createProviders();
const service = new AdService(setup.providers, serviceOptions(setup, process.env, { port: config.port }));
log.info("providers", { summary: setup.summary });
if (service.downloads.ephemeral) log.warn("HOOKMINT_URL_SECRET is not set, so download links stop working when the server restarts.");
if (config.production) log.warn("Running with in-memory state (HOOKMINT_ALLOW_EPHEMERAL=1). Every ad is lost on restart.");

// Stand-in for billing until there is a real one: each account gets a starting balance.
const devCtx = fullAccess("acct_dev");
const accounts = new Set(config.apiKeys ? config.apiKeys.accountIds() : [devCtx.accountId]);
for (const a of accounts) service.grantCredits(a, config.initialCredits, "initial grant");

const lifecycle = new Lifecycle();
const server = createApp(service, { apiKeys: config.apiKeys, devCtx, logger: log, maxBodyBytes: config.maxBodyBytes, corsOrigins: config.corsOrigins, hsts: config.hsts, lifecycle });
server.listen(config.port, () => {
  const addr = server.address();
  log.info("listening", { port: typeof addr === "object" && addr ? addr.port : config.port, open: !config.apiKeys, mcp: "/mcp", rest: "/v1/ads", health: "/healthz", ready: "/readyz" });
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
    log.info("stopped");
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));
