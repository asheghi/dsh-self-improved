/**
 * Secret redaction for episode records before persistence: key-based object
 * redaction, pattern-based free-text redaction, and length bounding.
 */

/** Normalized lowercase key names treated as sensitive. */
export const SENSITIVE_KEY_HINTS: string[] = [
  "password", "passwd", "secret", "token", "authtoken", "accesstoken", "refreshtoken",
  "apikey", "apikeyvalue", "authorization", "auth", "cookie", "cookies",
  "privatekey", "recoverycode", "recoveryphrase", "credential", "credentials",
  "bearer", "sessionkey", "clientsecret", "setcookie",
];

/** Keys containing these normalized substrings (beyond the exact list) are sensitive. */
const SENSITIVE_KEY_CONTAINS: string[] = [
  "apikey", "apisecret", "secretkey", "accesstoken", "refreshtoken",
  "privatekey", "recoverycode", "password",
];

/** Normalize a key: lowercase and strip every char outside [a-z0-9]. */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when a normalized key matches the exact list or contains a substring hint. */
const isSensitiveKey = (normalized: string): boolean => {
  if (SENSITIVE_KEY_HINTS.includes(normalized)) return true;
  return SENSITIVE_KEY_CONTAINS.some((s) => normalized.includes(s));
};

/** Deep-clone a value, replacing sensitive-key values with [REDACTED] and cycles with [CYCLIC]. */
export function redactObject(value: unknown): unknown {
  const seen = new Set<object>();
  const walk = (v: unknown, key?: string): unknown => {
    if (key !== undefined && isSensitiveKey(normalizeKey(key))) return "[REDACTED]";
    if (typeof v === "string") return redactFreeText(v); // credentials inside ordinary strings must not persist
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[CYCLIC]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((item) => walk(item));
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) out[k] = walk(item, k);
    return out;
  };
  return walk(value);
}

/** Parse a JSON string, redact object/array results, or fall back to free-text redaction. */
export function redactJsonString(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return redactFreeText(raw);
  }
  if (typeof parsed === "string") return redactFreeText(parsed);
  if (parsed !== null && typeof parsed === "object") return JSON.stringify(redactObject(parsed));
  return raw;
}

/** Free-text replacement patterns applied case-insensitively; value = non-space run.
 * Labeled credential forms use a 4-char floor (short secrets like `token=abc1`
 * and Basic-auth values are still stripped); unanchored forms keep 6+ chars. */
const VALUE = "[^\\s,]{6,}";
const VALUE4 = "[^\\s,]{4,}";
type FreeTextPattern = { re: RegExp; as: ((m: string) => string) | string };
const FREE_TEXT_PATTERNS: FreeTextPattern[] = [
  // Basic-auth forms run BEFORE the generic `authorization:` label so the
  // full "Authorization: Basic <value>" (value may be <16 base64 chars) is
  // consumed whole instead of only its label part.
  { re: /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{8,}/gi, as: "[REDACTED]" },
  { re: new RegExp(`\\bBasic\\s+[A-Za-z0-9+/]{16,}`, "gi"), as: "[REDACTED]" },
  // (a) labeled credentials and headers (every pattern is global: ALL occurrences of each kind are replaced)
  { re: new RegExp(`bearer\\s+${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\btoken=\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bpassword=\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bpasswd=\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bpwd=\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bapi[_-]?key=\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bsecret=\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bauthorization:\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bcookie:\\s*${VALUE4}`, "gi"), as: "[REDACTED]" },
  // Generic labeled-colon/equals credential forms (after the specific Basic/
  // Bearer forms above so whole-form matches win): `password: x`,
  // `TOKEN = abc123`, `secret:xyz` — any non-space run ≥4 chars. May overlap
  // (double-redact) the URL-userinfo pattern; the overlap is benign.
  {
    re: /\b(password|passwd|pwd|secret|api[_-]?key|token|authorization)\s*[:=]\s*\S{4,}/gi,
    as: "[REDACTED]",
  },
  { re: /\b(bearer|basic)\s+[A-Za-z0-9+/=._-]{8,}/gi, as: "[REDACTED]" },
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, as: "[REDACTED]" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, as: "[REDACTED]" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, as: "[REDACTED]" },
  { re: /AKIA[0-9A-Z]{12,}/g, as: "[REDACTED]" },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, as: "[REDACTED]" },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, as: "[REDACTED]" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g, as: "[REDACTED-PRIVATE-KEY]" },
  { re: /https?:\/\/[^/\s:]+:[^@/\s]{4,}@/g, as: (m) => m.match(/^https?:\/\//)?.[0] + "[REDACTED]@" },
];

/** Pattern-based redaction of a free-text string with [REDACTED] placeholders. */
export function redactFreeText(text: string): string {
  let out = text;
  for (const { re, as } of FREE_TEXT_PATTERNS) {
    out = out.replace(re, (m) => (typeof as === "function" ? as(m) : as));
  }
  return out;
}

/** Truncate text to maxChars, reporting whether it was cut. */
export function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * Redact a JSON-argument string, then bound it. Redaction runs BEFORE bounding
 * because patterns work on whole secrets; note pattern redaction cannot
 * guarantee every secret is removed, so truncation also bounds residual
 * exposure. A secret straddling the cut boundary is not affected by this
 * ordering (it was already redacted), but a secret missed by patterns and cut
 * in half may leave a partial fragment — accepted, since bounding limits it.
 */
export function redactAndBoundArguments(raw: string, maxChars: number): { text: string; truncated: boolean } {
  return boundText(redactJsonString(raw), maxChars);
}

/**
 * Redact a result string, then bound it (redaction before bounding). JSON-shaped
 * results are parsed and run through object redaction first (key + free-text
 * patterns), so `{"password":"hunter2"}` cannot persist intact. On a parse
 * failure only the free-text patterns run. Pattern redaction cannot guarantee
 * every secret is removed, so the maxChars bound further limits residual exposure.
 */
export function redactAndBoundResult(text: string, maxChars: number): { text: string; truncated: boolean } {
  let redacted: string;
  try {
    const parsed: unknown = JSON.parse(text);
    redacted = JSON.stringify(redactObject(parsed));
  } catch {
    redacted = redactFreeText(text);
  }
  return boundText(redactFreeText(redacted), maxChars);
}
