import { spawn } from 'node:child_process';
import { pgCommand, quoteIdentifier, managedCustomizations } from './lib.mjs';

// One read-only repeatable-read transaction holds the exported snapshot while
// pg_dump and the inventory use it. Writes on the live site remain possible.
export class Snapshot {
  constructor(root, env) {
    const spec = pgCommand(root, 'psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], env);
    this.child = spawn(spec.program, spec.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = ''; this.pending = null; this.ended = false;
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      if (this.pending && this.buffer.includes('\n__AVOCADO_QUERY_END__\n')) {
        const [result, rest] = this.buffer.split('\n__AVOCADO_QUERY_END__\n'); this.buffer = rest;
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(result.trim());
      }
    });
    this.child.stderr.resume(); this.child.stdin.on('error', () => {});
    const fail = () => {
      this.ended = true;
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Database snapshot failed. Verify BACKUP_DB_HOST, BACKUP_DB_USER and BACKUP_DB_PASSWORD; use session pooler port 5432.')); this.pending = null; }
    };
    this.child.on('error', fail); this.child.on('close', fail);
  }
  query(sql) {
    if (this.pending || this.ended) throw new Error('Snapshot connection unavailable.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill(); reject(new Error('Database snapshot query timed out.')); }, 120000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(`${sql};\nSELECT '__AVOCADO_QUERY_END__';\n`);
    });
  }
  async begin() {
    const snapshot = await this.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot()');
    if (!/^[0-9A-Fa-f-]+$/.test(snapshot)) throw new Error('Invalid database snapshot identifier.');
    return snapshot;
  }
  async inventory() {
    const info = JSON.parse(await this.query(`SELECT jsonb_build_object(
      'serverVersion',current_setting('server_version'),
      'tables',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private','auth') AND c.relkind IN ('r','p') AND NOT (n.nspname='auth' AND c.relname='schema_migrations')),
      'objects',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'bucket',bucket_id,'name',name,'updated_at',updated_at,'version',to_jsonb(o)->>'version','metadata',metadata)) FROM storage.objects o),'[]'::jsonb),
      'buckets',COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM storage.buckets b),'[]'::jsonb),
      'documents',COALESCE((SELECT jsonb_agg(storage_path) FROM public.farm_documents),'[]'::jsonb),
      'triggers',COALESCE((SELECT jsonb_agg(pg_get_triggerdef(t.oid)||';') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc f ON f.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=f.pronamespace WHERE NOT t.tgisinternal AND n.nspname IN ('auth','storage') AND fn.nspname IN ('public','private')),'[]'::jsonb),
      'policies',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p WHERE schemaname IN ('auth','storage')),'[]'::jsonb),
      'extensions',(SELECT jsonb_agg(jsonb_build_object('name',extname,'version',extversion)) FROM pg_extension),
      'roles',(SELECT jsonb_agg(rolname) FROM pg_roles WHERE rolname !~ '^pg_')
    )`));
    info.counts = [];
    for (const table of info.tables ?? []) {
      const count = await this.query(`SELECT count(*) FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`);
      info.counts.push({ ...table, count: Number(count) });
    }
    const objectPaths = new Set(info.objects.filter(o => o.bucket === 'farm-documents').map(o => o.name));
    if (info.documents.some(p => !objectPaths.has(p))) throw new Error('A document references a missing Storage object. Backup is incomplete; repair the missing attachment first.');
    info.managedSql = managedCustomizations(info.triggers, info.policies);
    return info;
  }
  async close() {
    if (!this.ended) { this.child.stdin.end('ROLLBACK;\n\\q\n'); }
  }
}
