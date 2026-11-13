import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { command, verifyBundle } from './lib.mjs';

export const PREVIEW_URL='http://127.0.0.1:3001';
const unquote=value=>value.trim().replace(/^"(.*)"$/,'$1');

export function previewConfig(manifest, rawUrl, rawKey) {
  if(!manifest.projectRef) throw new Error('Backup does not identify the original project.');
  const url=new URL(rawUrl.trim()),key=rawKey.trim();
  if(url.protocol!=='https:'||!/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)||url.pathname!=='/'||url.username||url.password||url.port||url.search||url.hash) throw new Error('Enter the TEST Supabase project URL, https://PROJECT.supabase.co.');
  const ref=url.hostname.split('.')[0];
  if(ref===manifest.projectRef) throw new Error('This is the ORIGINAL project. Enter the avocado-restore-test project URL.');
  if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    // Older projects may still expose an anon JWT. Service-role JWTs must never
    // enter a NEXT_PUBLIC variable, even on a local test site.
    if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) throw new Error('Enter a publishable key (sb_publishable_...), not a secret key.');
    let payload;
    try {payload=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8'));} catch {throw new Error('Invalid public API key.');}
    if(payload.role!=='anon'||payload.ref!==ref) throw new Error('Only the TEST project publishable/anon key is allowed.');
  }
  return {url:url.origin,key,ref};
}

export function previewEnvironment(config, inherited=process.env) {
  const env=Object.fromEntries(Object.entries(inherited).filter(([name])=>!/(?:SUPABASE|^NEXT_PUBLIC_|^BACKUP_|^RESTORE_|^PG[A-Z_]|DATABASE_URL|^APP_URL$|^VERCEL_)/i.test(name)));
  // Use Windows' trusted certificate store where supported, without disabling
  // TLS validation. This covers managed PCs and first-time font/npm downloads.
  if(process.platform==='win32'&&process.allowedNodeEnvironmentFlags.has('--use-system-ca')&&!env.NODE_OPTIONS?.includes('--use-system-ca')) env.NODE_OPTIONS=((env.NODE_OPTIONS||'')+' --use-system-ca').trim();
  return {...env,NEXT_PUBLIC_SUPABASE_URL:config.url,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:config.key,APP_URL:PREVIEW_URL,NEXT_TELEMETRY_DISABLED:'1'};
}

export function checkSourceEntries(names, verbose) {
  for(const original of names) {
    const name=original.replace(/^\.\//,'');
    if(name.startsWith('/')||original.includes('\\')||/^[A-Za-z]:/.test(name)||original.split('/').includes('..')) throw new Error('Unsafe source archive path.');
    if(/^(?:\.git|node_modules|\.next)(?:\/|$)/.test(name)||/^\.env(?:\.|$)/.test(name)) throw new Error('Source archive contains environment, repository or generated files. Preview refused.');
  }
  if(verbose.split(/\r?\n/).some(line=>/^[lh]/.test(line))) throw new Error('Linked files are not allowed in a recovery preview.');
}

export async function preparePreview(bundle, config, home=os.homedir()) {
  const manifest=await verifyBundle(bundle);
  config=previewConfig(manifest,config.url,config.key);
  if(!manifest.files.some(f=>f.path==='source-code.tar')) throw new Error('Backup has no source-code.tar.');
  const archive=path.join(bundle,'source-code.tar');
  const names=(await command('tar',['-tf',archive])).split(/\r?\n/).filter(Boolean);
  const verbose=await command('tar',['-tvf',archive]);
  checkSourceEntries(names,verbose);
  const dir=await mkdtemp(path.join(path.resolve(home),'avocado-restore-site-'));
  await command('tar',['-xf',archive,'-C',dir]);
  const pkg=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
  if(pkg.scripts?.dev!=='next dev') throw new Error('Unexpected dev script in the archived project.');
  const archivedNext=pkg.dependencies?.next?.match(/^[~^]?16\.4\.(\d+)$/);
  if(!archivedNext) throw new Error('This archive uses a different Next.js release. A compatible recovery runtime must be reviewed.');
  const runtimePatched=Number(archivedNext[1])<6;
  if(runtimePatched) {
    // Keep the recovered app source but do not launch a known-vulnerable runtime
    // from an old lockfile. This change is confined to the isolated copy.
    pkg.dependencies.next='16.4.6';
    if(pkg.devDependencies?.['eslint-config-next'])pkg.devDependencies['eslint-config-next']='16.4.6';
    await writeFile(path.join(dir,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  }
  await stat(path.join(dir,'package-lock.json'));
  const client=await readFile(path.join(dir,'app','lib','supabase.ts'),'utf8');
  if(!client.includes('NEXT_PUBLIC_SUPABASE_URL')||!client.includes('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')) throw new Error('Archived application environment names are not supported.');
  const layoutPath=path.join(dir,'app','layout.tsx');
  const layout=await readFile(layoutPath,'utf8');
  const body=layout.match(/<body\b[^>]*>/);
  if(!body) throw new Error('Could not add the restore-test banner.');
  const banner='<aside data-restore-preview="true" dir="rtl" style={{position:"sticky",top:0,zIndex:9999,background:"#fff3cd",color:"#713f12",padding:"10px",textAlign:"center",fontWeight:700}}>סביבת בדיקת שחזור — פרויקט בדיקה</aside>';
  await writeFile(layoutPath,layout.replace(body[0],body[0]+banner));
  const env=previewEnvironment(config);
  // Public values only. No source .env or server/service key is copied.
  await writeFile(path.join(dir,'.env.local'),`NEXT_PUBLIC_SUPABASE_URL=${config.url}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${config.key}\nAPP_URL=${PREVIEW_URL}\nNEXT_TELEMETRY_DISABLED=1\n`,{mode:0o600,flag:'wx'});
  await writeFile(path.join(dir,'RESTORE_PREVIEW.json'),JSON.stringify({format:1,sourceProject:manifest.projectRef,sourceCommit:manifest.commit,backupUtc:manifest.createdAt,testProject:config.ref,previewUrl:PREVIEW_URL,runtimePatched,nextVersion:pkg.dependencies.next},null,2));
  await writeFile(path.join(dir,'START-RESTORE-TEST.cmd'),'@echo off\r\ncd /d "%~dp0"\r\nnode scripts/backup/preview-start.mjs\r\npause\r\n');
  // This starter is copied from the current recovery tool, so even a backup
  // predating this feature has a guarded way to restart its isolated preview.
  await mkdir(path.join(dir,'scripts','backup'),{recursive:true});
  for(const file of ['preview-start.mjs','preview.mjs','lib.mjs']) await writeFile(path.join(dir,'scripts','backup',file),await readFile(new URL('./'+file,import.meta.url)));
  return {dir,env,manifest,config,runtimePatched};
}

export async function checkPreviewPort() {
  await new Promise((resolve,reject)=>{
    const server=createServer();
    server.once('error',()=>reject(new Error('Port 3001 is already in use. Stop the other test server before retrying.')));
    server.listen(3001,'127.0.0.1',()=>server.close(resolve));
  });
}

export async function runNpm(dir, env, action) {
  const commands={lock:['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],install:['ci','--no-audit','--no-fund'],start:['run','dev','--','--hostname','127.0.0.1','--port','3001']};
  const args=commands[action];if(!args)throw new Error('Unknown preview operation.');
  const line='npm '+args.join(' ');
  return new Promise((resolve,reject)=>{
    // Fixed command text only: project URL, key and paths never enter the shell.
    const child=process.platform==='win32'
      ?spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',line],{cwd:dir,env,stdio:'inherit',windowsHide:true})
      :spawn('npm',args,{cwd:dir,env,stdio:'inherit'});
    child.once('error',()=>reject(new Error('Could not start npm. Check your Node.js installation.')));
    child.once('close',code=>code===0||(action==='start'&&(code===130||code===null))?resolve():reject(new Error(`Preview ${action} stopped or failed (exit ${code}).`)));
  });
}

async function main() {
  if(Number(process.versions.node.split('.')[0])<22) throw new Error('Node.js 22 or newer is required.');
  const rl=createInterface({input:stdin,output:stdout});
  let prepared;
  try {
    console.log('LOCAL RESTORE TEST - separate code folder, TEST Supabase only.');
    const recovered=(await readdir(os.homedir(),{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name.startsWith('avocado-recovery-')).map(e=>e.name).sort().at(-1);
    const defaultFolder=recovered?path.join(os.homedir(),recovered):'';
    const answer=process.argv[2]||await rl.question(`Recovered backup folder${defaultFolder?` [Enter = ${defaultFolder}]`:''}: `);
    if(!unquote(answer)&&!defaultFolder) throw new Error('Enter the recovered folder path, usually avocado-recovery-..., not the .avbackup file.');
    const bundle=path.resolve(unquote(answer)||defaultFolder);
    if(!(await stat(bundle)).isDirectory()) throw new Error('Choose the recovered folder (avocado-recovery-...), not the encrypted .avbackup file.');
    const manifest=await verifyBundle(bundle);
    const url=await rl.question('TEST Supabase Project URL (https://PROJECT.supabase.co): ');
    const key=await rl.question('TEST Publishable key (sb_publishable_...; NEVER sb_secret_...): ');
    const config=previewConfig(manifest,url,key);
    console.log('Checking the TEST project public connection...');
    const response=await fetch(config.url+'/auth/v1/settings',{headers:{apikey:config.key},redirect:'error',signal:AbortSignal.timeout(30000)});
    await response.body?.cancel();
    if(!response.ok) throw new Error('Test project URL/key check failed. Check the publishable key and project status.');
    await checkPreviewPort();
    prepared=await preparePreview(bundle,config);
  } finally {rl.close();}
  console.log(`Separate test copy: ${prepared.dir}`);
  if(prepared.runtimePatched) {
    console.log('Applying Next.js 16.4.6 security fixes to this isolated recovery copy...');
    await runNpm(prepared.dir,prepared.env,'lock');
  }
  console.log('Installing the archived, locked dependencies. This may take a few minutes...');
  await runNpm(prepared.dir,prepared.env,'install');
  console.log(`Open ${PREVIEW_URL} in your browser. Look for the yellow RESTORE TEST banner.`);
  console.log('Use your normal app email/password. Changes on this copy go to the TEST project.');
  console.log('Keep this window open; press Ctrl+C to stop. Use START-RESTORE-TEST.cmd inside the test folder to restart.');
  await runNpm(prepared.dir,prepared.env,'start');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.platform==='win32'&&process.allowedNodeEnvironmentFlags.has('--use-system-ca')&&!process.execArgv.includes('--use-system-ca')&&!process.env.NODE_OPTIONS?.includes('--use-system-ca')) {
    const child=spawn(process.execPath,['--use-system-ca',fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
    child.once('error',()=>{console.error('Could not start the preview setup.');process.exitCode=1;});
    child.once('close',code=>{process.exitCode=code===130||code===null?0:code;});
  } else {
    try {await main();}catch(error){console.error(error instanceof Error?error.message:'Preview setup failed.');process.exitCode=1;}
  }
}
