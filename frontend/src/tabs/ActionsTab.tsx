import { useEffect, useState } from 'react';
import { X, ExternalLink, ShoppingCart, RefreshCw } from 'lucide-react';
import { connectLive } from '../liveSocket';

interface SessionSummary {
  id: string;
  proxyId?: string;
  proxyLabel?: string;
  accountId?: string;
  accountLabel?: string;
  headless: boolean;
  status: 'running' | 'closed';
  createdAt: number;
  url?: string;
  error?: string;
}

interface ProxyPublic {
  id: string;
  host: string;
  port: number;
  label: string;
}

interface ProxyTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  ip?: string;
  error?: string;
}

interface AccountSummary {
  id: string;
  nom: string;
  prenom: string;
  proxyId?: string;
  /** Off = parked in the carnet: excluded from the invitation selection. */
  enabled?: boolean;
}

interface Props {
  connected: boolean;
}

const INV_STATUS_LABEL: Record<string, string> = {
  requested: 'demandées ✓',
  available: 'dispo (non demandée)',
  already: 'déjà demandées',
  orderable: 'commandables',
  unavailable: 'indispo',
  login: 'login requis',
  error: 'erreurs',
};

interface InvRunState {
  running: boolean;
  queued?: boolean;
  done: number;
  total: number;
  dryRun: boolean;
  lastStatus?: string;
  counts?: Record<string, number>;
  error?: string;
}

// Backend per-account progress (WS snapshot / GET) → UI run state.
interface InvitationProgress {
  accountId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  dryRun: boolean;
  lastStatus?: string;
  counts?: Record<string, number>;
  message?: string;
}

function progressToRun(p: InvitationProgress): InvRunState {
  return {
    running: p.status === 'running',
    queued: p.status === 'queued',
    done: p.done,
    total: p.total,
    dryRun: p.dryRun,
    lastStatus: p.lastStatus,
    counts: p.counts,
    error: p.status === 'error' ? p.message : undefined,
  };
}

interface NamedGroup {
  id: string;
  name: string;
  memberIds: string[];
}

// Accepted Amazon invitation still inside its 72h order window (mail-derived).
interface OrderableInvitation {
  asin: string | null;
  productName: string;
  price?: string;
  email: string;
  receivedAt: number;
  expiresAt: number;
  productUrl?: string;
  accountId?: string;
  accountLabel?: string;
  title?: string;
  imageUrl?: string;
}

/**
 * Invitation found **accepted on the product page** by a verification run
 * (status `orderable`). Amazon doesn't always send the acceptance mail, so this
 * is the signal that doesn't depend on one. No expiry: the 72 h clock is only
 * known from the mail.
 */
interface DetectedOrderable {
  accountId: string;
  accountLabel?: string;
  asin: string;
  title?: string;
  imageUrl?: string;
  productUrl: string;
  detectedAt: number;
}

/** "2 j 5 h", "5 h 12 min" or "23 min" left until `expiresAt`. */
function formatTimeLeft(ms: number): string {
  if (ms <= 0) return 'expiré';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export default function ActionsTab({ connected: _connected }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [proxies, setProxies] = useState<ProxyPublic[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [proxyId, setProxyId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [headless, setHeadless] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<(ProxyTestResult & { proxyId: string }) | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [otpSessionId, setOtpSessionId] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [invRuns, setInvRuns] = useState<Record<string, InvRunState>>({});
  const [selectedInv, setSelectedInv] = useState<string[]>([]);
  const [invError, setInvError] = useState<string | null>(null);
  const [invNotice, setInvNotice] = useState<string | null>(null);
  const [accountGroups, setAccountGroups] = useState<NamedGroup[]>([]);
  const [proxyGroups, setProxyGroups] = useState<NamedGroup[]>([]);
  const [proxyGroupId, setProxyGroupId] = useState('');
  // Also visit disabled items, detect-only, so their verdict stops being frozen.
  const [refreshDisabled, setRefreshDisabled] = useState(false);
  const [orderable, setOrderable] = useState<OrderableInvitation[]>([]);
  const [orderableLoading, setOrderableLoading] = useState(false);
  const [orderableError, setOrderableError] = useState<string | null>(null);
  const [orderableChecked, setOrderableChecked] = useState(false);
  const [detected, setDetected] = useState<DetectedOrderable[]>([]);
  const [orderLaunching, setOrderLaunching] = useState<Set<string>>(new Set());
  const [orderError, setOrderError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  function refreshAccounts() {
    fetch('/api/accounts')
      .then((r) => r.json())
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }

  /** Page-detected acceptances — pure store read, no mail, no browser. */
  function loadDetected() {
    fetch('/api/amazon/invitations/detected-orderable')
      .then((r) => r.json())
      .then((d) => setDetected(d.detected ?? []))
      .catch(() => setDetected([]));
  }

  async function loadOrderable() {
    loadDetected();
    setOrderableLoading(true);
    setOrderableError(null);
    try {
      const res = await fetch('/api/amazon/invitations/orderable');
      const data = await res.json();
      if (!res.ok) {
        setOrderableError(data.error ?? 'échec de la lecture des mails');
        setOrderable([]);
      } else {
        setOrderable(data.invitations ?? []);
      }
    } catch (e) {
      setOrderableError((e as Error).message);
      setOrderable([]);
    } finally {
      setOrderableChecked(true);
      setOrderableLoading(false);
    }
  }

  // "Commander" opens a HEADED session for the invitation's account — its
  // persistent profile (cookies), its proxy + fingerprint, auto-login — landing
  // straight on the product page so the order is placed as that account.
  async function orderViaSession(
    o: { accountId?: string; accountLabel?: string; productUrl?: string },
    key: string
  ) {
    setOrderError(null);
    if (!o.accountId) {
      if (o.productUrl) window.open(o.productUrl, '_blank', 'noopener');
      else setOrderError('Compte introuvable pour cette invitation — ouverture impossible.');
      return;
    }
    setOrderLaunching((s) => new Set(s).add(key));
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: o.accountId,
          action: 'amazon',
          headless: false,
          targetUrl: o.productUrl,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'erreur inconnue' }));
        setOrderError(`${o.accountLabel ?? o.accountId} : ${data.error ?? 'échec'}`);
      }
    } catch (e) {
      setOrderError((e as Error).message);
    } finally {
      setOrderLaunching((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  useEffect(() => {
    return connectLive((msg: any) => {
      if (msg.type === 'snapshot') {
        setSessions(msg.sessions);
        // Recover in-flight invitation progress after a page refresh.
        if (Array.isArray(msg.invitations)) {
          setInvRuns(
            Object.fromEntries(
              (msg.invitations as InvitationProgress[]).map((p) => [p.accountId, progressToRun(p)])
            )
          );
        }
      }
      if (msg.type === 'session.created') setSessions((s) => [...s, msg.session]);
      if (msg.type === 'session.destroyed') {
        setSessions((s) => s.filter((x) => x.id !== msg.id));
        setOtpSessionId((curr) => (curr === msg.id ? null : curr));
      }
      if (msg.type === 'session.navigated') {
        setSessions((s) => s.map((x) => (x.id === msg.id ? { ...x, url: msg.url } : x)));
      }
      if (msg.type === 'session.updated') {
        setSessions((s) => s.map((x) => (x.id === msg.session.id ? msg.session : x)));
      }
      if (msg.type === 'session.awaiting_otp') {
        setOtpSessionId((curr) => curr ?? msg.id);
        setOtpCode('');
        setOtpError(null);
      }
      if (msg.type === 'account.updated') refreshAccounts();
      if (msg.type === 'invitation.queued') {
        setInvRuns((r) => ({
          ...r,
          [msg.accountId]: { running: false, queued: true, done: 0, total: msg.total, dryRun: msg.dryRun },
        }));
      }
      if (msg.type === 'invitation.started') {
        setInvRuns((r) => ({
          ...r,
          [msg.accountId]: { running: true, queued: false, done: 0, total: msg.total, dryRun: msg.dryRun },
        }));
      }
      if (msg.type === 'invitation.item') {
        setInvRuns((r) =>
          r[msg.accountId]
            ? {
                ...r,
                [msg.accountId]: {
                  ...r[msg.accountId],
                  done: msg.done,
                  total: msg.total,
                  lastStatus: msg.status,
                },
              }
            : r
        );
      }
      if (msg.type === 'invitation.done') {
        setInvRuns((r) =>
          r[msg.accountId]
            ? { ...r, [msg.accountId]: { ...r[msg.accountId], running: false, counts: msg.counts } }
            : r
        );
        // A run is what discovers an accepted invitation — pick it up right away.
        loadDetected();
      }
      if (msg.type === 'invitation.error') {
        setInvRuns((r) => ({
          ...r,
          [msg.accountId]: {
            ...(r[msg.accountId] ?? { running: false, done: 0, total: 0, dryRun: false }),
            running: false,
            error: msg.message,
          },
        }));
      }
    });
  }, []);

  useEffect(() => {
    fetch('/api/proxies')
      .then((r) => r.json())
      .then(setProxies)
      .catch(() => setProxies([]));
    fetch('/api/account-groups')
      .then((r) => r.json())
      .then(setAccountGroups)
      .catch(() => setAccountGroups([]));
    fetch('/api/proxy-groups')
      .then((r) => r.json())
      .then(setProxyGroups)
      .catch(() => setProxyGroups([]));
    refreshAccounts();
    loadOrderable(); // also pulls the page-detected acceptances
  }, []);

  // Keep the "temps restant" countdowns fresh without re-fetching the inbox.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // The carnet's on/off toggle parks an account: it keeps its profile, proxy and
  // fingerprint but disappears from this whole tab — invitation checklist *and*
  // session picker. Nothing here should offer a parked account. `accounts` stays
  // complete so `accountLabel` can still name one in a server-side notice.
  const activeAccounts = accounts.filter((a) => a.enabled !== false);
  const parkedAccountIds = new Set(accounts.filter((a) => a.enabled === false).map((a) => a.id));

  // An account parked while it was ticked (or picked) must not stay selected.
  useEffect(() => {
    const eligible = new Set(activeAccounts.map((a) => a.id));
    setSelectedInv((s) => (s.every((id) => eligible.has(id)) ? s : s.filter((id) => eligible.has(id))));
    setAccountId((id) => (id && !eligible.has(id) ? '' : id));
  }, [accounts]);

  function loadAccountGroup(groupId: string) {
    const g = accountGroups.find((x) => x.id === groupId);
    if (!g) return;
    // A group can still list accounts parked since it was saved — drop them.
    const eligible = new Set(activeAccounts.map((a) => a.id));
    setSelectedInv(g.memberIds.filter((id) => eligible.has(id)));
  }

  const busyAccountIds = new Set(sessions.map((s) => s.accountId).filter(Boolean));

  function accountLabel(id: string): string {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.prenom} ${a.nom}` : id.slice(0, 8);
  }

  function onAccountChange(id: string) {
    setAccountId(id);
    const acc = accounts.find((a) => a.id === id);
    if (acc?.proxyId) setProxyId(acc.proxyId);
  }

  async function createSession(action?: 'amazon' | 'amazon-register') {
    setError(null);
    // Account creation must be watchable (captcha/phone fallbacks) → force headed.
    const effectiveHeadless = action === 'amazon-register' ? false : headless;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proxyId: proxyId || undefined,
        accountId: accountId || undefined,
        headless: effectiveHeadless,
        action,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'erreur inconnue' }));
      setError(data.error ?? 'erreur inconnue');
    } else {
      setAccountId('');
    }
  }

  function toggleInvAccount(id: string) {
    setSelectedInv((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  /**
   * `verify` = review every in-store item's current state without requesting
   * anything (detect-only over enabled *and* disabled items). It's how an
   * accepted invitation gets found: Amazon doesn't always send the acceptance
   * mail, so the product page is the only reliable signal.
   */
  async function runInvitations(dryRun: boolean, verify = false) {
    if (selectedInv.length === 0) return;
    setInvError(null);
    setInvNotice(null);
    // optimistic: mark selected as starting
    setInvRuns((r) => {
      const next = { ...r };
      // Optimistic: shown as queued until the backend confirms started/queued.
      for (const id of selectedInv) next[id] = { running: false, queued: true, done: 0, total: 0, dryRun };
      return next;
    });
    // A throw here (backend down) must not leave every card stuck on the
    // optimistic "en file d'attente" with nothing ever arriving to clear it.
    let res: Response;
    try {
      res = await fetch('/api/amazon/invitations/run-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountIds: selectedInv,
          proxyGroupId: proxyGroupId || undefined,
          dryRun,
          refreshDisabled: verify ? true : refreshDisabled,
        }),
      });
    } catch (e) {
      setInvError(`Backend injoignable : ${(e as Error).message}`);
      setInvRuns({});
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'erreur inconnue' }));
      setInvError(data.error ?? 'erreur inconnue');
      setInvRuns({});
      return;
    }
    const data = await res.json();
    const notices: string[] = [];
    if (data.skipped?.length) {
      notices.push(
        `Ignorés : ${data.skipped
          .map((s: { accountId: string; reason: string }) => `${accountLabel(s.accountId)} (${s.reason})`)
          .join(', ')}`
      );
      // clear optimistic state for skipped accounts
      setInvRuns((r) => {
        const next = { ...r };
        for (const s of data.skipped as { accountId: string }[]) delete next[s.accountId];
        return next;
      });
    }
    if (data.proxyShortfall > 0) {
      notices.push(
        `${data.proxyShortfall} compte(s) sans proxy : leur propre proxy manquait et le pool était épuisé — lancés sans proxy.`
      );
    }
    if (notices.length) setInvNotice(notices.join(' · '));
  }

  async function destroy(id: string) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  }

  async function reopen(id: string) {
    setError(null);
    const res = await fetch(`/api/sessions/${id}/reopen`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'erreur inconnue' }));
      setError(data.error ?? 'erreur inconnue');
    }
  }

  async function submitOtp() {
    if (!otpSessionId || !otpCode.trim()) return;
    setOtpSubmitting(true);
    setOtpError(null);
    try {
      const r = await fetch(`/api/sessions/${otpSessionId}/otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: otpCode.trim() }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({ error: 'erreur inconnue' }));
        setOtpError(data.error ?? 'erreur inconnue');
      } else {
        setOtpSessionId(null);
        setOtpCode('');
      }
    } catch (e) {
      setOtpError((e as Error).message);
    } finally {
      setOtpSubmitting(false);
    }
  }

  const otpSession = otpSessionId ? sessions.find((s) => s.id === otpSessionId) : null;

  async function testProxy() {
    if (!proxyId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(`/api/proxies/${proxyId}/test`).then((r) => r.json());
      setTestResult({ ...r, proxyId });
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message, proxyId });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <section className="bg-zinc-900 rounded-lg p-4 mb-6 border border-zinc-800">
        <h2 className="font-medium mb-3">Nouvelle session</h2>
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <select
              value={accountId}
              onChange={(e) => onAccountChange(e.target.value)}
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              <option value="">Anonyme (sans compte, contexte éphémère)</option>
              {activeAccounts.map((a) => {
                const busy = busyAccountIds.has(a.id);
                return (
                  <option key={a.id} value={a.id} disabled={busy}>
                    {a.prenom} {a.nom}
                    {busy ? ' (en cours)' : ''}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            <select
              value={proxyId}
              onChange={(e) => setProxyId(e.target.value)}
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              <option value="">Sans proxy (connexion directe)</option>
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} — {p.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm whitespace-nowrap">
              <input
                type="checkbox"
                checked={headless}
                onChange={(e) => setHeadless(e.target.checked)}
              />
              headless
            </label>
            <button
              onClick={testProxy}
              disabled={!proxyId || testing}
              className="bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-sm px-3 py-2 rounded"
            >
              {testing ? 'test…' : 'Tester'}
            </button>
            <button
              onClick={() => createSession()}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-4 py-2 rounded"
            >
              Lancer
            </button>
            <button
              onClick={() => createSession('amazon')}
              disabled={!accountId}
              title={!accountId ? 'Sélectionne un compte' : 'Ouvre Amazon avec ce compte'}
              className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded"
            >
              Amazon
            </button>
            <button
              onClick={() => createSession('amazon-register')}
              disabled={!accountId}
              title={
                !accountId
                  ? 'Sélectionne un compte'
                  : 'Crée le compte Amazon (navigateur visible, OTP email auto)'
              }
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded"
            >
              Créer compte Amazon
            </button>
          </div>
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          {proxies.length} proxys · {activeAccounts.length} comptes — un compte conserve cookies,
          localStorage et sessions entre les lancements.
        </p>
        {error && (
          <div className="mt-3 text-xs px-3 py-2 rounded border bg-red-950 border-red-800 text-red-200">
            {error}
          </div>
        )}
        {testResult && (
          <div
            className={`mt-3 text-xs px-3 py-2 rounded border ${
              testResult.ok
                ? 'bg-emerald-950 border-emerald-800 text-emerald-200'
                : 'bg-red-950 border-red-800 text-red-200'
            }`}
          >
            <span className="font-mono">#{testResult.proxyId}</span>{' '}
            {testResult.ok ? (
              <>
                OK — IP <span className="font-mono">{testResult.ip}</span> en{' '}
                {testResult.latencyMs} ms
              </>
            ) : (
              <>
                échec ({testResult.latencyMs ?? '–'} ms) — {testResult.error}
              </>
            )}
          </div>
        )}
      </section>

      <section className="bg-zinc-900 rounded-lg p-4 mb-6 border border-zinc-800">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="font-medium">Invitations Amazon</h2>
            <p className="text-xs text-zinc-500 mt-1">
              Demande l'invitation d'achat pour tous les items activés du catalogue, en parallèle
              pour les comptes cochés. Réutilisable : les items déjà demandés sont ignorés.
              « Revérifier les décochés » visite aussi les items désactivés — en détection seule,
              sans jamais les demander — pour que leur disponibilité puisse redevenir « dispo ».
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label
              className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none mr-1"
              title="Visite aussi les items décochés, sans jamais les demander, pour rafraîchir leur disponibilité. Sans ça un item décoché garde son verdict indéfiniment."
            >
              <input
                type="checkbox"
                checked={refreshDisabled}
                onChange={(e) => setRefreshDisabled(e.target.checked)}
                className="accent-emerald-600"
              />
              Revérifier les décochés
            </label>
            <button
              onClick={() => runInvitations(true)}
              disabled={selectedInv.length === 0}
              title="Détecte sans rien demander"
              className="bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-3 py-2 rounded"
            >
              Simuler
            </button>
            <button
              onClick={() => runInvitations(true, true)}
              disabled={selectedInv.length === 0}
              title="Passe en revue TOUS les items du store (cochés ou non) sans rien demander, et relève ceux dont l'invitation a été acceptée — le mail d'acceptation n'est pas toujours envoyé."
              className="inline-flex items-center gap-1.5 bg-sky-700 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-3 py-2 rounded"
            >
              <RefreshCw size={14} />
              Vérifier l'état
            </button>
            <button
              onClick={() => runInvitations(false)}
              disabled={selectedInv.length === 0}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded"
            >
              Demander ({selectedInv.length})
            </button>
          </div>
        </div>

        {activeAccounts.length === 0 ? (
          <p className="text-xs text-zinc-500">Aucun compte. Crée-en dans le Carnet.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <button
                onClick={() =>
                  setSelectedInv((s) =>
                    s.length === activeAccounts.length ? [] : activeAccounts.map((a) => a.id)
                  )
                }
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                {selectedInv.length === activeAccounts.length
                  ? 'Tout désélectionner'
                  : 'Tout sélectionner'}
              </button>
              {accountGroups.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) loadAccountGroup(e.target.value);
                    e.target.value = '';
                  }}
                  className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs"
                  title="Cocher les membres d'un groupe de comptes"
                >
                  <option value="">Charger un groupe de comptes…</option>
                  {accountGroups.map((g) => {
                    // Show what loading the group will actually tick, not its raw
                    // member count: a group keeps members that have since been
                    // parked (or deleted), and `loadAccountGroup` drops them — so
                    // the raw count promised more accounts than it selects.
                    const eligible = g.memberIds.filter((id) =>
                      activeAccounts.some((a) => a.id === id)
                    ).length;
                    return (
                      <option key={g.id} value={g.id}>
                        {g.name} (
                        {eligible < g.memberIds.length
                          ? `${eligible} sur ${g.memberIds.length}`
                          : eligible}
                        )
                      </option>
                    );
                  })}
                </select>
              )}
              <label className="flex items-center gap-1 text-xs text-zinc-500">
                Proxies :
                <select
                  value={proxyGroupId}
                  onChange={(e) => setProxyGroupId(e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs"
                  title="Pool de proxies réparti sur les comptes (sinon le proxy de chaque compte)"
                >
                  <option value="">proxy de chaque compte</option>
                  {proxyGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.memberIds.length})
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-xs text-zinc-600">·</span>
              <span className="text-xs text-zinc-500">{selectedInv.length} sélectionné(s)</span>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {activeAccounts.map((a) => {
                const run = invRuns[a.id];
                // A finished run that errored on items never checked them — it
                // must not read like a clean "terminé", or the operator assumes
                // the invitations went out when nothing was ever requested.
                const runErrors = !run?.running && !run?.queued ? (run?.counts?.error ?? 0) : 0;
                const busy = busyAccountIds.has(a.id);
                const checked = selectedInv.includes(a.id);
                return (
                  <li
                    key={a.id}
                    className={`border rounded p-2 ${
                      checked ? 'border-emerald-700/60 bg-zinc-950/40' : 'border-zinc-800'
                    }`}
                  >
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleInvAccount(a.id)}
                      />
                      <span className="flex-1 min-w-0 truncate">
                        {a.prenom} {a.nom}
                      </span>
                      {busy && (
                        <span className="text-[10px] text-amber-400" title="Session ouverte">
                          session
                        </span>
                      )}
                    </label>
                    {run && (
                      <div className="mt-2">
                        <div
                          className={`flex items-center justify-between text-[10px] mb-1 ${
                            runErrors > 0 ? 'text-amber-400' : 'text-zinc-400'
                          }`}
                        >
                          <span>
                            {run.error
                              ? `⚠ ${run.error}`
                              : run.queued
                                ? 'en file d’attente… (5 runs en parallèle max)'
                                : run.running
                                  ? `${run.dryRun ? 'simulation' : 'demande'}… ${run.done}/${run.total}`
                                  : runErrors > 0
                                    ? `⚠ terminé, ${runErrors} item(s) en échec — à relancer`
                                    : `terminé ${run.done}/${run.total}${run.dryRun ? ' (sim)' : ''}`}
                          </span>
                        </div>
                        {!run.error && (
                          <div className="h-1 bg-zinc-800 rounded overflow-hidden">
                            <div
                              className={`h-full transition-all ${
                                run.queued
                                  ? 'bg-amber-600/70'
                                  : run.running
                                    ? 'bg-emerald-600'
                                    : runErrors > 0
                                      ? 'bg-amber-600'
                                      : 'bg-emerald-700'
                              }`}
                              style={{ width: `${run.queued ? 5 : run.total ? (run.done / run.total) * 100 : 5}%` }}
                            />
                          </div>
                        )}
                        {run.counts && (
                          <div className="flex gap-1.5 flex-wrap mt-1 text-[10px] text-zinc-500">
                            {Object.entries(run.counts).map(([status, n]) => (
                              <span
                                key={status}
                                className={status === 'error' ? 'text-amber-400' : undefined}
                              >
                                {INV_STATUS_LABEL[status] ?? status}: {n}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {invError && (
          <div className="mt-3 text-xs px-3 py-2 rounded border bg-red-950 border-red-800 text-red-200">
            {invError}
          </div>
        )}
        {invNotice && (
          <div className="mt-3 text-xs px-3 py-2 rounded border bg-amber-950 border-amber-800 text-amber-200">
            {invNotice}
          </div>
        )}
      </section>

      <section className="bg-zinc-900 rounded-lg p-4 mb-6 border border-zinc-800">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="font-medium flex items-center gap-2">
              <ShoppingCart size={16} className="text-emerald-400" />
              À commander — invitations acceptées
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              Deux sources : les mails Amazon « Félicitations, vous êtes invité à passer commande »
              de moins de 72 h (lecture Gmail seule, aucune action sur Amazon), et les acceptations
              relevées directement sur la page produit par « Vérifier l'état » — Amazon n'envoie pas
              toujours le mail.
            </p>
          </div>
          <button
            onClick={loadOrderable}
            disabled={orderableLoading}
            className="inline-flex items-center gap-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-white text-sm px-3 py-2 rounded"
          >
            <RefreshCw size={14} className={orderableLoading ? 'animate-spin' : ''} />
            {orderableLoading ? 'Lecture…' : 'Vérifier les mails'}
          </button>
        </div>

        {orderableError ? (
          <div className="text-xs px-3 py-2 rounded border bg-red-950 border-red-800 text-red-200">
            {orderableError}
          </div>
        ) : (() => {
          // Parked accounts are gone from this tab — an acceptance for one would
          // otherwise bring it back here with a "Commander" button that opens a
          // session for an account the carnet says not to use.
          const live = orderable.filter(
            (o) => o.expiresAt > now && !(o.accountId && parkedAccountIds.has(o.accountId))
          );
          if (live.length === 0) {
            return (
              <p className="text-xs text-zinc-500">
                {orderableChecked
                  ? 'Aucune invitation acceptée en attente de commande.'
                  : 'Clique sur « Vérifier les mails ».'}
              </p>
            );
          }
          return (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {live.map((o, idx) => {
                const left = o.expiresAt - now;
                const hoursLeft = left / 3_600_000;
                const urgency =
                  hoursLeft < 6
                    ? 'bg-red-950 border-red-800 text-red-200'
                    : hoursLeft < 24
                      ? 'bg-amber-950 border-amber-800 text-amber-200'
                      : 'bg-emerald-950 border-emerald-800 text-emerald-200';
                const key = `${o.email}:${o.asin ?? o.productName}:${idx}`;
                const launching = orderLaunching.has(key);
                return (
                  <li
                    key={key}
                    className="bg-zinc-950/40 border border-zinc-800 rounded-lg p-2.5 flex gap-3"
                  >
                    <div className="w-16 h-16 shrink-0 bg-white rounded overflow-hidden flex items-center justify-center">
                      {o.imageUrl ? (
                        <img src={o.imageUrl} alt="" loading="lazy" className="w-full h-full object-contain" />
                      ) : (
                        <ShoppingCart size={20} className="text-zinc-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col justify-between gap-1">
                      <div>
                        <p className="text-xs leading-tight line-clamp-2" title={o.title ?? o.productName}>
                          {o.title ?? o.productName}
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1">
                          {o.accountLabel && (
                            <span className="text-[10px] px-1.5 py-px rounded bg-emerald-950 border border-emerald-800 text-emerald-200">
                              {o.accountLabel}
                            </span>
                          )}
                          {o.price && <span className="text-[10px] text-zinc-400">{o.price}</span>}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span
                          className={`text-[10px] px-1.5 py-px rounded border ${urgency}`}
                          title={`Expire le ${new Date(o.expiresAt).toLocaleString('fr-FR')}`}
                        >
                          {formatTimeLeft(left)}
                        </span>
                        <button
                          onClick={() => orderViaSession(o, key)}
                          disabled={launching}
                          title={
                            o.accountId
                              ? `Ouvre une session ${o.accountLabel ?? ''} (proxy + cookies) sur la page produit`
                              : 'Compte introuvable — ouvre la page Amazon dans un onglet'
                          }
                          className="inline-flex items-center gap-1 text-[10px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-2 py-1 rounded"
                        >
                          {launching ? 'Ouverture…' : 'Commander'}
                          <ExternalLink size={11} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          );
        })()}

        {detected.length > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-800">
            <p className="text-xs text-zinc-400 mb-2">
              <span className="text-sky-300 font-medium">Détectées sur la page produit</span> — l'offre
              Amazon est passée en achat direct pour ce compte, sans mail d'acceptation. Relève du
              dernier « Vérifier l'état » ; la fenêtre de 72 h n'est pas connue ici.
            </p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {detected.map((d) => {
                const key = `detected:${d.accountId}:${d.asin}`;
                const launching = orderLaunching.has(key);
                return (
                  <li
                    key={key}
                    className="bg-zinc-950/40 border border-sky-900/60 rounded-lg p-2.5 flex gap-3"
                  >
                    <div className="w-16 h-16 shrink-0 bg-white rounded overflow-hidden flex items-center justify-center">
                      {d.imageUrl ? (
                        <img src={d.imageUrl} alt="" loading="lazy" className="w-full h-full object-contain" />
                      ) : (
                        <ShoppingCart size={20} className="text-zinc-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col justify-between gap-1">
                      <div>
                        <p className="text-xs leading-tight line-clamp-2" title={d.title ?? d.asin}>
                          {d.title ?? d.asin}
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1">
                          {d.accountLabel && (
                            <span className="text-[10px] px-1.5 py-px rounded bg-sky-950 border border-sky-800 text-sky-200">
                              {d.accountLabel}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="text-[10px] text-zinc-500"
                          title={new Date(d.detectedAt).toLocaleString('fr-FR')}
                        >
                          vu le {new Date(d.detectedAt).toLocaleDateString('fr-FR')}
                        </span>
                        <button
                          onClick={() => orderViaSession(d, key)}
                          disabled={launching}
                          title={`Ouvre une session ${d.accountLabel ?? ''} (proxy + cookies) sur la page produit`}
                          className="inline-flex items-center gap-1 text-[10px] bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white px-2 py-1 rounded"
                        >
                          {launching ? 'Ouverture…' : 'Commander'}
                          <ExternalLink size={11} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {orderError && (
          <div className="mt-3 text-xs px-3 py-2 rounded border bg-red-950 border-red-800 text-red-200">
            {orderError}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-medium mb-3">Sessions ({sessions.length})</h2>
        {sessions.length === 0 ? (
          <p className="text-zinc-500 text-sm">Aucune session active.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => {
              const canReopen = s.status === 'closed' || s.headless;
              return (
                <li
                  key={s.id}
                  className="bg-zinc-900 border border-zinc-800 rounded p-3 flex items-center justify-between"
                >
                  <div className="text-sm">
                    <div className="font-mono text-xs text-zinc-500">{s.id.slice(0, 8)}</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {s.status === 'closed' ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400">
                          fermée
                        </span>
                      ) : (
                        <span>{s.headless ? 'headless' : 'headed'}</span>
                      )}
                      {s.accountLabel && (
                        <span className="text-xs px-2 py-0.5 rounded bg-emerald-950 border border-emerald-800 text-emerald-200">
                          {s.accountLabel}
                        </span>
                      )}
                      {s.proxyLabel && (
                        <span className="text-zinc-400 text-xs">
                          via #{s.proxyId} {s.proxyLabel}
                        </span>
                      )}
                    </div>
                    {s.url && <div className="text-zinc-400 text-xs mt-1">{s.url}</div>}
                    {s.error && (
                      <div className="text-red-300 text-xs mt-1">{s.error}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {canReopen && (
                      <button
                        onClick={() => reopen(s.id)}
                        title={s.status === 'closed' ? 'Réouvrir' : 'Ouvrir la fenêtre'}
                        className="inline-flex items-center justify-center w-7 h-7 rounded text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/50"
                      >
                        <ExternalLink size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => destroy(s.id)}
                      title="Supprimer la session"
                      className="inline-flex items-center justify-center w-7 h-7 rounded text-red-400 hover:text-red-300 hover:bg-red-950/50"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {otpSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-sm shadow-xl">
            <div className="px-4 py-3 border-b border-zinc-800">
              <h3 className="font-medium">Code de vérification Amazon</h3>
              <p className="text-xs text-zinc-400 mt-1">
                {otpSession.accountLabel ?? otpSession.id.slice(0, 8)} — récupère le code dans
                ta boîte mail
              </p>
            </div>
            <div className="p-4 space-y-3">
              <input
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && otpCode.trim() && !otpSubmitting) submitOtp();
                }}
                placeholder="123456"
                autoFocus
                inputMode="numeric"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-lg font-mono tracking-[0.4em] text-center"
              />
              {otpError && (
                <div className="text-xs px-3 py-2 rounded border bg-red-950 border-red-800 text-red-200">
                  {otpError}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-zinc-800 flex gap-2 justify-end">
              <button
                onClick={() => {
                  setOtpSessionId(null);
                  setOtpCode('');
                  setOtpError(null);
                }}
                className="text-sm px-3 py-2 rounded text-zinc-400 hover:text-zinc-200"
              >
                Plus tard
              </button>
              <button
                onClick={submitOtp}
                disabled={!otpCode.trim() || otpSubmitting}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded"
              >
                {otpSubmitting ? 'Envoi…' : 'Valider'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
