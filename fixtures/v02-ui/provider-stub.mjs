#!/usr/bin/env node
/**
 * fixtures/v02-ui/provider-stub.mjs — loopback-only provider stub for the
 * isolated mounted fixtures.
 *
 * Answers every POST with a canned Anthropic-style SSE completion and appends
 * each request to the log path given as argv[2], so a pause firewall is
 * inspectable on disk and provider traffic is never real.
 *
 * Default text is `STUB-ACK`. When the request carries the continuity
 * handoff-worker prompt, the stub answers the way that worker requires: the
 * worker accepts ONLY extractive quotes that are exact substrings of the
 * supplied source text, so the stub echoes a prefix of the first supplied
 * excerpt as valid JSON. That is what lets an isolated fixture exercise the
 * real capture -> worker -> handoff -> offer path without a model.
 *
 * It never reads the network and holds no credentials.
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const LOG = process.argv[2];
if (!LOG) { console.error("usage: provider-stub.mjs <log-path>"); process.exit(2); }

const frames = (text) => [
  { type: "message_start", message: { id: "m1", type: "message", model: "stub", usage: { input_tokens: 8, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
];
const sse = (t) => frames(t).map((e) => "data: " + JSON.stringify(e)).join("\n\n") + "\n\n";

/** Answer the continuity worker extractively, or fall back to the ack text. */
function replyText(body) {
  try {
    const wire = JSON.parse(body);
    const inner = wire?.messages?.[0]?.content?.[0]?.text;
    if (typeof inner !== "string") return "STUB-ACK";
    const payload = JSON.parse(inner);
    const first = Array.isArray(payload?.excerpts) ? payload.excerpts[0] : null;
    if (!first || typeof first.text !== "string" || !Number.isInteger(first.seq)) return "STUB-ACK";
    const quote = first.text.slice(0, Math.min(80, first.text.length));
    if (!quote.trim()) return JSON.stringify({ excerpts: [] });
    return JSON.stringify({ excerpts: [{ seq: first.seq, quote }] });
  } catch { return "STUB-ACK"; }
}

appendFileSync(LOG, JSON.stringify({ t: Date.now(), note: "stub booted; only real requests below" }) + "\n");
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), path: req.url, apiKeyPresent: Boolean(req.headers["x-api-key"]), bodyBytes: body.length }) + "\n");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(replyText(body)));
  });
});
server.listen(0, "127.0.0.1", () => console.log("STUB_READY port=" + server.address().port));
