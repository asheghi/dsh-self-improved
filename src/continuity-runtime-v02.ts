import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import type * as Zod from "zod";
import type { ContinuityStoreV02 } from "./continuity-store-v02.js";
import { ContinuityOwnerV02 } from "./continuity-owner-v02.js";

/** Domain job trigger OUTSIDE the pure structural fold. Effect-owned native
 * post-commit turn/end only; no fabricated event or second projection drive.
 * Default session admission denies. Main runtime must supply its CURRENT
 * master/capture/exclusion/consent predicates, not capability-presence proof.
 */
export function mountContinuityRuntime(
  ctx: Context, lane: ContinuityStoreV02, registry: SessionProjectionRegistry,
  z: typeof Zod, query: Pick<SessionQueryEngine, "observeSession">,
  admitted: (session: Session) => boolean = () => false,
  track: (task: Promise<void>) => void = () => {},
): { sync(enabled: boolean): void; flush(): Promise<void>; dispose(): void; failures(): number } {
  let enabled = false, disposed = false, failures = 0;
  let owner: ContinuityOwnerV02 | undefined;
  const pending = new Set<Promise<void>>();
  const remove = ctx.on("session/event", (session, event) => {
    if (!enabled || disposed || event.type !== "turn/end" || event.seq < session.inheritedEventCount) return;
    const current = owner;
    if (!current) return;
    // Observer failures never change a committed native append. Diagnostics
    // deliberately expose only a counter, never raw source/error text.
    let task: Promise<void>;
    task = current.capture(session, "turn-end").then(() => {}, () => { failures++; }).finally(() => pending.delete(task));
    pending.add(task);
    // Main shutdown must retain EVERY accepted capture, not only a later
    // flush snapshot. This task includes the owner's lease-disposal finally.
    track(task);
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; enabled = false; owner?.dispose(); owner = undefined; remove();
    // Unload preserves already committed progress for reconstruction. Privacy
    // pause is different and must invoke sync(false) BEFORE store close.
  };
  ctx.effect(() => dispose);
  return {
    sync(next) {
      if (disposed) return;
      if (!next) {
        enabled = false; owner?.dispose(); owner = undefined;
        lane.denyAll(); return;
      }
      if (enabled) return;
      owner = new ContinuityOwnerV02(lane, registry, z, query, admitted);
      enabled = true;
    },
    async flush() { await Promise.all([...pending]); },
    dispose,
    failures: () => failures,
  };
}
