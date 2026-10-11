import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";
import { OutboundError } from "./address.js";

export const DEFAULT_DKIM_SELECTOR = "flytrap";

const SELECTOR_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface DkimMaterial {
  privatePem: string;
  publicP: string;
}

export function normalizeSelector(raw: string | undefined): string {
  const selector = (raw ?? DEFAULT_DKIM_SELECTOR).trim().toLowerCase();
  if (!SELECTOR_RE.test(selector)) throw new OutboundError("invalid selector");
  return selector;
}

export function generateDkimMaterial(): DkimMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = privateKey.export({ type: "pkcs8", format: "pem" });
  const privatePem = typeof exported === "string" ? exported : exported.toString("utf8");
  const publicP = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { privatePem, publicP };
}

export function dkimDnsName(selector: string, domain: string): string {
  return `${selector}._domainkey.${domain}`;
}

export function dkimTxt(publicP: string): string {
  return `v=DKIM1; k=rsa; p=${publicP}`;
}

export async function signMessage(
  raw: Buffer,
  input: { domain: string; selector: string; privatePem: string },
): Promise<Buffer> {
  const signed = await dkimSign(raw, {
    signingDomain: input.domain,
    selector: input.selector,
    privateKey: input.privatePem,
    signatureData: [
      {
        signingDomain: input.domain,
        selector: input.selector,
        privateKey: input.privatePem,
      },
    ],
  });
  if (signed.errors.length > 0 || !signed.signatures.includes("DKIM-Signature:")) {
    throw new OutboundError("dkim sign failed");
  }
  return Buffer.concat([Buffer.from(signed.signatures, "utf8"), raw]);
}
