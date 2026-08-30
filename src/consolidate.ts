/**
 * Consolidation module (M4): L2 scene consolidation + L3 user persona synthesis (LLM-driven, versioned personas).
 *
 * - Scenes: high-importance memories are batched to the LLM and consolidated into scene blocks (title + Markdown), with source memory ids kept for traceability;
 * - Persona: based on top memories + the previous persona version, the LLM synthesizes incrementally, writing to the persona_versions table + persona.md (with rolling backups).
 */
import { randomUUID } from "node:crypto";
import type { MemoryStore } from "./storage.js";
import type { EmbeddingProvider } from "./recall.js";

export interface ConsolidateSettings {
  /** Max number of memories participating in scene consolidation */
  sceneMaxMemories: number;
  /** Max number of memories participating in persona synthesis */
  personaMaxMemories: number;
  /** Max memories per scene */
  sceneBatchSize: number;
}

export interface ConsolidateCallLlm {
  (input: { system: string; user: string; signal: AbortSignal }): Promise<string>;
}

export interface ConsolidateResult {
  scenes: number;
  personaVersion?: number;
}

export const SCENE_SYSTEM_PROMPT = `You are a memory organizer. Consolidate the given atomic memories into "scene blocks" (Scenes): each scene is a short section about a related past experience, with a brief title (4-12 words) and a 3-6 line Markdown summary as the body.
Output only one JSON object: {"scenes":[{"title":"title","summary":"body Markdown"}]}, with no other text.`;

export const PERSONA_SYSTEM_PROMPT = `You are a user persona analyst. Based on user-related memories in the memory store, maintain a concise user persona (Markdown):
- Structure: ## Basic Info / ## Preferences & Habits / ## Working Style / ## Known Conventions
- Only write content backed by evidence, tagging the source kind (fact/preference); leave a section empty when there is nothing for it.
- Output plain Markdown text only — no JSON, no explanations.`;

export class Consolidator {
  constructor(
    private readonly store: MemoryStore,
    private readonly settings: ConsolidateSettings,
    private readonly callLlm: ConsolidateCallLlm,
    private readonly embedding: EmbeddingProvider | null = null,
  ) {}

  /** Consolidates scenes + synthesizes the persona (each step fails independently without affecting the other) */
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

  /** L2: consolidate memories into scene blocks in batches */
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
      const signal = AbortSignal.timeout(180_000);
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

  /** L3: synthesize a new persona from top memories + the previous persona version */
  private async synthesizePersona(): Promise<number | undefined> {
    const memories = this.store.getActiveMemories(this.settings.personaMaxMemories);
    if (memories.length === 0) return undefined;
    const prev = this.store.getPersona();
    const input = [
      prev ? `## Previous persona (for incremental reference)\n${prev.content}\n` : "",
      "## New memories\n" + memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n"),
    ].join("\n");
    const signal = AbortSignal.timeout(180_000);
    const content = (await this.callLlm({ system: PERSONA_SYSTEM_PROMPT, user: input, signal })).trim();
    if (!content) {
      console.warn("[dsh-self-improved] persona synthesis returned empty output");
      return undefined;
    }
    const ver = this.store.savePersona(content);
    // Persona vector (lets recall retrieve the persona section; failure is non-blocking)
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

/** Parses scene JSON (tolerates code fences/noise) */
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
