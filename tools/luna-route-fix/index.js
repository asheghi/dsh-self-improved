import { isDeepStrictEqual } from 'node:util';

export const name = 'luna-route-protocol-fix';
export const inject = ['configEditor'];
const ROUTE = 'go-opencode-responses';
const MODEL = 'gpt-5.6-luna';

/** Preserve the complete live raw config; add only one dedicated route. */
export function withLunaResponsesRoute(current) {
  const providers = current?.providers;
  const source = providers?.['go-opencode'];
  if (!source || source.api !== 'openai-completions' || source.baseURL !== 'https://opencode.ai/zen/go/v1') {
    throw new Error('Luna fix refused: source route no longer matches the reviewed configuration');
  }
  const models = source.models?.filter(model => model.id === MODEL);
  if (!models || models.length !== 1) throw new Error('Luna fix refused: expected exactly one configured Luna model');
  const route = { ...structuredClone(source), api: 'openai-responses', models: structuredClone(models) };
  if (providers[ROUTE]) {
    if (!isDeepStrictEqual(providers[ROUTE], route)) throw new Error('Luna fix refused: destination route already has different configuration');
    return current;
  }
  return { ...current, providers: { ...providers, [ROUTE]: route } };
}

export function apply(ctx) {
  // Defer until the bundle-manager installation/reconciliation lock is released.
  // The effect owns the pending timer. Existing exact configuration is inert.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      const editor = ctx.configEditor;
      const candidates = editor.entries().filter(entry => entry.options.id === 'llm-pi-ai'
        && entry.options.name === '@deepseek-ai/dsh-llm-pi-ai');
      if (candidates.length !== 1) {
        ctx.logger.error('Luna fix refused: provider configuration entry is unavailable or ambiguous');
        return;
      }
      void editor.edit(candidates[0], current => withLunaResponsesRoute(current)).then(
        () => ctx.logger.info('Luna Responses route configured; all existing provider routes preserved'),
        () => ctx.logger.error('Luna Responses route configuration failed; inspect provider settings before retrying'),
      );
    }, 1000);
    return () => clearTimeout(timer);
  });
}
