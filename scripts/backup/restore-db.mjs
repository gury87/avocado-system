import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiHeaders, digest, pg, quoteIdentifier, verifyBundle, storageUrl } from './lib.mjs';

// Deliberately accepts a *different*, empty project only. No production restore
// endpoint is exposed by the website or by the scheduled workflow.
let stage='validation';
let recoveryRoot;
try {
  const [folder,confirmation]=process.argv.slice(2);
  if(!folder) throw new Error('Supply the recovered bundle directory and --confirm-empty-project=<new-project-ref>.');
  const root=path.resolve(folder),manifest=await verifyBundle(root);recoveryRoot=root;
  const base=process.env.RESTORE_SUPABASE_URL?.replace(/\/$/,'');
  const url=new URL(base);
  const ref=url.hostname.split('.')[0];
  if(url.protocol!=='https:'||!/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)||confirmation!==`--confirm-empty-project=${ref}`||ref===manifest.projectRef) throw new Error('Restore requires explicit confirmation of a different, new Supabase project.');
  for(const name of ['RESTORE_DB_HOST','RESTORE_DB_USER','RESTORE_DB_PASSWORD','RESTORE_SUPABASE_SECRET_KEY']) if(!process.env[name]) throw new Error(`Missing ${name}.`);
  if(process.env.RESTORE_DB_USER!==`postgres.${ref}`||!/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(process.env.RESTORE_DB_HOST)) throw new Error('Restore database and Storage project do not match.');
  const env={...process.env,PGHOST:process.env.RESTORE_DB_HOST,PGPORT:'5432',PGUSER:process.env.RESTORE_DB_USER,PGPASSWORD:process.env.RESTORE_DB_PASSWORD,PGDATABASE:'postgres',PGSSLMODE:'require',PGCONNECT_TIMEOUT:'30'};
  const query=async sql=>(await pg(root,'psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',sql],env)).trim();
  stage='empty target check';
  const nonempty=Number(await query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e'))+(SELECT count(*) FROM auth.users)+(SELECT count(*) FROM storage.objects)+(SELECT count(*) FROM storage.buckets)`));
  if(!Number.isSafeInteger(nonempty)||nonempty!==0) throw new Error('Target is not empty or could not be verified. Restore refused; use a new test project.');
  const major=(await query('SHOW server_version')).split('.')[0];
  if(major!==manifest.inventory.serverVersion.split('.')[0]) throw new Error('Source and target PostgreSQL major versions differ. Use a compatible project.');
  stage='database restore';
  await pg(root,'pg_restore',['--no-owner','--exit-on-error','--single-transaction',`--use-list=${path.join(root,'restore.list')}`,'--dbname=postgres',path.join(root,'database.dump')],{...env,PGOPTIONS:'-c session_replication_role=replica'});
  stage='database row verification';
  for(const table of manifest.inventory.counts) {
    if(Number(await query(`SELECT count(*) FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`))!==table.count) throw new Error('Restored row counts differ. Keep this test project isolated.');
  }
  stage='Auth triggers and Storage policies';
  await pg(root,'psql',['-X','-v','ON_ERROR_STOP=1','--single-transaction','--file',path.join(root,'managed-customizations.sql')],env);
  const key=process.env.RESTORE_SUPABASE_SECRET_KEY,headers=apiHeaders(key);
  stage='Storage buckets';
  for(const bucket of manifest.inventory.buckets) {
    const response=await fetch(`${base}/storage/v1/bucket`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:bucket.id,name:bucket.name,public:bucket.public,file_size_limit:bucket.file_size_limit,allowed_mime_types:bucket.allowed_mime_types}),redirect:'error',signal:AbortSignal.timeout(60000)});
    await response.body?.cancel();
    if(!response.ok) throw new Error('Could not create a Storage bucket.');
  }
  stage='Storage files';
  const checks=path.join(root,'.restore-checks');await mkdir(checks,{mode:0o700});
  try {
    for(const object of manifest.inventory.objects) {
      const uploadUrl=`${base}/storage/v1/object/${encodeURIComponent(object.bucket)}/${object.name.split('/').map(encodeURIComponent).join('/')}`;
      const uploaded=await fetch(uploadUrl,{method:'POST',headers:{...headers,'Content-Type':object.metadata?.mimetype||'application/octet-stream','x-upsert':'false'},body:createReadStream(path.join(root,object.file)),duplex:'half',redirect:'error',signal:AbortSignal.timeout(120000)});
      await uploaded.body?.cancel();if(!uploaded.ok) throw new Error('Storage upload failed.');
      const response=await fetch(storageUrl(base,object.bucket,object.name),{headers,redirect:'error',signal:AbortSignal.timeout(120000)});
      if(!response.ok||!response.body) throw new Error('Storage verification download failed.');
      const file=path.join(checks,'object.bin');
      const {createWriteStream}=await import('node:fs');
      await pipeline(Readable.fromWeb(response.body),createWriteStream(file,{mode:0o600}));
      const expected=manifest.files.find(f=>f.path===object.file);
      if(!expected||await digest(file)!==expected.sha256) throw new Error('Restored file checksum differs.');
      await rm(file);
    }
  } finally { await rm(checks,{recursive:true,force:true}); }
  await query("NOTIFY pgrst, 'reload schema'");
  await writeFile(path.join(root,'restore-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),targetProject:ref,databaseRowsVerified:true,storageFilesVerified:manifest.inventory.objects.length,applicationChecksRequired:true},null,2));
  console.log('Database counts and restored file hashes verified on the NEW project.');
  console.log('Before switching the website, configure Auth URLs/email, test all roles, receipt totals and image viewing. The live website has NOT been switched.');
} catch(error) {
  const message=error instanceof Error?error.message:'Unexpected error.';
  if(recoveryRoot) await writeFile(path.join(recoveryRoot,'.restore-failure.json'),JSON.stringify({stage,message})).catch(()=>{});
  console.error(`Restore FAILED at ${stage}: ${message}`);process.exitCode=1;
}
