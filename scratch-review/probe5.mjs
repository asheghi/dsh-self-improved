// ── P5: genuine rc.2 fork Session + REAL capture flush + fork cut & seq semantics ──
const repo = new URL(".", import.meta.url).pathname;
const built = (m) => import(`${repo}../lib/${m}.js`);
const dshSession = await import("@deepseek-ai/dsh-session");
const { MemoryStore, } = await built("storage");
const { installCapture } = await built("capture");
const { mkdtempSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

const msg = (text, kind, id) => ({ id, role: kind, content: [{ type: "text", text }], source: { kind } });
const seed = [
  { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
  { type: "user/message", seq: 1, time: 2, data: msg("inherited parent request", "user", "m1"), surfaceOp: "append" },
];
const header = { id: "fork-child", version: 4, createdAt: 1, cwd: "/tmp/proj-x", lineage: {}, isSeeded: true };
let session;
try {
  session = dshSession.Session.create("fork-child", seed, header, 2);
} catch (e) {
  console.log("P5 header rejected:", String(e).slice(0, 200));
  session = dshSession.Session.create("fork-child", seed, undefined, 2);
}
console.log("P5 session:", { id: session.id, inherited: session.inheritedEventCount, firstLiveSeq: session.firstLiveSeq, ownCount: session.ownEvents().length });
const parentRequestData = msg("own child request", "user", "m2");
session.append("user/message", parentRequestData, { surfaceOp: "append" });
console.log("P5 own seq range:", session.ownEvents().map((e) => e.seq));

const dir = join(mkdtempSync(join(tmpdir(), "dsi-review-")), "store");
const store = new MemoryStore(dir);
const flushes = [];
installCapture({ on: (name, fn) => flushes.push(fn) }, store, { enabled: () => true }, null, { enabled: () => true, maxChars: () => 800 });
await flushes[0](session);
const slices = store.readSlices("fork-child", -1, 1e9);
console.log("P5 captured slices:", JSON.stringify({ seqs: slices.map((s) => s.seq), texts: slices.map((s) => s.text.slice(0, 35)) }));
// second flush: idempotent (no duplicate capture of already-consumed events)
await flushes[0](session);
const slices2 = store.readSlices("fork-child", -1, 1e9);
console.log("P5 after second flush:", { seqs: slices2.map((s) => s.seq), unchanged: slices.length === slices2.length });
// disabled master gate: no new capture even after another own event
rmSync(dir, { recursive: true, force: true });
