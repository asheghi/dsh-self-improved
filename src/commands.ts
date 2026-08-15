/**
 * CLI/文本命令（M5）：/memory 命令组（search / list / forget / correct / status）。
 * 处理器为纯函数，便于单元测试；installMemoryCommands 仅在宿主提供 commands 服务时注册。
 */
import type { Context } from "@deepseek-ai/cordis";
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

/** 记忆命令处理器（纯函数） */
export function handleMemoryCommand(store: MemoryStore, rawInput: string): CommandOutcome {
  const args = rawInput.trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] ?? "help").toLowerCase();
  switch (sub) {
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
          "/memory forget <id>\n" +
          "/memory correct <id> <新内容>\n" +
          "/memory status",
      );
  }
}

/** 注册 /memory 命令（仅当宿主存在 commands 服务时；可选能力，不阻塞插件） */
export function installMemoryCommands(ctx: Context, store: MemoryStore): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commands = (ctx as any).get?.("commands");
  if (!commands) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).effect(function* () {
    yield async () => {
      /* cleanup 占位：register 返回的 disposer 由 effect 自动管理 */
    };
    yield commands.register({
      name: "memory",
      description: "管理 dsh-self-improved 记忆库（search/list/forget/correct/status）",
      handler: async (invocation: { rawInput?: string }) => handleMemoryCommand(store, invocation.rawInput ?? ""),
    });
  }, "dsh-self-improved commands");
  return true;
}
