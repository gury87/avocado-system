import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function load(file, { env = {}, fetch = () => { throw new Error('Unexpected network access'); }, imports = {} } = {}) {
  const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, process: { env }, fetch, Response, AbortSignal, URL, Date, Error,
    require: name => { if (name === 'server-only') return {}; if (imports[name]) return imports[name]; throw new Error('Unexpected import ' + name); } });
  return exports;
}
const env = { VERCEL_ENV: 'production', BACKUP_GITHUB_TOKEN: 'fake-server-token', BACKUP_SITE_PROJECT_REF: 'productionref', NEXT_PUBLIC_SUPABASE_URL: 'https://productionref.supabase.co' };
const raw = (id, status, conclusion) => ({ id, run_number: id, run_attempt: 2, status, conclusion, created_at: '2026-11-13T01:00:00Z', run_started_at: '2026-11-13T03:00:00Z', updated_at: '2026-11-13T03:05:00Z', event: 'schedule', html_url: 'https://untrusted.invalid' });

test('The real admin guard validates identity and active admin role on every request', async () => {
  for (const profile of [null, { role: 'worker', is_active: true }, { role: 'viewer', is_active: true }, { role: 'admin', is_active: false }, { role: 'admin', is_active: true }]) {
    let verified = false;
    const guard = await load('app/lib/admin-server.ts', { imports: { '@supabase/supabase-js': { createClient: () => ({
      auth: { getUser: async () => { verified = true; return { data: { user: { id: 'verified-user' } } }; } },
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: profile }) }) }) }),
    }) } } });
    const req = new Request('https://site.invalid/api/backups', { headers: { Authorization: 'Bearer fake-user-token' } });
    if (profile?.role === 'admin' && profile.is_active) assert.equal((await guard.requireAdmin(req)).user.id, 'verified-user');
    else await assert.rejects(guard.requireAdmin(req), /FORBIDDEN/);
    assert.equal(verified, true);
    await assert.rejects(guard.requireAdmin(new Request('https://site.invalid/api/backups')), /UNAUTHORIZED/);
  }
});

test('Admin API rejects unauthenticated, worker and blocked callers before touching GitHub', async () => {
  for (const code of ['UNAUTHORIZED', 'FORBIDDEN']) {
    let touched = false;
    const service = await load('app/lib/backup-server.ts');
    const route = await load('app/api/backups/route.ts', { imports: {
      '@/app/lib/admin-server': { requireAdmin: async () => { throw new Error(code); } },
      '@/app/lib/backup-server': { ...service, backupOverview: () => { touched = true; }, startBackup: () => { touched = true; } },
    } });
    for (const method of ['GET', 'POST']) {
      const result = await route[method](new Request('https://site.invalid/api/backups', { method }));
      assert.equal(result.status, code === 'UNAUTHORIZED' ? 401 : 403);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    assert.equal(touched, false);
  }
});

test('History retains a previous successful backup after failure and returns only safe metadata', async () => {
  const calls = [];
  const service = await load('app/lib/backup-server.ts', { env, fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ workflow_runs: url.includes('status=success') ? [raw(1, 'completed', 'success')] : [raw(2, 'completed', 'failure'), raw(1, 'completed', 'success')] });
  } });
  const result = await service.backupOverview();
  assert.equal(result.lastSuccess.id, 1); assert.equal(result.runs[0].conclusion, 'failure');
  assert.equal(result.canStart, true); assert.equal(result.active, false);
  assert.equal(result.runs[0].createdAt, '2026-11-13T03:00:00Z');
  assert.equal(result.runs[0].url, 'https://github.com/gury87/avocado-system/actions/runs/2');
  assert.ok(!JSON.stringify(result).includes(env.BACKUP_GITHUB_TOKEN));
  assert.ok(calls.every(c => c.options.cache === 'no-store' && c.options.headers.Authorization === 'Bearer fake-server-token'));
});

test('Manual backup dispatch uses fixed workflow and branch; active backup prevents a duplicate dispatch', async () => {
  for (const running of [false, true]) {
    const calls = [];
    const service = await load('app/lib/backup-server.ts', { env, fetch: async (url, options) => {
      calls.push({ url, options });
      return options.method === 'POST' ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: url.includes('status=success') ? [] : running ? [raw(3, 'queued', null)] : [] });
    } });
    const result = await service.startBackup();
    assert.equal(result.accepted, !running);
    const posts = calls.filter(c => c.options.method === 'POST');
    assert.equal(posts.length, running ? 0 : 1);
    if (!running) {
      assert.equal(posts[0].url, 'https://api.github.com/repos/gury87/avocado-system/actions/workflows/backup.yml/dispatches');
      assert.deepEqual(JSON.parse(posts[0].options.body), { ref: 'main', inputs: { reason: 'manual' } });
    }
  }
});

test('Manual backups are disabled in preview, missing configuration and a different Supabase project', async () => {
  for (const changes of [{ VERCEL_ENV: 'preview' }, { BACKUP_GITHUB_TOKEN: '' }, { BACKUP_SITE_PROJECT_REF: '' }, { NEXT_PUBLIC_SUPABASE_URL: 'https://testref.supabase.co' }]) {
    const service = await load('app/lib/backup-server.ts', { env: { ...env, ...changes } });
    assert.equal(service.backupCanStart(), false);
    await assert.rejects(service.startBackup(), /BACKUP_CONFIG/);
  }
});

test('GitHub errors never expose credential, response body or falsely report dispatch success', async () => {
  for (const failure of [401, 500, 'timeout']) {
    const service = await load('app/lib/backup-server.ts', { env, fetch: async (_url, options) => {
      if (options.method !== 'POST') return Response.json({ workflow_runs: [] });
      if (failure === 'timeout') throw new Error('fake-server-token');
      return new Response('private diagnostic fake-server-token', { status: failure });
    } });
    try { await service.startBackup(); assert.fail('Must reject'); }
    catch (error) {
      const response = service.backupError(error);
      assert.ok(response.status >= 500);
      const text = await response.text();
      assert.ok(!text.includes('fake-server-token')); assert.ok(!text.includes('private diagnostic'));
      if (failure === 'timeout') assert.match(text, /ייתכן/);
    }
  }
});
