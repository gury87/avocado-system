import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { command, decryptFile, encryptionKey, verifyBundle } from './lib.mjs';

// Decryption only: this command does not connect to any database or cloud.
const [source, target] = process.argv.slice(2);
let temporary;
try {
  if (!source || !target) throw new Error('Usage: node scripts/backup/recover.mjs <file.avbackup> <new-output-directory>');
  if (await stat(target).catch(e => { if(e.code!=='ENOENT') throw e; return null; })) throw new Error('Output directory already exists. Choose a new directory.');
  temporary=await mkdtemp(path.join(os.tmpdir(),'avocado-recover-'));
  const archive=path.join(temporary,'backup.tar.gz');
  await decryptFile(path.resolve(source),archive,encryptionKey(process.env.BACKUP_ENCRYPTION_KEY));
  const names=(await command('tar',['-tzf',archive])).split(/\r?\n/).filter(Boolean);
  if(names.some(n=>n.startsWith('/')||n.includes('\\')||n.split('/').includes('..'))) throw new Error('Unsafe archive paths.');
  await mkdir(target,{mode:0o700});
  try {
    await command('tar',['-xzf',archive,'-C',path.resolve(target)]);
    const manifest=await verifyBundle(path.resolve(target));
    console.log(`Recovery package verified. Created UTC: ${manifest.createdAt}; code commit: ${manifest.commit}.`);
    console.log('No database was modified. Read BACKUP_SETUP.md in the recovered directory for the isolated restore procedure.');
  } catch(error) { await rm(target,{recursive:true,force:true}); throw error; }
} catch(error) { console.error(error instanceof Error?error.message:'Recovery failed.');process.exitCode=1; }
finally { if(temporary) await rm(temporary,{recursive:true,force:true}); }
