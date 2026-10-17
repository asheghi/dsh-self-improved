// Run the existing scoped Chromium battery against the stock runtime with continuity enabled.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const root = await realpath(resolve('.'));
let text = await readFile('scripts/run-v02-browser.mjs', 'utf8');
const anchor = "const root=resolve(new URL('..',import.meta.url).pathname),temp=";
assert.equal(text.split(anchor).length, 2);
text = text.replace(anchor, `const root=${JSON.stringify(root)},temp=`);
const fixture = "['scripts/test-v02-mounted-ui.mjs','up']";
assert.equal(text.split(fixture).length, 2);
text = text.replace(fixture, "['scripts/run-v02-auth-host.mjs','up']");
const lane = join(root, '.tmp-import-lane', 'auth-host'); await mkdir(lane, { recursive: true });
const file = join(lane, 'browser-auth-host.mjs'); await writeFile(file, text);
const child = spawn(process.execPath, [file], { env: process.env, stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.once('exit', code => { process.exitCode = code ?? 1; });
