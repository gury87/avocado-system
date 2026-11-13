import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { command, digest } from '../scripts/backup/lib.mjs';
import { preparePreview, previewConfig } from '../scripts/backup/preview.mjs';

// Real historical UI, synthetic configuration only. Never reads .env.local or
// contacts either live Supabase project; no real credentials are used.
const root=await mkdtemp(path.join(os.tmpdir(),'avocado-preview-smoke-'));
let child,modulesLink;
try {
  const bundle=path.join(root,'bundle'),home=path.join(root,'home');
  await mkdir(bundle);await mkdir(home);
  const archive=path.join(bundle,'source-code.tar');
  await command('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,'archive','--format=tar',`--output=${archive}`,'2303bdd']);
  const manifest={format:1,projectRef:'originalproject',commit:'2303bdd',createdAt:'2026-11-12T19:46:49.892Z',files:[{path:'source-code.tar',bytes:(await stat(archive)).size,sha256:await digest(archive)}]};
  await writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest));
  const config=previewConfig(manifest,'https://restoredproject.supabase.co','sb_publishable_smokeTestOnly');
  const preview=await preparePreview(bundle,config,home);
  modulesLink=path.join(preview.dir,'node_modules');
  await symlink(path.resolve('node_modules'),modulesLink,process.platform==='win32'?'junction':'dir');
  const next=path.resolve('node_modules','next','dist','bin','next');
  console.log('Compiling the isolated historical UI with a synthetic TEST project connection...');
  await new Promise((resolve,reject)=>{
    const build=spawn(process.execPath,[next,'build','--webpack'],{cwd:preview.dir,env:preview.env,stdio:'inherit',windowsHide:true});
    build.once('error',reject);build.once('close',code=>code===0?resolve():reject(new Error(`Isolated preview build failed (${code}).`)));
  });
  let testUrlFound=false;
  async function inspect(dir) {
    for(const file of await readdir(dir,{withFileTypes:true})) {
      if(file.isDirectory())await inspect(path.join(dir,file.name));
      else if(file.name.endsWith('.js')) {
        const text=await readFile(path.join(dir,file.name),'utf8');
        assert.ok(!text.includes('https://originalproject.supabase.co'),'Original URL must not enter a client bundle');
        if(text.includes(config.url))testUrlFound=true;
      }
    }
  }
  await inspect(path.join(preview.dir,'.next','static'));assert.ok(testUrlFound,'Test URL must be compiled into the client');
  child=spawn(process.execPath,[next,'start','--hostname','127.0.0.1','--port','3197'],{cwd:preview.dir,env:preview.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.resume();child.stderr.resume();
  let response;
  for(let i=0;i<40;i++) {
    try {response=await fetch('http://127.0.0.1:3197',{signal:AbortSignal.timeout(3000)});if(response.ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(response?.ok,'Isolated UI must serve HTTP successfully');
  const html=await response.text();assert.ok(html.includes('data-restore-preview="true"'));
  assert.ok(!html.includes('https://originalproject.supabase.co'));
  console.log('Preview smoke check passed: historical app compiled, test public URL in client, restore banner rendered, HTTP 200. No database was contacted.');
} finally {
  if(child) {
    child.kill();
    await Promise.race([new Promise(resolve=>child.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
  }
  // Remove the junction itself before cleaning the scratch directory. Never
  // recurse through the existing workspace node_modules directory.
  if(modulesLink)await unlink(modulesLink);
  if(root.startsWith(path.resolve(os.tmpdir())+path.sep+'avocado-preview-smoke-'))await rm(root,{recursive:true,force:true});
}
