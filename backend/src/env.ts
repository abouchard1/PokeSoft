import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';

// Load env files into process.env before any other module reads them. Keep this
// as the very FIRST import in index.ts — ESM evaluates imported modules in
// order, so this side effect must run before the stores that read their
// paths/secrets at module load.
//
// cwd is backend/ at runtime, so `backend/.env` is the canonical location, but a
// `.env` at the repo root is accepted too (it's the natural place to drop it and
// was silently ignored before — Gmail/smspool/Anti-Captcha all looked
// "non configuré"). backend/.env is loaded first and wins: loadEnvFile never
// overrides a variable that is already set (shell vars win over both).
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
];

const loaded: string[] = [];
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
    loaded.push(file);
  } catch (err) {
    console.warn(`[env] impossible de lire ${file}:`, (err as Error).message);
  }
}
if (loaded.length) console.log(`[env] chargé: ${loaded.join(', ')}`);
else console.warn('[env] aucun fichier .env trouvé (backend/.env ou ./.env) — variables du shell uniquement');
