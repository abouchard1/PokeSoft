import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, ExternalLink, Trash2, PackageOpen } from 'lucide-react';

interface InviteAvailability {
  available: 'yes' | 'no' | 'unknown';
  inStore: boolean;
  unavailable: number;
  gotInvite: number;
  checkedAccounts: number;
  lastCheckedAt: number;
}

interface AmazonItem {
  id: string;
  asin: string;
  title: string;
  imageUrl: string;
  productUrl: string;
  extension: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  invite?: InviteAvailability;
}

interface ProxyPublic {
  id: string;
  host: string;
  port: number;
  label: string;
}

/**
 * Derive a compact display name from the full Amazon title. The extension is
 * shown as the section header, so it's dropped here. The original title stays
 * untouched (kept as the hover tooltip).
 */
function condenseTitle(rawTitle: string, extension: string): string {
  const t = rawTitle.replace(/^Pok[ée]mon\s*:?\s*/i, '').trim();
  const beforeParen = t.split(/\s*\(/)[0];
  const countMatch = rawTitle.match(/\((?:[^)]*?\b)?(\d+)\s*boosters?/i);
  const count = countMatch ? countMatch[1] : '';

  const segs = beforeParen.split('–').map((s) => s.trim()).filter(Boolean);
  let variant = '';
  if (segs.length >= 2) {
    const last = segs[segs.length - 1]
      .replace(/\bdu\s+JCC\s+Pok[ée]mon\b.*/i, '')
      .replace(/\bJCC\s+Pok[ée]mon\b.*/i, '')
      .replace(/\bdu\b\s*$/i, '')
      .trim();
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (last && norm(last) !== norm(extension)) variant = last;
  }
  const withVariant = (label: string) => (variant ? `${label} · ${variant}` : label);
  const low = t.toLowerCase().replace(/[’']/g, "'");

  if (low.includes('coffret dresseur d')) return withVariant('ETB');
  if (low.includes('présentoir de boosters')) return `Présentoir ${count || '18'} boosters`;
  if (low.includes('lot de boosters')) return withVariant('Bundle');
  if (low.includes('blister de trois boosters')) return withVariant('Blister 3 boosters');
  if (low.includes('mini-boîte')) return withVariant('Mini tin');
  if (low.includes('collection poster premium')) return withVariant('Poster Premium');
  if (low.includes("pin's")) {
    const m = t.match(/pin['’]s Deluxe\s+(.+?)\s+(?:Méga-Évolution|Écarlate)/i);
    return m ? `Pin's Deluxe · ${m[1].trim()}` : "Pin's Deluxe";
  }
  if (low.includes('premium avec figurine')) return 'Collection Premium · Figurine';
  if (low.includes('autocollant')) return withVariant('Autocollant');
  if (low.includes('coffret')) return withVariant('Coffret');
  if (low.includes('collection')) return withVariant('Collection');
  return beforeParen.slice(0, 60);
}

/** Base product type (the condensed label without its variant). */
function itemType(rawTitle: string, extension: string): string {
  return condenseTitle(rawTitle, extension).split(' · ')[0];
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-emerald-600' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export default function AmazonTab() {
  const [items, setItems] = useState<AmazonItem[]>([]);
  const [proxies, setProxies] = useState<ProxyPublic[]>([]);
  const [proxyId, setProxyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [extFilter, setExtFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [hideUnavailable, setHideUnavailable] = useState(false);

  async function refresh() {
    const data = await fetch('/api/amazon/items').then((r) => r.json());
    setItems(data);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    fetch('/api/proxies')
      .then((r) => r.json())
      .then(setProxies)
      .catch(() => setProxies([]));
  }, []);

  const allExtensions = useMemo(
    () => Array.from(new Set(items.map((i) => i.extension))).sort((a, b) => a.localeCompare(b)),
    [items]
  );
  const allTypes = useMemo(
    () =>
      Array.from(new Set(items.map((i) => itemType(i.title, i.extension)))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [items]
  );

  const grouped = useMemo(() => {
    const map = new Map<string, AmazonItem[]>();
    for (const it of items) {
      if (extFilter && it.extension !== extFilter) continue;
      if (typeFilter && itemType(it.title, it.extension) !== typeFilter) continue;
      if (hideUnavailable && it.invite?.available === 'no') continue;
      const arr = map.get(it.extension) ?? [];
      arr.push(it);
      map.set(it.extension, arr);
    }
    return Array.from(map.entries());
  }, [items, extFilter, typeFilter, hideUnavailable]);

  const filteredCount = useMemo(() => grouped.reduce((n, [, l]) => n + l.length, 0), [grouped]);
  const enabledCount = items.filter((i) => i.enabled).length;
  const unavailableCount = useMemo(() => items.filter((i) => i.invite?.available === 'no').length, [items]);
  const enabledUnavailable = useMemo(
    () => items.filter((i) => i.invite?.available === 'no' && i.enabled),
    [items]
  );
  const filtered = !!extFilter || !!typeFilter || hideUnavailable;

  async function runImport() {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/amazon/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxyId: proxyId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'échec de l’import');
      } else {
        setNotice(
          `${data.scraped} items récupérés · ${data.added} ajoutés, ${data.updated} mis à jour` +
            (data.absent ? `, ${data.absent} disparus du store → indispo` : '') +
            ` · ${data.extensions.length} extensions`
        );
        await refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function toggle(item: AmazonItem, enabled: boolean) {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, enabled } : i)));
    const res = await fetch(`/api/amazon/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      // revert on failure
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, enabled: !enabled } : i)));
    }
  }

  // Disable every item flagged "no longer open to invitation" so it stops being
  // requested. Non-destructive: items stay in the catalogue (Amazon may re-open).
  async function disableUnavailable() {
    const targets = enabledUnavailable;
    if (targets.length === 0) return;
    setItems((prev) =>
      prev.map((i) => (i.invite?.available === 'no' ? { ...i, enabled: false } : i))
    );
    await Promise.all(
      targets.map((i) =>
        fetch(`/api/amazon/items/${i.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        }).catch(() => {})
      )
    );
  }

  async function remove(item: AmazonItem) {
    if (!confirm(`Retirer « ${item.title.slice(0, 50)}… » ?`)) return;
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    await fetch(`/api/amazon/items/${item.id}`, { method: 'DELETE' });
  }

  return (
    <>
      <section className="bg-zinc-900 rounded-lg p-4 mb-6 border border-zinc-800">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-medium">Catalogue Amazon — JCC Pokémon</h2>
            <p className="text-xs text-zinc-500 mt-1">
              {items.length} items · {enabledCount} activés · {grouped.length} extensions
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={proxyId}
              onChange={(e) => setProxyId(e.target.value)}
              disabled={importing}
              className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              <option value="">Import sans proxy</option>
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>
                  via #{p.id} {p.label}
                </option>
              ))}
            </select>
            <button
              onClick={runImport}
              disabled={importing}
              className="inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded"
            >
              <RefreshCw size={14} className={importing ? 'animate-spin' : ''} />
              {importing ? 'Import en cours… (~1 min)' : 'Importer / Rafraîchir'}
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-3 text-xs px-3 py-2 rounded border bg-red-950 border-red-800 text-red-200">
            {error}
          </div>
        )}
        {notice && (
          <div className="mt-3 text-xs px-3 py-2 rounded border bg-emerald-950 border-emerald-800 text-emerald-200">
            {notice}
          </div>
        )}
        {items.length > 0 && (
          <div className="mt-3 pt-3 border-t border-zinc-800 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-zinc-500">Filtrer :</span>
            <select
              value={extFilter}
              onChange={(e) => setExtFilter(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs"
            >
              <option value="">Toutes les extensions</option>
              {allExtensions.map((ext) => (
                <option key={ext} value={ext}>
                  {ext}
                </option>
              ))}
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs"
            >
              <option value="">Tous les types</option>
              {allTypes.map((ty) => (
                <option key={ty} value={ty}>
                  {ty}
                </option>
              ))}
            </select>
            {unavailableCount > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideUnavailable}
                  onChange={(e) => setHideUnavailable(e.target.checked)}
                />
                Masquer indispo invit ({unavailableCount})
              </label>
            )}
            {enabledUnavailable.length > 0 && (
              <button
                onClick={disableUnavailable}
                title="Désactive les items qui ne sont plus ouverts à l'invitation"
                className="text-xs text-amber-400 hover:text-amber-300 px-2 py-1.5"
              >
                Désactiver les indispo ({enabledUnavailable.length})
              </button>
            )}
            {filtered && (
              <button
                onClick={() => {
                  setExtFilter('');
                  setTypeFilter('');
                  setHideUnavailable(false);
                }}
                className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1.5"
              >
                Réinitialiser
              </button>
            )}
            <span className="text-xs text-zinc-500 ml-auto">
              {filteredCount} résultat{filteredCount > 1 ? 's' : ''}
            </span>
          </div>
        )}
      </section>

      {loading ? (
        <p className="text-zinc-500 text-sm">Chargement…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-zinc-500">
          <PackageOpen size={40} className="mx-auto mb-3 opacity-50" />
          <p className="text-sm">Aucun item. Lance un import pour récupérer les extensions.</p>
        </div>
      ) : grouped.length === 0 ? (
        <p className="text-zinc-500 text-sm">Aucun item ne correspond à ce filtre.</p>
      ) : (
        <div className="space-y-5">
          {grouped.map(([extension, list]) => (
            <section key={extension}>
              <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
                {extension}
                <span className="text-xs text-zinc-500">
                  ({list.filter((i) => i.enabled).length}/{list.length})
                </span>
              </h3>
              <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {list.map((item) => {
                  const unavailable = item.invite?.available === 'no';
                  return (
                  <li
                    key={item.id}
                    className={`bg-zinc-900 border rounded-lg p-2.5 flex gap-3 transition-colors ${
                      unavailable
                        ? 'border-zinc-800 opacity-50'
                        : item.enabled
                          ? 'border-emerald-700/60'
                          : 'border-zinc-800'
                    }`}
                  >
                    <div className="w-20 h-20 shrink-0 bg-white rounded overflow-hidden flex items-center justify-center">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          loading="lazy"
                          className={`w-full h-full object-contain ${unavailable ? 'grayscale' : ''}`}
                        />
                      ) : (
                        <PackageOpen size={24} className="text-zinc-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col justify-between gap-1">
                      <div>
                        <p className="text-xs leading-tight line-clamp-2" title={item.title}>
                          {condenseTitle(item.title, item.extension)}
                        </p>
                        {unavailable && (
                          <span
                            title={
                              item.invite?.inStore === false
                                ? 'Absent du dernier import (retiré du store) → plus d’invitation'
                                : `Plus ouvert à l'invitation — ${item.invite?.unavailable}/${item.invite?.checkedAccounts} comptes`
                            }
                            className="inline-block mt-1 text-[9px] uppercase tracking-wide text-amber-500/90 border border-amber-700/40 rounded px-1 py-px"
                          >
                            {item.invite?.inStore === false ? 'hors store' : 'indispo invit'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <Toggle checked={item.enabled} onChange={(v) => toggle(item, v)} />
                        <div className="flex items-center">
                          <a
                            href={item.productUrl}
                            target="_blank"
                            rel="noreferrer"
                            title={`Ouvrir sur Amazon · ${item.asin}`}
                            className="inline-flex items-center justify-center w-5 h-5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                          >
                            <ExternalLink size={12} />
                          </a>
                          <button
                            onClick={() => remove(item)}
                            title="Retirer"
                            className="inline-flex items-center justify-center w-5 h-5 rounded text-red-400 hover:text-red-300 hover:bg-red-950/50"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
