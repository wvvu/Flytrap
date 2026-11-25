// 纯工具函数：地址规范化、时间字节格式化、验证码识别、密码生成。
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
  const who = replyAddress(detail) || "发件方";
  const source = String((detail.parsed && detail.parsed.text) || "").replace(/\r\n/g, "\n").slice(0, 8000);
  const lines = source.split("\n").map((line) => "> " + line);
  return "\n\n" + when + "，" + who + " 写道：\n" + lines.join("\n");
}

export function outboxStatus(item) {
  if (item.status === "sent") return "已发出";
  if (item.status === "error") return "失败";
  if (item.error) return "还会再试";
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
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
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
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
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

const OTP_REPLY_PREFIX_RE = /^(?:re|fwd|fw|回复|转发)\s*[:：]/i;
const OTP_BLOCKED_LABELS = new Set(["phish", "malware", "spam"]);
const OTP_HINT_RE =
  /验证码|驗證碼|校验码|校驗碼|动态码|確認碼|确认码|安全码|安全碼|登录码|登錄碼|一次性代码|一次性代碼|一次性密码|一次性密碼|verification\s*code|confirmation\s*code|security\s*code|passcode|one[-\s]?time|\botp\b|login\s*code|auth(?:entication)?\s*code|c[oó]digo\s+de\s+verificaci/i;
const OTP_NEAR_PATTERNS = [
  /(?:验证码|驗證碼|校验码|校驗碼|动态码|确认码|確認碼|安全码|安全碼|登录码|登錄碼|一次性代码|一次性代碼|一次性密码|一次性密碼)[^\dA-Za-z]{0,12}([0-9]{3}\s[0-9]{3}|[0-9]{4,8})(?![A-Za-z0-9])/i,
  /(?<![A-Za-z0-9])([0-9]{3}\s[0-9]{3}|[0-9]{4,8})(?![A-Za-z0-9])[^\n]{0,16}(?:是本次|为本次|验证码|驗證碼|校验码|确认码|確認碼|登录码|登錄碼)/i,
  /(?:verification|confirmation|security|login|auth(?:entication)?|one[-\s]?time)\s*(?:code|pin|passcode)(?:\s*(?:is|was)\s*)?[^\dA-Za-z]{0,12}([0-9]{3}\s[0-9]{3}|[0-9]{4,8})(?![A-Za-z0-9])/i,
  /\b(?:otp|passcode|code)(?:\s*(?:is|was)\s*)?[:：]\s*([0-9]{3}\s[0-9]{3}|[0-9]{4,8})(?![A-Za-z0-9])/i,
];
const OTP_BRACKET_RE = /[[【(]\s*([0-9]{3}\s[0-9]{3}|[0-9]{6})\s*[\]】)]/;
const OTP_STANDALONE_LINE_RE = /(?:^|\n)[ \t]*([0-9]{3}\s[0-9]{3}|[0-9]{6})[ \t]*(?:\n|$)/;

/** 分类尚未返回时的保守正则兜底，排除回复主题与年份。 */
export function extractOtpCode(subject, text) {
  const subj = String(subject || "").trim();
  if (OTP_REPLY_PREFIX_RE.test(subj)) return "";
  const combined = `${subj}\n${String(text || "").slice(0, 2400)}`;
  const bracket = OTP_BRACKET_RE.exec(subj);
  if (bracket && bracket[1] && !isLikelyYear(bracket[1])) return bracket[1].trim();
  if (!OTP_HINT_RE.test(combined)) return "";
  for (const re of OTP_NEAR_PATTERNS) {
    const near = re.exec(combined);
    if (near && near[1] && !isLikelyYear(near[1])) return near[1].trim();
  }
  const line = OTP_STANDALONE_LINE_RE.exec(combined);
  if (line && line[1] && !isLikelyYear(line[1])) return line[1].trim();
  return "";
}

/** 详情视图：优先采用模型裁决结果；未带 otp 字段时再走保守正则兜底。 */
export function resolveDetailOtp(detail) {
  const ai = detail && detail.aiResult;
  if (ai && typeof ai === "object" && Object.prototype.hasOwnProperty.call(ai, "otp")) {
    if (OTP_BLOCKED_LABELS.has(ai.label)) return "";
    return typeof ai.otp === "string" ? ai.otp.trim() : "";
  }
  if (ai && OTP_BLOCKED_LABELS.has(ai.label)) return "";
  return extractOtpCode(detail?.subject, detail?.parsed?.text || "");
}

/** 列表视图：模型已裁决时以服务端 otp 为准；旧记录或待分类再走保守兜底。 */
export function resolveListOtp(item) {
  if (!item) return "";
  if (OTP_BLOCKED_LABELS.has(item.label)) return "";
  if (item.otpChecked) return typeof item.otp === "string" ? item.otp.trim() : "";
  return extractOtpCode(item.subject, item.summary || "");
}

/** 复制到剪贴板时，纯数字分段码自动去空格与短横线，方便直接粘贴。 */
export function formatOtpForCopy(code) {
  const text = String(code || "").trim();
  if (/^\d+(?:[\s-]\d+)+$/.test(text)) return text.replace(/[\s-]+/g, "");
  return text;
}

function isLikelyYear(code) {
  return /^(?:19|20)\d{2}$/.test(String(code || "").trim());
}

/** 生成易读无歧义的 14 位随机初始密码。 */
export function generateRandomPassword(length = 14) {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
  const bytes = new Uint32Array(length);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 100000);
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function allocationRank(box, local, base) {
  if (box.localpart === local) return 1;
  if (box.localpart === base && local !== base) return 2;
  if (
    typeof box.localpart === "string" &&
    box.localpart.endsWith("*") &&
    box.localpart !== "*" &&
    local.startsWith(box.localpart.slice(0, -1))
  ) {
    return 3;
  }
  if (box.localpart === "*") return 4;
  return 9;
}

/** 判断当前账号是否被授权使用该发件地址。owner 直通，协同管理员和成员走同一套裁决。 */
export function memberCanSendFrom(address) {
  if (!state.sessionUserId) return false;
  if (state.sessionUserId === "owner") return true;
  const norm = normalizeAddress(address);
  if (!norm) return false;
  const at = norm.lastIndexOf("@");
  const local = norm.slice(0, at);
  const plus = local.indexOf("+");
  const base = plus > 0 ? local.slice(0, plus) : local;
  const domain = norm.slice(at + 1);
  const candidates = state.allocatedMailboxes.filter(
    (b) => b.domain === domain && allocationRank(b, local, base) < 9,
  );
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => {
    const rankA = allocationRank(a, local, base);
    const rankB = allocationRank(b, local, base);
    if (rankA !== rankB) return rankA - rankB;
    if (rankA === 3) return b.localpart.length - a.localpart.length;
    return 0;
  });
  return Boolean(candidates[0] && candidates[0].canSend);
}
