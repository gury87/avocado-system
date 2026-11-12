import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiHeaders, pg, quoteIdentifier, storageUrl, verifyBundle } from './lib.mjs';

let stage='validation',root;
try {
  const [folder,confirmation]=process.argv.slice(2);
  if(!folder) throw new Error('Supply a verified backup bundle.');
  root=path.resolve(folder);const manifest=await verifyBundle(root);
  const base=process.env.RESTORE_SUPABASE_URL?.replace(/\/$/,''),url=new URL(base),ref=url.hostname.split('.')[0];
  if(!manifest.projectRef||url.protocol!=='https:'||!/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)||ref===manifest.projectRef||confirmation!==`--confirm-restored-project=${ref}`) throw new Error('Verification requires the separate test project.');
  if(process.env.RESTORE_DB_USER!==`postgres.${ref}`||!/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(process.env.RESTORE_DB_HOST)) throw new Error('Test database and API URL do not match.');
  const env={...process.env,PGHOST:process.env.RESTORE_DB_HOST,PGPORT:'5432',PGUSER:process.env.RESTORE_DB_USER,PGPASSWORD:process.env.RESTORE_DB_PASSWORD,PGDATABASE:'postgres',PGSSLMODE:'require',PGCONNECT_TIMEOUT:'30'};
  const query=async sql=>(await pg(root,'psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',sql],env)).trim();
  stage='restored data inventory';
  // Auth session/audit tables change as soon as an actual sign-in is tested.
  const tables=manifest.inventory.counts.filter(t=>t.schema!=='auth'||['users','identities','mfa_factors'].includes(t.name));
  if(!tables.length) throw new Error('Backup inventory is empty.');
  const countSql=tables.map((t,i)=>`SELECT ${i} AS id,count(*)::text AS count FROM ${quoteIdentifier(t.schema)}.${quoteIdentifier(t.name)}`).join(' UNION ALL ');
  const actual=JSON.parse(await query(`SELECT jsonb_agg(c) FROM (${countSql}) c`));
  if(actual.length!==tables.length||actual.some(c=>Number(c.count)!==tables[c.id]?.count)) throw new Error('Test-project business data does not match this backup. Verification refused.');

  stage='Auth sequence verification';
  const toc=await pg(root,'pg_restore',['--list',path.join(root,'database.dump')],env);
  const sequences=toc.split('\n').filter(l=>/^\d+;/.test(l)&&/ SEQUENCE SET auth /.test(l));
  let sequencesChecked=0;
  if(sequences.length) {
    const list=path.join(root,'.auth-sequences.list'),sql=path.join(root,'.auth-sequences.sql');
    try {
      await writeFile(list,sequences.join('\n')+'\n',{mode:0o600});
      await pg(root,'pg_restore',[`--use-list=${list}`,`--file=${sql}`,path.join(root,'database.dump')],env);
      const text=await readFile(sql,'utf8');
      const seeds=[...text.matchAll(/SELECT pg_catalog\.setval\('auth\.([A-Za-z_][A-Za-z0-9_]*)',\s*(\d+),\s*(true|false)\);/g)];
      if(seeds.length!==sequences.length) throw new Error('Could not safely parse all Auth sequence snapshots.');
      for(const [,name,value,called] of seeds) {
        const current=JSON.parse(await query(`SELECT jsonb_build_object('value',last_value::text,'called',is_called) FROM auth.${quoteIdentifier(name)}`));
        // Older archives omitted Auth sequence SET entries from their restore
        // list. Advance missing counters only, never rewind an active counter.
        if(BigInt(current.value)<BigInt(value)||(current.value===value&&!current.called&&called==='true')) await query(`SELECT pg_catalog.setval('auth.${name}',${value},${called})`);
        sequencesChecked++;
      }
    } finally {await rm(list,{force:true});await rm(sql,{force:true});}
  }

  const key=process.env.RESTORE_SUPABASE_SECRET_KEY,serviceHeaders=apiHeaders(key);
  async function jsonRequest(endpoint,headers,body,method=body===undefined?'GET':'POST') {
    const response=await fetch(base+endpoint,{method,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(60000)});
    const data=await response.json().catch(()=>null);
    return {ok:response.ok,status:response.status,data};
  }
  stage='Storage content verification';
  for(const object of manifest.inventory.objects) {
    const response=await fetch(storageUrl(base,object.bucket,object.name),{headers:serviceHeaders,redirect:'error',signal:AbortSignal.timeout(120000)});
    if(!response.ok) {await response.body?.cancel();throw new Error('A restored Storage file is unavailable.');}
    const hash=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    if(hash!==manifest.files.find(f=>f.path===object.file)?.sha256) throw new Error('A restored file differs from the backup.');
  }

  stage='Auth sign-in and role checks';
  const profiles=JSON.parse(await query("SELECT COALESCE(jsonb_agg(p),'[]'::jsonb) FROM (SELECT DISTINCT ON(role) id,email,role FROM public.profiles WHERE is_active AND email<>'' ORDER BY role,id) p"));
  if(!profiles.some(p=>p.role==='admin')) throw new Error('No active restored administrator.');
  const roles=[];let imageVerified=false;
  for(const profile of profiles) {
    // Admin generate_link creates a one-time token without sending email. The
    // token is exchanged privately and never logged or exported as an artifact.
    const generated=await jsonRequest('/auth/v1/admin/generate_link',serviceHeaders,{type:'magiclink',email:profile.email});
    const tokenHash=generated.data?.hashed_token??generated.data?.properties?.hashed_token;
    if(!generated.ok||!tokenHash) throw new Error('Auth could not generate the test-only sign-in token.');
    const session=await jsonRequest('/auth/v1/verify',serviceHeaders,{token_hash:tokenHash,type:generated.data.verification_type||'magiclink'});
    if(!session.ok||!session.data?.access_token||session.data.user?.id!==profile.id) throw new Error('Restored account sign-in failed.');
    const headers={apikey:key,Authorization:`Bearer ${session.data.access_token}`};
    try {
      const visible=await jsonRequest('/rest/v1/profiles?select=id,role,is_active',headers);
      if(!visible.ok||!Array.isArray(visible.data)||!visible.data.some(p=>p.id===profile.id&&p.role===profile.role)) throw new Error('Restored user profile is not accessible.');
      if(profile.role!=='admin'&&(visible.data.length!==1||visible.data[0].id!==profile.id)) throw new Error('Non-admin profile isolation failed.');
      const catalog=await jsonRequest('/rest/v1/rpc/get_farm_catalog',headers,{});
      if(!catalog.ok||!Array.isArray(catalog.data?.plots)) throw new Error('Authenticated catalog access failed.');
      const reports=await jsonRequest('/rest/v1/rpc/get_farm_reports',headers,{});
      if(profile.role==='admin') {
        const expected=manifest.inventory.counts.find(t=>t.schema==='public'&&t.name==='harvest_events')?.count;
        if(!reports.ok||reports.data?.shipments?.length!==expected) throw new Error('Administrator reports do not match the restored inventory.');
      } else if(reports.ok||reports.data?.message!=='FORBIDDEN') throw new Error('Non-admin report access was not rejected correctly.');
      const object=manifest.inventory.objects[0];
      if(object) {
        const signed=await jsonRequest(`/storage/v1/object/sign/${encodeURIComponent(object.bucket)}/${object.name.split('/').map(encodeURIComponent).join('/')}`,headers,{expiresIn:60});
        if(profile.role==='admin') {
          const signedPath=signed.data?.signedURL??signed.data?.signedUrl;
          if(!signed.ok||typeof signedPath!=='string') throw new Error('Administrator image signing failed.');
          const signedUrl=signedPath.startsWith('http')?new URL(signedPath):new URL(base+'/storage/v1'+signedPath);
          if(signedUrl.origin!==url.origin) throw new Error('Signed image URL points outside the test project.');
          const image=await fetch(signedUrl,{redirect:'error',signal:AbortSignal.timeout(120000)});
          if(!image.ok) {await image.body?.cancel();throw new Error('Signed image viewing failed.');}
          const hash=createHash('sha256').update(Buffer.from(await image.arrayBuffer())).digest('hex');
          if(hash!==manifest.files.find(f=>f.path===object.file)?.sha256) throw new Error('Signed image content differs.');
          imageVerified=true;
        } else if(signed.ok||![400,401,403,404].includes(signed.status)) throw new Error('Non-admin image access was not rejected correctly.');
      }
      roles.push(profile.role);
    } finally {await jsonRequest('/auth/v1/logout?scope=local',headers,{}).catch(()=>{});}
  }
  await writeFile(path.join(root,'restore-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),targetProject:ref,databaseRowsVerified:true,storageFilesVerified:manifest.inventory.objects.length,authSequencesChecked:sequencesChecked,authRolesChecked:roles,signedImageVerified:imageVerified,applicationChecksRequired:true},null,2));
  console.log(`SUCCESS: verified test-project sign-in and permissions for roles ${roles.join(', ')}; Storage files: ${manifest.inventory.objects.length}.`);
} catch(error) {
  const message=error instanceof Error?error.message:'Unexpected error.';
  if(root)await writeFile(path.join(root,'.restore-failure.json'),JSON.stringify({stage,message})).catch(()=>{});
  console.error(`Test verification FAILED at ${stage}: ${message}`);process.exitCode=1;
}
