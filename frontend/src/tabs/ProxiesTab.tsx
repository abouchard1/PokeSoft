import { useEffect, useState } from 'react';
import { RotateCw, Trash2 } from 'lucide-react';

interface ProxyTestRecord {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  ip?: string;
  error?: string;
  testedAt: number;
}

interface ProxyPublic {
  id: string;
  host: string;
  port: number;
  label: string;
  lastTest?: ProxyTestRecord;
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}j`;
}

const CONCURRENCY = 8;

export default function ProxiesTab() {
  const [proxies, setProxies] = useState<ProxyPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [testAll, setTestAll] = useState<{ done: number; total: number } | null>(null);

  function markBusy(id: string, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function refresh() {
    const list: ProxyPublic[] = await fetch('/api/proxies').then((r) => r.json());
    setProxies(list);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function testOne(id: string) {
    markBusy(id, true);
    try {
      const record: ProxyTestRecord = await fetch(`/api/proxies/${id}/test`).then((r) => r.json());
      setProxies((list) => list.map((p) => (p.id === id ? { ...p, lastTest: record } : p)));
    } finally {
      markBusy(id, false);
    }
  }

  async function testAllProxies() {
    if (testAll) return;
    const ids = proxies.map((p) => p.id);
    if (ids.length === 0) return;
    setTestAll({ done: 0, total: ids.length });

    let cursor = 0;
    let done = 0;

    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        await testOne(id);
        done++;
        setTestAll((s) => (s ? { ...s, done } : s));
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker());
    await Promise.all(workers);
    setTestAll(null);
  }

  async function remove(id: string) {
    if (!confirm(`Supprimer le proxy #${id} de la liste ?`)) return;
    await fetch(`/api/proxies/${id}`, { method: 'DELETE' });
    setProxies((list) => list.filter((p) => p.id !== id));
  }

  return (
    <section className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="font-medium">Proxys ({proxies.length})</h2>
        <div className="flex items-center gap-3">
          {testAll && (
            <span className="text-xs text-zinc-400">
              {testAll.done} / {testAll.total}
            </span>
          )}
          <button
            onClick={testAllProxies}
            disabled={!!testAll || proxies.length === 0}
            className="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white"
          >
            {testAll ? 'test en cours…' : 'Tester tous'}
          </button>
        </div>
      </div>
      {loading ? (
        <p className="p-4 text-zinc-500 text-sm">Chargement…</p>
      ) : proxies.length === 0 ? (
        <p className="p-4 text-zinc-500 text-sm">Aucun proxy chargé.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-950/50 text-zinc-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">#</th>
                <th className="text-left px-4 py-2 font-medium">IP</th>
                <th className="text-left px-4 py-2 font-medium">Port</th>
                <th className="text-left px-4 py-2 font-medium">Dernier test</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((p) => {
                const t = p.lastTest;
                return (
                  <tr key={p.id} className="border-t border-zinc-800 hover:bg-zinc-800/30">
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500">{p.id}</td>
                    <td className="px-4 py-2 font-mono">{p.host}</td>
                    <td className="px-4 py-2 font-mono text-zinc-400">{p.port}</td>
                    <td className="px-4 py-2">
                      {!t ? (
                        <span className="text-zinc-600 text-xs">jamais testé</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block w-2 h-2 rounded-full ${
                              t.ok ? 'bg-emerald-500' : 'bg-red-500'
                            }`}
                          />
                          <span className="text-xs text-zinc-300">
                            {t.ok ? (
                              <>
                                {t.latencyMs} ms
                                {t.ip && (
                                  <span className="text-zinc-500"> · {t.ip}</span>
                                )}
                              </>
                            ) : (
                              <span className="text-red-400" title={t.error}>
                                {t.error?.slice(0, 40) ?? 'échec'}
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-zinc-600">
                            il y a {formatAgo(t.testedAt)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => testOne(p.id)}
                        disabled={busy.has(p.id)}
                        title="Tester"
                        className="inline-flex items-center justify-center w-7 h-7 mr-1 rounded text-zinc-300 hover:text-white hover:bg-zinc-700/50 disabled:opacity-40"
                      >
                        <RotateCw size={14} className={busy.has(p.id) ? 'animate-spin' : ''} />
                      </button>
                      <button
                        onClick={() => remove(p.id)}
                        title="Supprimer"
                        className="inline-flex items-center justify-center w-7 h-7 rounded text-red-400 hover:text-red-300 hover:bg-red-950/50"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
