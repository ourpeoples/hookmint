#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fullAccess } from "./core/context.js";
import { AdService } from "./core/service.js";
import { createProviders } from "./providers/index.js";
import { buildMcpServer } from "./server/mcp.js";

const { providers, summary } = createProviders();
const service = new AdService(providers);
console.error(`hookmint providers: ${summary}`);
const ctx = fullAccess("acct_dev");
service.grantCredits(ctx.accountId, Number(process.env.INITIAL_CREDITS ?? 1000), "dev grant");
await buildMcpServer(service, ctx).connect(new StdioServerTransport());
console.error("hookmint running on stdio");
