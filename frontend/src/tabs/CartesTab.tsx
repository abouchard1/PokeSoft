import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';

type CardBrand = 'visa' | 'mastercard' | 'amex' | 'unknown';

interface Card {
  id: string;
  libelle: string;
  titulaire: string;
  numero: string;
  expiration: string;
  cvv: string;
  brand: CardBrand;
  accountId?: string;
  createdAt: number;
  updatedAt: number;
}

interface AccountSummary {
  id: string;
  nom: string;
  prenom: string;
}

type Draft = Omit<Card, 'id' | 'brand' | 'createdAt' | 'updatedAt'>;

const EMPTY: Draft = {
  libelle: '',
  titulaire: '',
  numero: '',
  expiration: '',
  cvv: '',
  accountId: undefined,
};

const BRAND_LABEL: Record<CardBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  unknown: '—',
};

const BRAND_COLOR: Record<CardBrand, string> = {
  visa: 'bg-blue-900/40 text-blue-200 border-blue-800',
  mastercard: 'bg-orange-900/40 text-orange-200 border-orange-800',
  amex: 'bg-emerald-900/40 text-emerald-200 border-emerald-800',
  unknown: 'bg-zinc-800 text-zinc-400 border-zinc-700',
};

function formatNumero(n: string): string {
  return n.replace(/\D/g, '').match(/.{1,4}/g)?.join(' ') ?? n;
}

function maskNumero(n: string): string {
  const digits = n.replace(/\D/g, '');
  if (digits.length < 4) return digits;
  return `•••• •••• •••• ${digits.slice(-4)}`;
}

export default function CartesTab() {
  const [cards, setCards] = useState<Card[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  async function refresh() {
    const [c, a] = await Promise.all([
      fetch('/api/cards').then((r) => r.json()),
      fetch('/api/accounts').then((r) => r.json()),
    ]);
    setCards(c);
    setAccounts(a);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY);
    setModalOpen(true);
  }

  function openEdit(c: Card) {
    setEditingId(c.id);
    setDraft({
      libelle: c.libelle,
      titulaire: c.titulaire,
      numero: formatNumero(c.numero),
      expiration: c.expiration,
      cvv: c.cvv,
      accountId: c.accountId,
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setDraft(EMPTY);
  }

  async function save() {
    if (!draft.numero.trim() || !draft.titulaire.trim()) return;
    if (editingId) {
      await fetch(`/api/cards/${editingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
    } else {
      await fetch('/api/cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
    }
    closeModal();
    refresh();
  }

  async function remove(id: string) {
    if (!confirm('Supprimer cette carte ?')) return;
    await fetch(`/api/cards/${id}`, { method: 'DELETE' });
    refresh();
  }

  function accountLabel(id?: string): string {
    if (!id) return '—';
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.prenom} ${a.nom}` : '—';
  }

  return (
    <>
      <section className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="font-medium">Cartes ({cards.length})</h2>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            <Plus size={14} />
            Nouvelle
          </button>
        </div>
        {loading ? (
          <p className="p-4 text-zinc-500 text-sm">Chargement…</p>
        ) : cards.length === 0 ? (
          <p className="p-4 text-zinc-500 text-sm">Aucune carte enregistrée.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-950/50 text-zinc-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Libellé</th>
                  <th className="text-left px-4 py-2 font-medium">Réseau</th>
                  <th className="text-left px-4 py-2 font-medium">Numéro</th>
                  <th className="text-left px-4 py-2 font-medium">Titulaire</th>
                  <th className="text-left px-4 py-2 font-medium">Expiration</th>
                  <th className="text-left px-4 py-2 font-medium">Compte lié</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id} className="border-t border-zinc-800 hover:bg-zinc-800/30">
                    <td className="px-4 py-2 whitespace-nowrap">{c.libelle || '—'}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span
                        className={`text-xs px-2 py-0.5 rounded border ${BRAND_COLOR[c.brand]}`}
                      >
                        {BRAND_LABEL[c.brand]}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">
                      {maskNumero(c.numero)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{c.titulaire}</td>
                    <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">
                      {c.expiration || '—'}
                    </td>
                    <td className="px-4 py-2 text-zinc-400 whitespace-nowrap">
                      {accountLabel(c.accountId)}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => openEdit(c)}
                        title="Modifier"
                        className="inline-flex items-center justify-center w-7 h-7 mr-1 rounded text-zinc-300 hover:text-white hover:bg-zinc-700/50"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => remove(c.id)}
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
                {editingId ? 'Modifier la carte' : 'Nouvelle carte'}
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
              <input
                value={draft.libelle}
                onChange={(e) => setDraft((d) => ({ ...d, libelle: e.target.value }))}
                placeholder="Libellé (ex: Visa perso, Mastercard pro…)"
                autoFocus
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
              <input
                value={draft.numero}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, numero: formatNumero(e.target.value) }))
                }
                placeholder="Numéro de carte"
                inputMode="numeric"
                maxLength={23}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              />
              <input
                value={draft.titulaire}
                onChange={(e) => setDraft((d) => ({ ...d, titulaire: e.target.value }))}
                placeholder="Titulaire"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={draft.expiration}
                  onChange={(e) => setDraft((d) => ({ ...d, expiration: e.target.value }))}
                  placeholder="MM/AA"
                  maxLength={5}
                  className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                />
                <input
                  value={draft.cvv}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, cvv: e.target.value.replace(/\D/g, '') }))
                  }
                  placeholder="CVV"
                  maxLength={4}
                  inputMode="numeric"
                  className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                />
              </div>
              <select
                value={draft.accountId ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, accountId: e.target.value || undefined }))
                }
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                <option value="">— Aucun compte lié —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.prenom} {a.nom}
                  </option>
                ))}
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
                disabled={!draft.numero.trim() || !draft.titulaire.trim()}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded"
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
