/**
 * Phase E activation core — turn ONE reviewed skill draft into a RUNTIME skill
 * contribution, and be able to take it back.
 *
 * Why this shape:
 *
 * - `ctx.skills.register()` returns the exact Cordis effect disposer, so an
 *   activation is reversible by construction and also dies with the plugin
 *   fiber. Nothing is written to a skills root, so a learned skill can never
 *   overwrite user-authored material.
 * - The invocation policy is NOT caller-controlled. Every learned skill is
 *   registered `userInvocable: true, modelInvocable: false`: the operator can
 *   invoke it explicitly, but it never enters a model-facing catalog, so
 *   activation cannot silently change what the agent does on its own. Wider
 *   automation is a later, measured decision.
 * - The body is RENDERED here from structured fields, so the provenance and
 *   "verify before use" header cannot be omitted by a caller, and the total
 *   size stays bounded.
 *
 * This core performs no I/O and holds no durable state: the caller owns
 * persistence and passes in the register function, which keeps the safety
 * properties testable without a live Cordis context.
 */
import { isSkillName } from "@deepseek-ai/dsh-skill";

/** Evaluation version stamped into every activation record and rendered body. */
export const SKILL_EVALUATION_VERSION = "static-eval-1";

export interface SkillActivationRequest {
  /** Durable draft identity this activation came from. */
  draftId: string;
  /** Kebab-case skill name (the public skill-name grammar). */
  name: string;
  description: string;
  whenToUse?: string;
  /** Ordered procedure steps from the reviewed draft. */
  steps: readonly string[];
  /** Human-readable evidence citations carried by the draft. */
  citations: readonly string[];
}

export interface SkillActivationRecord {
  draftId: string;
  name: string;
  description: string;
  whenToUse?: string;
  /** The policy this module FORCES; recorded so the store cannot claim otherwise. */
  invocation: { modelInvocable: false; userInvocable: true };
  evaluationVersion: string;
  activatedAt: number;
  contentChars: number;
}

export interface SkillActivationHost {
  /** Real wiring passes `(skill) => ctx.skills.register(skill)`. */
  register(skill: {
    name: string; description: string; whenToUse?: string; content: string;
    source: "runtime"; invocation: { modelInvocable: boolean; userInvocable: boolean };
  }): () => void;
}

const MAX_NAME = 64;
const MAX_DESCRIPTION = 200;
const MAX_WHEN = 280;
const MAX_STEPS = 24;
const MAX_STEP = 400;
const MAX_CITATIONS = 24;
const MAX_CITATION = 200;
const MAX_BODY = 4000;
const FORCED_INVOCATION = Object.freeze({ modelInvocable: false as const, userInvocable: true as const });

/** Read a field only if it is an own, enumerable, plain data property. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}
const text = (value: unknown, max: number, what: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`activation requires a nonblank ${what}`);
  if (value.length > max) throw new Error(`activation ${what} exceeds ${max} characters`);
  if (value.includes("\0")) throw new Error(`activation ${what} contains a NUL`);
  return value;
};
const list = (value: unknown, max: number, itemMax: number, what: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(`activation ${what} must be 1..${max} entries`);
  return value.map((item, index) => {
    const entry = text(item, itemMax, `${what}[${index}]`);
    return entry.replace(/^\s*\d+[.)]\s*/, "").trim();
  });
};

/**
 * Render the skill body. The header is mandatory and generated here: an
 * activated skill must always say where it came from, that it is not
 * permission, and that it has to be verified.
 */
export function renderLearnedSkillBody(request: {
  name: string; steps: readonly string[]; citations: readonly string[]; activatedAt: number;
}): string {
  const iso = new Date(request.activatedAt).toISOString();
  const lines = [
    `# ${request.name}`,
    "",
    "> Learned from reviewed operational evidence and activated by the operator.",
    "> This is a suggestion, not permission, and not proof that anything succeeded.",
    "> Verify the current environment before following it; deactivate it if it stops being true.",
    `> Evidence: ${request.citations.join("; ")}`,
    `> Evaluation: ${SKILL_EVALUATION_VERSION} · Activated: ${iso}`,
    "",
    "## Procedure",
    ...request.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * Owns the live activations. One activation per name; `rollback` is the only
 * way to free a name again, and a failed disposal never reports success.
 */
export class LearnedSkillActivator {
  private readonly active = new Map<string, { record: SkillActivationRecord; dispose: () => void }>();

  constructor(private readonly host: SkillActivationHost, private readonly clock: () => number = Date.now) {}

  activate(request: SkillActivationRequest): SkillActivationRecord {
    const draftId = text(field(request, "draftId"), 256, "draft id");
    const name = text(field(request, "name"), MAX_NAME, "name");
    if (!isSkillName(name)) throw new Error("activation name must be kebab-case (a-z, 0-9, single dashes)");
    const description = text(field(request, "description"), MAX_DESCRIPTION, "description");
    const rawWhen = field(request, "whenToUse");
    const whenToUse = rawWhen === undefined ? undefined : text(rawWhen, MAX_WHEN, "whenToUse");
    const steps = list(field(request, "steps"), MAX_STEPS, MAX_STEP, "steps");
    const citations = list(field(request, "citations"), MAX_CITATIONS, MAX_CITATION, "citations");
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("activation requires a safe clock");
    if (this.active.has(name)) throw new Error(`skill "${name}" is already activated; roll it back first`);

    const content = renderLearnedSkillBody({ name, steps, citations, activatedAt: now });
    if (content.length > MAX_BODY) throw new Error(`activation body exceeds ${MAX_BODY} characters`);

    // The caller cannot influence this: a learned skill is never model-invocable.
    const dispose = this.host.register({
      name, description, ...(whenToUse === undefined ? {} : { whenToUse }), content,
      source: "runtime", invocation: { ...FORCED_INVOCATION },
    });
    if (typeof dispose !== "function") throw new Error("activation host did not return a disposer");

    const record: SkillActivationRecord = Object.freeze({
      draftId, name, description, ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation: { ...FORCED_INVOCATION }, evaluationVersion: SKILL_EVALUATION_VERSION,
      activatedAt: now, contentChars: content.length,
    });
    this.active.set(name, { record, dispose });
    return record;
  }

  /** Dispose the registration. Returns false — and keeps the record — if the
   *  disposal throws, so a caller never believes a rollback that did not happen. */
  rollback(name: string): boolean {
    const entry = this.active.get(name);
    if (!entry) return false;
    try { entry.dispose(); } catch { return false; }
    this.active.delete(name);
    return true;
  }

  list(): SkillActivationRecord[] {
    return [...this.active.values()].map(entry => entry.record);
  }

  get size(): number { return this.active.size; }

  /** Best-effort teardown for the plugin unload path; never throws. */
  dispose(): void {
    for (const name of [...this.active.keys()]) this.rollback(name);
  }
}
