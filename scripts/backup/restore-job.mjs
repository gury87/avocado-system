import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, digest, verifyBundle } from './lib.mjs';

export function backupSelection(value, complete) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.avbackup$/.test(value)) throw new Error('Choose one backup path: YYYY-MM-DD/name.avbackup.');
  if(complete && (complete.format!==1||complete.verifiedUpload!==true||complete.file!==path.posix.basename(value)||!/^[a-f0-9]{64}$/.test(complete.sha256)||!Number.isSafeInteger(complete.bytes)||complete.bytes<=0)) throw new Error('Backup success marker is invalid.');
  return value;
}

export async function restoreJob() {
  if(process.env.RESTORE_CONFIRM!=='true') throw new Error('Confirm that the configured target is the separate test project.');
  for(const name of ['RCLONE_CONFIG','BACKUP_ENCRYPTION_KEY','RESTORE_DB_HOST','RESTORE_DB_USER','RESTORE_DB_PASSWORD','RESTORE_SUPABASE_URL','RESTORE_SUPABASE_SECRET_KEY']) if(!process.env[name]?.trim()) throw new Error(`Missing secret: ${name}`);
  const selected=backupSelection(process.env.RESTORE_BACKUP_PATH);
  const root=await mkdtemp(path.join(os.tmpdir(),'avocado-restore-job-'));
  try {
    const config=path.join(root,'config'),files=path.join(root,'files'),bundle=path.join(root,'recovered');
    await mkdir(config,{mode:0o700});await mkdir(files,{mode:0o700});
    await writeFile(path.join(config,'rclone.conf'),process.env.RCLONE_CONFIG,{mode:0o600});
    async function download(remote,file) {
      await command('docker',['run','--rm','--user',`${process.getuid()}:${process.getgid()}`,'--volume',`${config}:/config/rclone`,'--volume',`${files}:/download`,'rclone/rclone:1.76.0','copyto',`avocado-backups:Avocado-System-Backups/${remote}`,`/download/${file}`,'--contimeout','20s','--timeout','90s','--low-level-retries','2','--retries','2'],{label:'OneDrive backup download'});
    }
    console.log('Downloading the selected backup and its success marker...');
    await download(selected+'.complete.json','complete.json');
    const complete=JSON.parse(await readFile(path.join(files,'complete.json'),'utf8'));
    backupSelection(selected,complete);
    await download(selected,'selected.avbackup');
    if(await digest(path.join(files,'selected.avbackup'))!==complete.sha256) throw new Error('Downloaded backup checksum does not match its success marker.');
    console.log('Decrypting and checking every recovered file...');
    const recovery=await command(process.execPath,['scripts/backup/recover.mjs',path.join(files,'selected.avbackup'),bundle],{label:'Backup package recovery'});
    if(!recovery.includes('Recovery package verified.')) throw new Error('Recovery verification did not complete.');
    const manifest=await verifyBundle(bundle);
    if(manifest.commit!==complete.commit||manifest.createdAt!==complete.createdAt) throw new Error('Recovered package and success marker disagree.');
    const target=new URL(process.env.RESTORE_SUPABASE_URL).hostname.split('.')[0];
    if(!manifest.projectRef||target===manifest.projectRef) throw new Error('Restore to the source production project is forbidden.');
    const verifying=process.env.RESTORE_MODE==='verify-restored';
    console.log(verifying?'Verifying the isolated restored test project...':'Starting restore into the separate empty test project...');
    try {
      await command(process.execPath,[verifying?'scripts/backup/verify-test.mjs':'scripts/backup/restore-db.mjs',bundle,`${verifying?'--confirm-restored-project':'--confirm-empty-project'}=${target}`],{label:'Isolated Supabase restore',timeoutMs:30*60*1000});
    } catch(error) {
      const failure=await readFile(path.join(bundle,'.restore-failure.json'),'utf8').then(JSON.parse).catch(()=>null);
      if(failure) throw new Error(`Restore failed at ${failure.stage}: ${failure.message}`);
      throw error;
    }
    const result=JSON.parse(await readFile(path.join(bundle,'restore-verification.json'),'utf8'));
    if(result.targetProject!==target||!result.databaseRowsVerified||result.storageFilesVerified!==manifest.inventory.objects.length) throw new Error('Restore verification report is incomplete.');
    const summary=`## Test-project ${verifying?'verification':'restore'} completed\n\n- Backup UTC: ${manifest.createdAt}\n- Code commit: ${manifest.commit}\n- Database tables inventoried: ${manifest.inventory.counts.length}\n- Storage files verified: ${result.storageFilesVerified}\n- Auth roles checked: ${(result.authRolesChecked??[]).join(', ')||'separate check required'}\n- Target: separate test project\n\nThe live site and production database were not changed. Next: check the visual app using an isolated copy. No sensitive rows or decrypted artifacts are published by this workflow.\n`;
    if(process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,summary);
    console.log(`SUCCESS: test-project database and ${result.storageFilesVerified} Storage files restored and verified.`);
    if(verifying) console.log(`Verified Auth roles: ${(result.authRolesChecked??[]).join(', ')}; signed image: ${result.signedImageVerified}; Auth sequences checked: ${result.authSequencesChecked}.`);
  } finally { await rm(root,{recursive:true,force:true}); }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { await restoreJob(); }
  catch(error) { console.error(`Restore job failed: ${error instanceof Error?error.message:'Unexpected error.'}`);process.exitCode=1; }
}
