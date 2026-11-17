import type { AdService } from "../src/core/service.js";
import { MemoryStore } from "../src/core/memory-store.js";
import type { RenderFileRecord } from "../src/core/store.js";

/** Reads of stored state for tests, through the same transactions the service uses, so they work for any store. */
const tx = <T>(service: AdService, accountId: string, fn: Parameters<AdService["store"]["tx"]>[1] & ((t: never) => Promise<T>)) => service.store.tx(accountId, fn as never) as Promise<T>;

export const auditOf = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.audit());
export const verifyAudit = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.verifyAudit());
export const reservationsOf = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.reservations());
export const ledgerOf = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.ledger());
export const adOf = (s: AdService, id: string, acct = "acct_a") => tx(s, acct, (t) => t.getAd(id));
export const kitCount = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.countKits());
export const pendingLogos = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.countPendingLogos());
export const groupCount = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.countGroups());
export const renderCount = (s: AdService, acct = "acct_a") => tx(s, acct, (t) => t.countRenders());
export const rulesOf = (s: AdService, kit: string, acct = "acct_a") => tx(s, acct, (t) => t.getRules(kit));
export const putRender = (s: AdService, id: string, rec: RenderFileRecord) => tx(s, rec.account_id, (t) => t.putRender(id, rec));
export const outboxRows = (s: AdService) => s.store.outboxRows();
export const redeliverAll = async (s: AdService) => {
  for (const row of await s.store.outboxRows()) await s.redeliver(row.id);
  await s.idle();
};

/** Corrupts a stored audit entry, to prove tampering is detected. Memory store only: it reaches into its tables. */
export function tamperAudit(s: AdService, index: number, change: (e: { detail: unknown; action: string }) => void, acct = "acct_a") {
  if (!(s.store instanceof MemoryStore)) throw new Error("tamperAudit needs the memory store");
  const rows = ([...s.store.table("audit").values()] as { account_id: string; seq: number; detail: unknown; action: string }[]).filter((r) => r.account_id === acct).sort((a, b) => a.seq - b.seq);
  change(rows[index]);
}
