/** Last four characters, and only when the secret is long enough that those four are not most of it. */
export function keyTail(secret: string): string {
  const value = secret.trim();
  if (value.length < 12) return "";
  return value.slice(-4);
}

export function scrubSecrets(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length >= 8) out = out.split(value).join("[redacted]");
  }
  return out.replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]");
}
