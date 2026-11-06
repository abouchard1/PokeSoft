import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { proxyStore } from './proxies.js';
import {
  generateFingerprint,
  fingerprintSummary,
  MAX_VIEWPORT,
  type Fingerprint,
} from './fingerprint.js';

export interface Account {
  id: string;
  nom: string;
  prenom: string;
  email: string;
  password: string;
  adresse: string;
  telephone: string;
  proxyId?: string;
  lastUsedAt?: number;
  fingerprint?: Fingerprint;
  /** Off = parked: hidden from the invitation selection and refused by runs.
   *  Nothing is deleted — flip it back on to use the account again. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AccountInput = Omit<
  Account,
  'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'fingerprint' | 'enabled'
>;

export interface AccountPublic extends Account {
  hasStore: boolean;
  proxyLabel?: string;
  fingerprintSummary?: string;
}

const DEFAULT_PATH = resolve(process.cwd(), '..', 'data', 'accounts.json');
const PROFILES_ROOT =
  process.env.PROFILES_DIR ?? resolve(process.cwd(), '..', 'data', 'playwright-profiles');

class AccountsStore {
  private path = process.env.ACCOUNTS_FILE ?? DEFAULT_PATH;
  private accounts: Account[] = [];

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) {
      this.accounts = [];
      return;
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.accounts = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.accounts = [];
    }
    let dirty = false;
    for (const a of this.accounts) {
      if (!a.fingerprint) {
        a.fingerprint = generateFingerprint();
        dirty = true;
      }
      // Older fingerprints could be 1920/2560 wide — too big for the headed
      // window on a small screen. Clamp the viewport (keep GPU/OS/UA intact).
      const vp = a.fingerprint.viewport;
      if (vp.width > MAX_VIEWPORT.width || vp.height > MAX_VIEWPORT.height) {
        a.fingerprint.viewport = {
          width: Math.min(vp.width, MAX_VIEWPORT.width),
          height: Math.min(vp.height, MAX_VIEWPORT.height),
        };
        dirty = true;
      }
      if (typeof a.password !== 'string') {
        a.password = '';
        dirty = true;
      }
      // Accounts saved before the on/off toggle existed are active.
      if (typeof a.enabled !== 'boolean') {
        a.enabled = true;
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.accounts, null, 2), 'utf8');
  }

  private enrich(a: Account): AccountPublic {
    const proxy = a.proxyId ? proxyStore.get(a.proxyId) : undefined;
    return {
      ...a,
      hasStore: existsSync(join(PROFILES_ROOT, a.id)),
      proxyLabel: proxy ? `${proxy.host}:${proxy.port}` : undefined,
      fingerprintSummary: a.fingerprint ? fingerprintSummary(a.fingerprint) : undefined,
    };
  }

  list(): AccountPublic[] {
    return [...this.accounts]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => this.enrich(a));
  }

  get(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  create(input: AccountInput): AccountPublic {
    const now = Date.now();
    const account: Account = {
      id: randomUUID(),
      nom: input.nom.trim(),
      prenom: input.prenom.trim(),
      email: (input.email ?? '').trim(),
      password: input.password ?? '',
      adresse: (input.adresse ?? '').trim(),
      telephone: (input.telephone ?? '').trim(),
      proxyId: input.proxyId?.trim() || undefined,
      fingerprint: generateFingerprint(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.push(account);
    this.persist();
    return this.enrich(account);
  }

  regenerateFingerprint(id: string): AccountPublic | undefined {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    this.accounts[idx].fingerprint = generateFingerprint();
    this.accounts[idx].updatedAt = Date.now();
    this.persist();
    return this.enrich(this.accounts[idx]);
  }

  update(
    id: string,
    patch: Partial<AccountInput> & { enabled?: boolean }
  ): AccountPublic | undefined {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    const current = this.accounts[idx];
    const next: Account = {
      ...current,
      nom: patch.nom?.trim() ?? current.nom,
      prenom: patch.prenom?.trim() ?? current.prenom,
      email: patch.email?.trim() ?? current.email,
      password: patch.password ?? current.password,
      adresse: patch.adresse?.trim() ?? current.adresse,
      telephone: patch.telephone?.trim() ?? current.telephone,
      proxyId:
        patch.proxyId === undefined ? current.proxyId : patch.proxyId?.trim() || undefined,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      updatedAt: Date.now(),
    };
    this.accounts[idx] = next;
    this.persist();
    return this.enrich(next);
  }

  touch(id: string) {
    const acc = this.accounts.find((a) => a.id === id);
    if (!acc) return;
    acc.lastUsedAt = Date.now();
    this.persist();
  }

  delete(id: string): boolean {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length === before) return false;
    this.persist();
    return true;
  }
}

export const accountsStore = new AccountsStore();
