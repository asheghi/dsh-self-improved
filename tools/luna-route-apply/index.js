import { writeFileSync } from 'node:fs';
import { withLunaResponsesRoute } from '../luna-route-fix/index.js';
export const name = 'luna-route-apply';
export const inject = ['configEditor'];
const path = '/home/bahman/github/dsh-self-improved/fixtures/luna-route-apply-status.json';
const report = value => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export function apply(ctx) {
  report({ phase: 'waiting-for-normal-agent-step' });
  let repair;
  const drop = ctx.on('agent/pre-step', async (_payload, next) => {
    // Run from ordinary Agent dispatch, never from the installer HMR context.
    repair ??= (async () => {
      try {
        const editor = ctx.get('configEditor');
        const entries = editor.entries().filter(entry => entry.options.id === 'llm-pi-ai');
        if (entries.length !== 1) throw new Error('Expected one llm-pi-ai configuration entry');
        await editor.edit(entries[0], current => withLunaResponsesRoute(current));
        report({ phase: 'configured', provider: 'go-opencode-responses', model: 'gpt-5.6-luna' });
      } catch (error) { report({ phase: 'failed', name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 800) }); }
      finally { drop(); }
    })();
    await repair;
    return next();
  });
}
