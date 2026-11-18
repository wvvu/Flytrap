// 纯工具函数：格式化、地址解析、回复引用推导、验证码提取与随机口令生成。
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

export function replySubject(subject) {
  const text = String(subject || "").trim();
  const value = !text ? "Re:" : /^re:/i.test(text) ? text : "Re: " + text;
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
  const who = replyAddress(detail) || "对方";
  const source = String((detail.parsed && detail.parsed.text) || "").replace(/\r\n/g, "\n").slice(0, 8000);
  const lines = source.split("\n").map((line) => "> " + line);
  return "\n\n" + when + "，" + who + " 写道：\n" + lines.join("\n");
}

export function outboxStatus(item) {
  if (item.status === "sent") return "已发出";
  if (item.status === "error") return "失败";
  if (item.error) return "等待重试";
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
  return raw || "没有发件人";
}

export function formatRecipients(value) {
  const list = Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (list.length === 0) return "";
  return list.map(formatRecipient).join(", ");
}

export function firstRecipientShort(value) {
  const list = Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (list.length === 0) return "";
  const first = extractEmail(list[0]) || list[0];
  return list.length > 1 ? `${first} +${list.length - 1}` : first;
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

const OTP_HINT_RE = /(?:验证码|校验码|动态码|安全码|确认码|登录码|一次性密码|verification\s*code|security\s*code|login\s*code|auth(?:entication)?\s*code|passcode|\botp\b)/i;
const OTP_NEAR_PATTERNS = [
  /(?:验证码|校验码|动态码|安全码|确认码|登录码|一次性密码)[^\dA-Za-z]{0,16}([0-9]{4,8})\b/i,
  /\b([0-9]{4,8})\b[^\n]{0,18}(?:是本次|为本次|验证码|校验码|动态码)/i,
  /(?:verification|security|login|confirmation|authentication|one[-\s]?time)\s*(?:code|pin|passcode)[^\d]{0,20}\b([0-9]{4,8})\b/i,
  /\b(?:otp|passcode|code)\s*[:：is]\s*\b([0-9]{4,8})\b/i,
];

/** 从正常邮件标题与纯文本中提取高置信度数字验证码（排除年份与纯金额）。 */
export function extractOtpCode(subject, plainText, label) {
  if (label && label !== "legit" && label !== "gray") return "";
  const sample = `${String(subject || "")}\n${String(plainText || "").slice(0, 2400)}`;
  if (!OTP_HINT_RE.test(sample)) return "";
  for (const re of OTP_NEAR_PATTERNS) {
    const m = re.exec(sample);
    if (m && m[1] && !isLikelyYear(m[1])) return m[1];
  }
  const standaloneLine = sample.match(/(?:^|\n)\s*([0-9]{6})\s*(?:\n|$)/);
  if (standaloneLine && standaloneLine[1]) return standaloneLine[1];
  return "";
}

function isLikelyYear(digits) {
  if (digits.length !== 4) return false;
  const n = Number(digits);
  return n >= 1990 && n <= 2039;
}

/** 在浏览器端用密码学随机数生成易读高强度初始口令。 */
export function generateStrongPassword(length = 16) {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*-_";
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
