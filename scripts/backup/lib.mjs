import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const MAGIC = Buffer.from('AVOCADO-BACKUP-01\n');
const HEADER_LENGTH = MAGIC.length + 12;
export function encryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.trim())) throw new Error('BACKUP_ENCRYPTION_KEY must contain a base64-encoded 32-byte key.');
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32) throw new Error('Invalid encryption key length.');
  return key;
}
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function safePath(root, relative) {
  if (!relative || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(relative)) throw new Error('Unsafe backup file path.');
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Backup path escapes its directory.');
  return result;
}
export async function encryptFile(source, target, key) {
  const header = Buffer.concat([MAGIC, randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  cipher.setAAD(header);
  const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  output.write(header);
  try {
    await pipeline(createReadStream(source), cipher, new Transform({
      transform(chunk, encoding, callback) { callback(null, chunk); },
      flush(callback) { this.push(cipher.getAuthTag()); callback(); },
    }), output);
  } catch (error) { await rm(target, { force: true }); throw error; }
}
export async function decryptFile(source, target, key) {
  const temporary = target + '.partial-' + randomBytes(6).toString('hex');
  const handle = await open(source, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size < HEADER_LENGTH + 16) throw new Error('Truncated backup.');
    const header = Buffer.alloc(HEADER_LENGTH), tag = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unknown backup format.');
    await handle.read(tag, 0, 16, size - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
    decipher.setAAD(header); decipher.setAuthTag(tag);
    const input = size === HEADER_LENGTH + 16 ? (await import('node:stream')).Readable.from([]) : createReadStream(source, { start: HEADER_LENGTH, end: size - 17 });
    await pipeline(input, decipher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    // Never overwrite a previously recovered archive.
    const existing = await stat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (existing) throw new Error('Recovery output already exists.');
    await rename(temporary, target);
  } finally { await handle.close(); await rm(temporary, { force: true }); }
}

// Child stderr is deliberately not forwarded: DB clients and HTTP tools can
// include connection credentials or tokens in their error messages.
export async function command(program, args, { env = process.env, input, cwd, label = program, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const parts = []; let size = 0, databaseHint = '';
    child.stdout.on('data', chunk => { size += chunk.length; if (size < 64 * 1024 * 1024) parts.push(chunk); else child.kill(); });
    child.stderr.on('data', chunk => {
      if(label==='pg_restore'||label==='psql') {
        const text=chunk.toString('utf8');
        // Whitelisted metadata-only diagnostics, never COPY rows, SQL statements,
        // connection URLs, passwords, request headers or database error DETAIL.
        const match=text.match(/(?:ERROR|FATAL):\s*((?:permission denied|must be owner|unsupported startup parameter|invalid startup parameter|unrecognized configuration parameter|schema |relation |role |type |column |function |extension |could not access file|syntax error|cannot |invalid input syntax|duplicate key|insert or update|no pg_hba.conf|password authentication failed|Tenant or user not found|remaining connection slots|new row)[^\r\n]*)/);
        if(match) {
          let hint=match[1].replace(/'[^']*'/g,"'<redacted>'");
          for(const [name,value] of Object.entries(env)) if(value && /PASSWORD|SECRET|TOKEN|ENCRYPTION_KEY/.test(name)) hint=hint.replaceAll(value,'<redacted>');
          databaseHint=hint.slice(0,220);
        }
      }
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error(`${label} could not start.`)); });
    child.on('close', code => { clearTimeout(timer); return code === 0 ? resolve(Buffer.concat(parts).toString('utf8')) : reject(new Error(`${label} failed (exit ${code}). ${databaseHint||'Check the configured credentials, connectivity and tool version.'}`)); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function pgCommand(root, tool, args = [], env = process.env) {
  const keys = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGCONNECT_TIMEOUT', 'PGOPTIONS'];
  return { program: 'docker', args: ['run', '--rm', '-i', '--network=host', '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, ...keys.flatMap(k => ['--env', k]), '--volume', `${root}:${root}`, 'postgres:18', tool, ...args], env };
}
export async function pg(root, tool, args, env, input) {
  const spec = pgCommand(root, tool, args, env);
  return command(spec.program, spec.args, { env, input, label: tool });
}
export function quoteIdentifier(value) { return '"' + value.replaceAll('"', '""') + '"'; }

export function restoreList(toc) {
  const lines = toc.split('\n').filter(line => {
    if (!/^\d+;/.test(line)) return false;
    if (/ SCHEMA - public /.test(line)) return false; // Fresh Supabase already has public.
    if (/ SCHEMA - private /.test(line)) return true;
    if (/ (public|private) /.test(line)) return true;
    return / TABLE DATA auth /.test(line) && !/ TABLE DATA auth schema_migrations /.test(line);
  });
  if (!lines.some(l => / TABLE public profiles /.test(l)) || !lines.some(l => / TABLE DATA auth users /.test(l))) throw new Error('Archive is missing application or Auth data.');
  return lines.join('\n') + '\n';
}
export function managedCustomizations(triggers, policies) {
  const sql = [...triggers];
  for (const p of policies) {
    const table = `${quoteIdentifier(p.schemaname)}.${quoteIdentifier(p.tablename)}`;
    const roles = p.roles.map(r => r === 'public' ? 'PUBLIC' : quoteIdentifier(r)).join(',');
    sql.push(`CREATE POLICY ${quoteIdentifier(p.policyname)} ON ${table} AS ${p.permissive} FOR ${p.cmd} TO ${roles}${p.qual ? ` USING (${p.qual})` : ''}${p.with_check ? ` WITH CHECK (${p.with_check})` : ''};`);
  }
  return sql.join('\n') + '\n';
}
export async function verifyBundle(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid backup manifest.');
  for (const file of manifest.files) {
    const target = safePath(root, file.path);
    if ((await stat(target)).size !== file.bytes || await digest(target) !== file.sha256) throw new Error('Backup integrity check failed.');
  }
  return manifest;
}
export function storageUrl(base, bucket, name) {
  return `${base}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${name.split('/').map(encodeURIComponent).join('/')}`;
}
export function apiHeaders(key) { return { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) }; }
