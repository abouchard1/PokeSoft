import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Users, Server } from 'lucide-react';

interface Group {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface Member {
  id: string;
  label: string;
  /** Parked in the Carnet (`enabled:false`). Still listed here — a group is
   *  where you'd want to spot one and take it out. */
  parked?: boolean;
}

function GroupManager({
  kind,
  members,
  emptyMembersHint,
  /** Flag members parked / missing from the group. Accounts only: proxies have
   *  no on/off switch, and "N non inclus" over ~100 proxies is just noise. */
  trackCoverage = false,
}: {
  kind: 'account-groups' | 'proxy-groups';
  members: Member[];
  emptyMembersHint: string;
  trackCoverage?: boolean;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [newName, setNewName] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  async function refresh() {
    const g = await fetch(`/api/${kind}`).then((r) => r.json());
    setGroups(g);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    await fetch(`/api/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    refresh();
  }

  async function rename(id: string, name: string) {
    await fetch(`/api/${kind}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)));
  }

  async function remove(id: string) {
    if (!confirm('Supprimer ce groupe ?')) return;
    await fetch(`/api/${kind}/${id}`, { method: 'DELETE' });
    refresh();
  }

  async function toggleMember(group: Group, memberId: string) {
    const memberIds = group.memberIds.includes(memberId)
      ? group.memberIds.filter((m) => m !== memberId)
      : [...group.memberIds, memberId];
    setGroups((gs) => gs.map((g) => (g.id === group.id ? { ...g, memberIds } : g)));
    await fetch(`/api/${kind}/${group.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberIds }),
    });
  }

  return (
    <div>
      <div className="flex gap-2 mb-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder="Nom du groupe"
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
        />
        <button
          onClick={create}
          disabled={!newName.trim()}
          className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm px-3 py-2 rounded"
        >
          <Plus size={14} />
          Créer
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="text-zinc-500 text-sm">Aucun groupe.</p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => {
            const isOpen = expanded === g.id;
            const inGroup = new Set(g.memberIds);
            // What's actually wrong with this group, so it says which member to
            // take out and which to add instead of just a raw member count.
            const parkedIn = trackCoverage
              ? members.filter((m) => m.parked && inGroup.has(m.id)).length
              : 0;
            const activeOut = trackCoverage
              ? members.filter((m) => !m.parked && !inGroup.has(m.id)).length
              : 0;
            return (
              <li key={g.id} className="bg-zinc-950/40 border border-zinc-800 rounded">
                <div className="flex items-center gap-2 p-2">
                  <button
                    onClick={() => setExpanded(isOpen ? null : g.id)}
                    className="text-zinc-400 hover:text-zinc-200"
                    title="Gérer les membres"
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <input
                    value={g.name}
                    onChange={(e) =>
                      setGroups((gs) => gs.map((x) => (x.id === g.id ? { ...x, name: e.target.value } : x)))
                    }
                    onBlur={(e) => rename(g.id, e.target.value.trim() || g.name)}
                    className="flex-1 bg-transparent text-sm font-medium focus:bg-zinc-950 focus:border-zinc-700 border border-transparent rounded px-2 py-1"
                  />
                  <span className="text-xs text-zinc-500 whitespace-nowrap">
                    {g.memberIds.length} membre(s)
                  </span>
                  {parkedIn > 0 && (
                    <span
                      className="text-xs text-amber-400 whitespace-nowrap"
                      title="Comptes désactivés dans le Carnet : ils comptent dans le total mais sont ignorés au lancement. À retirer."
                    >
                      · {parkedIn} désactivé(s) à retirer
                    </span>
                  )}
                  {activeOut > 0 && (
                    <span
                      className="text-xs text-sky-400 whitespace-nowrap"
                      title="Comptes actifs absents de ce groupe : ils ne partiront pas avec lui."
                    >
                      · {activeOut} actif(s) non inclus
                    </span>
                  )}
                  <button
                    onClick={() => remove(g.id)}
                    title="Supprimer"
                    className="inline-flex items-center justify-center w-7 h-7 rounded text-red-400 hover:text-red-300 hover:bg-red-950/50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {isOpen && (
                  <div className="border-t border-zinc-800 p-2">
                    {members.length === 0 ? (
                      <p className="text-xs text-zinc-500">{emptyMembersHint}</p>
                    ) : (
                      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 max-h-64 overflow-y-auto">
                        {members.map((m) => (
                          <li key={m.id}>
                            <label
                              className={`flex items-center gap-2 text-xs cursor-pointer px-1.5 py-1 rounded hover:bg-zinc-800/50 ${
                                m.parked ? 'text-zinc-600' : ''
                              }`}
                              title={
                                m.parked
                                  ? 'Compte désactivé dans le Carnet — ignoré au lancement même s’il est coché.'
                                  : undefined
                              }
                            >
                              <input
                                type="checkbox"
                                checked={inGroup.has(m.id)}
                                onChange={() => toggleMember(g, m.id)}
                              />
                              <span className="truncate">{m.label}</span>
                              {m.parked && (
                                <span className="ml-auto shrink-0 text-[10px] text-amber-500/80">
                                  désactivé
                                </span>
                              )}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function GroupesTab() {
  const [accounts, setAccounts] = useState<
    { id: string; prenom: string; nom: string; enabled?: boolean }[]
  >([]);
  const [proxies, setProxies] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    fetch('/api/accounts')
      .then((r) => r.json())
      .then(setAccounts)
      .catch(() => setAccounts([]));
    fetch('/api/proxies')
      .then((r) => r.json())
      .then(setProxies)
      .catch(() => setProxies([]));
  }, []);

  const accountMembers = useMemo<Member[]>(
    () =>
      accounts.map((a) => ({
        id: a.id,
        label: `${a.prenom} ${a.nom}`,
        parked: a.enabled === false,
      })),
    [accounts]
  );
  const proxyMembers = useMemo<Member[]>(
    () => proxies.map((p) => ({ id: p.id, label: `#${p.id} ${p.label}` })),
    [proxies]
  );

  return (
    <div className="space-y-6">
      <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
        <h2 className="font-medium mb-1 flex items-center gap-2">
          <Users size={16} /> Groupes de comptes
        </h2>
        <p className="text-xs text-zinc-500 mb-3">
          Regroupe des comptes pour lancer une action sur plusieurs d'un coup. Les comptes
          désactivés dans le Carnet restent listés, en grisé : ils sont ignorés au lancement,
          donc autant les retirer du groupe.
        </p>
        <GroupManager
          kind="account-groups"
          members={accountMembers}
          emptyMembersHint="Aucun compte. Crée-en dans le Carnet."
          trackCoverage
        />
      </section>

      <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
        <h2 className="font-medium mb-1 flex items-center gap-2">
          <Server size={16} /> Groupes de proxies
        </h2>
        <p className="text-xs text-zinc-500 mb-3">
          Regroupe des proxies en pool. Une action peut utiliser ce pool, réparti sur les comptes.
        </p>
        <GroupManager
          kind="proxy-groups"
          members={proxyMembers}
          emptyMembersHint="Aucun proxy chargé."
        />
      </section>
    </div>
  );
}
