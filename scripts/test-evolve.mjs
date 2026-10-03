/**
 * M4 self-evolution unit tests: scene consolidation / persona versioning / forgetting decay / skill synthesis (fake LLM).
 * Run: node scripts/test-evolve.mjs
 */
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { Consolidator } from "../lib/consolidate.js";
import { applyDecay, memoryScore, synthesizeSkills, synthesizeSkillsFromEpisodes, deleteSkill } from "../lib/evolve.js";
import { installCapture } from "../lib/capture.js";
import { assembleSessionEpisodes } from "../lib/episodes.js";
import { randomUUID } from "node:crypto";

const dir = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "m4-unit");
rmSync(dir, { recursive: true, force: true });
const skillsRoot = join(dir, "skills");
rmSync(skillsRoot, { recursive: true, force: true });
const store = new MemoryStore(dir);

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

// Seeds: one preference/fact/event/instruction each (including one high-importance instruction used for skill synthesis)
store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 }, { provenance: "user" });
store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 }, { provenance: "user" });
store.insertMemory({ kind: "event", content: "Completed joint debugging of the login module yesterday", importance: 5 }, { provenance: "user" });
store.insertMemory({ kind: "instruction", content: "Use pnpm when updating dependencies and keep the lockfile up to date", importance: 8 }, { provenance: "user" });

// ---------- 1) Scene consolidation ----------
// Fake LLM: distinguishes scene/persona calls by the system prompt
const branchedFakeLlm = async ({ system }) =>
  system.includes("scene block")
    ? JSON.stringify({ scenes: [{ title: "Toolchain collaboration", summary: "The user manages dependencies with pnpm and prefers PowerShell." }] })
    : `## Basic Info\n- Uses Windows and PowerShell\n\n## Preferences & Habits\n- Prefers pnpm for dependency management`;
const consolidator = new Consolidator(store, { scenesEnabled: true, sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 }, branchedFakeLlm);
const r1 = await consolidator.consolidate();
check("scene consolidation writes", r1.scenes === 1, JSON.stringify(r1));
check("scene is listable", store.listScenes().length === 1 && store.listScenes()[0].title === "Toolchain collaboration");
check("persona first generated ver=1", r1.personaVersion === 1, JSON.stringify(r1));

// ---------- 2) Persona versioning ----------
// Gate: without new high-value memories, a re-consolidation keeps the existing persona version
const personaFakeLlm = async () =>
  `## Basic Info\n- Uses Windows and PowerShell\n\n## Preferences & Habits\n- Prefers pnpm for dependency management`;
const c2 = new Consolidator(store, { sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 }, personaFakeLlm);
const r2 = await c2.consolidate();
check("persona re-run without new memories keeps version (churn gate)", r2.personaVersion === 1, JSON.stringify(r2));
const p1 = store.getPersona();
check("persona content persisted", p1?.content.includes("PowerShell") === true);
check("persona.md written to disk", existsSync(join(dir, "persona", "persona.md")));
// 3 new memories since the last version → the gate opens and a new version is written
store.insertMemory({ kind: "fact", content: "User codes mainly in TypeScript", importance: 7 }, { provenance: "user" });
store.insertMemory({ kind: "preference", content: "User prefers dark editors", importance: 7 }, { provenance: "user" });
store.insertMemory({ kind: "preference", content: "User runs Arch Linux on the workstation", importance: 8 }, { provenance: "user" });
const r3 = await c2.consolidate();
check("persona bumps version after ≥3 new memories", r3.personaVersion === 2, JSON.stringify(r3));
check("persona.md has a backup", existsSync(join(dir, "persona", "persona.md.bak1")));

// ---------- 3) Forgetting decay ----------
const now = Date.now();
const fresh = store.insertMemory({ kind: "fact", content: "a temporary detail just recorded", importance: 1 }, { provenance: "user" });
check("old low-score memory scores below threshold", memoryScore({ importance: 1, accessCount: 0, createdAt: now - 60 * 86_400_000 }, now) < 2);
const decayed = applyDecay(store, { enabled: true, minAgeDays: 30, threshold: 2, retentionDays: 0 }, now);
check("decay run returns counts", typeof decayed.decayed === "number" && typeof decayed.deleted === "number");
// High-importance memories must not be decayed
const activeAfter = store.getActiveMemories(100);
check("high-importance active memory survives decay", activeAfter.some((m) => m.content.includes("PowerShell")));
// Fresh memory has not reached the minimum age → must not be decayed (correct behavior)
check("new memory not decayed (below minimum age)", store.getMemory(fresh.id)?.status === "active");

// ---------- 4) Skill synthesis ----------
const skillFakeLlm = async () =>
  `---\nname: bump-pnpm-deps\ndescription: Safely update dependencies with pnpm\nwhenToUse: When project dependencies need updating\n---\n1. Check current dependency versions\n2. Run pnpm update\n3. Confirm the lockfile has been updated`;
const synthesized = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("skill file written", synthesized === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md")));
if (existsSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md"))) {
  const content = readFileSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md"), "utf8");
  check("skill contains frontmatter and steps", content.includes("name: bump-pnpm-deps") && content.includes("pnpm update"));
}
// Same-content re-synthesis: must NOT spawn a suffixed near-duplicate (dedupe gate)
const synthesized2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("same-theme re-synthesis writes zero duplicates", synthesized2 === 0 && !existsSync(join(skillsRoot, "bump-pnpm-deps-2", "SKILL.md")));
// Genuinely different content under the same planned name → a suffixed variant is allowed
const skillFakeLlmV2 = async () =>
  `---\nname: bump-pnpm-deps\ndescription: Safely update dependencies with pnpm behind a proxy\nwhenToUse: When project dependencies need updating behind a proxy\n---\n1. Check current dependency versions\n2. Run pnpm update through the proxy endpoint\n3. Confirm the lockfile has been updated\n4. Document any new proxy quirks in the release notes for the team`;
const synthesized3 = await synthesizeSkills(store, skillFakeLlmV2, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("distinct content under same name gets a -2 variant", synthesized3 === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps-2", "SKILL.md")));
if (existsSync(join(skillsRoot, "bump-pnpm-deps-2", "SKILL.md"))) {
  const content = readFileSync(join(skillsRoot, "bump-pnpm-deps-2", "SKILL.md"), "utf8");
  check("suffixed skill rewrites frontmatter name", content.includes("name: bump-pnpm-deps-2"));
}

// Prefix: synthesized skill names get the dsi- prefix; on collision the suffix applies to the prefixed name
const pfxRoot = join(dir, "skills-pfx");
rmSync(pfxRoot, { recursive: true, force: true });
const pfx1 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: pfxRoot, prefix: "dsi-" }, pfxRoot);
check("synthesis with prefix (dsi-bump-pnpm-deps)", pfx1 === 1 && existsSync(join(pfxRoot, "dsi-bump-pnpm-deps", "SKILL.md")));
const pfxFile = join(pfxRoot, "dsi-bump-pnpm-deps", "SKILL.md");
if (existsSync(pfxFile)) {
  const content = readFileSync(pfxFile, "utf8");
  check("frontmatter name rewritten to the prefixed name", content.includes("name: dsi-bump-pnpm-deps"));
}
const pfx2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: pfxRoot, prefix: "dsi-" }, pfxRoot);
check("prefixed same-content re-synthesis writes zero duplicates", pfx2 === 0 && !existsSync(join(pfxRoot, "dsi-bump-pnpm-deps-2", "SKILL.md")));

// Delete skill: only dsi- prefixed, well-formed skill directories may be deleted
const d1 = deleteSkill("dsi-bump-pnpm-deps", pfxRoot);
check("prefixed skill deleted", d1 === true && !existsSync(join(pfxRoot, "dsi-bump-pnpm-deps")));
const d2 = deleteSkill("bump-pnpm-deps", pfxRoot);
check("unprefixed skill deletion rejected", d2 === false);
const d3 = deleteSkill("../evil", pfxRoot);
check("illegal name deletion rejected", d3 === false);

// Skill cap: synthesis stops once maxSkills is reached
const capRoot = join(dir, "skills-cap");
rmSync(capRoot, { recursive: true, force: true });
const cap1 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: capRoot, prefix: "dsi-", maxSkills: 1 }, capRoot);
check("synthesis allowed under the cap (1/1)", cap1 === 1 && existsSync(join(capRoot, "dsi-bump-pnpm-deps", "SKILL.md")));
const cap2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: capRoot, prefix: "dsi-", maxSkills: 1 }, capRoot);
check("synthesis stops at the cap", cap2 === 0);

// maxSkills is enforced even with an EMPTY prefix (counts unprefixed dirs too)
const bareRoot = join(dir, "skills-bare");
rmSync(bareRoot, { recursive: true, force: true });
const bare1 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: bareRoot, prefix: "", maxSkills: 1 }, bareRoot);
check("synthesis without prefix still writes (1/1)", bare1 === 1 && existsSync(join(bareRoot, "bump-pnpm-deps", "SKILL.md")));
const bare2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: bareRoot, prefix: "", maxSkills: 1 }, bareRoot);
check("empty prefix still enforces maxSkills", bare2 === 0, `bare2=${bare2}`);

// Heading-only model output (no frontmatter) is rejected — no fallback skill naming
const headingOnlyRoot = join(dir, "skills-heading");
rmSync(headingOnlyRoot, { recursive: true, force: true });
const headingOnly = async () =>
  `# Bump pnpm dependencies\n1. Check current dependency versions\n2. Run pnpm update\n3. Confirm the lockfile has been updated`.padEnd(120, "x");
const hReject = await synthesizeSkills(store, headingOnly, { enabled: true, minImportance: 7, skillsRoot: headingOnlyRoot, prefix: "dsi-" }, headingOnlyRoot);
check("heading-only output rejected (frontmatter required)", hReject === 0 && !existsSync(join(headingOnlyRoot, "dsi-bump-pnpm-deps")));
// Frontmatter missing description is also rejected (valid frontmatter = name + description)
const noDesc = async () =>
  `---\nname: bump-pnpm-deps\nwhenToUse: When project dependencies need updating\n---\n1. Check current dependency versions\n2. Run pnpm update`.padEnd(120, "x");
check("frontmatter without description rejected", (await synthesizeSkills(store, noDesc, { enabled: true, minImportance: 7, skillsRoot: headingOnlyRoot, prefix: "dsi-" }, headingOnlyRoot)) === 0);

// Deletion honors the CONFIGURED prefix, not a hardcoded one
const otherRoot = join(dir, "skills-other-prefix");
rmSync(otherRoot, { recursive: true, force: true });
await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: otherRoot, prefix: "mem-" }, otherRoot);
check("custom-prefixed skill written", existsSync(join(otherRoot, "mem-bump-pnpm-deps", "SKILL.md")));
check("hardcoded dsi- prefix refuses to delete mem- skill", deleteSkill("mem-bump-pnpm-deps", otherRoot) === false);
check("configured prefix deletes its own skill", deleteSkill("mem-bump-pnpm-deps", otherRoot, "mem-") === true && !existsSync(join(otherRoot, "mem-bump-pnpm-deps")));
check("deletion with empty prefix is refused", existsSync(join(skillsRoot, "bump-pnpm-deps-2", "SKILL.md")) && deleteSkill("bump-pnpm-deps-2", skillsRoot, "") === false);

// Memory total cap: over the limit, the lowest-scoring memories are demoted automatically
const capMem = await import("../lib/storage.js").then((m) => new m.MemoryStore(join(dir, "cap-mem")));
for (let i = 0; i < 5; i++) capMem.insertMemory({ kind: "fact", content: `test memory ${i}`, importance: 5 }, { provenance: "user" });
const dc = applyDecay(capMem, { enabled: true, minAgeDays: 9999, threshold: 0, retentionDays: 0, maxActiveMemories: 3 });
check("memory cap demotes lowest scores (5→3)", dc.decayed === 2, "decayed=" + dc.decayed);
check("active count after demotion = 3", capMem.getActiveMemories(100).length === 3);
capMem.close();

// ---------- Watermark-before-LLM regression ----------
// A memory inserted WHILE persona generation runs must remain eligible at the
// next regeneration: the persisted watermark is the value captured together
// with the input snapshot (before the awaited LLM call), never MAX(seq) read
// after generation finished.
{
  const wmStore = new MemoryStore(join(dir, "persona-watermark"));
  wmStore.insertMemory({ kind: "preference", content: "User drinks coffee", importance: 8 }, { provenance: "user" });
  // No previous persona → the gate opens; the fake LLM simulates three trusted
  // rows arriving DURING generation (after the input snapshot was taken).
  const concurrentLlm = async () => {
    for (const andThen of ["alpha", "beta", "gamma"]) {
      wmStore.insertMemory(
        { kind: "fact", content: `Concurrent user detail ${andThen}`, importance: 7 },
        { provenance: "user", source: "user-direct", scope: "global" },
      );
    }
    return `## Basic Info\n- Coffee drinker`;
  };
  const wmResult = await new Consolidator(
    wmStore,
    { scenesEnabled: false, sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 },
    concurrentLlm,
  ).consolidate();
  const wmPersona = wmStore.getPersona();
  const eligible = wmStore.countNewMemoriesForPersona({
    ver: wmPersona?.ver ?? 0,
    memWatermark: wmPersona?.memWatermark ?? null,
    createdAt: wmPersona?.createdAt ?? 0,
  });
  check("persona first version written", wmResult.personaVersion === 1 && wmPersona?.ver === 1, JSON.stringify(wmResult));
  check("concurrent insert during generation stays eligible next time (watermark captured before the LLM)", eligible === 3, `eligible=${eligible} watermark=${wmPersona?.memWatermark}`);
  wmStore.close();
}

// ---------- 5) Phase 5: episode-to-skill synthesis (opt-in, gated by the caller) ----------
{
  // Shared episode-seeding helpers (mirrors test-episode-review.mjs conventions)
  const flushOf = (store) => {
    const regs = [];
    const ctx = { on: (type, fn) => regs.push({ type, fn }) };
    installCapture(ctx, store, { enabled: () => true }, undefined, { enabled: () => true, maxChars: () => 4000 });
    return async (session) => {
      await regs[0].fn(session);
      assembleSessionEpisodes(store, session.id);
    };
  };
  const callEv = (seq, turn, step, callId, name, args, time = 1000) => ({
    type: "tool/call",
    seq,
    time,
    data: { turn, step, callId, name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  });
  const resultEv = (seq, turn, step, callId, text, time = 2000) => ({
    type: "tool/result",
    seq,
    time,
    data: { turn, step, message: { content: [{ type: "tool-result", toolCallId: callId, content: text }] } },
  });
  const turnEndEv = (seq, turn, time = 3000) => ({ type: "turn/end", seq, time, data: { turn, reason: { kind: "completed" } } });

  let sessionSeq = 0;
  /** One successful episode in its own session; returns the episode id. */
  const seedGoodEpisode = async (flush, tool = "bash", args = { cmd: "pnpm update" }, excerpt = "lockfile updated") => {
    const turn = 1;
    sessionSeq += 1;
    const sessionId = `ep-skill-session-${sessionSeq}`;
    await flush({
      id: sessionId,
      header: { cwd: "/tmp/ep-skill-proj" },
      events: [
        callEv(1, turn, 0, `c${sessionSeq}`, tool, args),
        resultEv(2, turn, 0, `c${sessionSeq}`, excerpt),
        turnEndEv(3, turn),
      ],
    });
    return sessionId;
  };
  const countReviewed = (store) => store.listEpisodes({ status: "succeeded", limit: 500 }).filter((e) => e.reviewedAt != null).length;
  const episodeIdOfSession = (store, sessionId) => {
    for (const reviewed of [false, true]) {
      const eps = reviewed
        ? store.listEpisodes({ status: "succeeded", limit: 500 }).filter((e) => e.reviewedAt != null)
        : store.listEpisodes({ status: "succeeded", limit: 500, unreviewedOnly: true });
      const ep = eps.find((e) => e.sessionId === sessionId);
      if (ep) return ep.id;
    }
    return null;
  };
  const markReviewed = (store, episodeId) => {
    store.setEpisodeReview(episodeId, {
      summary: "dependency update demonstrated successfully via pnpm",
      confidence: 0.9,
      status: "reviewed",
    });
  };

  /**
   * Seeds `n` identical (same fingerprint) episodes for one store and returns
   * their episode ids. whenReviewed=false leaves them unreviewed.
   */
  const seedGroup = async (store, n, whenReviewed = true) => {
    const flush = flushOf(store);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const sessionId = await seedGoodEpisode(flush);
      const id = episodeIdOfSession(store, sessionId);
      ids.push(id);
      if (whenReviewed) markReviewed(store, id);
    }
    return ids;
  };

  /** Canned LLM echoing the actual episode ids from the prompt (real citation path). */
  const emitSkill = (name, procedure, extra = {}) => {
    const fn = async ({ user }) => {
      const ids = [...user.matchAll(/Episode id: ([0-9a-f-]+)/g)].map((m) => m[1]);
      return JSON.stringify({
        skill: { name, description: "Update dependencies safely with pnpm", whenToUse: "When project dependencies need updating", procedure, source_episode_ids: ids, ...extra },
      });
    };
    fn.getSkillName = () => name;
    return fn;
  };
  const skillDir = (root, name) => join(root, name, "SKILL.md");

  const synth = (store, root, llm, opts = {}) =>
    synthesizeSkillsFromEpisodes(store, llm, {
      skillsRoot: root,
      prefix: "",
      maxSkills: 0,
      minEpisodes: 2,
      ...opts,
    });

  // --- 5a) ONE succeeded episode → never a skill
  {
    const s = new MemoryStore(join(dir, "ep-skill-one"));
    const root = join(dir, "ep-skill-root-one");
    await seedGroup(s, 1);
    const n = await synth(s, root, emitSkill("bump-deps", ["Update the lockfile", "Verify the build"]));
    check("5a: one succeeded episode yields NO skill", n === 0 && !existsSync(join(root, "bump-deps")));
    s.close();
  }

  // --- 5b) two compatible succeeded episodes → exactly 1 skill with full provenance
  let rootB;
  {
    const s = new MemoryStore(join(dir, "ep-skill-two"));
    rootB = join(dir, "ep-skill-root-two");
    const ids = await seedGroup(s, 2);
    const n = await synth(s, rootB, emitSkill("bump-deps", ["Check current dependency versions", "Update the lockfile", "Verify the build"]));
    check("5b: two compatible episodes write ONE skill", n === 1 && existsSync(skillDir(rootB, "bump-deps")));
    const content = existsSync(skillDir(rootB, "bump-deps")) ? readFileSync(skillDir(rootB, "bump-deps"), "utf8") : "";
    const cited = ids.every((id) => content.includes(`"${id}"`));
    check("5b: frontmatter cites BOTH episode ids", cited, content.match(/^source_episodes:.*$/m)?.[0] ?? "missing");
    check("5b: frontmatter carries generated_at", /^generated_at: .+Z$/m.test(content));
    check("5b: name validation applied (kebab-case kept)", content.includes("name: bump-deps"));
    check("5b: procedure steps present", content.includes("Update the lockfile"));
    // --- 5c) rerun on the SAME episodes (all already cited + same content) → 0 additional skills
    const n2 = await synth(s, rootB, emitSkill("bump-deps", ["Check current dependency versions", "Update the lockfile", "Verify the build"]));
    check("5c: re-synthesis of the same episodes writes 0 skills", n2 === 0 && !existsSync(join(rootB, "bump-deps-2")));
    s.close();
  }

  // --- 5d) partial citation: new uncited episode → 1; then all cited → 0
  {
    const s = new MemoryStore(join(dir, "ep-skill-partial"));
    const root = join(dir, "ep-skill-root-partial");
    const ids = await seedGroup(s, 2);
    // Hand-written prior skill citing ONLY the first episode (simulates an earlier synthesis)
    const prior = ["---", `name: bump-deps`, "description: prior version", "whenToUse: when updating", `source_episodes: ${JSON.stringify([ids[0]])}`, "generated_at: 2026-01-01T00:00:00.000Z", "---", "1. an old unrelated procedure line about uninstalling stale caches entirely"].join("\n");
    mkdirSync(join(root, "bump-deps"), { recursive: true });
    writeFileSync(join(root, "bump-deps", "SKILL.md"), prior + "\n");
    const n1 = await synth(s, root, emitSkill("bump-deps", ["Update the lockfile with pnpm update", "Then run the release verification suite freshly again"]));
    check("5d: partial citation + new episode → 1 new skill", n1 === 1, "n1=" + n1);
    // now all group ids are cited → gate 3 blocks
    const n2 = await synth(s, root, emitSkill("bump-deps", ["Yet another genuinely different generalized procedure text for testing purposes"]));
    check("5d: all cited → 0 (dedupe gate)", n2 === 0, "n2=" + n2);
    s.close();
  }

  // --- 5e) a later FAILED episode with the same fingerprint blocks the group
  {
    const s = new MemoryStore(join(dir, "ep-skill-failed"));
    const root = join(dir, "ep-skill-root-failed");
    await seedGroup(s, 2);
    // one same-fingerprint FAILED episode (same single bash call, erroring result)
    sessionSeq += 1;
    const sessionId = `ep-skill-session-${sessionSeq}`;
    await flushOf(s)({
      id: sessionId,
      header: { cwd: "/tmp/ep-skill-proj" },
      events: [
        callEv(1, 1, 0, `c${sessionSeq}`, "bash", { cmd: "pnpm update" }),
        {
          type: "tool/result",
          seq: 2,
          time: 2000,
          data: { turn: 1, step: 0, message: { content: [{ type: "tool-result", toolCallId: `c${sessionSeq}`, content: "failed to resolve", isError: true }] } },
        },
        turnEndEv(3, 1),
      ],
    });
    const n = await synth(s, root, emitSkill("bump-deps", ["Update the lockfile", "Verify the build passes"]));
    check("5e: later failed episode with same fingerprint blocks synthesis", n === 0 && !existsSync(join(root, "bump-deps")));
    s.close();
  }

  // --- 5f) contradictory evidence: {"skill":null,"reason"} → skip, no crash, no errored group
  {
    const s = new MemoryStore(join(dir, "ep-skill-contradict"));
    const root = join(dir, "ep-skill-root-contradict");
    await seedGroup(s, 2);
    const contradictLlm = async () => JSON.stringify({ skill: null, reason: "procedures differ between the episodes" });
    const n = await synth(s, root, contradictLlm);
    let files = "";
    try { files = readdirSync(root).join(","); } catch { files = ""; }
    check("5f: contradictory evidence → 0 skills, no files", n === 0 && files === "", files);
    s.close();
  }

  // --- 5g) credential-shaped procedure line is dropped; secrets never reach the file
  {
    const s = new MemoryStore(join(dir, "ep-skill-secret"));
    const root = join(dir, "ep-skill-root-secret");
    await seedGroup(s, 2);
    const n = await synth(s, root, emitSkill("bump-deps", ["Run the build to verify", "set token bearer AKIAIOSEXAMPLE123456"])); // eslint-disable-line no-restricted-syntax
    const file = skillDir(root, "bump-deps");
    const content = existsSync(file) ? readFileSync(file, "utf8") : "";
    check("5g: credential line dropped, skill still written", n === 1 && content.includes("Run the build to verify"));
    check("5g: no secret in written skill file", !content.includes("AKIAIOS"));
    // all-lines-secret → skill rejected entirely
    const root2 = join(dir, "ep-skill-root-secret-all");
    const secretOnly = emitSkill("bump-deps", ["set token bearer AKIAIOSEXAMPLE123456", "password=hunter2verysecretxx"]);
    const n2 = await synth(s, root2, secretOnly);
    check("5g: all-secret procedure → skill rejected", n2 === 0 && !existsSync(join(root2, "bump-deps")));
    s.close();
  }

  // --- 5h) maxSkills cap reached → 0 + existing skip behaviour
  {
    const s = new MemoryStore(join(dir, "ep-skill-cap"));
    const root = join(dir, "ep-skill-root-cap");
    await seedGroup(s, 2);
    mkdirSync(join(root, "dsi-existing-procedure"), { recursive: true });
    writeFileSync(join(root, "dsi-existing-procedure", "SKILL.md"), "---\nname: dsi-existing-procedure\ndescription: an existing synthesized skill\n---\n1. an existing step");
    const n = await synth(s, root, emitSkill("bump-deps", ["Update the lockfile"]), { prefix: "dsi-", maxSkills: 1 });
    check("5h: cap reached → 0 written", n === 0);
    s.close();
  }

  // --- 5i) prefix rules: prefixed config writes dsi-prefixed skill; unprefixed writes bare
  {
    const s = new MemoryStore(join(dir, "ep-skill-prefix"));
    const root = join(dir, "ep-skill-root-prefix");
    await seedGroup(s, 2);
    const n = await synth(s, root, emitSkill("bump-deps", ["Update the lockfile"]), { prefix: "dsi-" });
    const file = skillDir(root, "dsi-bump-deps");
    const content = existsSync(file) ? readFileSync(file, "utf8") : "";
    check("5i: prefixed skill written with rewritten frontmatter name", n === 1 && content.includes("name: dsi-bump-deps"));
    s.close();
  }

  // --- 5j) unreviewed succeeded episodes are NOT candidates
  {
    const s = new MemoryStore(join(dir, "ep-skill-unreviewed"));
    const root = join(dir, "ep-skill-root-unreviewed");
    await seedGroup(s, 2, false);
    check("5j: setup has unreviewed episodes", countReviewed(s) === 0);
    const n = await synth(s, root, emitSkill("bump-deps", ["Update the lockfile"]));
    check("5j: unreviewed episodes yield 0 skills", n === 0 && !existsSync(join(root, "bump-deps")));
    s.close();
  }

  // --- 5k) empty skillsRoot is a safe no-op; now override respected
  {
    const s = new MemoryStore(join(dir, "ep-skill-noop"));
    check("5k: empty skillsRoot → 0 (no-op)", (await synth(s, "", emitSkill("bump-deps", ["Update the lockfile"]))) === 0);
    const root = join(dir, "ep-skill-root-now");
    await seedGroup(s, 2);
    const n = await synth(s, root, emitSkill("bump-deps", ["Update the lockfile"]), { now: Date.UTC(2026, 0, 15) });
    const content = yamlGeneratedAt(join(root, "bump-deps"));
    if (content) check("5k: generated_at honors opts.now", content === "2026-01-15T00:00:00.000Z", content);
    s.close();
  }

  function yamlGeneratedAt(root) {
    const file = join(root, "SKILL.md");
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8").match(/^generated_at: (\S+)/m)?.[1] ?? null;
  }
}

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
