import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { request } from 'playwright';

export interface ProxyEntry {
  id: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  ip?: string;
  error?: string;
}

export interface ProxyTestRecord extends ProxyTestResult {
  testedAt: number;
}

export interface ProxyPublic {
  id: string;
  host: string;
  port: number;
  label: string;
  lastTest?: ProxyTestRecord;
}

const DEFAULT_FILE = resolve(process.cwd(), '..', 'Webshare 100 proxies.txt');
const DEFAULT_STATE = resolve(process.cwd(), '..', 'data', 'proxies-state.json');

interface PersistedState {
  deleted: string[];
  lastTests: Record<string, ProxyTestRecord>;
}

function parse(content: string): ProxyEntry[] {
  const entries: ProxyEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 4) continue;
    const [host, portStr, username, password] = parts;
    const port = Number(portStr);
    if (!host || !Number.isFinite(port) || !username || !password) continue;
    entries.push({ id: String(i + 1), host, port, username, password });
  }
  return entries;
}

class ProxyStore {
  private entries: ProxyEntry[] = [];
  private deleted = new Set<string>();
  private lastTests = new Map<string, ProxyTestRecord>();
  private path = process.env.PROXY_FILE ?? DEFAULT_FILE;
  private statePath = process.env.PROXY_STATE_FILE ?? DEFAULT_STATE;

  constructor() {
    this.load();
    this.loadState();
  }

  private load() {
    if (!existsSync(this.path)) {
      this.entries = [];
      return;
    }
    this.entries = parse(readFileSync(this.path, 'utf8'));
  }

  private loadState() {
    if (!existsSync(this.statePath)) return;
    try {
      const parsed: PersistedState = JSON.parse(readFileSync(this.statePath, 'utf8'));
      this.deleted = new Set(parsed.deleted ?? []);
      this.lastTests = new Map(Object.entries(parsed.lastTests ?? {}));
    } catch {
      // ignore corrupt state
    }
  }

  private persistState() {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const data: PersistedState = {
      deleted: Array.from(this.deleted),
      lastTests: Object.fromEntries(this.lastTests),
    };
    writeFileSync(this.statePath, JSON.stringify(data, null, 2), 'utf8');
  }

  list(): ProxyPublic[] {
    return this.entries
      .filter((e) => !this.deleted.has(e.id))
      .map((e) => ({
        id: e.id,
        host: e.host,
        port: e.port,
        label: `${e.host}:${e.port}`,
        lastTest: this.lastTests.get(e.id),
      }));
  }

  get(id: string): ProxyEntry | undefined {
    if (this.deleted.has(id)) return undefined;
    return this.entries.find((e) => e.id === id);
  }

  delete(id: string): boolean {
    if (!this.entries.some((e) => e.id === id)) return false;
    this.deleted.add(id);
    this.persistState();
    return true;
  }

  size() {
    return this.list().length;
  }

  async test(id: string): Promise<ProxyTestRecord> {
    const entry = this.get(id);
    if (!entry) {
      const record: ProxyTestRecord = {
        ok: false,
        error: `unknown proxy id: ${id}`,
        testedAt: Date.now(),
      };
      return record;
    }

    const started = Date.now();
    let result: ProxyTestResult;
    try {
      const ctx = await request.newContext({
        proxy: {
          server: `http://${entry.host}:${entry.port}`,
          username: entry.username,
          password: entry.password,
        },
        timeout: 15000,
      });
      const res = await ctx.get('https://api.ipify.org?format=json');
      const status = res.status();
      const body = await res.text();
      await ctx.dispose();
      const latencyMs = Date.now() - started;

      if (!res.ok()) {
        result = { ok: false, latencyMs, status, error: `HTTP ${status}: ${body.slice(0, 200)}` };
      } else {
        let ip: string | undefined;
        try {
          ip = JSON.parse(body)?.ip;
        } catch {
          // ignore
        }
        result = { ok: true, latencyMs, status, ip };
      }
    } catch (err) {
      result = { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
    }

    const record: ProxyTestRecord = { ...result, testedAt: Date.now() };
    this.lastTests.set(id, record);
    this.persistState();
    return record;
  }
}

export const proxyStore = new ProxyStore();
