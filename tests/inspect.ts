import type { AdService } from "../src/core/service.js";
import { MemoryStore } from "../src/core/memory-store.js";
import type { RenderFileRecord } from "../src/core/store.js";
import type { PgStore } from "../src/db/pg-store.js";
import pg from "pg";

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

/** Corrupts a stored audit entry, to prove tampering is detected. It reaches around the service, as an attacker with database access would. */
export async function tamperAudit(s: AdService, index: number, change: { action: string; detail: unknown }, acct = "acct_a") {
  if (s.store instanceof MemoryStore) {
    const rows = ([...s.store.table("audit").values()] as { account_id: string; seq: number; detail: unknown; action: string }[]).filter((r) => r.account_id === acct).sort((a, b) => a.seq - b.seq);
    rows[index].action = change.action;
    rows[index].detail = change.detail;
    return;
  }
  const admin = process.env.HOOKMINT_TEST_DATABASE_URL!;
  const c = new pg.Client({ connectionString: admin, options: `-c search_path=${(s.store as PgStore).schema}` });
  await c.connect();
  try {
    const r = await c.query("UPDATE audit_log SET action = $3, detail = $4 WHERE id = (SELECT id FROM audit_log WHERE account_id = $1 ORDER BY seq OFFSET $2 LIMIT 1)", [acct, index, change.action, JSON.stringify(change.detail)]);
    if (r.rowCount !== 1) throw new Error("no audit entry to tamper with");
  } finally {
    await c.end();
  }
}
