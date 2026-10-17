/** Read-only exact compiled boundary fingerprints, never credentials. */
import { readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tree,sha256 } from './learned-procedure-cases.mjs';
const packages=['dsh-api-session-controller','dsh-api-remotes','dsh-api-gateway','dsh-client-connection','dsh-host-webserver','dsh-agent','dsh-agent-loop','dsh-session','dsh-llm','dsh-llm-pi-ai','dsh-skill','dsh-tool-skill','dsh-credentials','dsh-credentials-local'];
export async function runtimeFingerprint(root){
 const result={root:resolve(root),packages:{}};
 for(const name of packages){const base=join(result.root,'node_modules/@deepseek-ai',name);result.packages[name]={manifestSha256:sha256(await readFile(join(base,'package.json'))),lib:await tree(join(base,'lib'))};}
 return result;
}
