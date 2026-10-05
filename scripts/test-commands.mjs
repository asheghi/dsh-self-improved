/**
 * M5 command handler unit tests: /memory search/list/forget/correct/status/help.
 * Run: node scripts/test-commands.mjs
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { handleMemoryCommand, listSkills, SnapshotTokenTracker } from "../lib/commands.js";

const dir = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "m5-unit");
rmSync(dir, { recursive: true, force: true });
const store = new MemoryStore(dir);

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

// Seed
const m1 = store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 }, { provenance: "user" });
store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 }, { provenance: "user" });

// help
const help = handleMemoryCommand(store, "");
check("help lists subcommands", help.kind === "success" && help.text.includes("/memory search"));

// search
const s1 = handleMemoryCommand(store, "search PowerShell");
check("search hit", s1.kind === "success" && s1.text.includes("PowerShell"), s1.text.slice(0, 40));
const s2 = handleMemoryCommand(store, "search nonexistentxyz");
check("search no hit", s2.text.includes("No relevant memories found"));
const s3 = handleMemoryCommand(store, "search");
check("search errors when missing argument", s3.kind === "error");

// list
const l1 = handleMemoryCommand(store, "list");
check("list outputs memories", l1.text.includes("preference") && l1.text.includes("fact"));

// forget
const f1 = handleMemoryCommand(store, `forget ${m1.id}`);
check("forget works", f1.text.includes("Forgotten"));
check("not found after forget", handleMemoryCommand(store, "search PowerShell").text.includes("No relevant memories found"));

// correct
const c1 = handleMemoryCommand(store, `correct ${m1.id} User prefers PowerShell or pwsh`);
check("correct creates a new memory", c1.kind === "success" && c1.text.includes("new id"));
const corrected = handleMemoryCommand(store, "search pwsh");
check("new content is searchable after correct", corrected.text.includes("pwsh"), corrected.text.slice(0, 40));

// Direct command correction inherits the old row's scope/project/session
const scopedOld = store.insertMemory(
  { kind: "fact", content: "Project workboard builds with Bun offline", importance: 8 },
  { provenance: "user", source: "user-direct", scope: "project", projectId: "workboard", sessionId: "sess-42", confidence: 0.8 },
);
const c2 = handleMemoryCommand(store, `correct ${scopedOld.id} Project workboard builds with Bun in offline mode`);
check("direct correction succeeds", c2.kind === "success", c2.text);
const scopedNew = store.listMemories({ limit: 50 }).find((m) => m.content.includes("offline mode") || m.supersedes === scopedOld.id);
const scopedNewMeta = scopedNew ? store.getMeta(scopedNew.id) : undefined;
check("corrected replacement inherits scope/project/session",
  scopedNewMeta?.scope === "project" && scopedNewMeta?.projectId === "workboard" && scopedNewMeta?.sessionId === "sess-42",
  JSON.stringify(scopedNewMeta),
);
check("old row retired with corrected status", store.getMemory(scopedOld.id)?.status === "corrected");
check("corrected old row excluded from FTS", store.searchMemories("Bun offline", { limit: 5 }).every((h) => h.id !== scopedOld.id));

// status
const st = handleMemoryCommand(store, "status");
check("status outputs statistics", st.text.includes("Memories") && st.text.includes("persona v"));

// listSkills: the synthesized flag follows the CONFIGURED prefix, not hardcoded dsi-
const skillsRootFake = join(dir, "skills-fake");
mkdirSync(join(skillsRootFake, "dsi-foo"), { recursive: true });
mkdirSync(join(skillsRootFake, "mem-bar"), { recursive: true });
writeFileSync(join(skillsRootFake, "dsi-foo", "SKILL.md"), "---\nname: dsi-foo\ndescription: dsi skill body\n---\nbody");
writeFileSync(join(skillsRootFake, "mem-bar", "SKILL.md"), "---\nname: mem-bar\ndescription: mem skill body\n---\nbody");
const withDsi = listSkills(100, "dsi-", skillsRootFake);
const dsiFlag = withDsi.find((s) => s.name.startsWith("dsi-"));
const memFlag = withDsi.find((s) => s.name.startsWith("mem-"));
check("listSkills marks configured-prefixed skills synthesized", dsiFlag?.synthesized === true, JSON.stringify(withDsi.map((s) => s.name)));
const withMem = listSkills(100, "mem-", skillsRootFake);
const memFlag2 = withMem.find((s) => s.name.startsWith("mem-"));
const dsiFlag2 = withMem.find((s) => s.name.startsWith("dsi-"));
check("custom prefix marks its own skills and not foreign ones",
  memFlag2?.synthesized === true && dsiFlag2?.synthesized === false,
  JSON.stringify(withMem));

// unknown subcommand → help
const u = handleMemoryCommand(store, "bogus");
check("unknown subcommand shows help", u.text.includes("/memory search"));

// ── SnapshotTokenTracker: stable-content signing + sliding TTL under a fake clock ──
let fakeNow = 1_000_000;
const tracker = new SnapshotTokenTracker("test-secret", 15 * 60_000, 4, () => fakeNow);
const snapA = { memories: [{ id: "m1", content: "alpha" }], updatedAt: fakeNow };
const first = tracker.sign({ ...snapA });
const second = tracker.sign({ ...snapA, updatedAt: fakeNow + 60_000 }); // only the clock moved
check("unchanged refresh reuses the token (updatedAt stripped before signing)", second.token === first.token && second.changed === false, JSON.stringify(second));
// Simulate the 60s refresh timer re-serving the same business content repeatedly:
// every tick re-notes the reused token, so it stays valid well past the TTL.
let strayTicks = 0;
for (let tick = 0; tick < 30; tick++) {
  fakeNow += 60_000;
  const again = tracker.sign({ ...snapA, updatedAt: fakeNow });
  if (again.token !== first.token || again.changed !== false) strayTicks++;
  tracker.note(first.token);
}
check("every unchanged refresh tick reused the token (sliding window intact)", strayTicks === 0, `strayTicks=${strayTicks}`);
fakeNow += 10 * 60_000; // before: 30 ticks of re-noting stretched far beyond 15 minutes
check("re-noted token stays valid beyond the TTL (sliding window)", tracker.verify(first.token));
fakeNow += 6 * 60_000; // now above 15 minutes since the last re-note
check("token expires once the sliding window lapses", !tracker.verify(first.token));

// Real content changes mint fresh tokens under the cap; an un-refreshed token expires by TTL.
const steady = new SnapshotTokenTracker("test-secret", 15 * 60_000, 4, () => fakeNow);
const tokens = [];
for (const label of ["one", "two", "three", "four"]) {
  fakeNow += 60_000;
  const t = steady.sign({ memories: [label], updatedAt: fakeNow }).token;
  tokens.push(t);
  steady.note(t);
}
check("real changes mint 4 distinct tokens", new Set(tokens).size === 4, JSON.stringify(tokens));
fakeNow += 16 * 60_000; // >15 minutes with NO re-note
check("un-refreshed tokens expire by the TTL", tokens.every((t) => !steady.verify(t)));

// Forged token (never signed/re-noted) rejected.
fakeNow += 60_000;
const signed = tracker.sign({ a: 1, updatedAt: 0 });
tracker.note(signed.token);
check("forged token rejected, valid token accepted", !tracker.verify("deadbeef") && tracker.verify(signed.token));

// ── Browser action channel integration tests (real host handler + fake settings scope) ──
{
  const { installBrowserChannel, MUTATING_BROWSER_OPS } = await import("../lib/commands.js");
  check("mutating op set is the challenge-gated set", [...MUTATING_BROWSER_OPS].sort().join(",") === "confirm-correct,correct,deleteSkill,dryReview,forget,purgeEpisodes");

  // Fake settings namespace (settings.register/get/replace/watch semantics)
  const watchState = { snapshot: "{}", action: "", detail: "", watchers: [] };
  const picture = () => ({ snapshot: watchState.snapshot, action: watchState.action, detail: watchState.detail });
  watchState.get = () => ({ ...picture() });
  watchState.replace = (next) => {
    Object.assign(watchState, next);
    for (const w of [...watchState.watchers]) w({ ...picture() });
    return Promise.resolve();
  };
  watchState.watch = (fn) => { watchState.watchers.push(fn); return () => {}; };
  const fakeCtx = {
    settings: { register() { return watchState; } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on() {} // noop dispose listener
  };

  const skillRoot = join(dir, "chan-skills");
  mkdirSync(join(skillRoot, "dsi-chan-skill"), { recursive: true });
  writeFileSync(join(skillRoot, "dsi-chan-skill", "SKILL.md"), "---\nname: dsi-chan-skill\ndescription: channel test\n---\nbody");

  let prefix = "dsi-";
  const activeList = () => store.listMemories({ limit: 50 }).filter((m) => m.status === "active");
  const victim = activeList().find((m) => m.content.includes("PowerShell")) ?? store.insertMemory({ kind: "fact", content: "Channel victim alpha", importance: 5 }, { provenance: "user" });
  let skillsPrefixCalls = 0;

  const channel = installBrowserChannel({
    ctx: fakeCtx,
    store,
    skillsPrefix: () => { skillsPrefixCalls++; return prefix; },
    skillsRoot: () => skillRoot,
    refreshIntervalMs: 0,
  });
  channel.refresh();

  const snap1 = JSON.parse(watchState.snapshot);
  check("channel serves snapshot with an actionToken", typeof snap1.actionToken === "string" && snap1.actionToken.length > 0);
  check("channel serves the configured-prefix skill list", (snap1.skills || []).some((s) => s.name === "dsi-chan-skill"));

  // 1) prepare: mutating submit carrying the served token is STAGED, not executed
  watchState.action = JSON.stringify({ op: "forget", id: victim.id, token: snap1.actionToken });
  watchState.replace({ action: watchState.action });
  check("prepare stages without executing (memory still active)", store.getMemory(victim.id)?.status === "active");
  const snap2 = JSON.parse(watchState.snapshot);
  check("staged challenge published through the snapshot", snap2.confirm && snap2.confirm.token && snap2.confirm.args?.op === "forget" && snap2.confirm.args?.id === victim.id, JSON.stringify(snap2.confirm));

  // 2) confirm with MISMATCHED arguments must be rejected (challenge is args-bound)
  const other = activeList().find((m) => m.id !== victim.id);
  watchState.action = JSON.stringify({ op: "forget", id: other.id, confirmToken: snap2.confirm.token });
  watchState.replace({ action: watchState.action });
  check("args-mismatched confirm rejected (other memory survives)", store.getMemory(other.id)?.status === "active", JSON.stringify(store.getMemory(other.id)?.status));

  // 3) correct args consume the challenge exactly once (re-stage after the mismatch cleared the pending slot)
  watchState.action = JSON.stringify({ op: "forget", id: victim.id, token: JSON.parse(watchState.snapshot).actionToken });
  watchState.replace({ action: watchState.action });
  check("re-prepare stages again", store.getMemory(victim.id)?.status === "active");
  channel.refresh();
  const snap3 = JSON.parse(watchState.snapshot);
  const pendingToken3 = snap3.confirm?.token;
  check("re-prepare published a fresh bound challenge", !!pendingToken3 && snap3.confirm.args?.id === victim.id);
  watchState.action = JSON.stringify({ op: "forget", id: victim.id, confirmToken: pendingToken3 });
  watchState.replace({ action: watchState.action });
  check("challenge-bound confirm executes (memory forgotten)", store.getMemory(victim.id)?.status !== "active");

  // 4) replaying the SAME confirm payload must fail (challenge consumed atomically)
  const fresh = store.insertMemory({ kind: "fact", content: "Replay probe rho", importance: 5 }, { provenance: "user" });
  watchState.action = JSON.stringify({ op: "forget", id: fresh.id, token: JSON.parse(watchState.snapshot).actionToken });
  watchState.replace({ action: watchState.action });
  channel.refresh();
  const replayChallenge = JSON.parse(watchState.snapshot).confirm.token;
  watchState.action = JSON.stringify({ op: "forget", id: fresh.id, confirmToken: replayChallenge });
  watchState.replace({ action: watchState.action });
  check("first confirm consumed the challenge (memory forgotten)", store.getMemory(fresh.id)?.status !== "active");
  const replayTarget = store.insertMemory({ kind: "fact", content: "Replay probe sigma survives", importance: 5 }, { provenance: "user" });
  watchState.action = JSON.stringify({ op: "forget", id: replayTarget.id, confirmToken: replayChallenge });
  watchState.replace({ action: watchState.action });
  check("replayed challenge rejected (target survives)", store.getMemory(replayTarget.id)?.status === "active");

  // 4b) Fresh-nonce regression: re-preparing the SAME action must mint a NEW
  // token, and the previously consumed token must not authorize the new attempt.
  const reprobe = store.insertMemory({ kind: "fact", content: "Nonce regression tau", importance: 5 }, { provenance: "user" });
  watchState.action = JSON.stringify({ op: "forget", id: reprobe.id, token: JSON.parse(watchState.snapshot).actionToken });
  watchState.replace({ action: watchState.action });
  channel.refresh();
  const firstChallenge = JSON.parse(watchState.snapshot).confirm.token;
  watchState.action = JSON.stringify({ op: "forget", id: reprobe.id, confirmToken: firstChallenge });
  watchState.replace({ action: watchState.action });
  check("identical-action confirm executes once", store.getMemory(reprobe.id)?.status !== "active");
  const reprobe2 = store.insertMemory({ kind: "fact", content: "Nonce regression upsilon", importance: 5 }, { provenance: "user" });
  watchState.action = JSON.stringify({ op: "forget", id: reprobe2.id, token: JSON.parse(watchState.snapshot).actionToken });
  watchState.replace({ action: watchState.action });
  channel.refresh();
  const secondChallenge = JSON.parse(watchState.snapshot).confirm.token;
  check("re-prepared identical action minted a fresh token", secondChallenge !== firstChallenge);
  watchState.action = JSON.stringify({ op: "forget", id: reprobe2.id, confirmToken: firstChallenge });
  watchState.replace({ action: watchState.action });
  check("old consumed token cannot authorize the newly prepared action", store.getMemory(reprobe2.id)?.status === "active");
  // any bad confirm clears the pending slot; re-prepare once more and confirm with the fresh token
  watchState.action = JSON.stringify({ op: "forget", id: reprobe2.id, token: JSON.parse(watchState.snapshot).actionToken });
  watchState.replace({ action: watchState.action });
  channel.refresh();
  const thirdChallenge = JSON.parse(watchState.snapshot).confirm.token;
  watchState.action = JSON.stringify({ op: "forget", id: reprobe2.id, confirmToken: thirdChallenge });
  watchState.replace({ action: watchState.action });
  check("fresh token still authorizes the new preparation", store.getMemory(reprobe2.id)?.status !== "active");

  // 4c) Ledger unit regression (deterministic, no channel round-trips)
  {
    const { ActionChallengeLedger } = await import("../lib/commands.js");
    let clock = 2_000_000;
    const ledger = new ActionChallengeLedger("ledger-secret", 120_000, () => clock);
    const identical = { op: "forget", id: "mem-x" };
    const first = ledger.prepare(identical);
    check("ledger consume succeeds with the bound token", ledger.consume({ ...identical }, first.token) === true);
    const second = ledger.prepare({ ...identical });
    check("ledger re-prepare mints a distinct token for identical args", second.token !== first.token, JSON.stringify({ first: first.token.slice(0, 8), second: second.token.slice(0, 8) }));
    check("ledger fresh token authorizes the new preparation", ledger.consume({ ...identical }, second.token) === true);
    const third = ledger.prepare({ ...identical });
    check("ledger old consumed token cannot authorize the new preparation", ledger.consume({ ...identical }, first.token) === false);
    const fourth = ledger.prepare({ ...identical });
    check("ledger other consumed token also rejected", ledger.consume({ ...identical }, second.token) === false);
    const fifth = ledger.prepare({ ...identical });
    check("ledger newest token is the one that authorizes", ledger.consume({ ...identical }, fifth.token) === true);
  }

  // 5) noop rides without any credential, and the unchanged snapshot refresh keeps the token stable
  const stripTk = (j) => { const o = JSON.parse(j); delete o.actionToken; delete o.confirm; return JSON.stringify(objKeys(o)); };

  function objKeys(o) { const out = {}; for (const k of Object.keys(o).sort()) out[k] = o[k]; return out; }
  function firstDiff(a, b) {
    const oa = JSON.parse(a), ob = JSON.parse(b);
    for (const k of Object.keys(oa)) if (JSON.stringify(oa[k]) !== JSON.stringify(ob[k])) {
      if (Array.isArray(oa[k])) {
        for (let i = 0; i < Math.max(oa[k].length, (ob[k] || []).length); i++) {
          if (JSON.stringify(oa[k][i]) !== JSON.stringify((ob[k] || [])[i])) return { field: k, idx: i, a: oa[k][i], b: (ob[k] || [])[i] };
        }
        return { field: k, idx: -1 };
      }
      return { field: k, a: oa[k], b: ob[k] };
    }
    return { field: "?" };
  }
  const observableTail = (s) => { const o = JSON.parse(s); const mem = (o.memories || []).map((m) => m.id + m.status + m.updatedAt); return { mem: mem.slice(0, 5), pending: o.pending, skillN: (o.skills || []).length }; };
  const stableBefore = stripTk(watchState.snapshot);
  const tokBefore = JSON.parse(watchState.snapshot).actionToken;
  watchState.action = JSON.stringify({ op: "noop" });
  watchState.replace({ action: watchState.action });
  channel.refresh();
  const stableAfter = stripTk(watchState.snapshot);
  const tokAfter = JSON.parse(watchState.snapshot).actionToken;
  if (tokBefore !== tokAfter) console.log("DEBUG instarun:", JSON.stringify(JSON.parse(stableBefore).memories.slice(0,4)), "||", JSON.stringify(JSON.parse(stableAfter).memories.slice(0,4)));
  check("unchanged snapshot refresh keeps the served token (sliding TTL authorization intact)", tokBefore === tokAfter && !!tokAfter, `${tokBefore.slice(0, 6)} vs ${tokAfter.slice(0, 6)}`);

  // 6) detail works without any token
  watchState.action = JSON.stringify({ op: "detail", id: replayTarget.id });
  watchState.replace({ action: watchState.action });
  const detail = watchState.detail ? JSON.parse(watchState.detail) : null;
  check("detail op returns the full memory without a token", detail?.id === replayTarget.id, JSON.stringify(Boolean(detail)));

  // ── 6b) Phase 6: episodes snapshot gating + episodeDetail/purgeEpisodes/dryReview ops ──
  // Each channel gets its OWN fake scope: scope.watch registrations are never
  // disposed by stop(), so sharing one watchState would double-handle actions
  // through stale channels' trackers/ledgers.
  const mkFakeScope = () => {
    const state = { snapshot: "{}", action: "", detail: "", episodeDetail: "", episodeStatus: "", watchers: [] };
    const picture = () => ({ snapshot: state.snapshot, action: state.action, detail: state.detail, episodeDetail: state.episodeDetail, episodeStatus: state.episodeStatus });
    state.get = () => ({ ...picture() });
    state.replace = (next) => {
      Object.assign(state, next);
      for (const w of [...state.watchers]) w({ ...picture() });
      return Promise.resolve();
    };
    state.watch = (fn) => { state.watchers.push(fn); return () => {}; };
    return state;
  };
  const mkFakeCtx = (scope) => ({ settings: { register() { return scope; } }, on() {} });
  {
    const { assembleSessionEpisodes } = await import("../lib/episodes.js");
    // Two succeeded episodes in a project + one failed, via the direct event/assembly API.
    const mkRows = (callId, turn, seq, okResult) => [
      { kind: "call", callId, turn, step: 0, seq, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: '{"cmd":"build"}', argsTruncated: 0, callId }) },
      { kind: "result", callId, turn, step: 0, seq: seq + 1, at: 1001, payload: JSON.stringify({ toolCallId: callId, resultExcerpt: okResult ? "build ok" : "exit 1", resultTruncated: 0, isError: okResult ? 0 : 1, errorName: okResult ? null : "Error", errorCode: null, toolHint: null }) },
      { kind: "turn-end", callId: "", turn, step: null, seq: seq + 2, at: 1002, payload: JSON.stringify({ reason: { kind: "completed" } }) },
    ];
    store.appendEpisodeEvents("chan-ep", "/tmp/proj-chan", false, mkRows("c-ep1", 1, 10, true));
    store.appendEpisodeEvents("chan-ep", "/tmp/proj-chan", false, mkRows("c-ep2", 2, 20, false));
    assembleSessionEpisodes(store, "chan-ep");

    // Snapshot: disabled → counts present, recent withheld
    const scopeOff = mkFakeScope();
    const noEpChannel = installBrowserChannel({
      ctx: mkFakeCtx(scopeOff), store, skillsPrefix: () => "dsi-", skillsRoot: () => skillRoot,
      episodeEnabled: () => false, refreshIntervalMs: 0,
    });
    noEpChannel.refresh();
    const snapOff = JSON.parse(scopeOff.snapshot);
    check("episodes disabled: counts served, recent rows withheld",
      snapOff.episodes && typeof snapOff.episodes.counts === "object" && snapOff.episodes.recent === null,
      JSON.stringify({ counts: snapOff.episodes?.counts, recent: Array.isArray(snapOff.episodes?.recent) }));
    check("episodes disabled: counts reflect the seeded rows",
      snapOff.episodes.counts.succeeded === 1 && snapOff.episodes.counts.failed === 1, JSON.stringify(snapOff.episodes.counts));
    noEpChannel.stop();

    // Snapshot: enabled → redacted recent rows served
    const scopeOn = mkFakeScope();
    let dryRuns = 0;
    const epChannel = installBrowserChannel({
      ctx: mkFakeCtx(scopeOn), store, skillsPrefix: () => "dsi-", skillsRoot: () => skillRoot,
      episodeEnabled: () => true, refreshIntervalMs: 0,
      episodeDryReview: () => {
        dryRuns += 1;
        return Promise.resolve({ considered: 2, reviewed: 1, rejected: 0, memories: 1, dropped: 0, errors: 0, dryRun: true });
      },
    });
    epChannel.refresh();
    const snapOn = JSON.parse(scopeOn.snapshot);
    check("episodes enabled: recent redacted rows served", Array.isArray(snapOn.episodes.recent) && snapOn.episodes.recent.length === 2, JSON.stringify(snapOn.episodes?.recent?.length));
    const listedEpisode = snapOn.episodes.recent.find((e) => e.status === "succeeded");
    check("episode rows carry no raw args/results fields",
      listedEpisode && !("steps" in listedEpisode) && listedEpisode.summary === null && listedEpisode.turn === 1, JSON.stringify(snapOn.episodes.recent[0]));

    // episodeDetail op (read-only, no token) — served through the episodeDetail field
    scopeOn.action = JSON.stringify({ op: "episodeDetail", id: listedEpisode.id });
    scopeOn.replace({ action: scopeOn.action });
    const epDetail = scopeOn.episodeDetail ? JSON.parse(scopeOn.episodeDetail) : null;
    check("episodeDetail op returns the redacted episode + steps", epDetail?.id === listedEpisode.id && Array.isArray(epDetail.steps) && epDetail.steps.length === 1, JSON.stringify(epDetail && { steps: epDetail.steps.length }));
    check("episodeDetail steps are redacted + bounded",
      epDetail.steps[0].argumentsRedacted === '{"cmd":"build"}' && epDetail.steps[0].resultExcerpt === "build ok" && epDetail.steps[0].isError === 0, JSON.stringify(epDetail.steps[0]));

    // purgeEpisodes: challenge handshake both steps
    check("episodes still stored before purge", store.episodeCounts().succeeded === 1, JSON.stringify(store.episodeCounts()));
    scopeOn.action = JSON.stringify({ op: "purgeEpisodes", id: "all", token: JSON.parse(scopeOn.snapshot).actionToken });
    scopeOn.replace({ action: scopeOn.action });
    check("purgeEpisodes prepare stages without executing", store.episodeCounts().succeeded === 1, JSON.stringify(store.episodeCounts()));
    epChannel.refresh();
    const purgeChip = JSON.parse(scopeOn.snapshot).confirm;
    check("purgeEpisodes challenge published", purgeChip?.token && purgeChip.args?.op === "purgeEpisodes" && purgeChip.args?.id === "all", JSON.stringify(purgeChip));
    scopeOn.action = JSON.stringify({ op: "purgeEpisodes", id: "all", confirmToken: purgeChip.token });
    scopeOn.replace({ action: scopeOn.action });
    const countsAfterPurge = store.episodeCounts();
    check("purgeEpisodes confirm executes (episodes, steps and events purged)",
      countsAfterPurge.succeeded === 0 && countsAfterPurge.failed === 0, JSON.stringify(countsAfterPurge));

    // dryReview: challenge-gated; delegate invoked on confirm; summary published via episodeStatus
    scopeOn.action = JSON.stringify({ op: "dryReview", token: JSON.parse(scopeOn.snapshot).actionToken });
    scopeOn.replace({ action: scopeOn.action });
    epChannel.refresh();
    const dryChip = JSON.parse(scopeOn.snapshot).confirm;
    check("dryReview challenge published", dryChip?.token && dryChip.args?.op === "dryReview", JSON.stringify(dryChip));
    scopeOn.action = JSON.stringify({ op: "dryReview", confirmToken: dryChip.token });
    scopeOn.replace({ action: scopeOn.action });
    await new Promise((r) => setTimeout(r, 20));
    check("dryReview delegate ran and published its summary",
      dryRuns === 1 && scopeOn.episodeStatus.includes('"dryRun":true') && scopeOn.episodeStatus.includes('"considered":2'), scopeOn.episodeStatus.slice(0, 80));

    // dryReview unavailable (no delegate) → ignored, nothing published
    const scopeDryless = mkFakeScope();
    const dryLessChannel = installBrowserChannel({
      ctx: mkFakeCtx(scopeDryless), store, skillsPrefix: () => "dsi-", skillsRoot: () => skillRoot,
      episodeEnabled: () => true, refreshIntervalMs: 0,
    });
    dryLessChannel.refresh();
    scopeDryless.action = JSON.stringify({ op: "dryReview", token: JSON.parse(scopeDryless.snapshot).actionToken });
    scopeDryless.replace({ action: scopeDryless.action });
    dryLessChannel.refresh();
    const dryChip2 = JSON.parse(scopeDryless.snapshot).confirm;
    scopeDryless.action = JSON.stringify({ op: "dryReview", confirmToken: dryChip2.token });
    scopeDryless.replace({ action: scopeDryless.action });
    await new Promise((r) => setTimeout(r, 20));
    check("dryReview without a delegate is ignored (no status published)", !scopeDryless.episodeStatus.includes('"considered"'), scopeDryless.episodeStatus.slice(0, 60));
    dryLessChannel.stop();
    epChannel.stop();
  }

  // 7) hot-apply: live prefix getter + /memory browser (command-side regression)
  prefix = "mem-";
  channel.refresh();
  const snapPref = JSON.parse(watchState.snapshot);
  check("hot-applied prefix flows into the browser snapshot", (snapPref.skills || []).some((s) => s.name === "dsi-chan-skill" && s.synthesized === false), JSON.stringify(snapPref.skills));
  const out = handleMemoryCommand(store, "browser --json", { skillsPrefix: () => prefix, skillsRoot: () => skillRoot });
  const snapCmd = JSON.parse(out.text);
  check("/memory browser --json follows a hot-applied prefix without re-registration", snapCmd.skills.some((s) => s.name === "dsi-chan-skill" && s.synthesized === false), out.text.slice(0, 80));
  prefix = "dsi-";
  const out2 = handleMemoryCommand(store, "browser --json", { skillsPrefix: () => prefix, skillsRoot: () => skillRoot });
  check("reset prefix restores the synthesized flag (getter is evaluated per call, not captured)", JSON.parse(out2.text).skills.some((s) => s.name === "dsi-chan-skill" && s.synthesized === true), out2.text.slice(0, 80));
  check("prefix getter is evaluated per call (live getter, not captured)", skillsPrefixCalls > 3, "calls=" + skillsPrefixCalls);

  channel.stop();
}

// ── Phase 6: /memory episodes | episode <id> | episode-purge | episode-review ──
{
  const { assembleSessionEpisodes } = await import("../lib/episodes.js");
  const mkRows = (callId, turn, seq, okResult) => [
    { kind: "call", callId, turn, step: 0, seq, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: '{"cmd":"build"}', argsTruncated: 0, callId }) },
    { kind: "result", callId, turn, step: 0, seq: seq + 1, at: 1001, payload: JSON.stringify({ toolCallId: callId, resultExcerpt: okResult ? "build ok" : "exit 1", resultTruncated: 0, isError: okResult ? 0 : 1, errorName: okResult ? null : "Error", errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: "", turn, step: null, seq: seq + 2, at: 1002, payload: JSON.stringify({ reason: { kind: "completed" } }) },
  ];
  store.appendEpisodeEvents("cmd-ep", "/tmp/proj-cmd", false, mkRows("c-cmd1", 1, 10, true));
  assembleSessionEpisodes(store, "cmd-ep");

  const off = handleMemoryCommand(store, "episodes", {});
  check("/memory episodes without enabled lists counts only", off.kind === "success" && off.text.includes("succeeded 1") === false && off.text.includes("Episode listing requires episodeLearning.enabled"), off.text.slice(0, 120));
  const on = handleMemoryCommand(store, "episodes succeeded", { episodeEnabled: () => true });
  check("/memory episodes lists redacted rows when enabled", on.kind === "success" && /\[succeeded\] [0-9a-f-]{36} · turn 1 · project \/tmp\/proj-cmd/.test(on.text), on.text.slice(0, 140));
  const bad = handleMemoryCommand(store, "episodes wat", { episodeEnabled: () => true });
  check("invalid status filter errors", bad.kind === "error");

  const epId = store.listEpisodes({ projectId: "/tmp/proj-cmd" })[0]?.id;
  const insp = handleMemoryCommand(store, `episode ${epId}`, {});
  check("/memory episode inspects steps + redaction note", insp.kind === "success" && insp.text.includes("bash") && insp.text.includes("build ok") && insp.text.includes("stored redacted"), insp.text.slice(0, 140));
  check("/memory episode unknown id errors", handleMemoryCommand(store, "episode ep-nope").kind === "error");
  check("/memory episode without id errors", handleMemoryCommand(store, "episode").kind === "error");

  const purgeBad = handleMemoryCommand(store, "episode-purge wat");
  check("invalid purge scope errors", purgeBad.kind === "error");
  const purge = handleMemoryCommand(store, "episode-purge all");
  check("/memory episode-purge all removes every episode", purge.kind === "success" && /Purged 1 episodes/.test(purge.text), purge.text);
  check("store empty after purge", store.episodeCounts().succeeded === 0 && store.getEpisodeSteps(epId).length === 0, JSON.stringify(store.episodeCounts()));
  store.appendEpisodeEvents("cmd-ep2", "/tmp/proj-cmd", false, mkRows("c-cmd2", 1, 30, true));
  assembleSessionEpisodes(store, "cmd-ep2");
  const purgeOld = handleMemoryCommand(store, "episode-purge 0");
  check("/memory episode-purge <days> purges by age", purgeOld.kind === "success" && /Purged 1 episodes/.test(purgeOld.text), purgeOld.text);

  // episode-review gating + intercept (async handler in installMemoryCommands is covered
  // by the host wiring; here the pure handler path is unavailable-delegate and dry parsing)
  check("help lists the episode subcommands", handleMemoryCommand(store, "").text.includes("episode-review"));
}

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
