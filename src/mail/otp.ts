const OTP_REPLY_PREFIX_RE = /^(?:re|fwd|fw|回复|转发)\s*[:：]/i;
const OTP_BLOCKED_YEAR_RE = /^(?:19|20)\d{2}$/;
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

/** Verify an AI-extracted OTP appears verbatim in the subject or body text. */
export function verifyExtractedOtp(candidate: string | null | undefined, subject: string, text: string): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 32) return null;
  const compact = trimmed.replace(/[\s-]+/g, "");
  if (compact.length < 4 || compact.length > 12) return null;
  if (!/^[A-Za-z0-9]+$/.test(compact)) return null;
  if (OTP_BLOCKED_YEAR_RE.test(compact)) return null;
  if (!/\d/.test(compact) && !/^[A-Z]{5,8}$/.test(compact)) return null;

  const source = `${subject}\n${text}`;
  const pattern = compact.split("").join("[\\s-]?");
  const present = new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "i");
  return present.test(source) ? trimmed : null;
}

/** Conservative regex OTP extraction used when AI classification fails so codes still reach fallback alerts. */
export function extractFallbackOtp(subject: string | null | undefined, text: string | null | undefined): string | null {
  const subj = String(subject ?? "").trim();
  if (OTP_REPLY_PREFIX_RE.test(subj)) return null;
  const body = String(text ?? "");
  const combined = `${subj}\n${body.slice(0, 2400)}`;
  const bracket = OTP_BRACKET_RE.exec(subj);
  if (bracket?.[1]) {
    const verified = verifyExtractedOtp(bracket[1], subj, body);
    if (verified) return verified;
  }
  if (!OTP_HINT_RE.test(combined)) return null;
  for (const re of OTP_NEAR_PATTERNS) {
    const near = re.exec(combined);
    if (near?.[1]) {
      const verified = verifyExtractedOtp(near[1], subj, body);
      if (verified) return verified;
    }
  }
  const line = OTP_STANDALONE_LINE_RE.exec(combined);
  if (line?.[1]) {
    const verified = verifyExtractedOtp(line[1], subj, body);
    if (verified) return verified;
  }
  return null;
}
