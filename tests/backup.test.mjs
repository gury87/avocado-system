import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apiHeaders, command, decryptFile, digest, encryptFile, encryptionKey, managedCustomizations, restoreList, safePath, storageUrl, verifyBundle } from '../scripts/backup/lib.mjs';
import { backupSelection, restoreJob } from '../scripts/backup/restore-job.mjs';

test('Authenticated encryption recovers bytes, randomizes ciphertext and never publishes corrupt recovery output',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'backup-test-'));
  try {
    const source=path.join(dir,'source'),first=path.join(dir,'first'),second=path.join(dir,'second'),key=randomBytes(32);
    const bytes=randomBytes(2*1024*1024+17);await writeFile(source,bytes);
    await encryptFile(source,first,key);await encryptFile(source,second,key);
    assert.notEqual(await digest(first),await digest(second));
    const recovered=path.join(dir,'recovered');await decryptFile(first,recovered,key);
    assert.deepEqual(await readFile(recovered),bytes);
    await assert.rejects(decryptFile(first,recovered,key),/already exists/);
    const wrong=path.join(dir,'wrong');await assert.rejects(decryptFile(first,wrong,randomBytes(32)));
    assert.equal(await stat(wrong).catch(()=>null),null);
    const corrupted=await readFile(first);corrupted[corrupted.length-20]^=1;
    await writeFile(second,corrupted);await assert.rejects(decryptFile(second,wrong,key));
    assert.equal(await stat(wrong).catch(()=>null),null);
    await writeFile(second,corrupted.subarray(0,15));await assert.rejects(decryptFile(second,wrong,key),/Truncated/);
    await writeFile(source,Buffer.alloc(0));await rm(first);await encryptFile(source,first,key);
    await decryptFile(first,wrong,key);assert.equal((await stat(wrong)).size,0);
    assert.deepEqual(encryptionKey(key.toString('base64')),key);
    assert.throws(()=>encryptionKey('bad-password'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Restore selection preserves users, permissions and application data without overwriting Supabase-managed schemas',()=>{
  const toc=[
    '1; 2615 1 SCHEMA - public postgres',
    '2; 2615 2 SCHEMA - private postgres',
    '3; 1259 3 TABLE public profiles postgres',
    '4; 1259 4 TABLE DATA public profiles postgres',
    '5; 0 5 TABLE DATA auth users supabase_auth_admin',
    '6; 0 6 TABLE DATA auth schema_migrations supabase_auth_admin',
    '7; 1255 7 FUNCTION private farm_role() postgres',
    '8; 0 8 POLICY public profiles profiles_read postgres',
    '9; 0 9 ACL public TABLE profiles postgres',
    '10; 1259 10 TABLE auth users supabase_auth_admin',
    '11; 0 11 TABLE DATA storage objects supabase_storage_admin',
  ].join('\n');
  const list=restoreList(toc);
  for(const fragment of ['SCHEMA - private','TABLE public profiles','TABLE DATA auth users','FUNCTION private farm_role','POLICY public profiles','ACL public TABLE profiles'])assert.ok(list.includes(fragment));
  for(const fragment of ['SCHEMA - public','TABLE auth users','TABLE DATA storage','schema_migrations'])assert.ok(!list.includes(fragment));
  assert.throws(()=>restoreList(''),/missing/);
});

test('Manifest detects changed/missing files and unsafe paths',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'manifest-test-'));
  try {
    await writeFile(path.join(dir,'data'),'payload');
    const manifest={format:1,files:[{path:'data',bytes:7,sha256:await digest(path.join(dir,'data'))}]};
    await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));await verifyBundle(dir);
    await writeFile(path.join(dir,'data'),'changed');await assert.rejects(verifyBundle(dir),/integrity/);
    for(const file of ['../escape','/absolute','a/../../escape','a\\b','a//b'])assert.throws(()=>safePath(dir,file));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('Storage paths and API authorization handle secret keys without turning them into JWTs',()=>{
  assert.equal(storageUrl('https://example.supabase.co','farm-documents','receipt/space name.jpg'),'https://example.supabase.co/storage/v1/object/authenticated/farm-documents/receipt/space%20name.jpg');
  assert.deepEqual(apiHeaders('sb_secret_fake'),{apikey:'sb_secret_fake'});
  assert.deepEqual(apiHeaders('legacy.jwt'),{apikey:'legacy.jwt',Authorization:'Bearer legacy.jwt'});
  const sql=managedCustomizations(['CREATE TRIGGER example;'],[{schemaname:'storage',tablename:'objects',policyname:'farm_read',permissive:'PERMISSIVE',cmd:'SELECT',roles:['authenticated'],qual:"bucket_id='farm-documents'",with_check:null}]);
  assert.ok(sql.includes('CREATE TRIGGER example;'));assert.ok(sql.includes('TO "authenticated" USING'));
});

test('Child failures never echo a database password or arbitrary tool stderr',async()=>{
  await assert.rejects(command(process.execPath,['-e',"process.stderr.write('password=DO_NOT_LOG');process.exit(1)"],{label:'Test client'}),e=>e.message.includes('Test client failed')&&!e.message.includes('DO_NOT_LOG'));
});

test('Cloud test restore refuses unconfirmed runs and unsafe/unverified backup selection',async()=>{
  const backup='2026-11-12/example.avbackup';
  const marker={format:1,verifiedUpload:true,file:'example.avbackup',sha256:'a'.repeat(64),bytes:123};
  assert.equal(backupSelection(backup,marker),backup);
  for(const invalid of ['../file.avbackup','2026-11-12/../../file.avbackup','2026-11-12/a.avbackup;echo secret','https://example/file.avbackup']) assert.throws(()=>backupSelection(invalid));
  assert.throws(()=>backupSelection(backup,{...marker,file:'other.avbackup'}));
  assert.throws(()=>backupSelection(backup,{...marker,verifiedUpload:false}));
  const previous=process.env.RESTORE_CONFIRM;delete process.env.RESTORE_CONFIRM;
  try {await assert.rejects(restoreJob(),/Confirm/);}finally{if(previous!==undefined)process.env.RESTORE_CONFIRM=previous;}
});

test('Standalone recovery CLI decrypts, extracts and verifies a complete package',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'recovery-cli-test-'));
  try {
    const {mkdir}=await import('node:fs/promises');
    const bundle=path.join(root,'bundle');await mkdir(bundle);
    await writeFile(path.join(bundle,'database.dump'),'synthetic database');
    await writeFile(path.join(bundle,'manifest.json'),JSON.stringify({format:1,createdAt:'2026-11-12',commit:'synthetic',files:[{path:'database.dump',bytes:18,sha256:await digest(path.join(bundle,'database.dump'))}]}));
    const archive=path.join(root,'plain.tar.gz'),encrypted=path.join(root,'backup.avbackup'),key=randomBytes(32);
    await command('tar',['-czf',archive,'-C',bundle,'.']);await encryptFile(archive,encrypted,key);
    const recovered=path.join(root,'recovered');
    const env={...process.env,BACKUP_ENCRYPTION_KEY:key.toString('base64')};
    const result=await command(process.execPath,[path.resolve('scripts/backup/recover.mjs'),encrypted,recovered],{env});
    assert.ok(result.includes('Recovery package verified'));
    assert.equal(await readFile(path.join(recovered,'database.dump'),'utf8'),'synthetic database');
    await assert.rejects(command(process.execPath,[path.resolve('scripts/backup/recover.mjs'),encrypted,recovered],{env}));
  } finally {await rm(root,{recursive:true,force:true});}
});
