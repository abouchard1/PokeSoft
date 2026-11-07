import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { sessionManager } from './playwright/sessionManager.js';
import { proxyStore } from './proxies.js';
import { accountsStore, type AccountInput } from './accounts.js';
import { cardsStore, type CardInput } from './cards.js';
import { generateAccounts, generateUniqueAddresses, type GenerateOptions } from './generator.js';
import { accountGroupsStore, proxyGroupsStore } from './groups.js';
import { amazonItemsStore } from './amazon/itemsStore.js';
import { invitationsStore } from './amazon/invitationsStore.js';
import {
  listOrderableInvitations,
  invitationMailboxConfigured,
  INVITATION_VALIDITY_HOURS,
} from './amazon/invitationMailbox.js';
import { scrapeBrandStore } from './amazon/storeScraper.js';
import { ordersStore } from './amazon/ordersStore.js';

const PORT = Number(process.env.PORT ?? 3210);

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

app.get('/health', async () => ({ ok: true, ts: Date.now() }));

app.get('/api/proxies', async () => proxyStore.list());

app.get<{ Params: { id: string } }>('/api/proxies/:id/test', async (req) => {
  return proxyStore.test(req.params.id);
});

app.delete<{ Params: { id: string } }>('/api/proxies/:id', async (req, reply) => {
  const ok = proxyStore.delete(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'not found' });
  proxyGroupsStore.removeMemberEverywhere(req.params.id);
  return { ok: true };
});

app.get('/api/sessions', async () => sessionManager.list());

app.post<{
  Body: { proxyId?: string; accountId?: string; headless?: boolean; action?: string; targetUrl?: string };
}>('/api/sessions', async (req, reply) => {
  const { proxyId, accountId, headless = true, action, targetUrl } = req.body ?? {};
  try {
    const session = await sessionManager.create({ proxyId, accountId, headless, action, targetUrl });
    return session.summary();
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
  await sessionManager.destroy(req.params.id);
  return { ok: true };
});

app.post<{ Params: { id: string } }>(
  '/api/sessions/:id/reopen',
  async (req, reply) => {
    try {
      const session = await sessionManager.reopen(req.params.id);
      return session.summary();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  }
);

app.post<{ Params: { id: string }; Body: { code?: string } }>(
  '/api/sessions/:id/otp',
  async (req, reply) => {
    const code = req.body?.code?.trim();
    if (!code) return reply.code(400).send({ error: 'code requis' });
    try {
      await sessionManager.submitOtp(req.params.id, code);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  }
);

app.post<{ Body: GenerateOptions }>('/api/generate/account', async (req) => {
  // Always exclude emails/addresses already in the carnet so no two accounts
  // end up with an identical email or address string.
  const existing = accountsStore.list();
  return generateAccounts({
    ...(req.body ?? {}),
    excludeEmails: existing.map((a) => a.email).filter(Boolean),
    excludeAddresses: existing.map((a) => a.adresse).filter(Boolean),
    excludePasswords: existing.map((a) => a.password).filter(Boolean),
  });
});

// Backfill a unique address for every account that has none, using variations of
// `baseAddress` and excluding all addresses already in the carnet.
app.post<{ Body: { baseAddress?: string } }>('/api/accounts/fill-addresses', async (req) => {
  const accounts = accountsStore.list();
  const targets = accounts.filter((a) => !a.adresse?.trim());
  if (targets.length === 0) return { filled: 0, requested: 0 };
  const existingAddresses = accounts.map((a) => a.adresse).filter(Boolean);
  const fresh = generateUniqueAddresses(targets.length, req.body?.baseAddress, existingAddresses);
  let filled = 0;
  for (let i = 0; i < targets.length && i < fresh.length; i++) {
    accountsStore.update(targets[i].id, { adresse: fresh[i] });
    filled++;
  }
  return { filled, requested: targets.length };
});

app.get('/api/accounts', async () => accountsStore.list());

app.post<{ Body: AccountInput }>('/api/accounts', async (req, reply) => {
  const { nom, prenom, email, password, adresse, telephone, proxyId } =
    req.body ?? ({} as AccountInput);
  if (!nom || !prenom) {
    return reply.code(400).send({ error: 'nom et prenom requis' });
  }
  return accountsStore.create({
    nom,
    prenom,
    email: email ?? '',
    password: password ?? '',
    adresse: adresse ?? '',
    telephone: telephone ?? '',
    proxyId,
  });
});

app.patch<{ Params: { id: string }; Body: Partial<AccountInput> & { enabled?: boolean } }>(
  '/api/accounts/:id',
  async (req, reply) => {
    const updated = accountsStore.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  }
);

app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
  const ok = accountsStore.delete(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'not found' });
  accountGroupsStore.removeMemberEverywhere(req.params.id);
  ordersStore.delete(req.params.id);
  return { ok: true };
});

app.post<{ Params: { id: string } }>(
  '/api/accounts/:id/fingerprint/regenerate',
  async (req, reply) => {
    const updated = accountsStore.regenerateFingerprint(req.params.id);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  }
);

app.get('/api/cards', async () => cardsStore.list());

app.post<{ Body: CardInput }>('/api/cards', async (req, reply) => {
  const { libelle, titulaire, numero, expiration, cvv, accountId } =
    req.body ?? ({} as CardInput);
  if (!numero || !titulaire) {
    return reply.code(400).send({ error: 'numero et titulaire requis' });
  }
  return cardsStore.create({
    libelle: libelle ?? '',
    titulaire,
    numero,
    expiration: expiration ?? '',
    cvv: cvv ?? '',
    accountId,
  });
});

app.patch<{ Params: { id: string }; Body: Partial<CardInput> }>(
  '/api/cards/:id',
  async (req, reply) => {
    const updated = cardsStore.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  }
);

app.delete<{ Params: { id: string } }>('/api/cards/:id', async (req, reply) => {
  const ok = cardsStore.delete(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

app.get('/api/amazon/items', async () => {
  // Enrich each item with a single "open to invitation?" verdict, so the UI can
  // grey out / filter dead items. Two signals are merged (they mean the same to
  // the user): (1) absent from the latest store scrape (`inStore === false`),
  // and (2) run results where no account ever got an invite.
  const avail = invitationsStore.availabilityByAsin();
  return amazonItemsStore.list().map((i) => {
    const run = avail[i.asin];
    const available: 'yes' | 'no' | 'unknown' =
      i.inStore === false ? 'no' : (run?.available ?? 'unknown');
    return {
      ...i,
      invite: {
        available,
        inStore: i.inStore !== false,
        unavailable: run?.unavailable ?? 0,
        gotInvite: run?.gotInvite ?? 0,
        checkedAccounts: run?.checkedAccounts ?? 0,
        lastCheckedAt: run?.lastCheckedAt ?? 0,
      },
    };
  });
});

let importInFlight = false;

app.post<{ Body: { proxyId?: string } }>('/api/amazon/import', async (req, reply) => {
  if (importInFlight) {
    return reply.code(409).send({ error: 'Un import est déjà en cours.' });
  }
  importInFlight = true;
  try {
    const { items, extensions } = await scrapeBrandStore({
      proxyId: req.body?.proxyId,
      onProgress: (m) => app.log.info(`[amazon-import] ${m}`),
    });
    const result = amazonItemsStore.upsertMany(items);
    return { ...result, extensions, scraped: items.length };
  } catch (err) {
    app.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  } finally {
    importInFlight = false;
  }
});

app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>(
  '/api/amazon/items/:id',
  async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled (boolean) requis' });
    }
    const updated = amazonItemsStore.setEnabled(req.params.id, req.body.enabled);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  }
);

app.delete<{ Params: { id: string } }>('/api/amazon/items/:id', async (req, reply) => {
  const ok = amazonItemsStore.delete(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

app.get<{ Querystring: { accountId?: string } }>('/api/amazon/invitations', async (req) => {
  return invitationsStore.list(req.query.accountId);
});

// Live per-account run progress (queued/running/done/error). Survives a front
// refresh — also delivered in the WS snapshot on (re)connect.
app.get('/api/amazon/invitations/progress', async () => sessionManager.invitationProgressList());

// Accepted invitations still inside their 72 h window, read straight from the
// shared Gmail inbox ("Félicitations, vous êtes invité à passer commande!").
// Detection is mail-only — no browser is launched. Each is mapped to its account
// (by recipient alias) and enriched from the catalogue (title/image) when known.
app.get('/api/amazon/invitations/orderable', async (_req, reply) => {
  if (!invitationMailboxConfigured()) {
    return reply.code(503).send({ error: 'IMAP Gmail non configuré (GMAIL_USER / GMAIL_APP_PASSWORD).' });
  }
  try {
    const invites = await listOrderableInvitations();
    const accounts = accountsStore.list();
    const items = amazonItemsStore.list();
    const enriched = invites.map((inv) => {
      const mail = inv.email.toLowerCase();
      const account = accounts.find((a) => a.email && mail.includes(a.email.toLowerCase()));
      const item = inv.asin ? items.find((i) => i.asin === inv.asin) : undefined;
      return {
        ...inv,
        accountId: account?.id,
        accountLabel: account ? `${account.prenom} ${account.nom}` : undefined,
        title: item?.title,
        imageUrl: item?.imageUrl,
        productUrl: item?.productUrl || inv.productUrl,
      };
    });
    enriched.sort((a, b) => a.expiresAt - b.expiresAt);
    return { validityHours: INVITATION_VALIDITY_HOURS, invitations: enriched };
  } catch (err) {
    app.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

/**
 * Invitations detected as **accepted** on the product page itself (status
 * `orderable`, set by a run when Amazon's own offer takes an add-to-cart with no
 * invite button). Complements `/orderable`, which reads the acceptance mail:
 * Amazon does not always send it, so the page is the reliable signal. No browser
 * here either — this only reads what the last run recorded.
 */
app.get('/api/amazon/invitations/detected-orderable', async () => {
  const accounts = accountsStore.list();
  const items = amazonItemsStore.list();
  const detected = invitationsStore
    .list()
    .filter((r) => r.status === 'orderable')
    .map((r) => {
      const account = accounts.find((a) => a.id === r.accountId);
      const item = items.find((i) => i.asin === r.asin);
      return {
        accountId: r.accountId,
        accountLabel: account ? `${account.prenom} ${account.nom}` : undefined,
        accountParked: account ? account.enabled === false : false,
        asin: r.asin,
        title: item?.title,
        imageUrl: item?.imageUrl,
        productUrl: item?.productUrl || `https://www.amazon.fr/dp/${r.asin}`,
        detectedAt: r.lastCheckedAt,
      };
    })
    // Parked accounts are invisible on the Actions tab — don't smuggle one back.
    .filter((d) => !d.accountParked)
    .sort((a, b) => b.detectedAt - a.detectedAt);
  return { detected };
});

/** Items a run will visit: every enabled item, plus the disabled ones still in
 *  store (checked, never requested) — every run is a full check-up. */
function invitationRunSize(): number {
  return amazonItemsStore.list().filter((i) => i.enabled || i.inStore !== false).length;
}

app.post<{ Body: { accountId?: string; dryRun?: boolean } }>(
  '/api/amazon/invitations/run',
  async (req, reply) => {
    const accountId = req.body?.accountId;
    if (!accountId) return reply.code(400).send({ error: 'accountId requis' });
    const total = invitationRunSize();
    if (total === 0) return reply.code(400).send({ error: 'Aucun item activé dans le catalogue.' });
    if (sessionManager.isInvitationRunning(accountId)) {
      return reply.code(409).send({ error: 'Tâche déjà en cours pour ce compte.' });
    }
    // Fire-and-forget: progress is streamed over the WebSocket.
    sessionManager
      .runInvitations(accountId, req.body?.dryRun === true)
      .catch((err) => app.log.error({ err }, 'invitation run failed'));
    return { started: true, total, dryRun: req.body?.dryRun === true };
  }
);

app.post<{
  Body: {
    accountIds?: string[];
    accountGroupId?: string;
    proxyIds?: string[];
    proxyGroupId?: string;
    dryRun?: boolean;
  };
}>('/api/amazon/invitations/run-batch', async (req, reply) => {
  const body = req.body ?? {};
  // Resolve the account list from an account group or an explicit list.
  const accountIds = body.accountGroupId
    ? (accountGroupsStore.get(body.accountGroupId)?.memberIds ?? [])
    : (body.accountIds ?? []);
  if (accountIds.length === 0) return reply.code(400).send({ error: 'aucun compte (groupe vide ?)' });

  const total = invitationRunSize();
  if (total === 0) return reply.code(400).send({ error: 'Aucun item activé dans le catalogue.' });

  // Resolve the proxy pool (optional). If empty, each account uses its own proxy.
  const proxyIds = body.proxyGroupId
    ? (proxyGroupsStore.get(body.proxyGroupId)?.memberIds ?? [])
    : (body.proxyIds ?? []);

  const dryRun = body.dryRun === true;
  const started: string[] = [];
  const skipped: { accountId: string; reason: string }[] = [];

  // Proxy policy: an account's own attached proxy ALWAYS wins (keeps a stable IP
  // per account → lower detection risk). The group pool only fills in accounts
  // that have no proxy of their own. Pool proxies that collide with an account's
  // own proxy are excluded so two accounts never share one IP, and each pool
  // proxy is consumed at most once.
  const ownProxies = new Set(
    accountIds.map((id) => accountsStore.get(id)?.proxyId).filter(Boolean) as string[]
  );
  const poolQueue = proxyIds.filter((p) => !ownProxies.has(p));
  let poolCursor = 0;
  let proxyShortfall = 0;

  accountIds.forEach((accountId) => {
    const can = sessionManager.canStartInvitations(accountId);
    if (!can.ok) {
      skipped.push({ accountId, reason: can.reason ?? 'impossible' });
      return;
    }
    let proxyId = accountsStore.get(accountId)?.proxyId;
    if (!proxyId) {
      if (poolCursor < poolQueue.length) proxyId = poolQueue[poolCursor++];
      else if (proxyIds.length > 0) proxyShortfall++; // pool given but exhausted
    }
    started.push(accountId);
    sessionManager
      .runInvitations(accountId, dryRun, proxyId)
      .catch((err) => app.log.error({ err, accountId }, 'invitation run failed'));
  });
  return { started, skipped, total, dryRun, proxyShortfall };
});

// Order history of every account, as last synced from its "Vos commandes" page.
// Accounts never synced come back with `orders: null` so the page can tell
// "nouveau compte" (synced, 0 orders) from "pas encore vérifié".
app.get('/api/amazon/orders', async () => {
  const progress = new Map(sessionManager.orderSyncProgressList().map((p) => [p.accountId, p]));
  return accountsStore.list().map((a) => {
    const rec = ordersStore.get(a.id);
    return {
      accountId: a.id,
      accountLabel: `${a.prenom} ${a.nom}`,
      email: a.email,
      enabled: a.enabled !== false,
      syncedAt: rec?.syncedAt,
      attemptedAt: rec?.attemptedAt,
      syncStatus: rec?.status,
      syncMessage: rec?.message,
      years: rec?.years ?? [],
      orders: rec?.syncedAt ? rec.orders : null,
      progress: progress.get(a.id),
    };
  });
});

app.get('/api/amazon/orders/progress', async () => sessionManager.orderSyncProgressList());

// Sync the order history of several accounts (fire-and-forget, progress over WS).
// Defaults to every enabled account. Each account uses its own proxy.
app.post<{ Body: { accountIds?: string[]; accountGroupId?: string } }>(
  '/api/amazon/orders/sync',
  async (req, reply) => {
    const body = req.body ?? {};
    const accountIds = body.accountGroupId
      ? (accountGroupsStore.get(body.accountGroupId)?.memberIds ?? [])
      : (body.accountIds ??
        accountsStore
          .list()
          .filter((a) => a.enabled !== false)
          .map((a) => a.id));
    if (accountIds.length === 0) return reply.code(400).send({ error: 'aucun compte' });
    const started: string[] = [];
    const skipped: { accountId: string; reason: string }[] = [];
    for (const accountId of accountIds) {
      const can = sessionManager.canStartOrderSync(accountId);
      if (!can.ok) {
        skipped.push({ accountId, reason: can.reason ?? 'impossible' });
        continue;
      }
      started.push(accountId);
      sessionManager
        .syncOrders(accountId)
        .catch((err) => app.log.error({ err, accountId }, 'order sync failed'));
    }
    return { started, skipped };
  }
);

// Two independent group kinds: account groups and proxy groups. They are not
// linked — a bulk action picks one of each at run time.
for (const [kind, store] of [
  ['account-groups', accountGroupsStore],
  ['proxy-groups', proxyGroupsStore],
] as const) {
  app.get(`/api/${kind}`, async () => store.list());

  app.post<{ Body: { name?: string } }>(`/api/${kind}`, async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name requis' });
    return store.create(name);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; memberIds?: string[] } }>(
    `/api/${kind}/:id`,
    async (req, reply) => {
      const updated = store.update(req.params.id, req.body ?? {});
      if (!updated) return reply.code(404).send({ error: 'not found' });
      return updated;
    }
  );

  app.delete<{ Params: { id: string } }>(`/api/${kind}/:id`, async (req, reply) => {
    const ok = store.delete(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}

app.register(async (instance) => {
  instance.get('/ws', { websocket: true }, (socket) => {
    sessionManager.attachClient(socket);
  });
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Pokesoft backend listening on :${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
