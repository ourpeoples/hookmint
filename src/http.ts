import { fullAccess } from "./core/context.js";
import { AdService } from "./core/service.js";
import { createProviders, serviceOptions } from "./providers/index.js";
import { createApp } from "./server/app.js";

const setup = createProviders();
const port = Number(process.env.PORT ?? 3000);
const service = new AdService(setup.providers, serviceOptions(setup, process.env, { port }));
console.error(`hookmint providers: ${setup.summary}`);
if (service.downloads.ephemeral) console.error("hookmint: HOOKMINT_URL_SECRET is not set, so download links stop working when the server restarts.");
const ctx = fullAccess("acct_dev");
service.grantCredits(ctx.accountId, Number(process.env.INITIAL_CREDITS ?? 1000), "dev grant");

const apiKey = process.env.API_KEY;
createApp(service, { apiKeys: apiKey ? new Map([[apiKey, ctx]]) : undefined, devCtx: ctx }).listen(port, () =>
  console.error(`hookmint: MCP at http://localhost:${port}/mcp, REST at /v1/ads${apiKey ? "" : " (no API_KEY set: open, dev only)"}`),
);
