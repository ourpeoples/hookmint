import { AdError } from "./errors.js";

export const ALL_SCOPES = [
  "ads:read",
  "ads:create",
  "ads:approve",
  "spend",
  "brand:read",
  "brand:write",
  "insights:read",
  "ad_accounts:connect",
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export interface Ctx {
  accountId: string;
  scopes: ReadonlySet<string>;
}

export const fullAccess = (accountId: string): Ctx => ({ accountId, scopes: new Set(ALL_SCOPES) });

export function requireScope(ctx: Ctx, ...scopes: Scope[]) {
  for (const s of scopes) {
    if (!ctx.scopes.has(s)) throw new AdError("forbidden", `Missing required scope "${s}".`);
  }
}
