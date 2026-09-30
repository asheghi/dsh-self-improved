/**
 * Tests for lib/redact.js: secret-key object redaction, free-text pattern
 * redaction, JSON-string redaction, and bound-after-redact helpers.
 * Run (after pnpm run build): node scripts/test-redact.mjs
 */
import {
  SENSITIVE_KEY_HINTS, redactObject, redactJsonString, redactFreeText,
  boundText, redactAndBoundArguments, redactAndBoundResult,
} from "../lib/redact.js";

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

// SENSITIVE_KEY_HINTS is exposed as a normalized lowercase name list.
check("hints are lowercase", SENSITIVE_KEY_HINTS.every((h) => h === h.toLowerCase()), JSON.stringify(SENSITIVE_KEY_HINTS.slice(0, 6)));
check("hints include token and password", SENSITIVE_KEY_HINTS.includes("token") && SENSITIVE_KEY_HINTS.includes("password"));

// Depth: object inside object inside array.
const deep = { outer: { meta: [{ password: "supersecret1", note: "keep me" }] } };
const deepOut = redactObject(deep);
check("deep nested password redacted", deepOut.outer.meta[0].password === "[REDACTED]", JSON.stringify(deepOut));
check("deep benign value kept", deepOut.outer.meta[0].note === "keep me");

// Variant key spellings normalize to sensitive names.
const variants = {
  apiKey: "k1", API_KEY: "k2", Authorization: "Bearer abc123", authToken: "t1",
  private_key: "-----BEGIN RSA PRIVATE KEY-----x", recoveryCode: "1234-5678",
  refreshToken: "r1", "session-key": "s1", setPassword: "p1", myApiKey: "k3",
};
const vOut = redactObject(variants);
const vRedacted = String(JSON.stringify(vOut)).split("k1").join("").length;
check("apiKey variant redacted", vOut.apiKey === "[REDACTED]");
check("API_KEY variant redacted", vOut.API_KEY === "[REDACTED]");
check("Authorization variant redacted", vOut.Authorization === "[REDACTED]");
check("authToken variant redacted (contains accesstoken? no — exact token)", vOut.authToken === "[REDACTED]", JSON.stringify(vOut));
check("private_key variant redacted", vOut.private_key === "[REDACTED]");
check("recoveryCode variant redacted", vOut.recoveryCode === "[REDACTED]");
check("refreshToken variant redacted", vOut.refreshToken === "[REDACTED]");
check("session-key variant redacted", vOut["session-key"] === "[REDACTED]");
check("setPassword variant redacted (contains password)", vOut.setPassword === "[REDACTED]");
check("myApiKey variant redacted (contains apikey)", vOut.myApiKey === "[REDACTED]");

// Benign keys must NOT be redacted. "authority" and "tokenize" stay; "cookies" itself is sensitive.
const benign = { author: "x", tokenize: "y", authority: "z", tokenCount: 3, tokenizer: "gpt", authenticity: "a" };
const bOut = redactObject(benign);
check("author kept", bOut.author === "x");
check("tokenize kept (token only as suffix)", bOut.tokenize === "y");
check("authority kept", bOut.authority === "z");
check("tokenCount kept", bOut.tokenCount === 3);
check("tokenizer kept", bOut.tokenizer === "gpt");
check("authenticity kept (auth only as prefix)", bOut.authenticity === "a");

// Cyclic input must not throw.
const cyc = { a: {} }; cyc.a.self = cyc; cyc.password = "dontleak";
let cycOut;
try { cycOut = redactObject(cyc); } catch (e) { cycOut = { threw: String(e) }; }
check("cyclic input survives", cycOut.a.self === "[CYCLIC]", JSON.stringify(cycOut));
check("cyclic password redacted", cycOut.password === "[REDACTED]");
check("deep clone: source not mutated", cyc.password === "dontleak");

// Primitives are returned as-is.
check("primitive passthrough", redactObject(42) === 42 && redactObject("hi") === "hi" && redactObject(null) === null);
check("array elements recursed", redactObject([{ api_key: "k" }, "ok"])[0].api_key === "[REDACTED]" && redactObject([{ api_key: "k" }, "ok"])[1] === "ok");

// redactJsonString: parse succeeds on object with embedded secret.
const js = redactJsonString('{"url":"https://u:passw0rd@host/x","args":[{"api_key":"abcdefghij123456"}]}');
check("json object redacted", !js.includes("abcdefghij123456") && js.includes("[REDACTED]"), js);
check("json object stays json", JSON.parse(js).args[0].api_key === "[REDACTED]");

// Parse fails → free-text patterns.
const malformed = redactJsonString("auth: {broken,; token=Sup3rSecretValue let me back");
check("malformed json bearer/token redacted", !malformed.includes("Sup3rSecretValue") && malformed.includes("[REDACTED]"), malformed);

// Parse succeeds but result is a primitive string → free-text on that string.
const prim = redactJsonString('"Authorization: Som3LonQHeader67890"');
check("json primitive string free-text redacted", !prim.includes("Som3LonQHeader67890"), prim);

// Free-text: Bearer header.
check("bearer redacted", redactFreeText("Bearer abcdefgh12345XYZ next") === "[REDACTED] next", redactFreeText("Bearer abcdefgh12345XYZ next"));
check("bearer case-insensitive", redactFreeText("BEARER abcdefgh123456") === "[REDACTED]");
// Short values (under 6 chars) are untouched, per spec.
check("short bearer value untouched", redactFreeText("Bearer abc, y") === "Bearer abc, y", redactFreeText("Bearer abc, y"));
check("password= redacted", redactFreeText("login password=hunter22222 done") === "login [REDACTED] done", redactFreeText("login password=hunter22222 done"));
check("pwd= and passwd= redacted", redactFreeText("passwd=verylong1 pwd=verylong2") === "[REDACTED] [REDACTED]", redactFreeText("passwd=verylong1 pwd=verylong2"));
check("api key variants redacted", redactFreeText("api_key=aaaaaaaaaaaa1, api-key=bbbbbbbbbbbb2") === "[REDACTED], [REDACTED]", redactFreeText("api_key=aaaaaaaaaaaa1, api-key=bbbbbbbbbbbb2"));
check("secret= redacted", redactFreeText("secret=zzzzzzzzzzzz1") === "[REDACTED]");
check("authorization: header redacted", redactFreeText("Authorization: SuperToken12345") === "[REDACTED]", redactFreeText("Authorization: SuperToken12345"));
// Basic-auth short run MUST be redacted (labeled forms have a 4-char floor, no 6-char exemption).
check("authorization: basic redacted", redactFreeText("Authorization: Basic dXNlcnBhc3MwMDA=") === "[REDACTED]", redactFreeText("Authorization: Basic dXNlcnBhc3MwMDA="));
check("bare Basic run redacted", redactFreeText("curl -H 'Basic dXNlcnBhc3N3b3JkMDAx1'") === "curl -H '[REDACTED]'", redactFreeText("curl -H 'Basic dXNlcnBhc3N3b3JkMDAx1'"));
check("cookie: header redacted", redactFreeText("Cookie: sessionabcdef9; other=1") === "[REDACTED] other=1", redactFreeText("Cookie: sessionabcdef9; other=1"));

// Typed tokens. Ordinary text must survive — no catch-all hex rules.
check("jwt redacted", redactFreeText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") === "[REDACTED]");
check("github token redacted", redactFreeText("ghp_AbCdEfGhIjKlMnOpQrStUvWx red") === "[REDACTED] red", redactFreeText("ghp_AbCdEfGhIjKlMnOpQrStUvWx red"));
check("github pat redacted", redactFreeText("github_pat_AbCdEfGhIjKlMnOpQrStUv") === "[REDACTED]");
check("aws key redacted", redactFreeText("AKIAIOSFODNN7EXAMPLE ok") === "[REDACTED] ok");
check("openai key redacted", redactFreeText("sk-abc123def456ghi789jkl_ send") === "[REDACTED] send");
check("slack token redacted", redactFreeText("xoxb-123456789012-abc ok") === "[REDACTED] ok", redactFreeText("xoxb-123456789012-abc ok"));
check("pem block collapsed", redactFreeText("-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\nafter") === "[REDACTED-PRIVATE-KEY]\nafter", redactFreeText("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"));
check("openssh pem block collapsed", redactFreeText("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----") === "[REDACTED-PRIVATE-KEY]");
check("url userinfo redacted", redactFreeText("https://user:supersecretpw@example.com/x") === "https://[REDACTED]@example.com/x", redactFreeText("https://user:supersecretpw@example.com/x"));
// Ordinary hex/free text is NOT mangled.
const ordinary = "sha512 deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef0123 not a secret";
check("ordinary hex text untouched", redactFreeText(ordinary) === ordinary, redactFreeText(ordinary));

// Regression: two GitHub tokens in one string — BOTH must be redacted (g flag).
check("two github tokens both redacted", redactFreeText("a ghp_AbCdEfGhIjKlMnOpQrStUvWx mid ghp_ZyXwVuTsRqPoNmLkJiHgFeD tail") === "a [REDACTED] mid [REDACTED] tail",
  redactFreeText("a ghp_AbCdEfGhIjKlMnOpQrStUvWx mid ghp_ZyXwVuTsRqPoNmLkJiHgFeD tail"));
check("two bearer labels both redacted", redactFreeText("Bearer abcdefgh1234XYZ then Bearer zzzzzzzz9876QRS") === "[REDACTED] then [REDACTED]", redactFreeText("Bearer abcdefgh1234XYZ then Bearer zzzzzzzz9876QRS"));

// Non-sensitive string values are scanned too: credentials hidden inside an ordinary
// key (e.g. "command") must never persist.
const cmdOut = redactObject({ command: "curl -H 'Authorization: Bearer abcdef123456' https://u:pw12345@host" });
check("ordinary-key value redacted", cmdOut.command.includes("[REDACTED]") && !cmdOut.command.includes("abcdef123456") && !cmdOut.command.includes("pw12345"), cmdOut.command);
check("numbers/booleans/null unchanged", redactObject({ n: 42, b: true, z: null }).n === 42 && redactObject({ n: 42, b: true, z: null }).b === true && redactObject({ n: 42, b: true, z: null }).z === null);

// JSON-shaped results redacted by redactAndBoundResult (not only free-text strings).
const jsonRes = redactAndBoundResult(JSON.stringify({ password: "hunter2" }), 400);
check("json result password redacted", !jsonRes.text.includes("hunter2") && jsonRes.text.includes("[REDACTED]"), jsonRes.text);
const plainRes = redactAndBoundResult("plain bearer abcdefgh123456XYZ text", 400);
check("plain result bearer redacted", !plainRes.text.includes("abcdefgh123456XYZ"), plainRes.text);

// boundText.
check("boundText under limit", boundText("short", 10).truncated === false);
const bt = boundText("0123456789abc", 10);
check("boundText truncates exactly", bt.text === "0123456789" && bt.truncated === true, JSON.stringify(bt));
check("boundText exact-length no truncate", boundText("0123456789", 10).truncated === false);

// Redact-then-bound: secret fully inside the first maxChars is gone.
const secretText = "Bearer abcdefgh123456 tail goes here to overflow the limit";
const sab1 = redactAndBoundResult(secretText, 20);
check("arguments/result redact before bounding", sab1.text.length === 20 && !sab1.text.includes("abcdefgh") && sab1.truncated, JSON.stringify(sab1));
// Fine print: a secret straddling the cut boundary is not a leak — it was already
// redacted before slicing; only secrets the patterns MISSED could leave a partial
// fragment at the edge, which is why bounding still runs after redaction.
check("redactAndBoundArguments json secret redacted", !redactAndBoundArguments('{"apiKey":"sk-aaaaaaaaaaaaaaaaaaaa1", "n": 5000000000}', 40).text.includes("aaaaaaaaaaaa"), redactAndBoundArguments('{"apiKey":"sk-aaaaaaaaaaaaaaaaaaaa1", "n": 5000000000}', 40).text);

if (failed) process.exit(1);
console.log("redact tests done");
