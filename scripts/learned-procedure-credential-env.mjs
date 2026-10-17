/** Resolve one explicitly configured API-key reference through the supported
 * credentials seam, solely for child environment inheritance. Never print,
 * return to the model, persist, or read/copy/refresh OAuth records.
 */
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
export async function inheritedCredential(runtime, ref, sourceHome) {
 if(!/^[A-Z][A-Z0-9_]*$/.test(ref))throw Error('invalid evaluation credential reference');
 if(process.env[ref])return {[ref]:process.env[ref]};
 if(!sourceHome)throw Error('existing credential home or inherited reference required');
 const {Context}=await import(pathToFileURL(join(resolve(runtime),'node_modules/@deepseek-ai/cordis/lib/index.js')));
 const {default:LocalCredentials}=await import(pathToFileURL(join(resolve(runtime),'node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js')));
 const {credentialRef}=await import(pathToFileURL(join(resolve(runtime),'node_modules/@deepseek-ai/dsh-credentials/lib/index.js')));
 const ctx=new Context();let fiber;
 try {
  fiber=ctx.plugin(LocalCredentials,{dshHome:resolve(sourceHome),watch:false});
  await fiber.await();
  const value=await ctx.credentials.resolve(credentialRef(ref));
  if(!value?.value)throw Error('configured evaluation credential reference is unavailable');
  return {[ref]:value.value};
 } finally {await fiber?.dispose();}
}
