#!/usr/bin/env node
/**
 * scripts/test-v02-minimization.mjs — Phase B data-minimization canaries.
 *
 * Owner: Phase B recall/inject lane (src/redact.ts). All markers are
 * SYNTHETIC; no real credentials, no filesystem writes, no provider, no
 * profile, no production store is touched.
 *
 * Coverage demanded by MIGRATION-V0.2.md (§learning/privacy defects): a
 * conservative, bounded redactor that covers ordinary user/assistant/tool
 * free text, structured JSON, credential assignments (incl. env-style),
 * header labels, URI userinfo on any scheme, well-known literal token
 * formats, and private-key material — plus a metadata seam so retained,
 * provider-side, export and debug metadata never carry credentials.
 *
 * Also guarded: the redactor must stay conservative — ordinary text (hex
 * checksums, URLs without userinfo, benign words containing "token"/"auth")
 * is never mangled.
 */
import {
  SENSITIVE_KEY_HINTS, redactObject, redactJsonString, redactFreeText,
  boundText, redactAndBoundArguments, redactAndBoundResult, redactAndBoundMetadata,
} from "../lib/redact.js";

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? `  (${e})` : ""}`);
  if (!c) failed++;
};
const C = (out, canary, label) => check(`${label}: canary does not survive`, !out.includes(canary), out.slice(0, 140));
const K = (label, kept, out) => check(`${label}: benign structure preserved`, out.includes(kept), out.slice(0, 140));

// ── 1. env-style credential assignments ──
{
  const out = redactFreeText("export DEPLOY_TOKEN=synthetic_env_token_9f8e7d && ./deploy.sh");
  C(out, "synthetic_env_token_9f8e7d", "env export assignment");
  K("env export assignment", "./deploy.sh", out);
  const out2 = redactFreeText('export MY_SECRET_KEY="syn-quoted-env-secret-7777" && bash');
  C(out2, "syn-quoted-env-secret-7777", "quoted env assignment");
  K("quoted env assignment", "&& bash", out2);
  const out3 = redactFreeText("docker run -e API_SECRET=synth_docker_env_12345678 image");
  C(out3, "synth_docker_env_12345678", "docker -e assignment");
  K("docker -e assignment", "image", out3);
  const out4 = redactFreeText("PASSWORD = spaced assignment value1234 done");
  C(out4, "spaced assignment value1234", "spaced assignment");
}
// ── 2. header labels ──
{
  const out = redactFreeText("curl -H 'X-Api-Key: synth_header_key_4321' https://api.example.test");
  C(out, "synth_header_key_4321", "x-api-key header");
  K("x-api-key header", "https://api.example.test", out);
  const out2 = redactFreeText('--header "Authorization: Bearer synth_bearer_value_1234"');
  C(out2, "synth_bearer_value_1234", "authorization bearer header");
  const out3 = redactFreeText("Set-Cookie: synth_session_cookie_value_8888; Path=/; HttpOnly");
  C(out3, "synth_session_cookie_value_8888", "set-cookie header");
  const out4 = redactFreeText("proxy-authorization: synth_proxy_basic_5555 next");
  C(out4, "synth_proxy_basic_5555", "proxy-authorization header");
  const out5 = redactFreeText('client_secret = "synth_oauth_secret_0000" submitted');
  C(out5, "synth_oauth_secret_0000", "client_secret assignment");
}
// ── 3. URI userinfo on other schemes ──
{
  const out = redactFreeText("psql postgres://svc_user:postgre_spw_9999@db.internal:5432/app");
  C(out, "postgre_spw_9999", "postgres URI userinfo");
  K("postgres URI userinfo", "db.internal:5432/app", out);
  const out2 = redactFreeText("redis://default:redis_spw_8888@cache.internal:6379");
  C(out2, "redis_spw_8888", "redis URI userinfo");
}
// ── 4. additional well-known literal tokens ──
{
  C(redactFreeText("registry auth npm_0000000000111111111122222 tail"), "npm_0000000000111111111122222", "npm literal");
  C(redactFreeText("token glpat-synthpat-abcdef0123456789, rest"), "glpat-synthpat-abcdef0123456789", "gitlab pat literal");
  C(redactFreeText("digitalocean dop_v1_0000000000111111111122223333444 ok"), "dop_v1_0000000000111111111122223333444", "do token literal");
  C(redactFreeText("key AIzaSyA-synthetic0123456789012345678901 done"), "AIzaSyA-synthetic0123456789012345678901", "google api literal");
}
// ── 5. quoted JSON assignment inside free text (unparsed payload) ──
{
  const out = redactFreeText('config load failed: {"password": "synth_json_pw_5555"} — retrying');
  C(out, "synth_json_pw_5555", "quoted json assignment");
  K("quoted json assignment", 'config load failed:', out);
  K("quoted json assignment", '"password"', out);
  const out2 = redactFreeText('api_key: "synth_quoted_api_9999" written');
  C(out2, "synth_quoted_api_9999", "yaml-ish quoted value");
}
// ── 6. private-key material ──
{
  const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7synthetic\nmorelines\n-----END PRIVATE KEY-----\nkeep-after`;
  const out = redactFreeText(pem);
  C(out, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7synthetic", "PEM private key block");
  K("PEM private key block", "keep-after", out);
}
// ── 7. metadata seam: nested objects, env maps, headers, strings, bounding ──
{
  const meta = {
    cwd: "/work/app",
    env: { CI_DEPLOY_TOKEN: "synth_meta_env_1111", PATH: "/usr/bin:/bin" },
    headers: { authorization: "Bearer synth_meta_bearer_2222", "content-type": "application/json" },
    counts: { tokens: 42, warnings: 1 },
    note: "ordinary summary without credentials",
  };
  const out = redactAndBoundMetadata(meta, 10_000);
  C(JSON.stringify(out), "synth_meta_env_1111", "metadata env map");
  C(JSON.stringify(out), "synth_meta_bearer_2222", "metadata header value");
  check("metadata preserves benign keys/shape", (() => {
    const parsed = JSON.parse(out.text);
    return parsed.headers["content-type"] === "application/json"
      && parsed.counts.tokens === 42
      && parsed.env.PATH === "/usr/bin:/bin"
      && parsed.note === "ordinary summary without credentials";
  })(), out.text.slice(0, 160));
  check("metadata sensitive keys are replaced, not dropped", JSON.parse(out.text).headers.authorization === "[REDACTED]", out.text.slice(0, 200));
  const bounded = redactAndBoundMetadata(meta, 64);
  check("metadata bounding truncates and reports", bounded.text.length === 64 && bounded.truncated === true, JSON.stringify(bounded.truncated));
  const stringPayload = redactAndBoundMetadata('debug: password=synth_debug_pw_3333', 10_000);
  C(stringPayload.text, "synth_debug_pw_3333", "metadata free-text payload");
  const labeledPayload = redactAndBoundMetadata("env snapshot: DEPLOY_SECRET=synth_meta_env_4444", 10_000);
  C(labeledPayload.text, "synth_meta_env_4444", "metadata env snapshot");
}
// ── 8. conservatism: ordinary content is untouched ──
{
  const ordinary = "sha512 deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef0123 tokenizer=on";
  check("ordinary hex + benign variable untouched", redactFreeText(ordinary) === ordinary, redactFreeText(ordinary));
  const url = "https://example.test/health?timeout=300ms";
  check("plain URL without userinfo untouched", redactFreeText(url) === url, redactFreeText(url));
  const wordy = "the stopwords authentify the authority; tokenize the tokens counts=3";
  check("benign words containing token/auth prefixes untouched", redactFreeText(wordy) === wordy, redactFreeText(wordy));
  // EXPECTATION CHANGED (MIGRATION-PHASE-B-RECALL fix): explicit labeled
  // credentials are redacted REGARDLESS of length — `token: ab` and `pwd=xy`
  // previously survived and were the recall defect. All other scenes above
  // (hex, URLs, benign token/auth words) stay untouched; only punctuation
  // -separated structure is slightly preserved: the newline survives.
  {
    const out = redactFreeText("token: ab\npwd=xy");
    check("labeled short credentials redacted (any length)", out === "[REDACTED]\n[REDACTED]", out);
    const pin = redactFreeText("pin=1");
    check("short PIN assignment redacted", pin === "[REDACTED]", pin);
  }
}
// ── 8b. adversarial recall-phase adds (short labeled secrets of every shape) ──
{
  // Short `=` assignments of every label shape.
  for (const [name, t, c] of [
    ["password=x", "password=x", "x"],
    ["pwd=xy", "pwd=xy", "xy"],
    ["passwd=a", "passwd=a", "a"],
    ["secret=q", "secret=q", "q"],
    ["token:z", "token:z", "z"],
    ["api_key=k", "api_key=k", "k"],
    ["api-key=k", "api-key=k", "k"],
    ["PIN=1", "PIN=1", "1"],
    ["pin=1234", "pin=1234", "1234"],
    ["pincode=9", "pincode=9", "9"],
    ["authkey=y", "AUTHKEY=y", "y"],
    ["Authorization:ab", "Authorization: ab", "ab"],
    ["cookie short", "Cookie: ab", "ab"],
  ]) {
    const out = redactFreeText(t);
    check(`short labeled credential ${name} redacted`, !out.includes(c) && out.includes("[REDACTED]"), out);
  }
  // Quoted JSON short secret + structured metadata short credentials.
  const quoted = redactFreeText('{"password": "x"}');
  check("quoted json short secret redacted", !quoted.includes('"x"') && quoted.includes("[REDACTED]"), quoted);
  const pinnedJson = redactFreeText('{"pinned": true, "note": "opinion: strong"}');
  check("quoted benign pin/opinion keys untouched",
    JSON.parse(pinnedJson).pinned === true && JSON.parse(pinnedJson).note === "opinion: strong", pinnedJson);
  const headerShort = redactFreeText("curl -H 'X-Api-Key: ab' https://api.example.test");
  // Known limitation (value-run eats a trailing quote — pre-existing): the
  // secret never survives and the URL tail is preserved.
  check("short x-api-key header redacted", !headerShort.includes(": ab") && !headerShort.includes("'ab'") && headerShort.includes("[REDACTED]") && headerShort.includes("https://api.example.test"), headerShort);
  const metaShort = redactAndBoundMetadata({ env: { DB_PWD: "p", PIN: "9" }, headers: { authorization: "B xy" } }, 10_000);
  check("metadata short env pwd → [REDACTED]", JSON.parse(metaShort.text).env.DB_PWD === "[REDACTED]", metaShort.text);
  check("metadata short pin key → [REDACTED]", JSON.parse(metaShort.text).env.PIN === "[REDACTED]", metaShort.text);
  check("metadata short auth header value → [REDACTED]", JSON.parse(metaShort.text).headers.authorization === "[REDACTED]", metaShort.text);
  const uriShort = redactFreeText("psql postgres://svc_user:p@db.internal:5432/app");
  C(uriShort, ":p@", "short uri userinfo redacted");
  K("short uri userinfo", "db.internal:5432/app", uriShort);
  // Benign family words with separators that must NOT be destroyed.
  const benign = "the pin is 4 digits; spinning up; padded=3; opinion: strong; authority: none; opinta=tom";
  check("benign pin/opinion/authority words untouched", redactFreeText(benign) === benign, redactFreeText(benign));
}
// ── 9. object layer: sensitive-key values are fully dropped, benign keys stay ──
{
  const out = redactObject({ apiKey: "synth_obj_key_6666", labels: ["a", "b"], ok: 1 });
  C(JSON.stringify(out), "synth_obj_key_6666", "sensitive object key");
  check("sensitive object key becomes [REDACTED]", out.apiKey === "[REDACTED]", JSON.stringify(out));
  const out2 = redactObject({ deployment: { envMap: { SERVICE_PASSWORD: "synth_obj_pw_7777" } } });
  C(JSON.stringify(out2), "synth_obj_pw_7777", "SENSITIVE_KEY_CONTAINS env-map key");
  const out3 = redactObject({ gatewayHeaders: { "proxy-authentication": "synth_obj_pa_8888" } });
  C(JSON.stringify(out3), "synth_obj_pa_8888", "normalized dashed header key");
  const hintsOk = SENSITIVE_KEY_HINTS.every((h) => h === h.toLowerCase());
  check("hints remain normalized lowercase", hintsOk, "");
}
// ── 10. helper composition still holds (parse failures degrade, bound last) ──
{
  const out = redactAndBoundArguments('{"apiKey":"synth_args_key_0000","n":1}', 10_000);
  C(out.text, "synth_args_key_0000", "redactAndBoundArguments json");
  const out2 = redactAndBoundResult("plain bearer synth_res_bearer_1111 tail", 10_000);
  C(out2.text, "synth_res_bearer_1111", "redactAndBoundResult free text");
  check("boundText unchanged semantics", (() => { const b = boundText("0123456789abc", 10); return b.text === "0123456789" && b.truncated; })(), "");
  const parsed = redactJsonString('{"env":{"MODEL_PRIVATE_KEY":"synth_nested_pk_2222"}}');
  C(parsed, "synth_nested_pk_2222", "nested sensitive json key");
}

if (failed) {
  console.log(`minimization canaries: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log("minimization canaries: PASS");
}
