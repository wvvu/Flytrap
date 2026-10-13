import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { dkimSign } from "mailauth";
import { OutboundError } from "./address.js";

export const DEFAULT_DKIM_SELECTOR = "flytrap";

const SELECTOR_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type DkimAlg = "rsa" | "ed25519";

export interface DkimMaterial {
  privatePem: string;
  publicP: string;
  alg: DkimAlg;
}

export function normalizeDkimAlg(raw: string | undefined): DkimAlg {
  if (raw === undefined || raw === "rsa") return "rsa";
  if (raw === "ed25519") return "ed25519";
  throw new OutboundError("invalid algorithm");
}

export function normalizeSelector(raw: string | undefined): string {
  const selector = (raw ?? DEFAULT_DKIM_SELECTOR).trim().toLowerCase();
  if (!SELECTOR_RE.test(selector)) throw new OutboundError("invalid selector");
  return selector;
}

export function generateDkimMaterial(alg: DkimAlg = "rsa"): DkimMaterial {
  if (alg === "ed25519") return generateEd25519();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privatePem: pemOf(privateKey), publicP: publicKey.export({ type: "spki", format: "der" }).toString("base64"), alg };
}

function generateEd25519(): DkimMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const bytes = Buffer.isBuffer(der) ? der : Buffer.from(der);
  const raw = bytes.subarray(ED25519_SPKI_PREFIX.length);
  if (raw.length !== 32 || !bytes.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new OutboundError("ed25519 key failed");
  }
  return { privatePem: pemOf(privateKey), publicP: raw.toString("base64"), alg: "ed25519" };
}

function pemOf(key: KeyObject): string {
  const exported = key.export({ type: "pkcs8", format: "pem" });
  return typeof exported === "string" ? exported : exported.toString("utf8");
}

export function dkimDnsName(selector: string, domain: string): string {
  return `${selector}._domainkey.${domain}`;
}

export function dkimTxt(publicP: string, alg: DkimAlg = "rsa"): string {
  const kind = alg === "ed25519" ? "ed25519" : "rsa";
  return `v=DKIM1; k=${kind}; p=${publicP}`;
}

export async function signMessage(
  raw: Buffer,
  input: { domain: string; selector: string; privatePem: string; alg?: DkimAlg },
): Promise<Buffer> {
  const algorithm = input.alg === "ed25519" ? "ed25519-sha256" : "rsa-sha256";
  const signature = {
    signingDomain: input.domain,
    selector: input.selector,
    privateKey: input.privatePem,
    algorithm,
  };
  const signed = await dkimSign(raw, {
    ...signature,
    signatureData: [signature],
  });
  if (signed.errors.length > 0 || !signed.signatures.includes("DKIM-Signature:")) {
    throw new OutboundError("dkim sign failed");
  }
  return Buffer.concat([Buffer.from(signed.signatures, "utf8"), raw]);
}
