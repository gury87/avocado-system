import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command, digest } from '../scripts/backup/lib.mjs';
import { checkSourceEntries, preparePreview, previewConfig, previewEnvironment } from '../scripts/backup/preview.mjs';

const manifest={projectRef:'originalproject',commit:'synthetic',createdAt:'2026-11-12T19:46:49.892Z'};
const testUrl='https://restoredproject.supabase.co';
const testKey='sb_publishable_testOnlyPublicKey';
const jwt=payload=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.synthetic';

test('Preview refuses the original project and refuses service keys in browser configuration',()=>{
  assert.equal(previewConfig(manifest,testUrl,testKey).ref,'restoredproject');
  assert.throws(()=>previewConfig(manifest,'https://originalproject.supabase.co',testKey),/ORIGINAL/);
  for(const bad of ['https://restoredproject.supabase.co.evil.example','https://user:pass@restoredproject.supabase.co','http://restoredproject.supabase.co','https://restoredproject.supabase.co/other','https://restoredproject.supabase.co?x=1']) assert.throws(()=>previewConfig(manifest,bad,testKey));
  assert.throws(()=>previewConfig(manifest,testUrl,'sb_secret_NEVER_PUBLIC'),/publishable/);
  assert.throws(()=>previewConfig(manifest,testUrl,jwt({role:'service_role',ref:'restoredproject'})),/Only/);
  assert.throws(()=>previewConfig(manifest,testUrl,jwt({role:'anon',ref:'originalproject'})),/Only/);
  assert.equal(previewConfig(manifest,testUrl,jwt({role:'anon',ref:'restoredproject'})).ref,'restoredproject');
});

test('Preview environment drops inherited production and backup credentials',()=>{
  const env=previewEnvironment(previewConfig(manifest,testUrl,testKey),{PATH:'kept',SYSTEMROOT:'kept',NEXT_PUBLIC_SUPABASE_URL:'https://originalproject.supabase.co',NEXT_PUBLIC_OTHER_SECRET:'not copied',SUPABASE_SERVICE_ROLE_KEY:'not copied',BACKUP_DB_PASSWORD:'not copied',RESTORE_DB_PASSWORD:'not copied',PGPASSWORD:'not copied',DATABASE_URL:'not copied',APP_URL:'https://live.example',VERCEL_TOKEN:'not copied'});
  assert.equal(env.PATH,'kept');assert.equal(env.SYSTEMROOT,'kept');
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL,testUrl);assert.equal(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,testKey);
  assert.equal(env.APP_URL,'http://127.0.0.1:3001');
  assert.ok(!Object.values(env).includes('not copied'));
});

test('Preview source extraction rejects paths, symlinks, environments and precompiled assets',()=>{
  for(const file of ['../outside','/absolute','./C:/outside','a\\b','.env.local','./.env.production','.git/config','node_modules/secret','.next/static/live.js']) assert.throws(()=>checkSourceEntries([file],'-rw-r--r-- file'));
  assert.throws(()=>checkSourceEntries(['app/file'],'lrwxrwxrwx linked file'));
  assert.doesNotThrow(()=>checkSourceEntries(['./','app/layout.tsx','package.json','package-lock.json'],'-rw-r--r-- regular file'));
});

test('Preview unpacks into a separate folder, brands it and writes only the test public connection',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'preview-test-'));
  try {
    const source=path.join(root,'source'),bundle=path.join(root,'bundle'),home=path.join(root,'home');
    for(const dir of [source,bundle,home,path.join(source,'app','lib')]) await mkdir(dir,{recursive:true});
    const layout='export default function Layout({children}) {return <body className="example">{children}</body>}';
    await writeFile(path.join(source,'app','layout.tsx'),layout);
    await writeFile(path.join(source,'app','lib','supabase.ts'),'process.env.NEXT_PUBLIC_SUPABASE_URL; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;');
    await writeFile(path.join(source,'package.json'),JSON.stringify({scripts:{dev:'next dev'},dependencies:{next:'^16.4.0'},devDependencies:{'eslint-config-next':'^16.4.0'}}));
    await writeFile(path.join(source,'package-lock.json'),'{}');
    const archive=path.join(bundle,'source-code.tar');await command('tar',['-cf',archive,'-C',source,'.']);
    const {stat}=await import('node:fs/promises');
    await writeFile(path.join(bundle,'manifest.json'),JSON.stringify({...manifest,format:1,files:[{path:'source-code.tar',bytes:(await stat(archive)).size,sha256:await digest(archive)}]}));
    const prepared=await preparePreview(bundle,previewConfig(manifest,testUrl,testKey),home);
    assert.ok(prepared.dir.startsWith(home+path.sep+'avocado-restore-site-'));
    assert.equal(await readFile(path.join(source,'app','layout.tsx'),'utf8'),layout);
    assert.ok((await readFile(path.join(prepared.dir,'app','layout.tsx'),'utf8')).includes('data-restore-preview'));
    const env=await readFile(path.join(prepared.dir,'.env.local'),'utf8');
    assert.ok(env.includes(testUrl));assert.ok(!env.includes('originalproject'));assert.ok(!env.includes('SERVICE_ROLE'));
    const meta=JSON.parse(await readFile(path.join(prepared.dir,'RESTORE_PREVIEW.json'),'utf8'));
    assert.equal(meta.sourceProject,'originalproject');assert.equal(meta.testProject,'restoredproject');
    assert.equal(meta.runtimePatched,true);assert.equal(meta.nextVersion,'16.4.6');
    assert.equal(JSON.parse(await readFile(path.join(source,'package.json'),'utf8')).dependencies.next,'^16.4.0');
    assert.ok((await readdir(prepared.dir)).includes('START-RESTORE-TEST.cmd'));
    assert.ok((await readFile(path.join(prepared.dir,'scripts','backup','preview-start.mjs'),'utf8')).includes('previewConfig'));
  } finally {await rm(root,{recursive:true,force:true});}
});
