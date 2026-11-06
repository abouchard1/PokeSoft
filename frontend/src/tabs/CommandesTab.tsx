import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, PackageOpen } from 'lucide-react';
import { connectLive } from '../liveSocket';

interface OrderItem {
  asin?: string;
  title: string;
  imageUrl?: string;
}

interface Order {
  orderId: string;
  date: string;
  placedAt: number;
  total?: string;
  totalCents?: number;
  recipient?: string;
  status?: string;
  cancelled: boolean;
  detailsUrl?: string;
  items: OrderItem[];
}

interface SyncProgress {
  accountId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  message?: string;
  orders?: number;
  updatedAt: number;
}

interface AccountOrders {
  accountId: string;
  accountLabel: string;
  email: string;
  enabled: boolean;
  syncedAt?: number;
  attemptedAt?: number;
  syncStatus?: 'ok' | 'error';
  syncMessage?: string;
  years: string[];
  /** null = never synced successfully. */
  orders: Order[] | null;
  progress?: SyncProgress;
}

type Filter = 'all' | 'fresh' | 'ordered' | 'unknown';

const euro = (cents: number) =>
  (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

const fmtDate = (ts?: number) =>
  ts ? new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Orders that went through (a cancelled one was never billed). */
const placed = (orders: Order[]) => orders.filter((o) => !o.cancelled);

function category(a: AccountOrders): Exclude<Filter, 'all'> {
  if (a.orders === null) return 'unknown';
  return placed(a.orders).length === 0 ? 'fresh' : 'ordered';
}

export default function CommandesTab() {
  const [rows, setRows] = useState<AccountOrders[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [showParked, setShowParked] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const data = await fetch('/api/amazon/orders').then((r) => r.json());
    setRows(data);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    return connectLive((msg: any) => {
      if (msg.type === 'snapshot' && Array.isArray(msg.orders)) {
        const byId = new Map<string, SyncProgress>(msg.orders.map((p: SyncProgress) => [p.accountId, p]));
        setRows((rs) => rs.map((r) => ({ ...r, progress: byId.get(r.accountId) ?? r.progress })));
      }
      if (msg.type === 'orders.progress') {
        const p: SyncProgress = msg.progress;
        setRows((rs) => rs.map((r) => (r.accountId === p.accountId ? { ...r, progress: p } : r)));
      }
      if (msg.type === 'orders.synced') refresh();
    });
  }, []);

  async function sync(accountIds?: string[]) {
    setNotice(null);
    const res = await fetch('/api/amazon/orders/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(accountIds ? { accountIds } : {}),
    });
    const body = await res.json();
    if (!res.ok) return setNotice(body.error ?? 'Erreur');
    if (body.skipped?.length) {
      const label = (id: string) => rows.find((r) => r.accountId === id)?.accountLabel ?? id;
      setNotice(
        'Ignorés : ' + body.skipped.map((s: any) => `${label(s.accountId)} (${s.reason})`).join(', ')
      );
    }
  }

  const visible = useMemo(
    () =>
      rows
        .filter((r) => showParked || r.enabled)
        .filter((r) => filter === 'all' || category(r) === filter)
        .sort((a, b) => a.accountLabel.localeCompare(b.accountLabel)),
    [rows, filter, showParked]
  );

  const counts = useMemo(() => {
    const pool = rows.filter((r) => showParked || r.enabled);
    const c = { all: pool.length, fresh: 0, ordered: 0, unknown: 0, orders: 0, spent: 0 };
    for (const r of pool) {
      c[category(r)]++;
      if (r.orders) {
        const ok = placed(r.orders);
        c.orders += ok.length;
        c.spent += ok.reduce((s, o) => s + (o.totalCents ?? 0), 0);
      }
    }
    return c;
  }, [rows, showParked]);

  const busy = rows.some((r) => r.progress && (r.progress.status === 'queued' || r.progress.status === 'running'));

  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  const FILTERS: { id: Filter; label: string; n: number }[] = [
    { id: 'all', label: 'Tous', n: counts.all },
    { id: 'fresh', label: 'Neufs (aucune commande)', n: counts.fresh },
    { id: 'ordered', label: 'Avec commandes', n: counts.ordered },
    { id: 'unknown', label: 'Jamais vérifiés', n: counts.unknown },
  ];

  return (
    <div>
      <section className="bg-zinc-900 rounded-lg p-4 mb-6 border border-zinc-800">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-medium">Commandes passées</h2>
            <p className="text-xs text-zinc-500 mt-1">
              Récupérées depuis la page « Vos commandes » de chaque compte (lecture seule, headless, proxy du
              compte). {counts.orders} commande{counts.orders > 1 ? 's' : ''} · {euro(counts.spent)} dépensés.
            </p>
          </div>
          <button
            onClick={() => sync()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded"
          >
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
            {busy ? 'Synchro en cours…' : 'Synchroniser tous les comptes actifs'}
          </button>
        </div>
        {notice && (
          <div className="mt-3 text-xs px-3 py-2 rounded border bg-amber-950 border-amber-800 text-amber-200">
            {notice}
          </div>
        )}
        <div className="mt-3 pt-3 border-t border-zinc-800 flex items-center gap-2 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`text-xs px-2.5 py-1 rounded border ${
                filter === f.id
                  ? 'bg-zinc-800 border-zinc-600 text-white'
                  : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {f.label} <span className="text-zinc-500">{f.n}</span>
            </button>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer ml-auto">
            <input type="checkbox" checked={showParked} onChange={(e) => setShowParked(e.target.checked)} />
            Afficher les comptes désactivés
          </label>
        </div>
      </section>

      {loading ? (
        <p className="text-zinc-500 text-sm">Chargement…</p>
      ) : visible.length === 0 ? (
        <p className="text-zinc-500 text-sm">Aucun compte ne correspond à ce filtre.</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((r) => {
            const cat = category(r);
            const ok = r.orders ? placed(r.orders) : [];
            const cancelled = r.orders ? r.orders.length - ok.length : 0;
            const spent = ok.reduce((s, o) => s + (o.totalCents ?? 0), 0);
            const last = ok[0];
            const p = r.progress;
            const running = p && (p.status === 'queued' || p.status === 'running');
            const open = expanded.has(r.accountId);
            return (
              <li
                key={r.accountId}
                className={`bg-zinc-900 border border-zinc-800 rounded-lg ${r.enabled ? '' : 'opacity-60'}`}
              >
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <button
                    onClick={() => toggle(r.accountId)}
                    disabled={!r.orders?.length}
                    className="text-zinc-400 hover:text-zinc-200 disabled:opacity-20"
                  >
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{r.accountLabel}</span>
                      {!r.enabled && (
                        <span className="text-[10px] uppercase tracking-wide text-zinc-400 border border-zinc-700 rounded px-1">
                          désactivé
                        </span>
                      )}
                      {cat === 'fresh' && (
                        <span className="text-[10px] uppercase tracking-wide text-sky-300 bg-sky-950 border border-sky-800 rounded px-1.5 py-px">
                          neuf
                        </span>
                      )}
                      {cat === 'ordered' && (
                        <span className="text-[10px] uppercase tracking-wide text-emerald-300 bg-emerald-950 border border-emerald-800 rounded px-1.5 py-px">
                          {ok.length} commande{ok.length > 1 ? 's' : ''}
                        </span>
                      )}
                      {cat === 'unknown' && (
                        <span className="text-[10px] uppercase tracking-wide text-zinc-400 border border-zinc-700 rounded px-1.5 py-px">
                          jamais vérifié
                        </span>
                      )}
                      {cancelled > 0 && (
                        <span className="text-[10px] text-zinc-500">
                          + {cancelled} annulée{cancelled > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 truncate">
                      {r.email}
                      {ok.length > 0 && (
                        <>
                          {' · '}
                          {euro(spent)} · dernière le {last.date}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-xs shrink-0">
                    {running ? (
                      <span className="text-amber-300">
                        {p!.status === 'queued' ? "en file d'attente" : (p!.message ?? 'en cours…')}
                      </span>
                    ) : r.syncStatus === 'error' ? (
                      <span className="text-red-400" title={r.syncMessage}>
                        ⚠ échec : {r.syncMessage?.slice(0, 60)}
                      </span>
                    ) : r.syncedAt ? (
                      <span className="text-zinc-500">vérifié {fmtDate(r.syncedAt)}</span>
                    ) : null}
                  </div>
                  <button
                    onClick={() => sync([r.accountId])}
                    disabled={!!running}
                    title="Synchroniser ce compte"
                    className="inline-flex items-center justify-center w-7 h-7 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    <RefreshCw size={14} className={running ? 'animate-spin' : ''} />
                  </button>
                </div>

                {open && r.orders && r.orders.length > 0 && (
                  <ul className="border-t border-zinc-800 divide-y divide-zinc-800">
                    {r.orders.map((o) => (
                      <li key={o.orderId} className={`px-4 py-2.5 ${o.cancelled ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-3 text-xs text-zinc-400 flex-wrap">
                          <span className="text-zinc-200">{o.date}</span>
                          <span>{o.cancelled ? 'annulée' : (o.total ?? '—')}</span>
                          {o.status && !o.cancelled && <span>{o.status}</span>}
                          {o.recipient && <span>→ {o.recipient}</span>}
                          <span className="font-mono text-zinc-500">{o.orderId}</span>
                          {o.detailsUrl && (
                            <a
                              href={o.detailsUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-200 ml-auto"
                            >
                              détails <ExternalLink size={11} />
                            </a>
                          )}
                        </div>
                        <ul className="mt-2 space-y-1.5">
                          {o.items.map((it, i) => (
                            <li key={it.asin ?? i} className="flex items-center gap-2">
                              <div className="w-10 h-10 shrink-0 bg-white rounded overflow-hidden flex items-center justify-center">
                                {it.imageUrl ? (
                                  <img src={it.imageUrl} alt="" className="max-w-full max-h-full object-contain" />
                                ) : (
                                  <PackageOpen size={16} className="text-zinc-400" />
                                )}
                              </div>
                              <span className="text-xs leading-tight line-clamp-2" title={it.title}>
                                {it.title}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
