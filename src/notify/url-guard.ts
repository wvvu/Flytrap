import { isIPv4, isIPv6 } from "node:net";

const CONTROL_RE = /[\u0000-\u001F\u007F]/;

export interface ValidateWebhookUrlOptions {
  blockPrivate?: boolean;
}

/** Validate a webhook/Bark URL and optionally reject loopback, private, and link-local hosts. */
export function validateWebhookUrl(raw: string, options: ValidateWebhookUrlOptions = {}): string {
  if (CONTROL_RE.test(raw)) {
    throw new Error("invalid webhook url");
  }
  const url = raw.trim();
  if (!url) {
    throw new Error("invalid webhook url");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid webhook url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid webhook url");
  }

  const rawHost = parsed.hostname.toLowerCase();
  const unwrapped = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const host = unwrapped.replace(/\.+$/, "");
  if (!host) {
    throw new Error("invalid webhook url");
  }

  if (options.blockPrivate && isForbiddenWebhookHost(host)) {
    throw new Error("forbidden webhook url");
  }
  return url;
}

function isForbiddenWebhookHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (isIPv4(host)) {
    return isForbiddenIpv4(host);
  }
  if (isIPv6(host)) {
    return isForbiddenIpv6(host);
  }
  return !host.includes(".");
}

function isForbiddenIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  return isForbiddenIpv4Octets(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
}

function isForbiddenIpv4Octets(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
  return false;
}

function isForbiddenIpv6(ip: string): boolean {
  const groups = parseIpv6Groups(ip);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true; // :: and ::1
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isForbiddenIpv4Octets((g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff);
  }
  return false;
}

function parseIpv6Groups(ip: string): number[] | null {
  const zoneIdx = ip.indexOf("%");
  const clean = zoneIdx >= 0 ? ip.slice(0, zoneIdx) : ip;
  const halves = clean.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.includes(".")) {
        if (i !== tokens.length - 1 || !isIPv4(token)) return null;
        const octets = token.split(".").map(Number);
        out.push(((octets[0]! << 8) | octets[1]!) >>> 0);
        out.push(((octets[2]! << 8) | octets[3]!) >>> 0);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        out.push(Number.parseInt(token, 16));
      }
    }
    return out;
  };

  const left = parseSide(halves[0]!);
  if (!left) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseSide(halves[1]!);
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}
