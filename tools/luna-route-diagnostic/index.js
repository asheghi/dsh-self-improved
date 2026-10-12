import { writeFileSync } from 'node:fs';
import { withLunaResponsesRoute } from '../luna-route-fix/index.js';
export const name = 'luna-route-diagnostic';
export const inject = ['configEditor'];
const reportPath = '/home/bahman/github/dsh-self-improved/fixtures/luna-route-fix-status.json';
function report(value) { writeFileSync(reportPath, JSON.stringify(value, null, 2) + '\n'); }
export function apply(ctx) {
  report({ phase: 'mounted' });
  ctx.effect(() => {
    report({ phase: 'scheduled' });
    const timer = setTimeout(() => {
      try {
        const editor = ctx.get('configEditor');
        if (!editor) throw new Error('configEditor lookup unavailable');
        const entries = editor.entries().filter(entry => entry.options.id === 'llm-pi-ai');
        report({ phase: 'entry-lookup', count: entries.length });
        if (entries.length !== 1) throw new Error('Expected one llm-pi-ai configuration entry');
        void editor.edit(entries[0], current => {
          report({ phase: 'edit-callback', keys: Object.keys(current), providerKeys: Object.keys(current.providers ?? {}) });
          return withLunaResponsesRoute(current);
        }).then(() => report({ phase: 'configured' }), error => report({ phase: 'failed', name: error.name, code: error.code ?? null,
          message: String(error.message).replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]').slice(0, 1600) }));
      } catch (error) { report({ phase: 'failed-before-edit', name: error.name, message: String(error.message).slice(0, 400) }); }
    }, 1000);
    return () => clearTimeout(timer);
  });
}
