/**
 * CLI/text commands (M5): the /memory command group (search / list / forget / correct / status).
 * Handlers are pure functions for easy unit testing; installMemoryCommands registers only when the host provides a commands service.
 */
import type { Context } from "@deepseek-ai/cordis";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { defaultSkillsDir, deleteSkill } from "./evolve.js";
import type { EpisodeStatus, MemoryStore } from "./storage.js";

export interface CommandOutcome {
  kind: "success" | "error";
  text: string;
}

function ok(text: string): CommandOutcome {
  return { kind: "success", text };
}
function err(text: string): CommandOutcome {
  return { kind: "error", text };
}

/** Valid episode status filters for /memory episodes */
const EPISODE_STATUSES: ReadonlySet<string> = new Set(["pending", "succeeded", "failed", "ambiguous", "reviewed", "rejected"]);
/** Cap on steps rendered by one /memory episode inspect call (display budget, not the DB cap) */
const MAX_EPISODE_INSPECT_STEPS = 24;

/** Memory command handler (pure function). When the input ends with `--json`, text outputs JSON (parsed by the settings-page memory browser) */
export function handleMemoryCommand(
  store: MemoryStore,
  rawInput: string,
  opts?: { evolve?: () => Promise<Record<string, unknown>>; skillsPrefix?: string | (() => string); skillsRoot?: string | (() => string); episodeEnabled?: () => boolean },
): CommandOutcome {
  const args = rawInput.trim().split(/\s+/).filter(Boolean);
  const json = args.includes("--json");
  const sub = (args[0] ?? "help").toLowerCase();
  if (json && sub === "browser") {
    // Prefix/root may be live getters: a hot-applied synthesis prefix must be
    // picked up without re-registering the command.
    const prefix = typeof opts?.skillsPrefix === "function" ? opts.skillsPrefix() : opts?.skillsPrefix;
    const root = typeof opts?.skillsRoot === "function" ? opts.skillsRoot() : opts?.skillsRoot;
    return ok(JSON.stringify(browserSnapshot(store, prefix, root, opts?.episodeEnabled?.() === true)));
  }
  switch (sub) {
    case "evolve": {
      if (!opts?.evolve) return err("Evolution is not installed (scheduled runs only)");
      const p = opts.evolve();
      if (json) return ok(JSON.stringify({ kind: "success", text: "Evolution triggered", value: {} }));
      return ok("Evolution triggered, running in the background (consolidation/decay/skills/governance)…");
    }
    case "search": {
      const q = args.slice(1).join(" ");
      if (!q) return err("Usage: /memory search <keyword>");
      const hits = store.searchMemories(q, { limit: 8, matchAny: true });
      return hits.length > 0
        ? ok(hits.map((h, i) => `${i + 1}. [${h.kind}] ${h.content}`).join("\n"))
        : ok("No relevant memories found.");
    }
    case "list": {
      const recs = store.listMemories({ limit: 20 });
      return recs.length > 0
        ? ok(recs.map((r) => `[${r.status}] ${r.kind} ${r.content}`).join("\n"))
        : ok("Memory store is empty");
    }
    case "forget": {
      const id = args[1];
      if (!id) return err("Usage: /memory forget <id>");
      return ok(store.forgetMemory(id) ? `Forgotten ${id}` : `Not found: ${id}`);
    }
    case "correct": {
      const id = args[1];
      const content = args.slice(2).join(" ");
      if (!id || !content) return err("Usage: /memory correct <id> <new content>");
      const old = store.getMemory(id);
      if (!old) return err(`Not found: ${id}`);
      const rec = store.insertMemory(
        { kind: old.kind, content, importance: old.importance, supersedes: old.id },
        {
          // Direct command → user-initiated correction: trusted, and it INHERITS
          // the old row's scope/project/session so context-bound corrections stay
          // in their original scope.
          provenance: "user",
          source: "user-direct",
          scope: old.meta?.scope ?? "global",
          projectId: old.meta?.projectId ?? null,
          sessionId: old.meta?.sessionId ?? null,
          confidence: 0.9,
        },
      );
      store.setMemoryStatus(id, "corrected");
      return ok(`Corrected, new id: ${rec.id}`);
    }
    case "status": {
      const active = store.getActiveMemories(10_000).length;
      const quarantined = store.listMemories({ status: "quarantined", limit: 10_000 }).length;
      const total = store.listMemories({ limit: 10_000 }).length;
      const pinned = store.listBaseline().length;
      const pending = store.pendingSessions().length;
      const scenes = store.listScenes(100).length;
      const persona = store.getPersona();
      return ok(
        `Memories: ${active} active / ${total} total (${quarantined} quarantined); baseline: ${pinned} pinned; pending extraction sessions: ${pending}; scenes: ${scenes}; persona v${persona?.ver ?? "-"}`,
      );
    }
    case "pin": {
      const id = args[1];
      if (!id) return err("Usage: /memory pin <memory-id> [slot]");
      const slot = Number(args[2]);
      const assigned = Number.isInteger(slot)
        ? store.pinBaselineSlot(id, slot)
        : store.pinBaseline(id);
      if (assigned === null) return err(`Cannot pin: memory not found or all slots in use (id=${id})`);
      return ok(`Pinned to baseline slot ${assigned}`);
    }
    case "unpin": {
      const slot = Number(args[1]);
      if (!Number.isInteger(slot)) return err("Usage: /memory unpin <slot>");
      return store.unpinBaseline(slot) ? ok(`Unpinned slot ${slot}`) : err(`Slot ${slot} is not pinned`);
    }
    case "baseline": {
      const entries = store.listBaseline();
      if (entries.length === 0) return ok("No baseline entries pinned. Pin with /memory pin <id>.");
      return ok(entries.map((e) => `${e.slot}. ${e.memory?.content.slice(0, 100) ?? "(missing memory)"} [${e.memory?.id.slice(0, 8) ?? e.memoryId}]`).join("\n"));
    }
    case "accept-legacy": {
      const id = args[1];
      const target = id ? store.getMemory(id) : undefined;
      if (id && !target) return err(`Not found: ${id}`);
      let accepted = 0;
      for (const m of target ? [target] : store.listMemories({ limit: 10_000 })) {
        if (!m.meta?.legacy) continue;
        // Bulk promotion deliberately leaves quarantined instructions untouched;
        // an operator must name one exact id to restore such a row.
        if (!target && (m.status === "quarantined" || m.status === "migrated")) continue;
        store.updateMeta(m.id, { provenance: "user", source: "user-direct", confidence: 0.6 });
        if (target && m.status === "quarantined") store.setMemoryStatus(m.id, "active");
        accepted++;
      }
      return target
        ? ok(accepted > 0 ? `Accepted legacy memory ${id} as user-proven` : "Nothing to accept (already accepted or not legacy)")
        : ok(`Accepted ${accepted} legacy memories as user-proven`);
    }
    case "episodes": {
      // Counts are harmless numbers; the recent list (redacted rows) only when
      // episode learning is enabled — same privacy posture as the browser.
      const counts = store.episodeCounts();
      const lines = [
        `Episodes: ${counts.reviewed} reviewed / ${counts.succeeded} succeeded / ${counts.failed} failed / ${counts.pending} pending / ${counts.ambiguous} ambiguous / ${counts.rejected} rejected`,
      ];
      if (opts?.episodeEnabled?.() !== true) {
        lines.push("Episode listing requires episodeLearning.enabled");
        return ok(lines.join("\n"));
      }
      const statusArg = args[1] && args[1] !== "--json" ? args[1].toLowerCase() : undefined;
      if (statusArg && !EPISODE_STATUSES.has(statusArg)) {
        return err("Usage: /memory episodes [pending|succeeded|failed|ambiguous|reviewed|rejected] [limit]");
      }
      const limitArg = args.find((a, i) => i >= 2 && /^\d+$/.test(a));
      const list = store.listEpisodes({
        status: statusArg as EpisodeStatus | undefined,
        limit: limitArg ? Math.min(Number(limitArg), 50) : 10,
      });
      lines.push(
        ...(list.length > 0
          ? list.map(
              (e) =>
                `[${e.status}] ${e.id} · turn ${e.turn} · project ${e.projectId}` +
                (e.summary ? ` · ${e.summary.slice(0, 80)}` : ""),
            )
          : ["(no episodes recorded)"]),
      );
      return ok(lines.join("\n"));
    }
    case "episode": {
      const id = args[1];
      if (!id) return err("Usage: /memory episode <episode-id>");
      const ep = store.getEpisode(id);
      if (!ep) return err(`Episode not found: ${id}`);
      const lines = [
        `[${ep.status}] ${ep.id}`,
        `session ${ep.sessionId} · turn ${ep.turn} · project ${ep.projectId}${ep.delegated ? " · delegated" : ""}`,
      ];
      if (ep.summary) {
        lines.push(`Summary: ${ep.summary.slice(0, 200)}${ep.confidence != null ? ` (confidence ${ep.confidence.toFixed(2)})` : ""}`);
      }
      if (ep.rejectReason) lines.push(`Reject reason: ${ep.rejectReason}`);
      const steps = store.getEpisodeSteps(id).slice(0, MAX_EPISODE_INSPECT_STEPS);
      lines.push(
        ...steps.map(
          (s) =>
            `  ${s.ordinal}. ${s.isError ? "FAIL" : " ok "} ${s.toolName}${s.errorName ? ` (${s.errorName})` : ""}` +
            ` · args: ${s.argumentsRedacted.slice(0, 120)}` +
            ` · result: ${s.resultExcerpt.slice(0, 160)}`,
        ),
      );
      lines.push("(arguments and results are stored redacted)");
      return ok(lines.join("\n"));
    }
    case "episode-purge": {
      const rest = args.slice(1).filter((a) => a !== "--json");
      const pIdx = rest.indexOf("--project");
      let projectId: string | undefined;
      if (pIdx >= 0) {
        projectId = rest[pIdx + 1];
        if (!projectId) return err("Usage: /memory episode-purge [days|all] [--project <id>]");
        rest.splice(pIdx, 2);
      }
      const scope = rest[0] ?? "30";
      if (scope !== "all" && !/^\d+$/.test(scope)) {
        return err("Usage: /memory episode-purge [days|all] [--project <id>]");
      }
      // "all" → explicit future cutoff (see the browser purgeEpisodes note: no
      // filters means delete-nothing by design).
      const olderThanTs =
        scope === "all" ? Date.now() + 60_000 : Date.now() - Number(scope) * 86_400_000;
      const res = store.purgeEpisodes({ projectId, olderThanTs });
      return ok(
        `Purged ${res.episodes} episodes (${res.steps} steps, ${res.events} events)` +
          `${projectId ? ` in project ${projectId}` : ""}${olderThanTs !== undefined ? ` older than ${scope}d` : ""}`,
      );
    }
    default:
      return ok(
        "dsh-self-improved memory commands:\n" +
          "/memory search <keyword>\n" +
          "/memory list\n" +
          "/memory browser --json\n" +
          "/memory baseline | pin <id> [slot] | unpin <slot>\n" +
          "/memory accept-legacy [id]\n" +
          "/memory forget <id>\n" +
          "/memory correct <id> <new content>\n" +
          "/memory episodes [status] [limit] | episode <id> | episode-purge [days|all] [--project <id>]\n" +
          "/memory episode-review [--dry]\n" +
          "/memory status",
      );
  }
}

/**
 * Snapshot-token ledger for the memory-browser trust-elevation channel.
 * Signing and change detection cover stable business content only: the volatile
 * wall-clock `updatedAt` stamp is stripped before comparing/signing, so an
 * unchanged refresh reuses the same token (and re-notes it, sliding its TTL
 * window) instead of minting a new one every tick — with the token cap, a
 * still-served token would otherwise be evicted after a few refreshes despite
 * the documented sliding TTL. `now` is injectable for fake-clock tests.
 */
export class SnapshotTokenTracker {
  private lastStableJson = "";
  private issued = new Map<string, number>(); // token → last noted at (ms)

  constructor(
    private readonly secret: string,
    private readonly ttlMs: number = 15 * 60_000,
    private readonly maxTokens = 4,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sign the stable business content of a snapshot (volatile updatedAt excluded). */
  sign(snap: Record<string, unknown>): { token: string; changed: boolean } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stable = { ...(snap as any) };
    delete stable.updatedAt;
    const stableJson = JSON.stringify(stable);
    const token = createHmac("sha256", this.secret).update(stableJson).digest("hex").slice(0, 32);
    const changed = stableJson !== this.lastStableJson;
    this.lastStableJson = stableJson;
    return { token, changed };
  }

  /** Note a token as freshly served: slides its TTL window, evicts the coldest over the cap. */
  note(token: string): void {
    this.issued.set(token, this.now());
    while (this.issued.size > this.maxTokens) {
      const entries = [...this.issued.entries()].sort((a, b) => a[1] - b[1]);
      const oldest = entries[0]?.[0];
      if (oldest === undefined) break;
      this.issued.delete(oldest);
    }
  }

  /** A token is usable when it has been noted again within the sliding TTL window. */
  verify(token: string): boolean {
    const notedAt = this.issued.get(token);
    return notedAt !== undefined && this.now() - notedAt <= this.ttlMs;
  }

  /** Verify AND consume atomically: a token authorizes exactly one action submit.
   *  Replaying a captured token fails, because the capability is gone after use. */
  consume(token: string): boolean {
    if (!this.verify(token)) return false;
    this.issued.delete(token);
    return true;
  }
}
/**
 * One-shot action challenges for trust-elevating browser operations.
 *
 * The old design published a reusable HMAC snapshot token in the same readable
 * namespace that submits actions: any observer could replay it for arbitrary
 * mutating actions within the TTL. Instead:
 *
 * 1. The client submits the intended op + arguments (prepare) gated by the
 *    snapshot-token check (it must be observing a freshly served snapshot).
 * 2. The host mints a short-TTL challenge bound to the EXACT operation and
 *    arguments (canonical HMAC fingerprint) and publishes it in the snapshot.
 * 3. The client echoes that challenge back; the host verifies the binding and
 *    consumes the pending challenge ATOMICALLY (cleared before executing):
 *    every challenge authorizes exactly one operation, replays fail.
 */
export interface BrowserActionArgs {
  op: string;
  id?: string;
  content?: string;
  name?: string;
  newId?: string;
}
/** `purgeEpisodes` reuses `id` as its purge scope: "all" | "<days>" (e.g. "30"). */

export const MUTATING_BROWSER_OPS: ReadonlySet<string> = new Set([
  "forget",
  "correct",
  "confirm-correct",
  "deleteSkill",
  // Phase 6: purge spends stored data; dry-review spends LLM tokens — both are
  // trust-elevating even though dry-review persists nothing.
  "purgeEpisodes",
  "dryReview",
]);

/** Canonical args fingerprint (sorted known fields; HMAC-bound to the exact operation + arguments). */
function fingerprintActionArgs(secret: string, args: BrowserActionArgs): string {
  const stable: Array<[string, string]> = [];
  for (const key of ["op", "id", "content", "name", "newId"] as const) {
    const value = args[key];
    if (value !== undefined) stable.push([key, String(value)]);
  }
  return createHmac("sha256", secret).update(JSON.stringify(stable)).digest("hex").slice(0, 32);
}

export interface PendingChallenge {
  token: string;
  fp: string;
  args: BrowserActionArgs;
}

export class ActionChallengeLedger {
  private pending: { fp: string; token: string; args: BrowserActionArgs; expiresAt: number } | null = null;

  constructor(
    private readonly secret: string,
    private readonly ttlMs: number = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mint (replace) the pending challenge bound to these exact args.
   *  The token includes a fresh random nonce per preparation, so re-preparing
   *  the SAME action never reproduces an old challenge token: a consumed
   *  confirmation captured earlier cannot authorize the newly staged attempt. */
  prepare(args: BrowserActionArgs): { token: string; fp: string } {
    const fp = fingerprintActionArgs(this.secret, args);
    const nonce = randomBytes(16).toString("hex");
    const token = createHmac("sha256", this.secret).update(`challenge:${fp}:${nonce}`).digest("hex").slice(0, 32);
    this.pending = { fp, token, args: { ...args }, expiresAt: this.now() + this.ttlMs };
    return { token, fp };
  }

  /** Publishable pending challenge (or null when none / expired-with-cleanup). */
  peek(): PendingChallenge | null {
    if (!this.pending) return null;
    if (this.now() > this.pending.expiresAt) {
      this.pending = null;
      return null;
    }
    return this.pending;
  }

  /** Atomic consume: exactly one shot, only for the args the challenge was minted for. */
  consume(args: BrowserActionArgs, token: string): boolean {
    const p = this.pending;
    this.pending = null; // consume first: the credential is gone whatever the verdict
    if (!p) return false;
    if (this.now() > p.expiresAt) return false;
    if (!token || token !== p.token) return false;
    if (fingerprintActionArgs(this.secret, args) !== p.fp) return false;
    return true;
  }

  clear(): void {
    this.pending = null;
  }
}

/** Memory browser snapshot (for the settings-page frontend; content truncation + count caps keep the payload small) */
export function browserSnapshot(
  store: MemoryStore,
  skillsPrefix = "dsi-",
  skillsRoot = "",
  /** Phase 6: recent episode rows (redacted) are served only while episode learning is enabled; counts are always included */
  episodeEnabled = false,
): Record<string, unknown> {
  const memories = store.listMemories({ limit: 300 })
    // Stable ordering: same-millisecond ties fall back to createdAt then id, so
    // an unchanged store renders an unchanged snapshot (the HMAC token stays the
    // same instead of churning on tie-order luck).
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => ({
    id: m.id,
    kind: m.kind,
    content: m.content.slice(0, 120),
    importance: m.importance,
    accessCount: m.accessCount,
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    supersedes: m.supersedes ?? null,
    // Additive meta fields (browser keeps rendering rows without them too)
    provenance: m.meta?.provenance ?? null,
    source: m.meta?.source ?? null,
    scope: m.meta?.scope ?? null,
    projectId: m.meta?.projectId ?? null,
    legacy: m.meta?.legacy ?? false,
  }));
  const baseline = store.listBaseline().map((b) => ({ slot: b.slot, memoryId: b.memoryId }));
  const scenes = store.listScenes(50).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
  const persona = store.getPersona();
  // Episode learning (Phase 6): counts by status (harmless numbers) + a bounded
  // recent list of redacted rows when enabled. Sorting mirrors the memories list
  // so an unchanged store re-signs to the same snapshot token.
  const episodes = {
    counts: store.episodeCounts(),
    recent: episodeEnabled
      ? store
          .listEpisodes({ limit: 12 })
          .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((e) => ({
            id: e.id,
            sessionId: e.sessionId,
            projectId: e.projectId,
            turn: e.turn,
            status: e.status,
            updatedAt: e.updatedAt,
            summary: e.summary ? e.summary.slice(0, 80) : null,
            confidence: e.confidence,
          }))
      : null,
  };
  return {
    memories,
    baseline,
    scenes,
    persona: persona ? { ver: persona.ver, content: persona.content.slice(0, 500), createdAt: persona.createdAt } : null,
    skills: listSkills(100, skillsPrefix, skillsRoot),
    pending: store.pendingSessions().length,
    episodes,
    updatedAt: Date.now(),
  };
}

/** List the skills in the skill repository (name + description + when to use + whether plugin-synthesized).
 *  The synthesized flag follows the CONFIGURED synthesis prefix, not a hardcoded one. */
export function listSkills(limit = 100, prefix = "dsi-", skillsRoot = ""): Array<{
  name: string;
  description: string;
  whenToUse: string;
  excerpt: string;
  synthesized: boolean;
}> {
  const root = skillsRoot.trim() || defaultSkillsDir();
  let dirNames: string[] = [];
  try {
    dirNames = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: Array<{ name: string; description: string; whenToUse: string; excerpt: string; synthesized: boolean }> = [];
  for (const dirName of dirNames.slice(0, limit)) {
    const file = join(root, dirName, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    let description = "";
    let whenToUse = "";
    let name = dirName;
    if (fmMatch) {
      const fm = fmMatch[1];
      name = fm.match(/^name:\s*([^\n]+)/m)?.[1]?.trim() ?? dirName;
      description = fm.match(/^description:\s*([^\n]+)/m)?.[1]?.trim() ?? "";
      whenToUse = fm.match(/^whenToUse:\s*([^\n]+)/m)?.[1]?.trim() ?? "";
    }
    const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 120);
    out.push({
      name,
      description,
      whenToUse,
      excerpt,
      synthesized: !!(prefix || "").trim() && name.startsWith((prefix || "").trim()),
    });
  }
  return out;
}

/** Registers the /memory command (only when the host provides a commands service; optional capability, never blocks the plugin).
 *  Returns the disposer of register (call it to unregister), so the plugin can hot-toggle registration alongside its master switch. */
export function installMemoryCommands(
  ctx: Context,
  store: MemoryStore,
  opts?: {
    evolve?: () => Promise<Record<string, unknown>>;
    isEnabled?: () => boolean;
    skillsPrefix?: string | (() => string);
    skillsRoot?: string | (() => string);
    episodeEnabled?: () => boolean;
    /** Phase 6: async episode-review runner (dry = validateOnly); gating lives in the delegate */
    episodeReview?: (dry: boolean) => Promise<unknown>;
  },
): (() => void) | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commands = (ctx as any).get?.("commands");
  if (!commands) return null;
  return commands.register({
    name: "memory",
    description: "Manage the dsh-self-improved memory store (search/list/forget/correct/status/episodes/evolve)",
    // Key: the command system only takes over parameterized input (e.g. /memory status) after input is declared;
    // otherwise parameterized input is treated as "the command does not accept arguments" and falls back to a plain message sent to the LLM.
    input: { hint: "search <term> | list | status | baseline | pin <id> [slot] | unpin <slot> | accept-legacy [id] | forget <id> | correct <id> <content> | episodes | episode <id> | episode-purge [days|all] | episode-review [--dry] | evolve | browser" },
    handler: async (invocation: { rawInput?: string }) => {
      // Fallback: even if unregistration has a timing window, refuse to execute while the plugin is disabled
      if (opts?.isEnabled && !opts.isEnabled()) {
        return { kind: "error" as const, text: "Plugin is disabled (dsh-self-improved enabled=false); the /memory command is unavailable" };
      }
      const sub = (invocation.rawInput ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "episode-review") {
        if (!opts?.episodeReview) return { kind: "error" as const, text: "Episode review is not installed (episodeLearning disabled or scheduled runs only)" };
        const dry = (invocation.rawInput ?? "").includes("--dry");
        try {
          const summary = (await opts.episodeReview(dry)) as Record<string, unknown>;
          const parts = Object.entries(summary)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${String(v)}`);
          return { kind: "success" as const, text: `Episode review ${dry ? "(dry-run) " : ""}done: ${parts.join(", ") || "no episodes considered"}` };
        } catch (e) {
          return { kind: "error" as const, text: `Episode review failed: ${String(e instanceof Error ? e.message : e)}` };
        }
      }
      return handleMemoryCommand(store, invocation.rawInput ?? "", opts);
    },
  });
}

/**
 * Memory browser data channel (host half of the settings-page "Memory" tab).
 * Dedicated namespace `dsh-self-improved-browser`: `snapshot` = snapshot JSON,
 * `action` = operation submitted by the frontend, `detail` = on-demand full row.
 *
 * Trust model for the mutating ops (forget/correct/confirm-correct/deleteSkill):
 * 3-step one-shot challenge handshake (see ActionChallengeLedger) — arriving
 * snapshot tokens authenticate that the submitter is observing a FRESH served
 * snapshot, but the executing credential is a short-TTL challenge bound to the
 * exact op + arguments, consumed atomically before execution, so captured
 * payloads cannot be replayed for arbitrary actions.
 *
 * Extracted from index.ts so the real handler is integration-testable (fake
 * settings scope + store) without booting the whole plugin.
 */
export interface BrowserChannelOptions {
  ctx: Context;
  store: MemoryStore;
  /** Live getter: applies hot-changed synthesis prefixes (no re-registration needed) */
  skillsPrefix: () => string;
  /** Destructive-op delegate so tests can slice the filesystem and prefix away */
  deleteSkill?: (name: string, skillsRoot: string, prefix: string) => boolean;
  /** Live getters for per-op settings, so tests can drive both halves */
  skillsRoot?: () => string;
  /** Phase 6: recent-episode rows are served only while episode learning is enabled */
  episodeEnabled?: () => boolean;
  /** Phase 6: dry-review runner (publishes the summary itself via episodeStatus). Returning null = unavailable. */
  episodeDryReview?: (() => Promise<unknown> | null) | null;
  /** Destructive-op delegate so tests can slice purge away from the real store */
  purgeEpisodes?: (scope: string) => unknown;
  log?: (...args: unknown[]) => void;
  /** 0 = no refresh timer (integration tests drive refresh() manually) */
  refreshIntervalMs?: number;
  /** Injectable trackers (tests; production uses per-plugin random secrets) */
  tracker?: SnapshotTokenTracker;
  ledger?: ActionChallengeLedger;
}

export interface BrowserChannel {
  refresh(): void;
  /** Process one raw `action` payload string submitted through the namespace */
  handle(raw: string): void;
  stop(): void;
  /** Publish a one-line status (e.g. a dry-review summary JSON) into the served snapshot */
  episodeStatus(json: string): void;
}

export function installBrowserChannel(opts: BrowserChannelOptions): BrowserChannel {
  const log = opts.log ?? (() => {});
  const browserNs = settingsNamespace("dsh-self-improved-browser");
  const BrowserSchema = z.object({
    snapshot: z.string().default("{}"),
    action: z.string().default(""),
    detail: z.string().default(""),
    // Phase 6: on-demand redacted episode detail (JSON) + last dry-review summary line
    episodeDetail: z.string().default(""),
    episodeStatus: z.string().default(""),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const browserScope = opts.ctx.settings.register(browserNs, BrowserSchema);
  const tracker = opts.tracker ?? new SnapshotTokenTracker(randomBytes(32).toString("hex"));
  const ledger = opts.ledger ?? new ActionChallengeLedger(randomBytes(32).toString("hex"));
  let lastSnapshotJson = "";
  let lastHandledAction = "";

  const extractArgs = (raw: string | undefined): BrowserActionArgs | null => {
    if (typeof raw !== "string") return null;
    let action: Record<string, unknown>;
    try {
      action = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (typeof action.op !== "string") return null;
    const args: BrowserActionArgs = { op: action.op };
    if (typeof action.id === "string") args.id = action.id;
    if (typeof action.content === "string") args.content = action.content;
    if (typeof action.name === "string") args.name = action.name;
    if (typeof action.newId === "string") args.newId = action.newId;
    return args;
  };

  const refresh = (): void => {
    try {
      const snap = browserSnapshot(opts.store, opts.skillsPrefix(), opts.skillsRoot?.() ?? "", opts.episodeEnabled?.() === true);
      // Sign stable business content only: the volatile updatedAt wall-clock
      // stamp must not make every refresh look changed (that minted a fresh
      // token per tick, so the unchanged branch was dead code and a still-served
      // token could be evicted past the documented sliding TTL).
      const { token, changed } = tracker.sign(snap);
      // Re-note on every tick: unchanged content keeps its token while the TTL
      // window slides forward (signature is HMAC-over-content, so re-noting
      // cannot forge anything).
      tracker.note(token);
      const pendingChip = ledger.peek();
      const confirmPayload = pendingChip
        ? { token: pendingChip.token, fp: pendingChip.fp, args: { ...pendingChip.args }, op: pendingChip.args.op }
        : null;
      // Rebuild when content changed, on first serve, or when a pending
      // challenge must be (de)published through the readable snapshot.
      if (changed || !lastSnapshotJson || confirmPayload || lastSnapshotJson.includes('"confirm"')) {
        let json = JSON.stringify({ ...snap, actionToken: token });
        if (confirmPayload) {
          // eslint-disable-next-line no-useless-escape
          const obj = JSON.parse(json) as Record<string, unknown>;
          obj.confirm = confirmPayload;
          json = JSON.stringify(obj);
        }
        lastSnapshotJson = json;
        writeScope({ snapshot: lastSnapshotJson });
      }
    } catch {
      /* noop */
    }
  };

  /**
   * Single writer for the browser namespace. `settings.replace` resets absent
   * keys to defaults, so EVERY replace must restate the full field set —
   * historically the bare replaces dropped `detail` on the next refresh tick
   * (a served detail modal self-closed within a minute). Explicit passthrough
   * of untouched fields fixes that and keeps the new Phase 6 fields intact.
   */
  const writeScope = (partial: Record<string, string>): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur = (browserScope.get() ?? {}) as any;
    browserScope
      .replace({
        snapshot: partial.snapshot !== undefined ? partial.snapshot : lastSnapshotJson,
        action: partial.action !== undefined ? partial.action : String(cur.action ?? ""),
        detail: partial.detail !== undefined ? partial.detail : String(cur.detail ?? ""),
        episodeDetail: partial.episodeDetail !== undefined ? partial.episodeDetail : String(cur.episodeDetail ?? ""),
        episodeStatus: partial.episodeStatus !== undefined ? partial.episodeStatus : String(cur.episodeStatus ?? ""),
      })
      .catch(() => { /* best effort */ });
  };

  const handle = (raw: string): void => {
    if (!raw || typeof raw !== "string" || raw === lastHandledAction) return;
    lastHandledAction = raw;
    try {
      const args = extractArgs(raw);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = (args ? JSON.parse(raw) : {}) as any;
      if (!args) {
        log("browser action rejected: malformed action payload");
        writeScope({ snapshot: lastSnapshotJson, action: "" });
        return;
      }
      // Mutating ops: the two-step one-shot challenge handshake.
      if (MUTATING_BROWSER_OPS.has(args.op)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const submitted = typeof action.confirmToken === "string" ? action.confirmToken : "";
        if (!submitted) {
          // Step 1 (prepare): gate on a fresh snapshot token the client echoes from the served snapshot.
          const token = typeof action.token === "string" ? action.token : "";
          if (!token || !tracker.verify(token)) {
            log("browser action rejected: missing, stale or replayed action token");
            writeScope({ snapshot: lastSnapshotJson, action: "" });
            return;
          }
          ledger.prepare(args);
          lastSnapshotJson = ""; // force re-serve with the confirm chip
          refresh();
          writeScope({ snapshot: lastSnapshotJson, action: "" });
          log("browser action staged, awaiting confirm:", args.op);
          return; // do not execute yet
        }
        // Step 2 (confirm): consume the pending challenge atomically.
        if (!ledger.consume(args, submitted)) {
          log("browser action rejected: challenge missing, stale, replayed or args mismatch");
          // Drop any published (now stale) confirm chip so the namespace never advertises a credential that no longer exists.
          lastSnapshotJson = "";
          refresh();
          writeScope({ snapshot: lastSnapshotJson, action: "" });
          return;
        }
        // fall through to execution with the args verified against the fingerprint
      }
      // Detail: return the full memory on demand (content is truncated in the snapshot)
      if (args.op === "detail" && typeof args.id === "string") {
        const m = opts.store.getMemory(args.id);
        if (m) writeScope({ snapshot: lastSnapshotJson, action: "", detail: JSON.stringify(m) });
        return; // detail does not need a snapshot refresh
      }
      // Phase 6: episode evidence inspector (read-only; rows are already stored redacted).
      // Served only while episode learning is enabled, with per-field display caps.
      if (args.op === "episodeDetail" && typeof args.id === "string") {
        if (opts.episodeEnabled?.() !== true) {
          log("browser action ignored: episodeDetail requires episodeLearning.enabled");
          return;
        }
        const ep = opts.store.getEpisode(args.id);
        if (!ep) return;
        const steps = opts.store
          .getEpisodeSteps(args.id)
          .slice(0, MAX_EPISODE_INSPECT_STEPS)
          .map((s) => ({
            ordinal: s.ordinal,
            callId: s.callId,
            toolName: s.toolName,
            argumentsRedacted: s.argumentsRedacted.slice(0, 800),
            resultExcerpt: s.resultExcerpt.slice(0, 800),
            isError: s.isError,
            errorName: s.errorName,
            errorCode: s.errorCode,
            argsTruncated: s.argsTruncated,
            resultTruncated: s.resultTruncated,
          }));
        writeScope({
          snapshot: lastSnapshotJson,
          action: "",
          episodeDetail: JSON.stringify({
            id: ep.id,
            sessionId: ep.sessionId,
            projectId: ep.projectId,
            turn: ep.turn,
            status: ep.status,
            delegated: ep.delegated,
            startedAt: ep.startedAt,
            endedAt: ep.endedAt,
            updatedAt: ep.updatedAt,
            summary: ep.summary,
            confidence: ep.confidence,
            fingerprint: ep.fingerprint,
            rejectReason: ep.rejectReason,
            steps,
          }),
        });
        return;
      }
      // Only re-served, freshly signed tokens count for the echo gate; execute with the SAME args that were fingerprinted.
      if (MUTATING_BROWSER_OPS.has(args.op)) {
        if (args.op === "forget" && typeof args.id === "string") {
          opts.store.forgetMemory(args.id);
          log("browser action: forget", args.id.slice(0, 8));
        } else if (args.op === "correct" && typeof args.id === "string" && typeof args.content === "string") {
          const old = opts.store.getMemory(args.id);
          if (old) {
            opts.store.insertMemory(
              { kind: old.kind, content: args.content, importance: old.importance, supersedes: old.id },
              {
                provenance: "user",
                source: "browser-correct",
                scope: old.meta?.scope ?? "global",
                projectId: old.meta?.projectId ?? null,
                sessionId: old.meta?.sessionId ?? null,
                confidence: 0.9,
              },
            );
            opts.store.setMemoryStatus(old.id, "corrected");
            log("browser action: correct", args.id.slice(0, 8));
          }
        } else if (args.op === "confirm-correct" && typeof args.newId === "string") {
          const candidate = opts.store.getMemory(args.newId);
          if (candidate?.supersedes) {
            opts.store.updateMeta(candidate.id, { provenance: "user", source: "browser-correct", confidence: 0.9 });
            opts.store.setMemoryStatus(candidate.supersedes, "corrected");
            log("browser action: confirm-correct", candidate.id.slice(0, 8));
          }
        } else if (args.op === "deleteSkill" && typeof args.name === "string") {
          const removed = opts.deleteSkill
            ? opts.deleteSkill(args.name, opts.skillsRoot?.() ?? "", opts.skillsPrefix())
            : deleteSkill(args.name, opts.skillsRoot?.() ?? "", opts.skillsPrefix());
          if (removed) log("browser action: deleteSkill", args.name);
        } else if (args.op === "purgeEpisodes" && typeof args.id === "string") {
          // id carries the purge scope: "all" | "<days>" — fingerprint-bound like any other op.
          // "all" maps to a FUTURE cutoff: purgeEpisodes treats "no filters" as
          // delete-nothing (it has no unfiltered-universe semantics), so an
          // explicit future olderThanTs is the only safe way to purge everything.
          const scope = args.id;
          if (scope !== "all" && !/^\d+$/.test(scope)) {
            log("browser action ignored: invalid purgeEpisodes scope", scope.slice(0, 20));
          } else {
            const res = opts.purgeEpisodes
              ? opts.purgeEpisodes(scope)
              : opts.store.purgeEpisodes(
                  scope === "all"
                    ? { olderThanTs: Date.now() + 60_000 }
                    : { olderThanTs: Date.now() - Number(scope) * 86_400_000 },
                );
            log("browser action: purgeEpisodes", scope, JSON.stringify(res));
          }
        } else if (args.op === "dryReview") {
          // Dry-run review persists nothing (validateOnly commit); the resolved
          // summary is published through episodeStatus. Absent delegate = disabled.
          const dry = opts.episodeDryReview?.();
          if (!dry) log("browser action ignored: episode review unavailable (disabled)");
          else
            void Promise.resolve(dry)
              .then((s) => {
                episodeStatus(JSON.stringify(s ?? {}));
              })
              .catch((e) => {
                log("browser dryReview error:", String(e));
              });
        } else {
          // shape mismatch reached execution: the fingerprinted args never mapped to a full op
          log("browser action ignored: invalid arguments for", args.op);
        }
      }
    } catch {
      /* noop */
    }
    lastSnapshotJson = ""; // force a refresh on the next round
    refresh();
    writeScope({ snapshot: lastSnapshotJson, action: "" });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  browserScope.watch((next: any) => {
    if (next.action) handle(next.action);
  });
  refresh();
  let timer: ReturnType<typeof setInterval> | null = null;
  const refreshIntervalMs = opts.refreshIntervalMs ?? 60_000;
  if (refreshIntervalMs > 0) {
    timer = setInterval(refresh, refreshIntervalMs);
    timer.unref?.();
  }
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const episodeStatus = (json: string): void => {
    writeScope({ episodeStatus: typeof json === "string" ? json.slice(0, 2000) : "" });
  };
  return { refresh, handle, stop, episodeStatus };
}
