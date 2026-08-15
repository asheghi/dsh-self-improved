/**
 * CLI/文本命令（M5）：/memory 命令组（search / list / forget / correct / status）。
 * 处理器为纯函数，便于单元测试；installMemoryCommands 仅在宿主提供 commands 服务时注册。
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

/** 记忆命令处理器（纯函数）。末尾带 `--json` 时 text 输出 JSON（供设置页记忆浏览器解析） */
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
      if (!opts?.evolve) return err("进化功能未安装（仅定时运行）");
      const p = opts.evolve();
      if (json) return ok(JSON.stringify({ kind: "success", text: "进化已触发", value: {} }));
      return ok("进化已触发，后台执行中（巩固/衰减/技能/治理）…");
    }
    case "search": {
      const q = args.slice(1).join(" ");
      if (!q) return err("用法：/memory search <关键词>");
      const hits = store.searchMemories(q, { limit: 8, matchAny: true });
      return hits.length > 0
        ? ok(hits.map((h, i) => `${i + 1}. [${h.kind}] ${h.content}`).join("\n"))
        : ok("没有相关记忆");
    }
    case "list": {
      const recs = store.listMemories({ limit: 20 });
      return recs.length > 0
        ? ok(recs.map((r) => `[${r.status}] ${r.kind} ${r.content}`).join("\n"))
        : ok("记忆库为空");
    }
    case "forget": {
      const id = args[1];
      if (!id) return err("用法：/memory forget <id>");
      return ok(store.forgetMemory(id) ? `已遗忘 ${id}` : `未找到 ${id}`);
    }
    case "correct": {
      const id = args[1];
      const content = args.slice(2).join(" ");
      if (!id || !content) return err("用法：/memory correct <id> <新内容>");
      const old = store.getMemory(id);
      if (!old) return err(`未找到 ${id}`);
      const rec = store.insertMemory({ kind: old.kind, content, importance: old.importance, supersedes: old.id });
      store.setMemoryStatus(id, "corrected");
      return ok(`已纠正，新 id: ${rec.id}`);
    }
    case "status": {
      const active = store.getActiveMemories(10_000).length;
      const total = store.listMemories({ limit: 10_000 }).length;
      const pending = store.pendingSessions().length;
      const scenes = store.listScenes(100).length;
      const persona = store.getPersona();
      return ok(
        `记忆 ${active} 活跃 / ${total} 总计；待提取会话 ${pending}；场景 ${scenes}；画像 v${persona?.ver ?? "-"}`,
      );
    }
    default:
      return ok(
        "dsh-self-improved 记忆命令：\n" +
          "/memory search <关键词>\n" +
          "/memory list\n" +
          "/memory browser --json\n" +
          "/memory forget <id>\n" +
          "/memory correct <id> <新内容>\n" +
          "/memory status",
      );
  }
}

/** 记忆浏览器快照（设置页前端用；content 截断 + 数量上限控制体积） */
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

/** 列出技能仓库中的技能（名称 + 描述 + 适用场景 + 是否插件合成） */
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

/** 注册 /memory 命令（仅当宿主存在 commands 服务时；可选能力，不阻塞插件）。
 *  返回 register 的 disposer（调用即注销），供插件跟随总开关热切换注册/注销。 */
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
    description: "管理 dsh-self-improved 记忆库（search/list/forget/correct/status/evolve）",
    // 关键：声明 input 后命令系统才会接管带参输入（如 /memory status），
    // 否则带参输入被判定为"命令不接受参数"而回落为普通消息发给 LLM。
    input: { hint: "search <词> | list | status | forget <id> | correct <id> <内容> | evolve | browser" },
    handler: async (invocation: { rawInput?: string }) => {
      // 兜底：即使注销存在时序窗口，关闭状态下也拒绝执行
      if (opts?.isEnabled && !opts.isEnabled()) {
        return { kind: "error" as const, text: "插件已关闭（dsh-self-improved enabled=false），/memory 命令不可用" };
      }
      return handleMemoryCommand(store, invocation.rawInput ?? "", opts);
    },
  });
}
