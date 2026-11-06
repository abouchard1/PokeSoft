import { useEffect, useState } from 'react';
import ActionsTab from './tabs/ActionsTab';
import AmazonTab from './tabs/AmazonTab';
import CarnetTab from './tabs/CarnetTab';
import CommandesTab from './tabs/CommandesTab';
import CartesTab from './tabs/CartesTab';
import GroupesTab from './tabs/GroupesTab';
import ProxiesTab from './tabs/ProxiesTab';
import GeneratorTab from './tabs/GeneratorTab';
import { connectLive } from './liveSocket';

type TabId = 'actions' | 'amazon' | 'commandes' | 'carnet' | 'cartes' | 'groupes' | 'proxies' | 'generator';

const TABS: { id: TabId; label: string }[] = [
  { id: 'actions', label: 'Actions' },
  { id: 'amazon', label: 'Amazon' },
  { id: 'commandes', label: 'Commandes' },
  { id: 'carnet', label: 'Carnet' },
  { id: 'cartes', label: 'Cartes' },
  { id: 'groupes', label: 'Groupes' },
  { id: 'generator', label: 'Générer' },
  { id: 'proxies', label: 'Proxy' },
];

export default function App() {
  const [tab, setTab] = useState<TabId>('actions');
  const [connected, setConnected] = useState(false);

  useEffect(() => connectLive(() => {}, setConnected), []);

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Pokesoft</h1>
        <span
          className={`text-xs px-2 py-1 rounded ${
            connected ? 'bg-emerald-900 text-emerald-200' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {connected ? 'connecté' : 'déconnecté'}
        </span>
      </header>

      <nav className="flex gap-1 mb-6 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm rounded-t border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-emerald-500 text-white'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'actions' && <ActionsTab connected={connected} />}
      {tab === 'amazon' && <AmazonTab />}
      {tab === 'commandes' && <CommandesTab />}
      {tab === 'carnet' && <CarnetTab />}
      {tab === 'cartes' && <CartesTab />}
      {tab === 'groupes' && <GroupesTab />}
      {tab === 'generator' && <GeneratorTab />}
      {tab === 'proxies' && <ProxiesTab />}
    </div>
  );
}
