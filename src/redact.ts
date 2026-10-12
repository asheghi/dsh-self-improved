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
  // Phase B recall fix: short, exactly-named credential keys (PINs/auth keys).
  // Exact matches only — "pin" is intentionally NOT a substring/ends-with hint
  // so benign keys like `pinned`/`spinning`/`unpin` are never redacted.
  "pin", "pincode", "authkey",
];

/** Keys containing these normalized substrings (beyond the exact list) are sensitive. */
const SENSITIVE_KEY_CONTAINS: string[] = [
  "apikey", "apisecret", "secretkey", "accesstoken", "refreshtoken",
  "privatekey", "recoverycode", "password",
  // Phase B minimization: header/env-shaped key names that normalize into
  // these substrings leak the same credential classes.
  "authtoken", "credential", "passphrase", "proxyauth", "wwwauthenticate",
  "servicekey", "signingkey", "pincode", "authkey",
];

/**
 * Keys ENDING with one of these normalized words are sensitive — the common
 * env-var naming shape (`DEPLOY_TOKEN`, `API_SECRET`, `MY_PASSWD`, …). The
 * word-boundary ending keeps documented benign keys safe (`tokenize`,
 * `tokenCount`, `tokenizer` do not END with a credential word in normalized
 * form: "tokenize"→ends 'e', "tokens"→ends 's', "tokenCount"→ends 'count').
 */
const SENSITIVE_KEY_ENDS_WITH: string[] = [
  "password", "passwd", "pwd", "secret", "passphrase", "passcode", "credential",
  "apikey", "apisecret", "token", "privatekey", "authtoken", "accesstoken",
  "refreshtoken", "sessionkey", "servicekey", "signingkey", "recoverycode",
];

/** Normalize a key: lowercase and strip every char outside [a-z0-9]. */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when a normalized key matches the exact list, contains a substring hint, or ends with a credential word. */
const isSensitiveKey = (normalized: string): boolean => {
  if (SENSITIVE_KEY_HINTS.includes(normalized)) return true;
  if (SENSITIVE_KEY_CONTAINS.some((s) => normalized.includes(s))) return true;
  return SENSITIVE_KEY_ENDS_WITH.some((s) => normalized.endsWith(s));
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
 * Labeled credential forms (`label[:=]value`, quoted-label values, URI
 * userinfo) have NO length floor: a labeled credential must never persist
 * (`password=x`, `pwd=xy`, `pin=1234`, `postgres://u:p@host` are all
 * redacted). Unanchored/unlabeled forms keep a length floor (Bearer/Basic +
 * value ≥4 chars) because "bearer"/"basic" are ordinary English words and
 * over-matching there destroys benign text. */
const VALUE = "[^\\s,]{6,}";
const VALUE4 = "[^\\s,]{4,}";
/** Labeled credential value: any non-empty non-space run (no length floor). */
const VALUE_ANY = "[^\\s,]+";
/** Word-boundary credential label run (used by the Phase B added patterns). */
const CREDENTIAL_LABEL_RUN = "(?:password|passwd|pwd|secret|secretkey|passcode|passphrase|pin(?:code)?|auth(?:[_-]?key)|credentials?|apikey|api[_-]?key|api[_-]?secret|authtoken|auth[_-]?token|accesstoken|access[_-]?token|refreshtoken|refresh[_-]?token|sessionkey|session[_-]?key|servicekey|service[_-]?key|signingkey|signing[_-]?key|privatekey|private[_-]?key|secret[_-]?key|recoverycode|recovery[_-]?code|token)";

type FreeTextPattern = { re: RegExp; as: ((m: string) => string) | string };
const FREE_TEXT_PATTERNS: FreeTextPattern[] = [
  // Basic-auth forms run BEFORE the generic `authorization:` label so the
  // full "Authorization: Basic <value>" (value may be <16 base64 chars) is
  // consumed whole instead of only its label part.
  { re: /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{8,}/gi, as: "[REDACTED]" },
  { re: new RegExp(`\\bBasic\\s+[A-Za-z0-9+/]{16,}`, "gi"), as: "[REDACTED]" },
  // (a) labeled credentials and headers (every pattern is global: ALL occurrences of each kind are replaced)
  { re: new RegExp(`bearer\\s+${VALUE4}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\btoken=\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bpassword=\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bpasswd=\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bpwd=\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bapi[_-]?key=\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bsecret=\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bauthorization:\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  { re: new RegExp(`\\bcookie:\\s*${VALUE_ANY}`, "gi"), as: "[REDACTED]" },
  // Generic labeled-colon/equals credential forms (after the specific Basic/
  // Bearer forms above so whole-form matches win): `password: x`,
  // `TOKEN = abc123`, `secret:xyz`, `pin=1` — ANY non-space, non-comma run,
  // no length floor (Phase B recall fix: labeled credentials never persist,
  // however short). The separator immediately following the label keeps
  // benign word shapes (`tokenizer=on`, `taping=…`) unmatched by construction.
  {
    re: /\b(password|passwd|pwd|secret|pin(?:code)?|auth(?:[_-]?key)?|authorization|api[_-]?key|token)\s*[:=]\s*[^\s,]+/gi,
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
  { re: /https?:\/\/[^/\s:]+:[^@/\s]+@/g, as: (m) => m.match(/^https?:\/\//)?.[0] + "[REDACTED]@" },
  // ── Phase B minimization additions (appended AFTER every legacy pattern so
  // legacy match rendering is byte-for-byte unchanged; only credential shapes
  // the legacy list missed are additionally redacted) ──
  // (1) Extended credential-assignment / header-label vocabulary: `-H
  // X-Api-Key:…`, `client_secret=…`, `Set-Cookie:…`, `docker run -e
  // API_SECRET=…`, `export SERVICE_KEY=…` (the `export`/`-e` carrier is
  // irrelevant — the labeled assignment itself matches). No value length floor
  // (Phase B recall fix): `X-Api-Key: ab` must not persist.
  {
    re: /\b(?:(?:x-)?(?:api[_-]?key|api[_-]?secret|auth[_-]?token|auth[_-]?keys|authkey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|pin(?:code)?|session[_-]?key|service[_-]?key|signing[_-]?key|csrf[_-]?token|amz-security-token)|proxy-authorization|www-authenticate|set-cookie|passphrase|secretkey)\s*[:=]\s*[^\s,]+/gi,
    as: "[REDACTED]",
  },
  // (2) Quoted JSON/YAML-ish assignment inside free text: `"password":
  // "hunter2"`, `"MY_SECRET_KEY": "abcdef…"` — the label and quoting stay
  // visible, only the value is dropped.
  {
    re: new RegExp(`\\b[A-Za-z0-9_./-]*${CREDENTIAL_LABEL_RUN}\\s*"?\\s*:\\s*"[^"]+"`, "gi"),
    as: redactQuotedAssignment,
  },
  // (3) ENV/namespace-prefixed assignment (`DEPLOY_TOKEN=…`, `MY_API_KEY: …`,
  // `CI_SECRET=…`): any dotted/dashed/scored key run ENDING on a credential
  // word. The word-boundary ending keeps benign forms (`tokenizer=on`,
  // `tokens=3`) untouched.
  {
    re: new RegExp(`\\b[A-Za-z0-9_./-]*${CREDENTIAL_LABEL_RUN}\\s*[:=]\\s*${VALUE_ANY}`, "gi"),
    as: "[REDACTED]",
  },
  // (4) Credential userinfo on OTHER URI schemes (the legacy pattern covers
  // http(s) only): `postgres://user:pw@host`, `redis://…@`.
  { re: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:]+:[^@/\s]+@/g,
    as: (m) => m.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//)?.[0] + "[REDACTED]@" },
  // (4) Additional literal token formats (bounded well-known vocabularies only —
  // never a catch-all rule, ordinary hex/base64 text stays untouched).
  { re: /npm_[A-Za-z0-9]{20,}/g, as: "[REDACTED]" },
  { re: /glpat-[A-Za-z0-9_-]{15,}/g, as: "[REDACTED]" },
  { re: /dop_v1_[A-Za-z0-9]{20,}/g, as: "[REDACTED]" },
  { re: /AIza[A-Za-z0-9_-]{30,}/g, as: "[REDACTED]" },
];

/**
 * Rebuild a labeled quoted assignment (`"password": "xxx…"`, `password: "x"`)
 * keeping the label and surrounding quotes, dropping only the value: quoting
 * structure stays inspectable while no credential material survives.
 */
function redactQuotedAssignment(m: string): string {
  const cut = m.indexOf(":");
  const quote = m.indexOf('"', cut === -1 ? 0 : cut + 1);
  if (cut === -1 || quote <= cut) return "[REDACTED]";
  return `${m.slice(0, quote + 1)}[REDACTED]"`;
}

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

/**
 * Redact ANY metadata payload (retained plugin metadata, provider-side review
 * payloads, export/backup fields, or debug annotations), then bound it.
 *
 * Accepts a string (free-text patterns after a JSON parse attempt, identical
 * to {@link redactAndBoundResult}) or ANY JSON-able value (deep key-based
 * redaction through {@link redactObject} first — every sensitive-key value,
 * including nested credential objects/env maps — then the free-text patterns
 * over the serialized form, so credentials embedded in ordinary-key strings
 * and unlabelled JSON leaves cannot survive either). Bounding is the final
 * defense: pattern redaction cannot guarantee every secret is removed.
 *
 * Phase B wiring note (producer lane owns capture/export/debug lanes; this
 * helper is the conservative seam): no lane may persist, send to a provider,
 * export, or log metadata without passing it through this (or an equivalent
 * redactObject/boundText composition) FIRST.
 */
export function redactAndBoundMetadata(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  return redactAndBoundResult(raw, maxChars);
}
