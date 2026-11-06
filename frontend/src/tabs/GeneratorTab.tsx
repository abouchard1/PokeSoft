import { useState } from 'react';

interface GeneratedAccount {
  prenom: string;
  nom: string;
  email: string;
  adresse: string;
  password: string;
}

const DEFAULT_ADDRESS = '17 Allée Edith Piaf 35000 Rennes';

export default function GeneratorTab() {
  const [baseAddress, setBaseAddress] = useState(DEFAULT_ADDRESS);
  const [count, setCount] = useState(5);
  const [results, setResults] = useState<GeneratedAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [filling, setFilling] = useState(false);
  const [fillMsg, setFillMsg] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setAdded(new Set());
    try {
      const r = await fetch('/api/generate/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseAddress, count }),
      });
      setResults(await r.json());
    } finally {
      setBusy(false);
    }
  }

  async function addOne(idx: number) {
    const acc = results[idx];
    await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...acc, telephone: '' }),
    });
    setAdded((s) => new Set(s).add(idx));
  }

  async function addAll() {
    for (let i = 0; i < results.length; i++) {
      if (!added.has(i)) await addOne(i);
    }
  }

  async function fillMissing() {
    setFilling(true);
    setFillMsg(null);
    try {
      const r = await fetch('/api/accounts/fill-addresses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseAddress }),
      });
      const d = await r.json();
      setFillMsg(
        d.requested === 0
          ? 'Aucun compte sans adresse.'
          : `${d.filled}/${d.requested} adresse(s) remplie(s) (uniques, hors carnet).`
      );
    } catch {
      setFillMsg('Échec du remplissage.');
    } finally {
      setFilling(false);
    }
  }

  return (
    <>
      <section className="bg-zinc-900 rounded-lg p-4 mb-6 border border-zinc-800">
        <h2 className="font-medium mb-3">Générer des comptes</h2>
        <div className="space-y-2 mb-3">
          <label className="block">
            <span className="text-xs text-zinc-400">Adresse de base</span>
            <input
              value={baseAddress}
              onChange={(e) => setBaseAddress(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm mt-1"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">Nombre (1-100)</span>
            <input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm mt-1"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={fillMissing}
            disabled={filling || !baseAddress.trim()}
            title="Génère une adresse unique pour chaque compte du Carnet qui n'en a pas"
            className="bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-sm px-4 py-2 rounded"
          >
            {filling ? 'remplissage…' : 'Remplir les adresses manquantes'}
          </button>
          <button
            onClick={generate}
            disabled={busy || !baseAddress.trim()}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded"
          >
            {busy ? 'génération…' : 'Générer'}
          </button>
        </div>
        {fillMsg && (
          <div className="mt-2 text-xs px-3 py-2 rounded border bg-emerald-950 border-emerald-800 text-emerald-200">
            {fillMsg}
          </div>
        )}
        <p className="text-xs text-zinc-500 mt-2">
          Les variations d'adresse appliquées restent délivrables (abréviation, accents, casse,
          séparateurs). La génération exclut toujours les emails et adresses déjà présents dans le
          Carnet.
        </p>
      </section>

      {results.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium">Résultats ({results.length})</h2>
            <button
              onClick={addAll}
              disabled={added.size === results.length}
              className="text-xs px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white"
            >
              Tout ajouter au Carnet
            </button>
          </div>
          <ul className="space-y-2">
            {results.map((a, i) => (
              <li
                key={i}
                className="bg-zinc-900 border border-zinc-800 rounded p-3 flex items-center justify-between"
              >
                <div className="text-sm">
                  <div className="font-medium">
                    {a.prenom} {a.nom}
                  </div>
                  <div className="text-zinc-400 text-xs font-mono">{a.email}</div>
                  <div className="text-zinc-400 text-xs">{a.adresse}</div>
                  <div className="text-zinc-500 text-xs font-mono">mdp : {a.password}</div>
                </div>
                {added.has(i) ? (
                  <span className="text-xs text-emerald-400">ajouté</span>
                ) : (
                  <button
                    onClick={() => addOne(i)}
                    className="text-xs text-zinc-300 hover:text-white"
                  >
                    ajouter
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
