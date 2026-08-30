/**
 * CLI/text commands (M5): the /memory command group (search / list / forget / correct / status).
 * Handlers are pure functions for easy unit testing; installMemoryCommands registers only when the host provides a commands service.
 */
import type { Context } from "@deepseek-ai/cordis";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSkillsDir } from "./evolve.js";
import type { MemoryStore } from "./storage.js";

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

/** Memory command handler (pure function). When the input ends with `--json`, text outputs JSON (parsed by the settings-page memory browser) */
export function handleMemoryCommand(
  store: MemoryStore,
  rawInput: string,
  opts?: { evolve?: () => Promise<Record<string, unknown>> },
): CommandOutcome {
  const args = rawInput.trim().split(/\s+/).filter(Boolean);
  const json = args.includes("--json");
  const sub = (args[0] ?? "help").toLowerCase();
  if (json && sub === "browser") {
    return ok(JSON.stringify(browserSnapshot(store)));
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
      const rec = store.insertMemory({ kind: old.kind, content, importance: old.importance, supersedes: old.id });
      store.setMemoryStatus(id, "corrected");
      return ok(`Corrected, new id: ${rec.id}`);
    }
    case "status": {
      const active = store.getActiveMemories(10_000).length;
      const total = store.listMemories({ limit: 10_000 }).length;
      const pending = store.pendingSessions().length;
      const scenes = store.listScenes(100).length;
      const persona = store.getPersona();
      return ok(
        `Memories: ${active} active / ${total} total; pending extraction sessions: ${pending}; scenes: ${scenes}; persona v${persona?.ver ?? "-"}`,
      );
    }
    default:
      return ok(
        "dsh-self-improved memory commands:\n" +
          "/memory search <keyword>\n" +
          "/memory list\n" +
          "/memory browser --json\n" +
          "/memory forget <id>\n" +
          "/memory correct <id> <new content>\n" +
          "/memory status",
      );
  }
}

/** Memory browser snapshot (for the settings-page frontend; content truncation + count caps keep the payload small) */
export function browserSnapshot(store: MemoryStore): Record<string, unknown> {
  const memories = store.listMemories({ limit: 300 }).map((m) => ({
    id: m.id,
    kind: m.kind,
    content: m.content.slice(0, 120),
    importance: m.importance,
    accessCount: m.accessCount,
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    supersedes: m.supersedes ?? null,
  }));
  const scenes = store.listScenes(50).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
  const persona = store.getPersona();
  return {
    memories,
    scenes,
    persona: persona ? { ver: persona.ver, content: persona.content.slice(0, 500), createdAt: persona.createdAt } : null,
    skills: listSkills(),
    pending: store.pendingSessions().length,
    updatedAt: Date.now(),
  };
}

/** List the skills in the skill repository (name + description + when to use + whether plugin-synthesized) */
export function listSkills(limit = 100): Array<{
  name: string;
  description: string;
  whenToUse: string;
  excerpt: string;
  synthesized: boolean;
}> {
  const root = defaultSkillsDir();
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
      synthesized: name.startsWith("dsi-"),
    });
  }
  return out;
}

/** Registers the /memory command (only when the host provides a commands service; optional capability, never blocks the plugin).
 *  Returns the disposer of register (call it to unregister), so the plugin can hot-toggle registration alongside its master switch. */
export function installMemoryCommands(
  ctx: Context,
  store: MemoryStore,
  opts?: { evolve?: () => Promise<Record<string, unknown>>; isEnabled?: () => boolean },
): (() => void) | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commands = (ctx as any).get?.("commands");
  if (!commands) return null;
  return commands.register({
    name: "memory",
    description: "Manage the dsh-self-improved memory store (search/list/forget/correct/status/evolve)",
    // Key: the command system only takes over parameterized input (e.g. /memory status) after input is declared;
    // otherwise parameterized input is treated as "the command does not accept arguments" and falls back to a plain message sent to the LLM.
    input: { hint: "search <term> | list | status | forget <id> | correct <id> <content> | evolve | browser" },
    handler: async (invocation: { rawInput?: string }) => {
      // Fallback: even if unregistration has a timing window, refuse to execute while the plugin is disabled
      if (opts?.isEnabled && !opts.isEnabled()) {
        return { kind: "error" as const, text: "Plugin is disabled (dsh-self-improved enabled=false); the /memory command is unavailable" };
      }
      return handleMemoryCommand(store, invocation.rawInput ?? "", opts);
    },
  });
}
