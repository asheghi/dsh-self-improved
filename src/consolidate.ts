/**
 * 巩固模块（M4）：L2 场景归纳 + L3 用户画像合成（LLM 驱动，画像版本化）。
 *
 * - 场景：把高重要度记忆分批交给 LLM 归纳为场景块（标题 + Markdown），来源记忆 id 留痕；
 * - 画像：基于 top 记忆 + 上一版画像，LLM 增量合成，写入 persona_versions 表 + persona.md（带滚动备份）。
 */
import { randomUUID } from "node:crypto";
import type { MemoryStore } from "./storage.js";
import type { EmbeddingProvider } from "./recall.js";

export interface ConsolidateSettings {
  /** 参与场景归纳的记忆数上限 */
  sceneMaxMemories: number;
  /** 参与画像合成的记忆数上限 */
  personaMaxMemories: number;
  /** 场景内最大记忆数 */
  sceneBatchSize: number;
}

export interface ConsolidateCallLlm {
  (input: { system: string; user: string; signal: AbortSignal }): Promise<string>;
}

export interface ConsolidateResult {
  scenes: number;
  personaVersion?: number;
}

export const SCENE_SYSTEM_PROMPT = `你是记忆组织者。把给出的原子记忆归纳成"场景块"（Scenes）：每个场景是过去一段相关经历的小节，标题简短（4-12 字），正文 3-6 行 Markdown 总结。
只输出一个 JSON 对象：{"scenes":[{"title":"标题","summary":"正文 Markdown"}]}，不要输出其他文字。`;

export const PERSONA_SYSTEM_PROMPT = `你是用户画像分析师。基于记忆库中的用户相关记忆，维护一份精炼的用户画像（Markdown）：
- 结构：## 基本信息 / ## 偏好与习惯 / ## 工作方式 / ## 已知约定
- 只写有依据的内容，标注来源类型（事实/偏好）；没有的内容留空小节。
- 输出为纯 Markdown 文本，不要 JSON、不要解释。`;

export class Consolidator {
  constructor(
    private readonly store: MemoryStore,
    private readonly settings: ConsolidateSettings,
    private readonly callLlm: ConsolidateCallLlm,
    private readonly embedding: EmbeddingProvider | null = null,
  ) {}

  /** 归纳场景 + 合成画像（内部各自独立失败不影响另一项） */
  async consolidate(): Promise<ConsolidateResult> {
    const result: ConsolidateResult = { scenes: 0 };
    try {
      result.scenes = await this.groupScenes();
    } catch (error) {
      console.warn("[dsh-self-improved] scene grouping failed:", String(error));
    }
    try {
      const ver = await this.synthesizePersona();
      if (ver !== undefined) result.personaVersion = ver;
    } catch (error) {
      console.warn("[dsh-self-improved] persona synthesis failed:", String(error));
    }
    return result;
  }

  /** L2：把记忆分批归纳为场景块 */
  private async groupScenes(): Promise<number> {
    const memories = this.store.getActiveMemories(this.settings.sceneMaxMemories);
    if (memories.length === 0) return 0;
    const batches: typeof memories[] = [];
    for (let i = 0; i < memories.length; i += this.settings.sceneBatchSize) {
      batches.push(memories.slice(i, i + this.settings.sceneBatchSize));
    }
    let count = 0;
    for (const batch of batches) {
      const input = batch.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
      const signal = AbortSignal.timeout(60_000);
      const text = await this.callLlm({ system: SCENE_SYSTEM_PROMPT, user: input, signal });
      const json = parseSceneJson(text);
      if (!json) continue;
      for (const scene of json) {
        if (!scene.title || !scene.summary) continue;
        this.store.saveScene({
          id: randomUUID(),
          title: scene.title,
          markdown: `## ${scene.title}\n\n${scene.summary}`,
          memoryIds: batch.map((m) => m.id),
        });
        count++;
      }
    }
    return count;
  }

  /** L3：基于 top 记忆 + 上一版画像合成新画像 */
  private async synthesizePersona(): Promise<number | undefined> {
    const memories = this.store.getActiveMemories(this.settings.personaMaxMemories);
    if (memories.length === 0) return undefined;
    const prev = this.store.getPersona();
    const input = [
      prev ? `## 上一版画像（供增量参考）\n${prev.content}\n` : "",
      "## 新记忆\n" + memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n"),
    ].join("\n");
    const signal = AbortSignal.timeout(60_000);
    const content = (await this.callLlm({ system: PERSONA_SYSTEM_PROMPT, user: input, signal })).trim();
    if (!content) return undefined;
    const ver = this.store.savePersona(content);
    // 画像向量（供 recall 检索画像段落；失败不阻断）
    if (this.embedding) {
      try {
        const [vec] = await this.embedding.embed([content]);
        if (vec?.length) this.store.upsertEmbedding(`persona:${ver}`, vec);
      } catch {
        /* noop */
      }
    }
    return ver;
  }
}

/** 解析场景 JSON（容忍代码块/杂讯） */
function parseSceneJson(text: string): Array<{ title?: string; summary?: string }> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  let json: unknown = null;
  try {
    json = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        json = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  if (!json || typeof json !== "object" || !Array.isArray((json as { scenes?: unknown }).scenes)) return null;
  return (json as { scenes: unknown[] }).scenes.filter((s) => s && typeof s === "object") as Array<{
    title?: string;
    summary?: string;
  }>;
}
