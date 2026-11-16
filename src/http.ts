import { fullAccess } from "./core/context.js";
import { AdService } from "./core/service.js";
import { createProviders } from "./providers/index.js";
import { createApp } from "./server/app.js";

const { providers, summary } = createProviders();
const service = new AdService(providers);
console.error(`hookmint providers: ${summary}`);
const ctx = fullAccess("acct_dev");
service.grantCredits(ctx.accountId, Number(process.env.INITIAL_CREDITS ?? 1000), "dev grant");

const apiKey = process.env.API_KEY;
const port = Number(process.env.PORT ?? 3000);
createApp(service, { apiKeys: apiKey ? new Map([[apiKey, ctx]]) : undefined, devCtx: ctx }).listen(port, () =>
  console.error(`hookmint: MCP at http://localhost:${port}/mcp, REST at /v1/ads${apiKey ? "" : " (no API_KEY set: open, dev only)"}`),
);
