import process from 'node:process';

// Load backend/.env (cwd is backend/ at runtime) into process.env before any
// other module reads it. Keep this as the very FIRST import in index.ts — ESM
// evaluates imported modules in order, so this side effect must run before the
// stores that read their paths/secrets at module load.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — env vars come from the shell. That's fine.
}
