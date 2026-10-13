import type { Db } from "../index.js";
import { ConfigError, parseAcceptDomains } from "../../config.js";
import { OutboundError } from "../../mail/address.js";
import { dkimDnsName, dkimTxt, generateDkimMaterial, normalizeDkimAlg, normalizeSelector, type DkimAlg } from "../../mail/dkim.js";

export interface DkimPublic {
  domain: string;
  selector: string;
  algorithm: DkimAlg;
  dnsName: string;
  txt: string;
  createdAt: number;
}

export interface DkimSecret {
  domain: string;
  selector: string;
  algorithm: DkimAlg;
  privatePem: string;
}

export function listDkimPublic(db: Db): DkimPublic[] {
  const rows = db
    .prepare("SELECT domain, selector, public_p, alg, created_at FROM dkim_keys ORDER BY domain, selector")
    .all() as Array<{ domain: string; selector: string; public_p: string; alg: string; created_at: number }>;
  return rows.map((row) => presentKey(row.domain, row.selector, row.public_p, row.alg, row.created_at));
}

export function findDkimKey(db: Db, domain: string): DkimSecret | null {
  const row = db
    .prepare(
      `SELECT domain, selector, private_pem, alg FROM dkim_keys
       WHERE domain = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(domain) as { domain: string; selector: string; private_pem: string; alg: string } | undefined;
  if (!row) return null;
  return {
    domain: row.domain,
    selector: row.selector,
    algorithm: storedAlg(row.alg),
    privatePem: row.private_pem,
  };
}

export function saveDkimKey(
  db: Db,
  domainRaw: string,
  selectorRaw: string | undefined,
  now: number,
  algorithmRaw?: string,
): DkimPublic {
  const domain = oneDomain(domainRaw);
  const selector = normalizeSelector(selectorRaw);
  const material = generateDkimMaterial(normalizeDkimAlg(algorithmRaw));
  db.prepare(
    `INSERT INTO dkim_keys (domain, selector, private_pem, public_p, alg, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain, selector) DO UPDATE SET
       private_pem = excluded.private_pem,
       public_p = excluded.public_p,
       alg = excluded.alg,
       created_at = excluded.created_at`,
  ).run(domain, selector, material.privatePem, material.publicP, material.alg, now);
  return presentKey(domain, selector, material.publicP, material.alg, now);
}

export function deleteDkimKey(db: Db, domainRaw: string, selectorRaw: string): boolean {
  const domain = oneDomain(domainRaw);
  const selector = normalizeSelector(selectorRaw);
  const result = db.prepare("DELETE FROM dkim_keys WHERE domain = ? AND selector = ?").run(domain, selector);
  return result.changes === 1;
}

function presentKey(domain: string, selector: string, publicP: string, alg: string, createdAt: number): DkimPublic {
  const algorithm = storedAlg(alg);
  return {
    domain,
    selector,
    algorithm,
    dnsName: dkimDnsName(selector, domain),
    txt: dkimTxt(publicP, algorithm),
    createdAt,
  };
}

function storedAlg(raw: string): DkimAlg {
  return raw === "ed25519" ? "ed25519" : "rsa";
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
