import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { command, pg, restoreList, managedCustomizations, restoreArchive } from './lib.mjs';
import { Snapshot } from './database.mjs';

// Runs only against an ephemeral PostgreSQL container with invented data.
// No live credentials are read. The hosted Supabase restore remains a separate
// drill because managed Auth/Storage versions and settings also need checking.
const name='avocado-drill-'+randomBytes(5).toString('hex');
const root=await mkdtemp(path.join(os.tmpdir(),'avocado-drill-'));
const password=randomBytes(24).toString('hex');
const base={...process.env,PGHOST:'127.0.0.1',PGPORT:'55439',PGUSER:'postgres',PGPASSWORD:password,PGDATABASE:'postgres',PGSSLMODE:'disable',PGCONNECT_TIMEOUT:'5'};
const skeleton=`
  CREATE SCHEMA auth; CREATE SCHEMA storage;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
  CREATE TABLE auth.users(id uuid primary key,email text,encrypted_password text);
  CREATE TABLE auth.schema_migrations(version text);
  CREATE TABLE storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  CREATE TABLE storage.objects(id uuid primary key,bucket_id text,name text,updated_at timestamptz,metadata jsonb,version text);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
`;
try {
  await command('docker',['run','--rm','-d','--name',name,'-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1:55439:5432','postgres:18'],{label:'Drill PostgreSQL'});
  let ready=false;
  for(let i=0;i<30;i++) {
    try { await pg(root,'psql',['-X','-q','-c','SELECT 1'],base);ready=true;break; }
    catch { await new Promise(resolve=>setTimeout(resolve,1000)); }
  }
  if(!ready)throw new Error('Drill database failed to start.');
  await pg(root,'psql',['-X','-v','ON_ERROR_STOP=1'],base,`${skeleton}
    CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA private;
    CREATE TABLE public.profiles(id uuid primary key references auth.users(id),role text);
    CREATE TABLE public.farm_documents(storage_path text);
    CREATE TABLE public.shipments(id int primary key,harvest_quantity numeric,containers int,picking_cost numeric);
    CREATE FUNCTION private.farm_role() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT role FROM public.profiles WHERE id=auth.uid() $$;
    REVOKE ALL ON FUNCTION private.farm_role() FROM PUBLIC;GRANT EXECUTE ON FUNCTION private.farm_role() TO authenticated;
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY only_self ON public.profiles TO authenticated USING(id=auth.uid());
    CREATE POLICY farm_read ON storage.objects TO authenticated USING(bucket_id='farm-documents');
    CREATE FUNCTION private.sync_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.profiles VALUES(NEW.id,'viewer');RETURN NEW;END $$;
    CREATE TRIGGER farm_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION private.sync_profile();
    INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001','synthetic@example.invalid','hashed-synthetic-password');
    UPDATE public.profiles SET role='admin';
    INSERT INTO public.shipments VALUES(1,1.25,2,162.50);
    INSERT INTO storage.buckets VALUES('farm-documents','farm-documents',false,10485760,ARRAY['image/jpeg']);
  `);
  const snapshot=new Snapshot(root,base);let info;
  try {
    const id=await snapshot.begin();info=await snapshot.inventory();
    await pg(root,'psql',['-X','-v','ON_ERROR_STOP=1','-c','INSERT INTO public.shipments VALUES(2,9,9,1170)'],base);
    await pg(root,'pg_dump',['--format=custom','--no-owner',`--snapshot=${id}`,`--file=${path.join(root,'database.dump')}`],base);
  } finally { await snapshot.close(); }
  const toc=await pg(root,'pg_restore',['--list',path.join(root,'database.dump')],base);
  await writeFile(path.join(root,'restore.list'),restoreList(toc));
  await writeFile(path.join(root,'managed.sql'),managedCustomizations(info.triggers,info.policies));
  await pg(root,'psql',['-X','-v','ON_ERROR_STOP=1','-c','CREATE DATABASE recovered'],base);
  const target={...base,PGDATABASE:'recovered'};
  await pg(root,'psql',['-X','-v','ON_ERROR_STOP=1'],target,skeleton);
  await restoreArchive(root,path.join(root,'database.dump'),path.join(root,'restore.list'),target);
  await pg(root,'psql',['-X','-v','ON_ERROR_STOP=1','--file',path.join(root,'managed.sql')],target);
  const query=async sql=>(await pg(root,'psql',['-X','-q','-A','-t','-c',sql],target)).trim();
  assert.equal(await query('SELECT picking_cost FROM public.shipments'),'162.50');
  assert.equal(await query('SELECT harvest_quantity FROM public.shipments'),'1.25');
  assert.equal(await query('SELECT containers FROM public.shipments'),'2');
  assert.equal(await query('SELECT role FROM public.profiles'),'admin');
  assert.equal(await query('SELECT encrypted_password FROM auth.users'),'hashed-synthetic-password');
  assert.equal(await query("SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND policyname='farm_read'"),'1');
  assert.equal(await query("SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='only_self'"),'1');
  await pg(root,'psql',['-X','-v','ON_ERROR_STOP=1','-c',"INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000002','another@example.invalid','hash')"],target);
  assert.equal(await query('SELECT count(*) FROM public.profiles'),'2');
  console.log('Synthetic PostgreSQL restore drill passed: users, original roles, fractional quantities, costs, RLS and Auth trigger.');
} finally {
  await command('docker',['rm','-f',name],{label:'Drill cleanup'}).catch(()=>{});
  await rm(root,{recursive:true,force:true});
}
