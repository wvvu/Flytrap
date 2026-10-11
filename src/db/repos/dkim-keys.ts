import type { Db } from "../index.js";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import { OutboundError } from "../../mail/address.js";
import { dkimDnsName, dkimTxt, generateDkimMaterial, normalizeSelector } from "../../mail/dkim.js";

export interface DkimPublic {
  domain: string;
  selector: string;
  dnsName: string;
  txt: string;
  createdAt: number;
}

export interface DkimSecret {
  domain: string;
  selector: string;
  privatePem: string;
}

export function listDkimPublic(db: Db): DkimPublic[] {
  const rows = db
    .prepare("SELECT domain, selector, public_p, created_at FROM dkim_keys ORDER BY domain, selector")
    .all() as Array<{ domain: string; selector: string; public_p: string; created_at: number }>;
  return rows.map((row) => ({
    domain: row.domain,
    selector: row.selector,
    dnsName: dkimDnsName(row.selector, row.domain),
    txt: dkimTxt(row.public_p),
    createdAt: row.created_at,
  }));
}

export function findDkimKey(db: Db, domain: string): DkimSecret | null {
  const row = db
    .prepare(
      `SELECT domain, selector, private_pem FROM dkim_keys
       WHERE domain = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(domain) as { domain: string; selector: string; private_pem: string } | undefined;
  if (!row) return null;
  return { domain: row.domain, selector: row.selector, privatePem: row.private_pem };
}

export function saveDkimKey(db: Db, domainRaw: string, selectorRaw: string | undefined, now: number): DkimPublic {
  const domain = oneDomain(domainRaw);
  const selector = normalizeSelector(selectorRaw);
  const material = generateDkimMaterial();
  db.prepare(
    `INSERT INTO dkim_keys (domain, selector, private_pem, public_p, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain, selector) DO UPDATE SET
       private_pem = excluded.private_pem,
       public_p = excluded.public_p,
       created_at = excluded.created_at`,
  ).run(domain, selector, material.privatePem, material.publicP, now);
  return {
    domain,
    selector,
    dnsName: dkimDnsName(selector, domain),
    txt: dkimTxt(material.publicP),
    createdAt: now,
  };
}

export function deleteDkimKey(db: Db, domainRaw: string, selectorRaw: string): boolean {
  const domain = oneDomain(domainRaw);
  const selector = normalizeSelector(selectorRaw);
  const result = db.prepare("DELETE FROM dkim_keys WHERE domain = ? AND selector = ?").run(domain, selector);
  return result.changes === 1;
}

function oneDomain(raw: string): string {
  try {
    const parsed = parseAcceptDomains(raw);
    if (parsed.length !== 1) throw new OutboundError("invalid domain");
    return parsed[0] ?? "";
  } catch (err) {
    if (err instanceof OutboundError) throw err;
    if (err instanceof ConfigError) throw new OutboundError("invalid domain");
    throw err;
  }
}
