import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { previewConfig, previewEnvironment, checkPreviewPort } from './preview.mjs';

// Copied into the recovered app only. It does not need the encrypted bundle or
// a copy of the current production repository to restart the local test server.
try {
  const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
  const meta=JSON.parse(await readFile(path.join(dir,'RESTORE_PREVIEW.json'),'utf8'));
  const values=Object.fromEntries((await readFile(path.join(dir,'.env.local'),'utf8')).split(/\r?\n/).filter(Boolean).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
  const config=previewConfig({projectRef:meta.sourceProject},values.NEXT_PUBLIC_SUPABASE_URL,values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  const allowed=['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','APP_URL','NEXT_TELEMETRY_DISABLED'];
  if(meta.previewUrl!=='http://127.0.0.1:3001'||config.ref!==meta.testProject||values.APP_URL!==meta.previewUrl||Object.keys(values).some(k=>!allowed.includes(k))||(await readdir(dir)).some(n=>/^\.env(?:\.|$)/.test(n)&&n!=='.env.local')) throw new Error('The restore-test configuration has changed. Prepare a new preview.');
  const env=previewEnvironment(config);
  await checkPreviewPort();
  console.log('RESTORE TEST ONLY - open http://127.0.0.1:3001. Ctrl+C stops this server.');
  const child=spawn(process.execPath,[path.join(dir,'node_modules','next','dist','bin','next'),'dev','--hostname','127.0.0.1','--port','3001'],{cwd:dir,env,stdio:'inherit',windowsHide:true});
  child.once('error',()=>{console.error('Could not start Next.js. Run npm ci inside this test folder.');process.exitCode=1;});
  child.once('close',code=>{process.exitCode=code===130||code===null?0:code;});
}catch(error){console.error(error instanceof Error?error.message:'Could not start the test preview.');process.exitCode=1;}
