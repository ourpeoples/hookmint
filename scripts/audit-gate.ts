/**
 * Fails the build on known vulnerabilities in production dependencies, except for advisories listed in
 * audit-allow.json. Every exception needs a written reason and an expiry date; once it expires the build fails
 * again, so an exception can never quietly become permanent.
 *
 *   npm run audit
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Allowance {
  id: string;
  reason: string;
  expires: string;
}
export interface Finding {
  id: string;
  severity: string;
  title: string;
  packages: string[];
}
export interface Verdict {
  failures: string[];
  accepted: string[];
  stale: string[];
}

const ORDER = ["info", "low", "moderate", "high", "critical"];

/** Every distinct advisory in an `npm audit --json` report, with the packages it reaches. */
export function findings(audit: unknown): Finding[] {
  const vulns = (audit as { vulnerabilities?: Record<string, { via?: unknown[] }> } | null)?.vulnerabilities;
  if (!vulns || typeof vulns !== "object") throw new Error("That does not look like an npm audit report.");
  const byId = new Map<string, Finding>();
  for (const [pkg, v] of Object.entries(vulns)) {
    for (const via of v.via ?? []) {
      if (!via || typeof via !== "object") continue;
      const { url, title, severity } = via as { url?: string; title?: string; severity?: string };
      const id = url?.split("/").pop();
      if (!id || !severity) continue;
      const f = byId.get(id) ?? { id, severity, title: title ?? id, packages: [] };
      if (!f.packages.includes(pkg)) f.packages.push(pkg);
      byId.set(id, f);
    }
  }
  return [...byId.values()];
}

export function evaluate(audit: unknown, allow: Allowance[], now: Date, level = "high"): Verdict {
  const failures: string[] = [];
  const accepted: string[] = [];
  const threshold = ORDER.indexOf(level);
  if (threshold < 0) throw new Error(`Unknown audit level "${level}".`);
  const byId = new Map<string, Allowance>();
  for (const a of allow) {
    if (!a.id || !a.reason?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(a.expires ?? "") || Number.isNaN(Date.parse(a.expires))) {
      failures.push(`audit-allow.json entry "${a.id ?? "?"}" needs an id, a written reason, and an expiry date like 2026-12-31.`);
      continue;
    }
    byId.set(a.id, a);
  }
  const all = findings(audit);
  for (const f of all.filter((x) => ORDER.indexOf(x.severity) >= threshold)) {
    const a = byId.get(f.id);
    const label = `${f.id} (${f.severity}): ${f.title}, reaching ${f.packages.join(", ")}`;
    if (!a) failures.push(`${label}. No exception is on file.`);
    else if (Date.parse(a.expires) < now.getTime()) failures.push(`${label}. The exception expired on ${a.expires}; review it and either fix the dependency or renew it with a new reason.`);
    else accepted.push(`${label}. Accepted until ${a.expires}.`);
  }
  const current = new Set(all.map((f) => f.id));
  const stale = [...byId.keys()].filter((id) => !current.has(id)).map((id) => `${id} is in audit-allow.json but is no longer reported; remove it.`);
  return { failures, accepted, stale };
}

async function main() {
  const level = process.env.AUDIT_LEVEL ?? "high";
  const allow = JSON.parse(readFileSync(new URL("../audit-allow.json", import.meta.url), "utf8")) as Allowance[];
  const out = await new Promise<string>((resolve, reject) => {
    // npm audit exits non-zero when it finds anything, so read stdout either way.
    execFile("npm", ["audit", "--omit=dev", "--json"], { maxBuffer: 20_000_000 }, (err, stdout) => (stdout ? resolve(stdout) : reject(err ?? new Error("npm audit printed nothing"))));
  });
  const v = evaluate(JSON.parse(out), allow, new Date(), level);
  for (const a of v.accepted) console.log(`accepted: ${a}`);
  for (const s of v.stale) console.log(`note: ${s}`);
  for (const f of v.failures) console.error(`FAIL: ${f}`);
  if (v.failures.length) process.exit(1);
  console.log(`audit ok: no unaccepted ${level}-or-worse advisories in production dependencies.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`audit could not run: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  });
}
