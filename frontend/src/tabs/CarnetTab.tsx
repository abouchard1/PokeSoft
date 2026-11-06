import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Pencil, Plus, Trash2, X, Check, RotateCw, Fingerprint, Eye, EyeOff, Copy, MapPin, Wand2 } from 'lucide-react';
import { connectLive } from '../liveSocket';

const HIDDEN_DOMAIN = '@a-bouchard.com';

/** Cell whose content copies `value` to the clipboard on click. */
function CopyCell({
  value,
  title,
  className,
  children,
}: {
  value: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const [done, setDone] = useState(false);
  if (!value) return <span className="text-zinc-600">—</span>;
  return (
    <button
      type="button"
      title={title ?? `Copier : ${value}`}
      onClick={() => {
        navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 900);
          })
          .catch(() => {});
      }}
      className={`group inline-flex items-center gap-1 text-left hover:text-white ${className ?? ''}`}
    >
      {children}
      {done ? (
        <Check size={11} className="shrink-0 text-emerald-400" />
      ) : (
        <Copy size={11} className="shrink-0 opacity-0 group-hover:opacity-50" />
      )}
    </button>
  );
}

interface FingerprintData {
  preset: string;
  os: string;
  osVersion: string;
  browser: string;
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  canvasSeed: number;
}

interface Account {
  id: string;
  nom: string;
  prenom: string;
  email: string;
  password: string;
  adresse: string;
  telephone: string;
  proxyId?: string;
  proxyLabel?: string;
  hasStore: boolean;
  /** Off = parked: hidden from the invitation selection, runs refuse it. */
  enabled: boolean;
  lastUsedAt?: number;
  fingerprint?: FingerprintData;
  fingerprintSummary?: string;
  createdAt: number;
  updatedAt: number;
}

interface ProxyPublic {
  id: string;
  host: string;
  port: number;
  label: string;
}

type Draft = {
  nom: string;
  prenom: string;
  email: string;
  password: string;
  adresse: string;
  telephone: string;
  proxyId: string;
};

const EMPTY: Draft = {
  nom: '',
  prenom: '',
  email: '',
  password: '',
  adresse: '',
  telephone: '',
  proxyId: '',
};

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}j`;
}

export default function CarnetTab() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [proxies, setProxies] = useState<ProxyPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [showPassword, setShowPassword] = useState(false);
  const [fpAccount, setFpAccount] = useState<Account | null>(null);
  const [autofilling, setAutofilling] = useState(false);

  async function refresh() {
    const [a, p] = await Promise.all([
      fetch('/api/accounts').then((r) => r.json()),
      fetch('/api/proxies').then((r) => r.json()),
    ]);
    setAccounts(a);
    setProxies(p);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    return connectLive((msg: any) => {
      if (msg.type === 'account.updated' || msg.type === 'session.created') {
        refresh();
      }
    });
  }, []);

  useEffect(() => {
    if (!modalOpen && !fpAccount) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeModal();
        setFpAccount(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, fpAccount]);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY);
    setShowPassword(false);
    setModalOpen(true);
  }

  function openEdit(a: Account) {
    setEditingId(a.id);
    setDraft({
      nom: a.nom,
      prenom: a.prenom,
      email: a.email,
      password: a.password ?? '',
      adresse: a.adresse,
      telephone: a.telephone,
      proxyId: a.proxyId ?? '',
    });
    setShowPassword(false);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setDraft(EMPTY);
    setShowPassword(false);
  }

  // Fill the create form with a coherent generated identity (email/password/
  // address follow the project conventions and are unique vs the carnet). Each
  // click re-rolls fresh values.
  async function autofill() {
    setAutofilling(true);
    try {
      const r = await fetch('/api/generate/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: 1 }),
      });
      const arr = await r.json();
      const g = Array.isArray(arr) ? arr[0] : null;
      if (g) {
        setDraft((d) => ({
          ...d,
          prenom: g.prenom,
          nom: g.nom,
          email: g.email,
          adresse: g.adresse,
          password: g.password,
        }));
        setShowPassword(true);
      }
    } finally {
      setAutofilling(false);
    }
  }

  async function save() {
    if (!draft.nom.trim() || !draft.prenom.trim()) return;
    const body = { ...draft, proxyId: draft.proxyId || undefined };
    if (editingId) {
      await fetch(`/api/accounts/${editingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    closeModal();
    refresh();
  }

  // Park / un-park an account. Nothing is deleted — a parked account keeps its
  // profile, proxy and fingerprint, it just drops out of the invitation runs.
  async function toggleEnabled(a: Account) {
    setAccounts((list) =>
      list.map((x) => (x.id === a.id ? { ...x, enabled: !a.enabled } : x))
    );
    await fetch(`/api/accounts/${a.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !a.enabled }),
    });
    refresh();
  }

  async function remove(id: string) {
    if (!confirm('Supprimer ce compte ?')) return;
    await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    refresh();
  }

  async function regenerateFingerprint(id: string) {
    if (
      !confirm(
        "Régénérer l'empreinte ? Le compte va prendre un nouveau profil (OS, GPU, résolution…)."
      )
    )
      return;
    const updated: Account = await fetch(`/api/accounts/${id}/fingerprint/regenerate`, {
      method: 'POST',
    }).then((r) => r.json());
    refresh();
    if (fpAccount?.id === id) setFpAccount(updated);
  }

  // Proxies already attached to another account (the one being edited keeps its
  // own) → greyed in the picker so free proxies stand out. Map to the account
  // label for the option tooltip/suffix.
  const proxyUsedBy = new Map<string, string>();
  for (const a of accounts) {
    if (a.proxyId && a.id !== editingId) {
      proxyUsedBy.set(a.proxyId, `${a.prenom} ${a.nom}`.trim());
    }
  }

  return (
    <>
      <section className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="font-medium">
            Comptes ({accounts.length})
            {accounts.some((a) => a.enabled === false) && (
              <span className="ml-2 text-xs font-normal text-zinc-500">
                {accounts.filter((a) => a.enabled === false).length} désactivé(s)
              </span>
            )}
          </h2>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            <Plus size={14} />
            Nouveau
          </button>
        </div>
        {loading ? (
          <p className="p-4 text-zinc-500 text-sm">Chargement…</p>
        ) : accounts.length === 0 ? (
          <p className="p-4 text-zinc-500 text-sm">Aucun compte enregistré.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-950/50 text-zinc-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-center px-3 py-2 font-medium">Actif</th>
                  <th className="text-left px-3 py-2 font-medium">Prénom</th>
                  <th className="text-left px-3 py-2 font-medium">Nom</th>
                  <th className="text-left px-3 py-2 font-medium">Email</th>
                  <th className="text-center px-3 py-2 font-medium">Adr.</th>
                  <th className="text-center px-3 py-2 font-medium">Profil</th>
                  <th className="text-left px-3 py-2 font-medium">Empreinte</th>
                  <th className="text-left px-3 py-2 font-medium">Proxy</th>
                  <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Utilisé</th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr
                    key={a.id}
                    className={`border-t border-zinc-800 hover:bg-zinc-800/30 ${
                      a.enabled === false ? 'opacity-40' : ''
                    }`}
                  >
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => toggleEnabled(a)}
                        role="switch"
                        aria-checked={a.enabled !== false}
                        title={
                          a.enabled === false
                            ? 'Compte désactivé — réactiver pour le réinclure dans les invitations'
                            : 'Compte actif — désactiver pour le retirer des invitations'
                        }
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          a.enabled === false ? 'bg-zinc-700' : 'bg-emerald-600'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                            a.enabled === false ? 'translate-x-1' : 'translate-x-[18px]'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <CopyCell value={a.prenom} className="text-zinc-200">
                        {a.prenom}
                      </CopyCell>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <CopyCell value={a.nom} className="text-zinc-200">
                        {a.nom}
                      </CopyCell>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                      <CopyCell value={a.email} title={`Copier : ${a.email}`} className="text-zinc-300">
                        <span>
                          {a.email.endsWith(HIDDEN_DOMAIN) ? a.email.slice(0, -HIDDEN_DOMAIN.length) : a.email}
                        </span>
                      </CopyCell>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {a.adresse ? (
                        <CopyCell value={a.adresse} title={`Copier : ${a.adresse}`}>
                          <MapPin size={14} className="text-emerald-400" />
                        </CopyCell>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {a.hasStore ? (
                        <Check size={14} className="inline text-emerald-400" />
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => setFpAccount(a)}
                        title="Voir l'empreinte"
                        className="inline-flex items-center justify-center w-7 h-7 rounded text-zinc-300 hover:text-white hover:bg-zinc-700/50"
                        disabled={!a.fingerprint}
                      >
                        <Fingerprint size={14} />
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {a.proxyId ? (
                        <span className="text-zinc-300" title={a.proxyLabel}>
                          #{a.proxyId} <span className="text-zinc-500">{a.proxyLabel}</span>
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {a.lastUsedAt ? (
                        <span className="text-zinc-300">il y a {formatAgo(a.lastUsedAt)}</span>
                      ) : (
                        <span className="text-zinc-600">jamais</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => openEdit(a)}
                        title="Modifier"
                        className="inline-flex items-center justify-center w-7 h-7 mr-1 rounded text-zinc-300 hover:text-white hover:bg-zinc-700/50"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => remove(a.id)}
                        title="Supprimer"
                        className="inline-flex items-center justify-center w-7 h-7 rounded text-red-400 hover:text-red-300 hover:bg-red-950/50"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {fpAccount && fpAccount.fingerprint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setFpAccount(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="font-medium">
                Empreinte — {fpAccount.prenom} {fpAccount.nom}
              </h3>
              <button
                onClick={() => setFpAccount(null)}
                title="Fermer"
                className="inline-flex items-center justify-center w-7 h-7 rounded text-zinc-400 hover:text-white hover:bg-zinc-800"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
              <span className="text-zinc-500">OS</span>
              <span>
                {fpAccount.fingerprint.os} {fpAccount.fingerprint.osVersion}
              </span>
              <span className="text-zinc-500">Navigateur</span>
              <span>{fpAccount.fingerprint.browser}</span>
              <span className="text-zinc-500">Platform</span>
              <span className="font-mono text-xs">{fpAccount.fingerprint.platform}</span>
              <span className="text-zinc-500">Résolution</span>
              <span className="font-mono text-xs">
                {fpAccount.fingerprint.viewport.width}×{fpAccount.fingerprint.viewport.height}{' '}
                (DPR {fpAccount.fingerprint.deviceScaleFactor})
              </span>
              <span className="text-zinc-500">Locale</span>
              <span className="font-mono text-xs">{fpAccount.fingerprint.locale}</span>
              <span className="text-zinc-500">Fuseau</span>
              <span className="font-mono text-xs">{fpAccount.fingerprint.timezoneId}</span>
              <span className="text-zinc-500">CPU</span>
              <span className="font-mono text-xs">
                {fpAccount.fingerprint.hardwareConcurrency} cœurs
              </span>
              <span className="text-zinc-500">RAM</span>
              <span className="font-mono text-xs">{fpAccount.fingerprint.deviceMemory} Go</span>
              <span className="text-zinc-500">WebGL vendor</span>
              <span className="font-mono text-xs break-all">
                {fpAccount.fingerprint.webglVendor}
              </span>
              <span className="text-zinc-500">WebGL renderer</span>
              <span className="font-mono text-xs break-all">
                {fpAccount.fingerprint.webglRenderer}
              </span>
              <span className="text-zinc-500">Canvas seed</span>
              <span className="font-mono text-xs">{fpAccount.fingerprint.canvasSeed}</span>
              <span className="text-zinc-500">User-Agent</span>
              <span className="font-mono text-xs break-all">
                {fpAccount.fingerprint.userAgent}
              </span>
              <span className="text-zinc-500">Preset</span>
              <span className="font-mono text-xs text-zinc-500">
                {fpAccount.fingerprint.preset}
              </span>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex gap-2 justify-end">
              <button
                onClick={() => regenerateFingerprint(fpAccount.id)}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-white"
              >
                <RotateCw size={14} />
                Régénérer
              </button>
              <button
                onClick={() => setFpAccount(null)}
                className="text-sm px-3 py-2 rounded text-zinc-400 hover:text-zinc-200"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={closeModal}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="font-medium">
                {editingId ? 'Modifier le compte' : 'Nouveau compte'}
              </h3>
              <button
                onClick={closeModal}
                title="Fermer"
                className="inline-flex items-center justify-center w-7 h-7 rounded text-zinc-400 hover:text-white hover:bg-zinc-800"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-2">
              {!editingId && (
                <button
                  type="button"
                  onClick={autofill}
                  disabled={autofilling}
                  title="Génère un nom, prénom, email, adresse et mot de passe cohérents et uniques. Reclique pour d'autres valeurs."
                  className="w-full inline-flex items-center justify-center gap-1.5 text-sm px-3 py-2 mb-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 border border-zinc-700"
                >
                  <Wand2 size={14} className={autofilling ? 'animate-pulse' : ''} />
                  {autofilling ? 'génération…' : 'Remplir automatiquement'}
                  <RotateCw size={12} className="opacity-50" />
                </button>
              )}
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={draft.prenom}
                  onChange={(e) => setDraft((d) => ({ ...d, prenom: e.target.value }))}
                  placeholder="Prénom"
                  autoFocus
                  className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
                />
                <input
                  value={draft.nom}
                  onChange={(e) => setDraft((d) => ({ ...d, nom: e.target.value }))}
                  placeholder="Nom"
                  className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
                />
              </div>
              <input
                value={draft.email}
                onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                placeholder="Email"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
              <div className="flex gap-2">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={draft.password}
                  onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
                  placeholder="Mot de passe (Amazon, …)"
                  autoComplete="new-password"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  title={showPassword ? 'Masquer' : 'Afficher'}
                  className="inline-flex items-center justify-center w-10 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <input
                value={draft.adresse}
                onChange={(e) => setDraft((d) => ({ ...d, adresse: e.target.value }))}
                placeholder="Adresse"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
              <input
                value={draft.telephone}
                onChange={(e) => setDraft((d) => ({ ...d, telephone: e.target.value }))}
                placeholder="Téléphone"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
              <select
                value={draft.proxyId}
                onChange={(e) => setDraft((d) => ({ ...d, proxyId: e.target.value }))}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                <option value="">— Aucun proxy associé —</option>
                {proxies.map((p) => {
                  const usedBy = proxyUsedBy.get(p.id);
                  return (
                    <option
                      key={p.id}
                      value={p.id}
                      style={usedBy ? { color: '#71717a' } : undefined}
                    >
                      #{p.id} — {p.label}
                      {usedBy ? ` · utilisé (${usedBy})` : ''}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex gap-2 justify-end">
              <button
                onClick={closeModal}
                className="text-sm px-3 py-2 rounded text-zinc-400 hover:text-zinc-200"
              >
                Annuler
              </button>
              <button
                onClick={save}
                disabled={!draft.nom.trim() || !draft.prenom.trim()}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm px-3 py-2 rounded"
              >
                {editingId ? 'Enregistrer' : 'Ajouter'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
