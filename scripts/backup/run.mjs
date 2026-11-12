import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Snapshot } from './database.mjs';
import { apiHeaders, command, decryptFile, digest, encryptFile, encryptionKey, pg, restoreList, storageUrl, verifyBundle } from './lib.mjs';

const required = ['BACKUP_DB_HOST','BACKUP_DB_USER','BACKUP_DB_PASSWORD','BACKUP_SUPABASE_URL','BACKUP_SUPABASE_SECRET_KEY','BACKUP_ENCRYPTION_KEY','RCLONE_CONFIG'];
let stage = 'configuration';
let root;
async function main() {
  for (const name of required) if (!process.env[name]?.trim()) throw new Error(`Missing secret: ${name}`);
  const key = encryptionKey(process.env.BACKUP_ENCRYPTION_KEY);
  const base = process.env.BACKUP_SUPABASE_URL.trim().replace(/\/$/, '');
  const url = new URL(base);
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.pathname !== '/') throw new Error('BACKUP_SUPABASE_URL must be the Supabase project HTTPS URL.');
  const ref = url.hostname.split('.')[0];
  if (process.env.BACKUP_DB_USER !== `postgres.${ref}` || !/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(process.env.BACKUP_DB_HOST)) throw new Error('Database session pooler credentials do not match the Storage project URL.');
  const config = process.env.RCLONE_CONFIG;
  if (!config.includes('[avocado-backups]') || !/^type\s*=\s*onedrive\s*$/m.test(config)) throw new Error('RCLONE_CONFIG must contain the avocado-backups OneDrive remote.');
  root = await mkdtemp(path.join(os.tmpdir(), 'avocado-backup-'));
  const bundle = path.join(root, 'bundle'), artifacts = path.join(root, 'artifacts'), configDir = path.join(root, 'rclone');
  for (const dir of [bundle, artifacts, configDir, path.join(bundle, 'objects')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const env = { ...process.env, PGHOST:process.env.BACKUP_DB_HOST, PGPORT:'5432', PGUSER:process.env.BACKUP_DB_USER, PGPASSWORD:process.env.BACKUP_DB_PASSWORD, PGDATABASE:'postgres', PGSSLMODE:'require', PGCONNECT_TIMEOUT:'30' };
  const snapshot = new Snapshot(root, env);
  let inventory;
  try {
    stage = 'read-only database connection'; console.log('Checking read-only database connection...');
    const id = await snapshot.begin();
    stage = 'database inventory'; inventory = await snapshot.inventory();
    // Vault / pgsodium keys live outside PostgreSQL. Do not label their encrypted
    // data recoverable without separately exporting the platform root key.
    const encryptedColumns = Number(await snapshot.query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname='vault' AND c.relname='secrets')"));
    if (encryptedColumns && Number(await snapshot.query('SELECT count(*) FROM vault.secrets')) > 0) throw new Error('Vault secrets require a separate platform root-key backup.');
    if (inventory.extensions.some(e => e.name === 'pgsodium')) throw new Error('pgsodium requires a separate platform root-key backup.');
    stage = 'PostgreSQL dump'; console.log('Exporting a consistent database snapshot...');
    await pg(root, 'pg_dump', ['--format=custom','--no-owner','--schema=public','--schema=private','--schema=auth','--schema=storage',`--snapshot=${id}`,`--file=${path.join(bundle,'database.dump')}`], env);
  } finally { await snapshot.close(); }
  stage = 'archive inventory';
  const toc = await pg(root,'pg_restore',['--list',path.join(bundle,'database.dump')],env);
  await writeFile(path.join(bundle,'restore.list'),restoreList(toc));
  await writeFile(path.join(bundle,'managed-customizations.sql'),inventory.managedSql);
  delete inventory.managedSql;
  await pg(root,'pg_dumpall',['--roles-only','--no-role-passwords',`--file=${path.join(bundle,'roles-reference.sql')}`],env);

  stage = 'Storage downloads'; console.log(`Downloading ${inventory.objects.length} Storage files...`);
  const headers = apiHeaders(process.env.BACKUP_SUPABASE_SECRET_KEY);
  for (const object of inventory.objects) {
    if (typeof object.bucket !== 'string' || typeof object.name !== 'string' || !object.name) throw new Error('Invalid Storage object metadata.');
    object.file = 'objects/' + createHash('sha256').update(object.bucket+'\0'+object.name).digest('hex') + '.bin';
    let downloaded = false;
    for (let attempt=0;attempt<3;attempt++) {
      try {
        const response = await fetch(storageUrl(base,object.bucket,object.name),{headers,signal:AbortSignal.timeout(120000),redirect:'error'});
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Storage download failed.'); }
        await pipeline(Readable.fromWeb(response.body),createWriteStream(path.join(bundle,object.file),{mode:0o600}));
        downloaded=true; break;
      } catch { if (attempt===2) throw new Error('Storage download failed. Check the secret API key and missing files.'); }
    }
    if (!downloaded) throw new Error('Storage download incomplete.');
  }
  // A file changed/deleted during the copy must not silently mismatch the dump.
  stage = 'Storage consistency check';
  const current = JSON.parse(await pg(root,'psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',"SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at,'version',to_jsonb(o)->>'version')),'[]'::jsonb) FROM storage.objects o"],env));
  const byId = new Map(current.map(o=>[o.id,o]));
  for (const object of inventory.objects) {
    const latest=byId.get(object.id);
    if (!latest || latest.updated_at!==object.updated_at || latest.version!==object.version) throw new Error('Storage changed during backup. Run a new backup.');
  }
  stage = 'source code archive';
  const commit=(await command('git',['rev-parse','HEAD'])).trim();
  await command('git',['archive','--format=tar',`--output=${path.join(bundle,'source-code.tar')}`,commit]);
  await writeFile(path.join(bundle,'BACKUP_SETUP.md'),await readFile('BACKUP_SETUP.md'));
  const files=[];
  async function collect(dir, prefix='') {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const name=prefix+entry.name;
      if(entry.isDirectory()) await collect(path.join(dir,entry.name),name+'/');
      else if(entry.isFile()) files.push({path:name,bytes:(await stat(path.join(dir,entry.name))).size,sha256:await digest(path.join(dir,entry.name))});
      else throw new Error('Unexpected symbolic link in backup.');
    }
  }
  await collect(bundle);
  const createdAt=new Date().toISOString();
  const manifest={format:1,projectRef:ref,createdAt,commit,reason:process.env.BACKUP_REASON==='before-migration'?'before-migration':process.env.GITHUB_EVENT_NAME==='schedule'?'daily':'manual',inventory,files};
  await writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  await verifyBundle(bundle);
  stage='encryption'; console.log('Encrypting and verifying the backup...');
  const name=`${createdAt.replaceAll(':','-')}-${randomBytes(4).toString('hex')}.avbackup`;
  const archive=path.join(root,'backup.tar.gz'), encrypted=path.join(artifacts,name), recovered=path.join(root,'verified.tar.gz');
  await command('tar',['-czf',archive,'-C',bundle,'.']);
  await encryptFile(archive,encrypted,key); await decryptFile(encrypted,recovered,key);
  if(await digest(archive)!==await digest(recovered)) throw new Error('Encrypted round-trip verification failed.');
  const sha256=await digest(encrypted),bytes=(await stat(encrypted)).size;
  await writeFile(path.join(artifacts,name+'.sha256'),`${sha256}  ${name}\n`);
  await writeFile(path.join(configDir,'rclone.conf'),config,{mode:0o600});
  const remote=`avocado-backups:Avocado-System-Backups/${createdAt.slice(0,10)}`;
  async function rclone(args) {
    return command('docker',['run','--rm','--user',`${process.getuid()}:${process.getgid()}`,'--volume',`${configDir}:/config/rclone`,'--volume',`${artifacts}:/backup`,'rclone/rclone:1.76.0',...args],{label:'OneDrive transfer'});
  }
  stage='OneDrive upload'; console.log('Uploading encrypted files to OneDrive...');
  await rclone(['copyto',`/backup/${name}`,`${remote}/${name}`,'--retries','3']);
  await rclone(['copyto',`/backup/${name}.sha256`,`${remote}/${name}.sha256`]);
  await rclone(['copyto',`${remote}/${name}`,'/backup/readback.avbackup']);
  if(await digest(path.join(artifacts,'readback.avbackup'))!==sha256) throw new Error('OneDrive read-back checksum failed.');
  const complete={format:1,createdAt,commit,reason:manifest.reason,file:name,sha256,bytes,storageFiles:inventory.objects.length,verifiedUpload:true,restoreDrill:'separate-test-required'};
  await writeFile(path.join(artifacts,name+'.complete.json'),JSON.stringify(complete,null,2));
  await rclone(['copyto',`/backup/${name}.complete.json`,`${remote}/${name}.complete.json`]);
  const summary=`Backup uploaded and read-back verified.\n\n- UTC: ${createdAt}\n- Commit: ${commit}\n- Reason: ${manifest.reason}\n- Storage files: ${inventory.objects.length}\n- Encrypted size: ${bytes} bytes\n- OneDrive folder: Avocado-System-Backups/${createdAt.slice(0,10)}\n- File: ${name}\n\nDownload the .avbackup file and matching .sha256. Only backups with a matching .complete.json finished successfully. A fresh-Supabase restore drill is still required before relying on disaster recovery.\n`;
  if(process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,summary);
  console.log('SUCCESS: encrypted backup uploaded and verified. No production data was changed.');
}
try { await main(); }
catch(error) { console.error(`Backup FAILED at: ${stage}. ${error instanceof Error ? error.message.replaceAll(process.env.BACKUP_DB_PASSWORD ?? '\0','[REDACTED]') : 'Unexpected error.'}`); process.exitCode=1; }
finally { if(root) await rm(root,{recursive:true,force:true}); }
