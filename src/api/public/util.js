// 纯工具函数：格式化、地址解析、回复/转发推导、智能验证码提取、随机强口令生成。
import { state } from "./state.js";

export function hashMailId() {
  const match = /^#\/m\/([\w-]+)$/.exec(window.location.hash || "");
  return match ? match[1] : "";
}

export function replyAddress(detail) {
  const box = detail && detail.parsed && detail.parsed.replyTo;
  const reply = box && typeof box.address === "string" ? box.address : "";
  return extractEmail(reply) || extractEmail((detail && (detail.from || detail.envelopeFrom)) || "");
}

export function replyAllAddresses(detail, selfFrom) {
  const primary = replyAddress(detail);
  const selfLower = normalizeAddress(selfFrom);
  const extra = [];
  const seen = new Set();
  if (primary) seen.add(primary.toLowerCase());
  if (selfLower) seen.add(selfLower);

  const candidates = [];
  if (Array.isArray(detail?.to)) candidates.push(...detail.to);
  if (Array.isArray(detail?.envelopeTo)) candidates.push(...detail.envelopeTo);

  for (const item of candidates) {
    const addr = normalizeAddress(extractEmail(String(item)));
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    extra.push(addr);
  }
  return { to: primary, cc: extra.slice(0, 15) };
}

export function replySubject(subject) {
  const text = String(subject || "").trim();
  const value = !text ? "Re:" : /^re:/i.test(text) ? text : "Re: " + text;
  return value.slice(0, 200);
}

export function forwardSubject(subject) {
  const text = String(subject || "").trim();
  const value = !text ? "Fwd:" : /^(?:fwd|fw):/i.test(text) ? text : "Fwd: " + text;
  return value.slice(0, 200);
}

export function normalizeClientId(raw) {
  if (!raw) return "";
  let text = String(raw).trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1).trim();
  text = text.toLowerCase();
  if (!/^[^\s<>]{1,200}$/.test(text)) return "";
  return text;
}

export function capReplyRefs(ids) {
  const unique = [];
  for (const id of ids) {
    if (id && !unique.includes(id)) unique.push(id);
  }
  if (unique.length <= 20) return unique;
  const tail = unique.slice(-19).filter((id) => id !== unique[0]);
  return [unique[0], ...tail];
}

export function quoteLetter(detail) {
  const when = formatFullTime(detail.receivedAt) || "";
  const who = replyAddress(detail) || "发件方";
  const source = String((detail.parsed && detail.parsed.text) || "").replace(/\r\n/g, "\n").slice(0, 8000);
  const lines = source.split("\n").map((line) => "> " + line);
  return "\n\n" + when + "，" + who + " 写道：\n" + lines.join("\n");
}

export function forwardBody(detail) {
  const from = detail.from || detail.envelopeFrom || "";
  const to = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : String(detail.envelopeTo || "");
  const when = formatFullTime(detail.receivedAt) || "";
  const subj = detail.subject || "(无主题)";
  const source = String((detail.parsed && detail.parsed.text) || "").replace(/\r\n/g, "\n").slice(0, 12000);
  return (
    "\n\n---------- 转发邮件 ----------\n" +
    `发件人: ${from}\n` +
    `时间: ${when}\n` +
    `主题: ${subj}\n` +
    `收件人: ${to}\n\n` +
    source
  );
}

/**
 * 智能验证码识别：仅在主题或正文出现明确验证语境时提取 4-8 位验证码，避免将年份或金额误判。
 */
export function extractVerificationCode(subject, bodyText) {
  const combined = `${String(subject || "")}\n${String(bodyText || "").slice(0, 2400)}`;
  const cueRe = /(?:验证码|校验码|动态码|安全码|确认码|登录码|一次性密码|verification\s*code|security\s*code|login\s*code|passcode|one[-\s]?time\s*(?:code|password)|\botp\b)/i;
  if (!cueRe.test(combined)) return "";

  const directPatterns = [
    /(?:验证码|校验码|动态码|安全码|确认码|登录码)[：:\s是为]*([0-9]{4,8})\b/i,
    /(?:verification|security|confirmation|login|one[-\s]?time)\s*(?:code|password|pin)[：:\sis]*([0-9]{4,8})\b/i,
    /\b([0-9]{6})\b(?=[^\n]{0,30}(?:分钟|有效|valid|expire))/i,
  ];
  for (const re of directPatterns) {
    const m = re.exec(combined);
    if (m && m[1] && !isLikelyYear(m[1])) return m[1];
  }

  const lines = combined.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^[0-9]{6}$/.test(line) && !isLikelyYear(line)) return line;
    if (cueRe.test(line)) {
      const sameLine = line.match(/\b([0-9]{4,8})\b/);
      if (sameLine && sameLine[1] && !isLikelyYear(sameLine[1])) return sameLine[1];
      const nextLine = (lines[i + 1] || "").trim();
      const nextMatch = nextLine.match(/^([0-9]{4,8})$/);
      if (nextMatch && nextMatch[1] && !isLikelyYear(nextMatch[1])) return nextMatch[1];
    }
  }
  return "";
}

function isLikelyYear(token) {
  if (token.length !== 4) return false;
  const n = Number(token);
  return n >= 1990 && n <= 2039;
}

export function avatarInitial(raw) {
  const text = String(raw || "").trim();
  if (!text) return "M";
  const display = formatFrom(text);
  const clean = display.replace(/^["'<(\s]+/, "").trim();
  if (!clean) return "M";
  const ch = clean[0];
  return ch ? ch.toUpperCase() : "M";
}

export function avatarToneIndex(raw) {
  const s = extractEmail(raw) || String(raw || "");
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash % 6;
}

export function generateStrongPassword(length = 16) {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
  const arr = new Uint32Array(length);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < length; i += 1) arr[i] = Math.floor(Math.random() * 100000);
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[arr[i] % alphabet.length];
  }
  return out;
}

export function outboxStatus(item) {
  if (item.status === "sent") return "已发出";
  if (item.status === "error") return "失败";
  if (item.error) return "重试排队";
  return "排队中";
}

export function extractEmail(raw) {
  if (!raw) return "";
  const text = String(raw).trim().toLowerCase();
  const angled = text.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : text).trim();
  return candidate.includes("@") ? candidate : "";
}

export function formatFrom(raw) {
  const email = extractEmail(raw);
  const named = email ? state.senderMap.get(email) : "";
  if (named && email) return `${named} · ${email}`;
  const displayMatch = String(raw || "").match(/^"?([^"<]+)"?\s*<[^>]+>$/);
  if (displayMatch && displayMatch[1] && displayMatch[1].trim()) {
    return `${displayMatch[1].trim()} · ${email}`;
  }
  return raw || "未知发件方";
}

export function formatFromCompact(raw) {
  const email = extractEmail(raw);
  const named = email ? state.senderMap.get(email) : "";
  if (named) return named;
  const displayMatch = String(raw || "").match(/^"?([^"<]+)"?\s*<[^>]+>$/);
  if (displayMatch && displayMatch[1] && displayMatch[1].trim()) {
    return displayMatch[1].trim();
  }
  return email || raw || "未知发件方";
}

export function formatRecipients(value) {
  const list = Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (list.length === 0) return "";
  return list.map(formatRecipient).join(", ");
}

export function formatRecipient(raw) {
  const email = extractEmail(raw);
  if (!email) return raw;
  const named = state.mailboxNames.get(email);
  if (named) return `${named} · ${email}`;
  const domain = email.split("@")[1];
  if (domain && state.domainNames[domain]) return `${email}（${state.domainNames[domain]}）`;
  return raw;
}

export function normalizeAddress(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(text)) return "";
  return text;
}

export function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function formatShortTime(val) {
  if (!val) return "";
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatFullTime(val) {
  if (!val) return "";
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
