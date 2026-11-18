// 纯工具函数：地址解析、显示格式化、验证码智能识别、文件读取与防抖。
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
  const sig = state.signature ? "\n\n--\n" + state.signature.trim() : "";
  return sig + "\n\n" + when + "，" + who + " 写道：\n" + lines.join("\n");
}

export function outboxStatus(item) {
  if (item.status === "sent") return "已送达";
  if (item.status === "error") return "失败";
  if (item.error) return "重试中";
  return "排队中";
}

export function extractEmail(raw) {
  if (!raw) return "";
  const text = String(raw).trim().toLowerCase();
  const angled = text.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : text).trim();
  return candidate.includes("@") ? candidate : "";
}

export function extractDisplayName(raw) {
  if (!raw) return "";
  const text = String(raw).trim();
  const match = text.match(/^([^<]+)<[^>]+>$/);
  if (!match) return "";
  return match[1].replace(/^["'\s]+|["'\s]+$/g, "").trim();
}

export function formatFrom(raw) {
  if (!raw) return "没有发件人";
  const email = extractEmail(raw);
  const custom = email ? state.senderMap.get(email) : "";
  if (custom && email) return `${custom} · ${email}`;
  const display = extractDisplayName(raw);
  if (display && email && display.toLowerCase() !== email) {
    return `${display} <${email}>`;
  }
  return email || raw;
}

export function formatListSender(raw) {
  if (!raw) return "没有发件人";
  const email = extractEmail(raw);
  const custom = email ? state.senderMap.get(email) : "";
  if (custom) return custom;
  const display = extractDisplayName(raw);
  if (display) return display;
  return email || raw;
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
  return email;
}

export function formatShortRecipient(raw) {
  const email = extractEmail(raw);
  if (!email) return "";
  const named = state.mailboxNames.get(email);
  if (named) return `→ ${named}`;
  return `→ ${email}`;
}

const OTP_HINT_RE = /验证码|校验码|动态码|确认码|安全码|登录码|verification\s*code|security\s*code|passcode|one[-\s]?time|otp|login\s*code|auth\s*code/i;
const OTP_NEAR_RE = /(?:验证码|校验码|动态码|确认码|安全码|code|otp|passcode)[^\dA-Za-z]{0,18}([0-9]{4,8})\b/i;
const OTP_STANDALONE_RE = /\b([0-9]{6})\b/g;

export function extractOtpCode(subject, text) {
  const combined = `${subject || ""}\n${(text || "").slice(0, 2400)}`;
  if (!OTP_HINT_RE.test(combined)) return "";
  const near = OTP_NEAR_RE.exec(combined);
  if (near && near[1] && !isLikelyYear(near[1])) return near[1];
  const matches = [...combined.matchAll(OTP_STANDALONE_RE)];
  for (const m of matches) {
    if (m[1] && !isLikelyYear(m[1])) return m[1];
  }
  return "";
}

function isLikelyYear(code) {
  return /^(?:19|20)\d{2}$/.test(code);
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
  return new Date(val).toLocaleString();
}

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === "string" ? reader.result : "";
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
