import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { WebSocket } from 'ws';
import { proxyStore } from '../proxies.js';
import { accountsStore, type Account } from '../accounts.js';
import { amazonItemsStore } from '../amazon/itemsStore.js';
import { invitationsStore, type InvitationStatus } from '../amazon/invitationsStore.js';
import { otpMailbox, otpMailboxConfigured } from '../amazon/otpMailbox.js';
import { orderNumber, pollSms, smsProviderConfigured, type SmsOrder } from '../amazon/smsProvider.js';
import { solveFunCaptcha, captchaSolverConfigured } from '../amazon/captchaSolver.js';
import { ordersStore } from '../amazon/ordersStore.js';
import { scrapeOrderHistory, OrdersLoginRequired } from '../amazon/ordersScraper.js';
import { FINGERPRINT_INIT_SCRIPT, NO_PASSKEY_INIT_SCRIPT, type Fingerprint } from '../fingerprint.js';

export type SessionAction = 'amazon' | 'amazon-register';

export interface SessionOptions {
  proxyId?: string;
  accountId?: string;
  headless?: boolean;
  action?: string;
  /** After the initial navigation + auto-login, land the session on this URL
   *  (e.g. a product page to place an accepted invitation's order). */
  targetUrl?: string;
  /** Abort some resource requests to cut bandwidth (residential proxies) + speed.
   *  'aggressive' (image/css/font/media) for headless automation; 'light'
   *  (font/media, keeps images+css usable) for headed flows that may need a
   *  human-readable page (e.g. solving a captcha by hand). */
  blockResources?: 'aggressive' | 'light';
}

const RESOURCE_BLOCK: Record<'aggressive' | 'light', Set<string>> = {
  aggressive: new Set(['image', 'stylesheet', 'font', 'media']),
  light: new Set(['font', 'media']),
};

const ACTION_URLS: Record<SessionAction, string> = {
  amazon: 'https://www.amazon.fr/',
  // Registration starts from the homepage; registerAmazonAccount() clicks through
  // to the create-account form (more reliable than hitting /ap/register cold).
  'amazon-register': 'https://www.amazon.fr/',
};

export type SessionStatus = 'running' | 'closed';

export interface SessionSummary {
  id: string;
  proxyId?: string;
  proxyLabel?: string;
  accountId?: string;
  accountLabel?: string;
  headless: boolean;
  status: SessionStatus;
  createdAt: number;
  url?: string;
  error?: string;
}

export type Event =
  | { type: 'session.created'; session: SessionSummary }
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.destroyed'; id: string }
  | { type: 'session.navigated'; id: string; url: string }
  | { type: 'session.awaiting_otp'; id: string }
  | { type: 'log'; id: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'account.updated'; id: string }
  | { type: 'invitation.queued'; accountId: string; total: number; dryRun: boolean }
  | { type: 'invitation.started'; accountId: string; total: number; dryRun: boolean }
  | {
      type: 'invitation.item';
      accountId: string;
      asin: string;
      status: InvitationStatus;
      done: number;
      total: number;
    }
  | {
      type: 'invitation.done';
      accountId: string;
      total: number;
      counts: Record<string, number>;
    }
  | { type: 'invitation.error'; accountId: string; message: string }
  | { type: 'orders.progress'; progress: OrderSyncProgress }
  | { type: 'orders.synced'; accountId: string };

/** Per-account order-history sync state (in memory, sent in the WS snapshot). */
export interface OrderSyncProgress {
  accountId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  /** Current step ("2025 — page 1"), or the outcome once finished. */
  message?: string;
  orders?: number;
  startedAt: number;
  updatedAt: number;
}

/** Per-account invitation run progress, kept in memory so the UI can recover it
 *  after a page refresh (sent in the WS snapshot + exposed via GET). */
export interface InvitationProgress {
  accountId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  dryRun: boolean;
  lastStatus?: InvitationStatus;
  counts?: Record<string, number>;
  message?: string;
  startedAt: number;
  updatedAt: number;
}

const OTP_SELECTOR = 'input[name="otpCode"]';
const INVITE_BUTTON_SELECTOR = 'input[name="submit.inviteButton"]';
/** Amazon.fr's own merchant id. `/dp/<asin>?m=<id>` forces that seller's offer
 *  into the buybox — the invitation-gated offers are always sold by Amazon. */
const AMAZON_FR_MERCHANT_ID = 'A1X6FK5RDHNB96';
/** Consecutive item failures that end a run (see the loop in `runInvitations`). */
const MAX_CONSECUTIVE_ERRORS = 5;
/** Amazon's offer is buyable outright — the invitation was accepted. */
const ADD_TO_CART_SELECTOR =
  '#add-to-cart-button, input[name="submit.add-to-cart"], #buy-now-button';

function isMeaningfulUrl(url: string): boolean {
  if (!url) return false;
  if (url === 'about:blank') return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('chrome-error://')) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('edge://')) return false;
  if (url.startsWith('data:')) return false;
  return true;
}

const PROFILES_ROOT =
  process.env.PROFILES_DIR ?? resolve(process.cwd(), '..', 'data', 'playwright-profiles');

function profileDirFor(accountId: string): string {
  return join(PROFILES_ROOT, accountId);
}

function accountLabelFor(accountId?: string): string | undefined {
  if (!accountId) return undefined;
  const a = accountsStore.list().find((x) => x.id === accountId);
  return a ? `${a.prenom} ${a.nom}` : undefined;
}

async function applyFingerprint(context: BrowserContext, fp: Fingerprint) {
  await context.addInitScript({
    content: `window.__POKESOFT_FP__ = ${JSON.stringify(fp)};\n${FINGERPRINT_INIT_SCRIPT}`,
  });
  await context.setExtraHTTPHeaders({
    'Accept-Language': `${fp.locale},${fp.locale.split('-')[0]};q=0.9`,
  });
}

class Session {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  url?: string;
  error?: string;
  status: SessionStatus = 'running';
  initialPage!: Page;
  private browser: Browser | undefined;
  private context!: BrowserContext;
  private localProxyUrl: string | undefined;
  private closing = false;

  constructor(
    browser: Browser | undefined,
    context: BrowserContext,
    page: Page,
    localProxyUrl: string | undefined,
    readonly options: SessionOptions
  ) {
    this.attach(browser, context, page, localProxyUrl);
  }

  attach(
    browser: Browser | undefined,
    context: BrowserContext,
    page: Page,
    localProxyUrl: string | undefined
  ) {
    this.browser = browser;
    this.context = context;
    this.localProxyUrl = localProxyUrl;
    this.initialPage = page;
    this.url = undefined;
    this.error = undefined;
    this.status = 'running';
    this.closing = false;
    this.bindPage(page);
    context.on('page', (p) => this.bindPage(p));
    context.on('close', () => {
      if (this.closing) return;
      this.status = 'closed';
      sessionManager.emit({ type: 'session.updated', session: this.summary() });
      if (this.browser) {
        this.browser.close().catch(() => {});
      }
    });
  }

  private bindPage(page: Page) {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const next = frame.url();
      if (!isMeaningfulUrl(next)) return;
      this.url = next;
      sessionManager.emit({ type: 'session.navigated', id: this.id, url: next });
    });
    page.on('domcontentloaded', async () => {
      const currentUrl = page.url();
      if (!/amazon\.[a-z.]+/i.test(currentUrl)) return;
      try {
        const otpInput = await page.$(OTP_SELECTOR);
        if (otpInput) {
          sessionManager.emit({ type: 'session.awaiting_otp', id: this.id });
        }
      } catch {
        // page closed / navigated mid-check
      }
    });
  }

  summary(): SessionSummary {
    const proxyEntry = this.options.proxyId ? proxyStore.get(this.options.proxyId) : undefined;
    return {
      id: this.id,
      proxyId: this.options.proxyId,
      proxyLabel: proxyEntry ? `${proxyEntry.host}:${proxyEntry.port}` : undefined,
      accountId: this.options.accountId,
      accountLabel: accountLabelFor(this.options.accountId),
      headless: this.options.headless ?? true,
      status: this.status,
      createdAt: this.createdAt,
      url: this.url,
      error: this.error,
    };
  }

  async close() {
    this.closing = true;
    try {
      await this.context.close();
    } catch {
      // ignore
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
    }
    if (this.localProxyUrl) {
      const url = this.localProxyUrl;
      this.localProxyUrl = undefined;
      try {
        await closeAnonymizedProxy(url, true);
      } catch {
        // ignore
      }
    }
  }
}

class SessionManager {
  private sessions = new Map<string, Session>();
  private accountSessions = new Map<string, string>();
  private clients = new Set<WebSocket>();

  list(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((s) => s.summary());
  }

  /** Abort image/css/font/media requests (per level) to save bandwidth + time. */
  private async applyResourceBlocking(context: BrowserContext, level: 'aggressive' | 'light') {
    const blocked = RESOURCE_BLOCK[level];
    await context.route('**/*', (route) => {
      if (blocked.has(route.request().resourceType())) return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });
  }

  private async launchContextAndPage(options: SessionOptions): Promise<{
    browser: Browser | undefined;
    context: BrowserContext;
    page: Page;
    localProxyUrl: string | undefined;
  }> {
    const account = options.accountId ? accountsStore.get(options.accountId) : undefined;
    const proxyEntry = options.proxyId ? proxyStore.get(options.proxyId) : undefined;
    if (options.proxyId && !proxyEntry) {
      throw new Error(`Proxy inconnu : ${options.proxyId}`);
    }
    // Chromium's native proxy auth flow (Fetch.continueWithAuth) sometimes
    // returns HTTP 407 even with valid credentials — depends on environment
    // (Windows firewall, AV, timing). Route the proxy through a local
    // proxy-chain forwarder so Chromium sees an auth-less proxy.
    let localProxyUrl: string | undefined;
    let proxyConfig: { server: string; username?: string; password?: string } | undefined;
    if (proxyEntry) {
      const upstream = `http://${encodeURIComponent(proxyEntry.username)}:${encodeURIComponent(proxyEntry.password)}@${proxyEntry.host}:${proxyEntry.port}`;
      localProxyUrl = await anonymizeProxy(upstream);
      proxyConfig = { server: localProxyUrl };
    }

    try {
      if (options.accountId) {
        const dir = profileDirFor(options.accountId);
        mkdirSync(dir, { recursive: true });
        const fp = account?.fingerprint;
        const context = await chromium.launchPersistentContext(dir, {
          headless: options.headless ?? true,
          proxy: proxyConfig,
          userAgent: fp?.userAgent,
          viewport: fp?.viewport,
          deviceScaleFactor: fp?.deviceScaleFactor,
          locale: fp?.locale,
          timezoneId: fp?.timezoneId,
        });
        await context.addInitScript({ content: NO_PASSKEY_INIT_SCRIPT });
        if (fp) await applyFingerprint(context, fp);
        if (options.blockResources) await this.applyResourceBlocking(context, options.blockResources);
        const page = context.pages()[0] ?? (await context.newPage());
        return { browser: undefined, context, page, localProxyUrl };
      }

      const browser = await chromium.launch({ headless: options.headless ?? true });
      const context = await browser.newContext(proxyConfig ? { proxy: proxyConfig } : undefined);
      await context.addInitScript({ content: NO_PASSKEY_INIT_SCRIPT });
      if (options.blockResources) await this.applyResourceBlocking(context, options.blockResources);
      const page = await context.newPage();
      return { browser, context, page, localProxyUrl };
    } catch (err) {
      if (localProxyUrl) {
        await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
      }
      throw err;
    }
  }

  private async navigateTo(session: Session, target: string | undefined) {
    if (!target) return;
    const sid = session.id.slice(0, 8);
    const page = session.initialPage;
    session.error = undefined;
    console.log(`[${sid}] navigate → ${target}`);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // Via a proxy, Amazon often answers the first request with an AWS WAF JS
      // challenge (~2KB HTML that sets a cookie then reloads). Wait for the real
      // page to settle in instead of returning while the body is still empty.
      // Also clicks through the "Continuer les achats" bot interstitial.
      if (!(await this.settleAmazonPage(page))) console.warn(`[${sid}] settle wait: page toujours vide`);
      console.log(`[${sid}] navigated → ${page.url()}`);
      this.emit({ type: 'session.updated', session: session.summary() });
    } catch (err) {
      // First line only — proxy/tunnel errors are multi-line and noisy.
      const message = (err as Error).message.split('\n')[0];
      console.error(`[${sid}] navigate failed: ${message}`);
      const proxyHint = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|TIMED_OUT|ECONNRESET|ERR_NO_SUPPORTED_PROXIES/i.test(
        message
      )
        ? ' (proxy injoignable ? teste-le dans l’onglet Proxy)'
        : '';
      session.error = `Échec navigation: ${message}${proxyHint}`;
      this.emit({ type: 'session.updated', session: session.summary() });
      this.emit({
        type: 'log',
        id: session.id,
        level: 'error',
        message: `navigate ${target} failed: ${message}`,
      });
    }
  }

  private actionUrl(action: string | undefined): string | undefined {
    return action ? ACTION_URLS[action as SessionAction] : undefined;
  }

  /**
   * Wipe an account's persistent profile (cookies/storage) and regenerate its
   * fingerprint, so the next launch looks like a brand-new device. Used before
   * account creation — a returning device/cookie is what makes Amazon flag the
   * attempt or claim the email/account already exists.
   */
  private resetProfileForFreshStart(accountId: string) {
    try {
      // Windows can hold a transient lock on a just-closed Chromium profile.
      rmSync(profileDirFor(accountId), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // nothing to clean / still locked — launch will reuse what's there
    }
    accountsStore.regenerateFingerprint(accountId);
    this.emit({ type: 'account.updated', id: accountId });
  }

  async create(options: SessionOptions): Promise<Session> {
    if (options.accountId && this.accountSessions.has(options.accountId)) {
      throw new Error('Une session est déjà ouverte pour ce compte.');
    }
    // Same persistent profile dir — Chromium can't open it twice.
    if (options.accountId && this.orderSyncs.has(options.accountId)) {
      throw new Error('Synchro des commandes en cours pour ce compte.');
    }

    // Account creation must look like a fresh device every attempt.
    if (options.action === 'amazon-register' && options.accountId) {
      this.resetProfileForFreshStart(options.accountId);
    }

    const account = options.accountId ? accountsStore.get(options.accountId) : undefined;
    const effectiveOptions: SessionOptions = {
      ...options,
      proxyId: options.proxyId ?? account?.proxyId,
      // Account creation is headed and may need a hand-solvable captcha → keep
      // images + CSS, only drop fonts/media.
      blockResources: options.action === 'amazon-register' ? 'light' : options.blockResources,
    };

    const { browser, context, page, localProxyUrl } = await this.launchContextAndPage(effectiveOptions);
    const session = new Session(browser, context, page, localProxyUrl, effectiveOptions);

    this.sessions.set(session.id, session);
    if (effectiveOptions.accountId) {
      this.accountSessions.set(effectiveOptions.accountId, session.id);
      accountsStore.touch(effectiveOptions.accountId);
      if (effectiveOptions.proxyId && account?.proxyId !== effectiveOptions.proxyId) {
        accountsStore.update(effectiveOptions.accountId, { proxyId: effectiveOptions.proxyId });
      }
      this.emit({ type: 'account.updated', id: effectiveOptions.accountId });
    }
    this.emit({ type: 'session.created', session: session.summary() });

    await this.navigateTo(session, this.actionUrl(effectiveOptions.action));
    if (account) {
      if (effectiveOptions.action === 'amazon-register') {
        // Long-running (email OTP + phone/SMS loop) — fire-and-forget so the HTTP
        // response returns immediately; progress streams via log/session events.
        void this.registerAmazonAccount(session, account).catch((err) =>
          this.emit({ type: 'log', id: session.id, level: 'error', message: `register: ${(err as Error).message}` })
        );
      } else {
        await this.ensureLoggedIn(session, account);
        // Land on the requested page (e.g. a product to order) once authenticated,
        // overriding ensureLoggedIn's return to the homepage.
        if (effectiveOptions.targetUrl) await this.navigateTo(session, effectiveOptions.targetUrl);
      }
    } else if (effectiveOptions.targetUrl) {
      await this.navigateTo(session, effectiveOptions.targetUrl);
    }

    return session;
  }

  async reopen(id: string): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('session inconnue');

    const lastUrl = session.url;

    if (session.status === 'running') {
      await session.close();
    }

    (session.options as { headless?: boolean }).headless = false;
    const { browser, context, page, localProxyUrl } = await this.launchContextAndPage(session.options);
    session.attach(browser, context, page, localProxyUrl);

    this.emit({ type: 'session.updated', session: session.summary() });

    await this.navigateTo(session, lastUrl ?? this.actionUrl(session.options.action));
    const account = session.options.accountId
      ? accountsStore.get(session.options.accountId)
      : undefined;
    if (account) await this.ensureLoggedIn(session, account);

    return session;
  }

  async destroy(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.close();
    this.sessions.delete(id);
    if (session.options.accountId) this.accountSessions.delete(session.options.accountId);
    this.emit({ type: 'session.destroyed', id });
  }

  async submitOtp(id: string, code: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('session inconnue');
    const page = session.initialPage;
    await page.fill(OTP_SELECTOR, code);
    await page
      .locator('input#auth-signin-button, input[type="submit"]')
      .first()
      .click();
  }

  private invitationRuns = new Set<string>();
  private invitationProgress = new Map<string, InvitationProgress>();

  // Concurrency cap: at most N invitation runs touch a browser at once. Extra
  // runs wait in a queue (status 'queued') — launching all at once spawns too
  // many headless Chromium + login flows and bogs the host down.
  private static INVITATION_CONCURRENCY = 5;
  private invitationActive = 0;
  private invitationQueue: (() => void)[] = [];

  private async acquireInvitationSlot(): Promise<void> {
    if (this.invitationActive >= SessionManager.INVITATION_CONCURRENCY) {
      await new Promise<void>((resolve) => this.invitationQueue.push(resolve));
    }
    this.invitationActive++;
  }

  private releaseInvitationSlot(): void {
    this.invitationActive--;
    const next = this.invitationQueue.shift();
    if (next) next();
  }

  /** Snapshot of all known invitation runs (queued/running/done/error). */
  invitationProgressList(): InvitationProgress[] {
    return Array.from(this.invitationProgress.values());
  }

  private setInvitationProgress(accountId: string, patch: Partial<InvitationProgress>): void {
    const prev = this.invitationProgress.get(accountId);
    const next: InvitationProgress = {
      accountId,
      status: 'queued',
      done: 0,
      total: 0,
      dryRun: false,
      startedAt: prev?.startedAt ?? Date.now(),
      ...prev,
      ...patch,
      updatedAt: Date.now(),
    };
    this.invitationProgress.set(accountId, next);
  }

  isInvitationRunning(accountId: string): boolean {
    return this.invitationRuns.has(accountId);
  }

  /** Whether an invitation run can start right now for this account. */
  canStartInvitations(accountId: string): { ok: boolean; reason?: string } {
    if (this.invitationRuns.has(accountId)) return { ok: false, reason: 'déjà en cours' };
    if (this.accountSessions.has(accountId)) return { ok: false, reason: 'session ouverte' };
    if (this.orderSyncs.has(accountId)) return { ok: false, reason: 'synchro commandes en cours' };
    const account = accountsStore.get(accountId);
    if (!account) return { ok: false, reason: 'compte inconnu' };
    // Backstop: a group can still carry a parked account long after it was
    // hidden from the picker.
    if (account.enabled === false) return { ok: false, reason: 'compte désactivé' };
    return { ok: true };
  }

  /**
   * Best-effort Amazon login with the account's stored credentials. Called when
   * an invitation navigation lands on /ap/signin. Returns `ok` once we're off the
   * signin pages. On an OTP/MFA/CVF challenge it fetches the code from the shared
   * Gmail inbox (the account's alias) and submits it; if that fails it reports
   * back with `otp: true` so a headed caller can finish by hand.
   */
  private async attemptLogin(
    page: Page,
    account: Account
  ): Promise<{ ok: true } | { ok: false; status: InvitationStatus; message: string; otp?: boolean }> {
    if (!account.email || !account.password) {
      return { ok: false, status: 'login', message: 'Identifiants manquants pour ce compte.' };
    }
    // Emails sent before this moment belong to earlier attempts — used to filter.
    const startedAt = new Date();
    const password = page.locator('input#ap_password, input[name="password"]').first();
    try {
      // Amazon FR's sign-in is email-first: enter the email, click "Continuer",
      // then the password shows on the next page (/ap/signin or /ax/claim).
      // The continue step occasionally lands on a transient "Veuillez activer
      // les cookies" interstitial — reloading and retrying the email step clears
      // it — so loop until the password field is actually visible.
      let passwordReady = false;
      for (let attempt = 0; attempt < 2 && !passwordReady; attempt++) {
        const email = page.locator('input#ap_email, input#ap_email_login, input[name="email"]').first();
        if ((await email.count()) > 0 && (await email.isVisible().catch(() => false))) {
          await email.fill(account.email);
          const cont = page.locator('input#continue, #continue').first();
          if ((await cont.count()) > 0) {
            await cont.click().catch(() => {});
            await page.waitForLoadState('domcontentloaded').catch(() => {});
          }
        }
        await password.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        if (await password.isVisible().catch(() => false)) {
          passwordReady = true;
          break;
        }
        // Not visible — likely the cookie interstitial. Reload and try once more.
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      if (!passwordReady) {
        return { ok: false, status: 'login', message: 'Champ mot de passe introuvable (interstitiel cookies ?).' };
      }
      await password.fill(account.password);
      await this.checkIfPresent(page, 'input[name="rememberMe"]');
      await page
        .locator('input#signInSubmit, #signInSubmit, input#auth-signin-button')
        .first()
        .click()
        .catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2500);
    } catch (err) {
      return { ok: false, status: 'login', message: 'Connexion échouée: ' + (err as Error).message.slice(0, 120) };
    }
    // Evaluate where the login attempt landed.
    if (await this.isOtpPage(page)) {
      // Timestamp the challenge itself (not the whole attempt) so we match the
      // code mailed for THIS page, not a stale one from an earlier try.
      const solved = await this.solveOtp(page, account, new Date());
      if (solved.ok) return { ok: true };
      return { ok: false, status: 'login', otp: true, message: solved.message };
    }
    if (/\/ap\/signin/.test(page.url()) || (await page.locator('input#ap_password').count()) > 0) {
      const captcha = (await page.locator('#auth-captcha-guess, img[src*="captcha"]').count()) > 0;
      return {
        ok: false,
        status: 'login',
        message: captcha ? 'Captcha Amazon rencontré.' : 'Échec de connexion (identifiants ?).',
      };
    }
    return { ok: true };
  }

  /**
   * Tick a checkbox only when it is actually on the page. A bare `.check()` on a
   * missing element waits Playwright's full 30 s default before failing — with
   * the field already filled, that read as "the form fills but never submits"
   * (2026-11-06: Amazon dropped `rememberMe` from the sign-in page, and the
   * email-code CVF page has no `rememberDevice`).
   */
  private async checkIfPresent(page: Page, selector: string): Promise<void> {
    const box = page.locator(selector).first();
    if ((await box.count()) === 0) return;
    await box.check({ timeout: 3000, force: true }).catch(() => {});
  }

  /**
   * Click through Amazon's "Cliquez sur le bouton ci-dessous pour continuer vos
   * achats" bot interstitial — a near-empty page with a single "Continuer les
   * achats" button, served to fresh profiles / new IPs instead of the homepage.
   * It has no account nav, so without this the login could never start.
   * The body-length cap keeps it from matching a real page (the cart also says
   * "continuer vos achats"). Returns true when it was there and clicked.
   */
  private async passShoppingInterstitial(page: Page): Promise<boolean> {
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (text.length > 800 || !/continuer vos achats/i.test(text)) return false;
    const btn = page.locator('form button[type="submit"], form input[type="submit"]').first();
    if ((await btn.count()) === 0) return false;
    console.log('[amazon] interstitiel « Continuer les achats » → clic');
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return true;
  }

  /**
   * Wait until a real Amazon page is on screen: past the AWS WAF JS challenge
   * (empty body that reloads itself) and past the "Continuer les achats"
   * interstitial (clicked through). Returns false when the body never filled.
   */
  private async settleAmazonPage(page: Page, timeout = 20000): Promise<boolean> {
    for (let pass = 0; pass < 3; pass++) {
      const filled = await page
        .waitForFunction(
          () => {
            const b = document.body ? document.body.innerText : '';
            return b.length > 200 || /continuer vos achats/i.test(b);
          },
          undefined,
          { timeout }
        )
        .then(() => true)
        .catch(() => false);
      if (!filled) return false;
      if (!(await this.passShoppingInterstitial(page))) return true;
    }
    return (await page.locator('body').innerText().catch(() => '')).length > 200;
  }

  /** Accept the Amazon cookie-consent banner if present (helps login settle). */
  private async acceptCookieBanner(page: Page): Promise<void> {
    await this.passShoppingInterstitial(page);
    const accept = page.locator('#sp-cc-accept, input[name="accept"]').first();
    if ((await accept.count()) > 0) {
      await accept.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  /** Is an OTP / MFA / CVF code input currently on the page? */
  private async isOtpPage(page: Page): Promise<boolean> {
    return (
      (await page
        .locator('input#input-box-otp, input[name="otpCode"], input#auth-mfa-otpcode, input#cvf-input-code, input[name="code"]')
        .count()) > 0
    );
  }

  /**
   * Resolve an OTP challenge by reading the code Amazon mailed to the account's
   * alias and submitting it. `since` bounds the inbox search to this attempt.
   */
  private async solveOtp(
    page: Page,
    account: Account,
    since: Date
  ): Promise<{ ok: boolean; message: string }> {
    if (!otpMailboxConfigured()) {
      return { ok: false, message: 'OTP requis — IMAP Gmail non configuré (backend/.env).' };
    }
    // Amazon only e-mails an OTP when 2-step verification is OFF. If the account
    // has phone 2FA (WhatsApp/SMS) the code goes to a phone, never to the inbox —
    // detect that and fail fast instead of polling Gmail for 90 s in vain.
    const pageText = await page.locator('body').innerText().catch(() => '');
    const phoneBased =
      /whatsapp|par\s*sms|num[ée]ro de t[ée]l[ée]phone|votre t[ée]l[ée]phone/i.test(pageText) &&
      !/code.*par e-?mail|envoy[ée].*(?:à votre )?(?:adresse )?e-?mail/i.test(pageText);
    if (phoneBased) {
      return {
        ok: false,
        message:
          'Vérification par téléphone/WhatsApp requise — OTP email indisponible (désactiver la 2FA téléphone du compte).',
      };
    }
    const code = await otpMailbox.fetchOtp(account.email, since, 90_000);
    if (!code) {
      return { ok: false, message: 'OTP requis — aucun code reçu dans la boîte mail (90 s).' };
    }
    const field = page
      .locator('input#input-box-otp, input[name="otpCode"], input#auth-mfa-otpcode, input#cvf-input-code, input[name="code"]')
      .first();
    if ((await field.count()) === 0) return { ok: true, message: 'OTP déjà validé.' };
    await field.fill(code);
    // "Ne plus demander de code sur ce navigateur" — keeps the profile trusted.
    await this.checkIfPresent(page, 'input[name="rememberDevice"], #auth-mfa-remember-device');
    // Click the ACTUAL submit button. The CVF page also carries a hidden
    // input[type=submit] earlier in the DOM, so a generic selector would click
    // that (a no-op) and the code would never be sent — target the real button.
    const submit = page
      .locator('#cvf-submit-otp-button, #cvf-submit-otp-button-announce, input#auth-signin-button, #auth-signin-button-announce')
      .first();
    if ((await submit.count()) > 0) await submit.click().catch(() => {});
    else await field.press('Enter').catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    // Amazon can take several seconds to validate the code and redirect — poll
    // for the challenge to clear instead of judging on a single early check (a
    // 2.5 s check produced false "rejected" results while the redirect was still
    // in flight). A wrong code keeps us on the OTP page, so we stay until cleared
    // or the window elapses.
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1500);
      if (!(await this.isOtpPage(page)) && !/\/ap\/signin/.test(page.url())) {
        return { ok: true, message: 'OTP validé.' };
      }
    }
    if (/\/ap\/signin/.test(page.url())) {
      return { ok: false, message: 'OTP soumis mais retour à la page de connexion.' };
    }
    return { ok: false, message: `OTP non validé (code ${code} rejeté ou expiré).` };
  }

  /** Heuristic: is the current Amazon page authenticated for an account? */
  private async isLoggedIn(page: Page): Promise<boolean> {
    // The account nav greeting reads "Identifiez-vous" / "Hello, sign in" when
    // logged out, and "Bonjour, <prénom>" once authenticated.
    const greeting = await page
      .locator('#nav-link-accountList-nav-line-1')
      .first()
      .innerText()
      .catch(() => '');
    if (greeting) return !/identifiez-vous|sign\s*in|hello,\s*sign/i.test(greeting);
    // Fallback: the sign-out link only exists when authenticated.
    return (await page.locator('#nav-item-signout').count()) > 0;
  }

  /**
   * From any logged-out Amazon page, reach the sign-in form via the account nav
   * link and run `attemptLogin` (credentials + auto-OTP). Caller must have already
   * confirmed we're on Amazon and not yet authenticated.
   */
  private async loginViaSigninLink(
    page: Page,
    account: Account
  ): Promise<{ ok: true } | { ok: false; status: InvitationStatus; message: string; otp?: boolean }> {
    // The account nav link routes to the sign-in form (returns to the prior page).
    const signinLink = page.locator('#nav-link-accountList').first();
    if ((await signinLink.count()) > 0) {
      await signinLink.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    return this.attemptLogin(page, account);
  }

  /**
   * For an account-backed session sitting on an Amazon page, log in with the
   * stored credentials when not already authenticated. Headed sessions are the
   * intended target: if Amazon throws an OTP/captcha the visible browser lets the
   * user finish by hand. No-op without credentials or when already logged in.
   */
  private async ensureLoggedIn(session: Session, account: Account): Promise<void> {
    if (!account.email || !account.password) return;
    const page = session.initialPage;
    try {
      if (!/amazon\.[a-z.]+/i.test(page.url())) return;
      await this.acceptCookieBanner(page);
      if (await this.isLoggedIn(page)) return;
      const login = await this.loginViaSigninLink(page, account);
      if (login.ok) {
        // Land back on a clean, authenticated page.
        await this.navigateTo(session, this.actionUrl(session.options.action));
        this.emit({ type: 'log', id: session.id, level: 'info', message: 'Connecté à Amazon.' });
      } else {
        const note = login.otp ? ' Saisis le code OTP dans le navigateur.' : '';
        session.error = `Connexion auto: ${login.message}${note}`;
        this.emit({ type: 'session.updated', session: session.summary() });
        this.emit({ type: 'log', id: session.id, level: 'warn', message: login.message });
      }
    } catch (err) {
      this.emit({
        type: 'log',
        id: session.id,
        level: 'warn',
        message: `Connexion auto échouée: ${(err as Error).message.split('\n')[0]}`,
      });
    }
  }

  /**
   * Create a new Amazon account from the session's identity. Headed only: fills
   * the registration form (name/email/password) and submits, then resolves the
   * email verification OTP from the shared Gmail inbox. Anything it can't handle
   * (captcha, phone challenge) is left on screen for the user to finish by hand.
   */
  private async registerAmazonAccount(session: Session, account: Account): Promise<void> {
    const page = session.initialPage;
    const fail = (msg: string) => {
      session.error = msg;
      this.emit({ type: 'session.updated', session: session.summary() });
      this.emit({ type: 'log', id: session.id, level: 'warn', message: msg });
    };
    try {
      if (!account.email || !account.password) {
        return fail('Création impossible : email ou mot de passe manquant sur le compte.');
      }
      if (!/amazon\.[a-z.]+/i.test(page.url())) return;
      await this.acceptCookieBanner(page);

      // Reach the create-account form: account nav → "Créer votre compte Amazon"
      // (a direct /ap/register hit 404s — the openid params on this link matter).
      const nameField = page.locator('input#ap_customer_name').first();
      if ((await nameField.count()) === 0) {
        await page.locator('#nav-link-accountList').first().click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1200);
        // Walk to the registration form — the path varies by A/B flow:
        // (A) a "Créer votre compte Amazon" button (#createAccountSubmit), or
        // (B) the unified email-first page → enter email + Continue, which for a
        // new address may show a "Cet e-mail est nouveau" intent page
        // (#intention-submit-button-announce) before the form, or go straight to it.
        for (let step = 0; step < 5 && (await nameField.count()) === 0; step++) {
          const cta = page
            .locator('#createAccountSubmit, #intention-submit-button-announce, #intention-submit-button')
            .first();
          if ((await cta.count()) > 0) {
            await cta.click().catch(() => {});
          } else {
            const emailLogin = page.locator('input#ap_email_login, input#ap_email, input[name="email"]').first();
            if ((await emailLogin.count()) > 0 && (await emailLogin.isVisible().catch(() => false))) {
              await emailLogin.fill(account.email);
              await page
                .locator('#continue, input#continue, #auth-continue-announce, input[type="submit"]')
                .first()
                .click()
                .catch(() => {});
            } else break;
          }
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(1500);
        }
      }

      await nameField.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
      if ((await nameField.count()) === 0) {
        const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
        // Email-first flow lands on the password page when the address already
        // has an account → that email is unusable for a new account.
        if ((await page.locator('input#ap_password').count()) > 0 || /mot de passe|d[ée]j[àa]|already/.test(body)) {
          return fail('Cet email est déjà associé à un compte Amazon — utilise un autre email.');
        }
        return fail("Formulaire de création introuvable (captcha/anti-bot ?). À finir à la main.");
      }
      await nameField.fill(`${account.prenom} ${account.nom}`.trim());
      await page.locator('input#ap_email').first().fill(account.email).catch(() => {});
      await page.locator('input#ap_password').first().fill(account.password).catch(() => {});
      const pwCheck = page.locator('input#ap_password_check').first();
      if ((await pwCheck.count()) > 0) await pwCheck.fill(account.password).catch(() => {});

      await page
        .locator('#continue, #auth-continue-announce, #auth-continue, input[type="submit"]')
        .first()
        .click()
        .catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2500);

      // Drive the verification: email OTP (from Gmail), then the forced "add
      // phone" step using smspool numbers (retried until one delivers the SMS).
      await this.runRegisterVerification(session, account);
    } catch (err) {
      fail(`Création échouée : ${(err as Error).message.split('\n')[0]}`);
    }
  }

  /**
   * Detect an Amazon/AWS-WAF captcha by several independent signals. The "casse-tête"
   * puzzle renders inside an iframe, so its text is NOT in the top document body —
   * we must scan every frame. Combines DOM markers (WAF iframes/forms/scripts, the
   * legacy text captcha) with keyword matching across all frames.
   */
  private async detectCaptcha(page: Page): Promise<{ captcha: boolean; signal?: string }> {
    const domMarker =
      'iframe[src*="captcha"], iframe[src*="challenge"], iframe[src*="awswaf"], iframe[title*="aptcha"], iframe[title*="hallenge"], #auth-captcha-guess, #captchacharacters, form[action*="validateCaptcha"], [id^="amzn-captcha"], script[src*="captcha"]';
    if ((await page.locator(domMarker).count()) > 0) return { captcha: true, signal: 'dom-marker' };
    const re =
      /casse-t[êe]te|[ée]nigme|r[ée]solvez|prot[ée]ger votre compte|v[ée]rifiez que vous [êe]tes (un )?humain|captcha|puzzle|faites glisser|s[ée]lectionnez (toutes )?les images|saisissez les caract|commencer l|cliquez dans l['’ ]ordre/i;
    for (const f of page.frames()) {
      const t = await f.locator('body').innerText().catch(() => '');
      const m = t && t.match(re);
      if (m) return { captcha: true, signal: `frame-text:${m[0].slice(0, 24)}` };
    }
    return { captcha: false };
  }

  /** Page state during account-creation verification. */
  private async classifyRegister(page: Page): Promise<string> {
    const greet = await page.locator('#nav-link-accountList-nav-line-1').first().innerText().catch(() => '');
    if (greet && !/identifiez-vous|sign\s*in/i.test(greet)) return 'logged-in';
    if ((await this.detectCaptcha(page)).captcha) return 'captcha';
    const otp = await page.locator('input#input-box-otp, input[name="otpCode"], input#cvf-input-code, input[name="code"], input#auth-mfa-otpcode').count();
    const phoneInput = await page.locator('input[name="phoneNumber"], input#ap_phone_number, input[type="tel"]').count();
    const nameInput = await page.locator('input#ap_customer_name').count();
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const phoneText = /num[ée]ro de t[ée]l[ée]phone|t[ée]l[ée]phone portable|par sms|votre t[ée]l[ée]phone/.test(body);
    if (nameInput > 0) return 'form';
    if (otp > 0) return phoneText ? 'sms-code' : 'email-otp';
    if (phoneInput > 0 && phoneText) return 'add-phone';
    return 'other';
  }

  /**
   * Headless-unfriendly part of account creation: resolve the email OTP, then the
   * forced phone verification by ordering smspool numbers and entering the SMS
   * code, retrying numbers (FR Amazon ~31% deliver) until one works or the budget
   * is spent. A captcha is left for the user (headed window); progress + the final
   * outcome are surfaced on the session card / log. Runs fire-and-forget.
   */
  private async runRegisterVerification(session: Session, account: Account): Promise<void> {
    const page = session.initialPage;
    const log = (level: 'info' | 'warn' | 'error', message: string) =>
      this.emit({ type: 'log', id: session.id, level, message });
    const setErr = (msg: string) => {
      session.error = msg;
      this.emit({ type: 'session.updated', session: session.summary() });
    };
    let order: SmsOrder | null = null;
    let phoneAttempts = 0;
    const MAX_PHONE = 6;
    let lastState = '';
    let captchaTried = false; // one auto-solve attempt per captcha appearance
    const submitOtpSel =
      '#cvf-submit-otp-button, #cvf-submit-otp-button-announce, input#continue, #auth-continue-announce, input[type="submit"]';
    const otpInputSel =
      'input#input-box-otp, input[name="otpCode"], input#cvf-input-code, input[name="code"], input#auth-mfa-otpcode';

    for (let i = 0; i < 220; i++) {
      const state = await this.classifyRegister(page);
      if (state !== lastState) {
        log('info', `Inscription — ${state}`);
        if (state !== 'captcha') captchaTried = false; // fresh attempt on a new captcha
        lastState = state;
      }
      if (state === 'logged-in') {
        session.error = undefined;
        this.emit({ type: 'session.updated', session: session.summary() });
        log('info', '✅ Compte Amazon créé et connecté.');
        return;
      }
      if (state === 'email-otp') {
        const solved = await this.solveOtp(page, account, new Date());
        if (!solved.ok) log('warn', `OTP email: ${solved.message}`);
      } else if (state === 'add-phone') {
        if (!smsProviderConfigured()) return setErr('Étape téléphone : smspool non configuré (SMSPOOL_API_KEY).');
        if (phoneAttempts >= MAX_PHONE)
          return setErr(`Échec : ${MAX_PHONE} numéros essayés sans SMS. À finir à la main ?`);
        phoneAttempts++;
        log('info', `Achat numéro smspool (essai ${phoneAttempts}/${MAX_PHONE})…`);
        order = await orderNumber();
        if (!order) {
          log('warn', 'Aucun numéro dispo, nouvelle tentative.');
          await page.waitForTimeout(6000);
          continue;
        }
        log('info', `Numéro ${order.phone} → saisie + Ajouter`);
        await page.locator('input[name="phoneNumber"], input#ap_phone_number, input[type="tel"]').first().fill(order.phone).catch(() => {});
        await page.locator('#continue, #auth-continue-announce, input[type="submit"]').first().click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(3000);
      } else if (state === 'sms-code') {
        if (!order) {
          await page.waitForTimeout(4000);
          continue;
        }
        log('info', `Attente du SMS (order ${order.orderId})…`);
        const code = await pollSms(order.orderId, 120_000);
        if (code) {
          log('info', `SMS reçu (${code}) → saisie + validation`);
          await page.locator(otpInputSel).first().fill(code).catch(() => {});
          await page.locator(submitOtpSel).first().click().catch(() => {});
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(3000);
        } else {
          log('warn', 'Numéro mort (pas de SMS) → changement de numéro.');
          order = null;
          const modif = page.locator('a:has-text("Modifier"), button:has-text("Modifier"), [id*="change-phone"], [id*="changephone"]').first();
          if ((await modif.count()) > 0) {
            await modif.click().catch(() => {});
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(2500);
          } else {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForTimeout(2000);
          }
        }
      } else if (state === 'form') {
        // Bounced back to the form (session reset) — re-submit.
        await page.locator('input#ap_customer_name').first().fill(`${account.prenom} ${account.nom}`.trim()).catch(() => {});
        await page.locator('input#ap_email').first().fill(account.email).catch(() => {});
        await page.locator('input#ap_password').first().fill(account.password).catch(() => {});
        const pc = page.locator('input#ap_password_check').first();
        if ((await pc.count()) > 0) await pc.fill(account.password).catch(() => {});
        await page.locator('#continue, #auth-continue-announce, input[type="submit"]').first().click().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(2500);
      } else if (state === 'captcha') {
        if (captchaSolverConfigured() && !captchaTried) {
          captchaTried = true;
          const ok = await this.solveAndInjectFunCaptcha(session, account).catch(() => false);
          if (!ok) setErr('Captcha Arkose : résolution auto KO — résous-le dans la fenêtre (je reprends ensuite).');
        } else if (!captchaSolverConfigured()) {
          setErr('Captcha « casse-tête » à résoudre dans la fenêtre — je reprends ensuite.');
        }
        await page.waitForTimeout(4000);
      } else {
        await page.waitForTimeout(4000);
      }
    }
    setErr('Inscription non finalisée (délai dépassé) — vérifie le navigateur.');
  }

  /**
   * Solve the Arkose FunCaptcha via Anti-Captcha and inject the token. Reads the
   * public key + `blob` from the Arkose iframe URL, solves, then best-effort
   * injects the token (token fields + Arkose-style postMessage). Injection is
   * **experimental** — Arkose binds tokens tightly, so this may not pass.
   */
  private async solveAndInjectFunCaptcha(session: Session, account: Account): Promise<boolean> {
    const page = session.initialPage;
    const log = (m: string) => this.emit({ type: 'log', id: session.id, level: 'info', message: m });
    // Anti-Captcha returns ERROR_CAPTCHA_UNSOLVABLE intermittently on Amazon's
    // Arkose — retry a few times (re-reading the iframe each time, since the blob
    // may refresh) before giving up to manual.
    let token: string | null = null;
    for (let attempt = 1; attempt <= 3 && !token; attempt++) {
      let arkUrl = '';
      for (const f of page.frames()) {
        const u = f.url();
        if (/iframe\.arkoselabs\.com\/[0-9A-Fa-f-]{20,}\/index/i.test(u)) {
          arkUrl = u;
          break;
        }
      }
      if (!arkUrl) {
        log('Arkose: iframe introuvable.');
        return false;
      }
      const publicKey = arkUrl.match(/arkoselabs\.com\/([0-9A-Fa-f-]{20,})\//)?.[1];
      if (!publicKey) return false;
      let blob = '';
      try {
        blob = decodeURIComponent(new URL(arkUrl).searchParams.get('data') ?? '');
      } catch {
        /* no blob */
      }
      let subdomain = 'amazon-api.arkoselabs.com';
      for (const f of page.frames()) {
        const sm = f.url().match(/https?:\/\/([a-z0-9-]+\.arkoselabs\.com)\/v2\//i);
        if (sm) {
          subdomain = sm[1];
          break;
        }
      }
      log(`Anti-Captcha essai ${attempt}/3 (clé ${publicKey.slice(0, 10)}…, blob ${blob ? 'oui' : 'non'})…`);
      token = await solveFunCaptcha(
        {
          websiteURL: page.url(),
          websitePublicKey: publicKey,
          funcaptchaApiJSSubdomain: subdomain,
          data: blob ? JSON.stringify({ blob }) : undefined,
          userAgent: account.fingerprint?.userAgent,
        },
        (m) => this.emit({ type: 'log', id: session.id, level: 'info', message: m }),
        110_000 // fail fast: the Arkose session ages while we wait, so retry sooner
      );
      if (!token && attempt < 3) {
        log('Essai KO (UNSOLVABLE/timeout) — nouvelle tentative.');
        await page.waitForTimeout(2000);
      }
    }
    if (!token) return false;
    log('Token Arkose reçu — injection (#cvf_aamation_response_token + submit form).');
    // Amazon's CVF Arkose flow: the solved token goes into the hidden
    // #cvf_aamation_response_token, then #cvf-aamation-challenge-form is POSTed to
    // /ap/cvf/verify (CSRF + action fields are already filled by the page).
    const injected = await page
      .evaluate((tk) => {
        const inp = (document.querySelector('#cvf_aamation_response_token') ||
          document.querySelector('input[name="cvf_aamation_response_token"]')) as HTMLInputElement | null;
        if (inp) {
          inp.value = tk;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const form = document.querySelector('#cvf-aamation-challenge-form') as HTMLFormElement | null;
        if (form) {
          form.submit();
          return true;
        }
        return !!inp;
      }, token)
      .catch(() => false);
    if (!injected) log('Injection : champ/formulaire CVF introuvable.');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3500);
    return injected;
  }

  /**
   * Wait for Amazon to actually acknowledge the request: the invite button goes
   * away, replaced by "Invitation demandée, merci !".
   *
   * This replaces a blind 2.5 s sleep, which was the whole bug. The request is
   * submitted asynchronously; the loop then navigated straight to the next item,
   * aborting it in flight whenever the proxy was slower than the sleep. That is
   * why the success rate tracked latency — ~59% on 2026-06-05, 6 of ~81 on
   * 2026-09-15, and **0 of 80** on 2026-09-18 with five concurrent runs, while
   * every request that *did* land was still confirmed months later.
   */
  private async waitForInviteAck(page: Page): Promise<boolean> {
    return await page
      .waitForFunction(
        (sel: string) => {
          const btn = document.querySelector(sel);
          return !btn || (btn as HTMLElement).getClientRects().length === 0;
        },
        INVITE_BUTTON_SELECTOR,
        { timeout: 20000 }
      )
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Click the invitation button if it's on the page. Returns undefined when absent.
   *
   * Never reports `requested` on the strength of the click alone: the status is
   * only set once Amazon acknowledges it. An unacknowledged click (twice) is
   * recorded as `available` — the invitation is still being offered, so nothing
   * was requested — instead of a `requested` the operator would trust.
   */
  private async clickInviteButton(
    page: Page,
    dryRun: boolean,
    via?: string
  ): Promise<{ status: InvitationStatus; message?: string } | undefined> {
    const btn = page.locator(INVITE_BUTTON_SELECTOR).first();
    // Visibility, never presence: Amazon leaves the button in the DOM and just
    // hides it once the request goes through (and ships the whole widget, both
    // branches, on every invitation product). A hidden button means "already
    // requested", so treat it exactly like an absent one.
    if ((await btn.count()) === 0) return undefined;
    if (!(await btn.isVisible().catch(() => false))) return undefined;
    const suffix = via ? ` ${via}` : '';
    if (dryRun) {
      return { status: 'available', message: `(détection seule, non cliqué)${suffix}` };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      // CSS is blocked on invitation runs, so actionability can fail on a panel
      // element — fall back to a DOM click.
      await btn.click({ timeout: 8000 }).catch(async () => {
        await btn.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      });
      const acked = await this.waitForInviteAck(page);
      if (/\/ap\/signin|\/ap\/cvf/.test(page.url())) {
        return { status: 'login', message: 'Redirigé vers la connexion au clic.' };
      }
      if (acked) return { status: 'requested', message: via };
    }
    return {
      status: 'available',
      message: `⚠ clic sans effet — invitation toujours proposée après 2 essais${suffix}`,
    };
  }

  /**
   * Navigate to a product page and wait for the real body (past the WAF challenge).
   *
   * **Throws when the body never fills.** Behind a proxy Amazon first serves an
   * AWS WAF JS challenge, and a hiccup can leave us on that ~2 KB stub forever.
   * Swallowing that used to hand `processInvitation` an empty DOM, which found
   * no invite button and recorded a confident `unavailable` — a verdict that,
   * under the freshest-wins rule, then buried the item. A page we never really
   * saw must fail, not produce an answer.
   */
  private async gotoProductPage(page: Page, url: string) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await this.settleAmazonPage(page))) {
      throw new Error('page vide (challenge WAF / proxy muet)');
    }
  }

  /**
   * `gotoProductPage` with retries. A dead proxy, a WAF challenge that didn't
   * resolve or a few seconds of lost connectivity are all transient — without a
   * retry a blip burns the item outright (seen 2026-09-15: three runs lost ~24
   * items each in about a second, yet still reported "terminé").
   */
  private async gotoProductPageWithRetry(page: Page, url: string, attempts = 3) {
    let last: Error | undefined;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.gotoProductPage(page, url);
        return;
      } catch (err) {
        last = err as Error;
        if (i < attempts - 1) await page.waitForTimeout(2000 * (i + 1));
      }
    }
    throw last ?? new Error('navigation impossible');
  }

  private async readBuybox(page: Page): Promise<string> {
    return await page
      .locator('#buybox, #desktop_buybox, #rightCol, #centerCol')
      .first()
      .innerText()
      .catch(() => '');
  }

  /**
   * Inspect a product page and (unless dryRun) request the buy invitation.
   * The live button state is authoritative: present = not yet requested, so we
   * click it; absent within an invitation context = already requested → skip.
   *
   * The default buybox is NOT enough: a higher-priced marketplace offer often
   * wins it and hides Amazon's own invitation-gated offer, which made the item
   * read `unavailable`. The AOD ("Autres vendeurs") panel is useless here — it
   * loads via JS that never fires headless — so we instead re-open the product
   * with `?m=<Amazon merchant id>`, which forces Amazon's offer into the buybox
   * and brings the invitation button back.
   */
  private async processInvitation(
    page: Page,
    dryRun: boolean,
    asin?: string
  ): Promise<{ status: InvitationStatus; message?: string }> {
    if (/\/ap\/signin|\/ap\/cvf/.test(page.url())) {
      return { status: 'login', message: 'Connexion Amazon requise pour ce compte.' };
    }
    const direct = await this.clickInviteButton(page, dryRun);
    if (direct) return direct;

    const buybox = await this.readBuybox(page);
    // A pending request ("Invitation demandée, merci !") shows no add-to-cart —
    // settle it here without the extra navigation. If something *is* buyable we
    // fall through to the forced-merchant check, which alone can tell an
    // accepted invitation (`orderable`) from a marketplace offer sitting on top
    // of a still-pending one.
    if (/invitation/i.test(buybox) && (await page.locator(ADD_TO_CART_SELECTOR).count()) === 0) {
      return { status: 'already', message: buybox.replace(/\s+/g, ' ').slice(0, 160) };
    }

    // Buybox held by someone else → force Amazon's own offer and re-check.
    if (asin && !page.url().includes(`m=${AMAZON_FR_MERCHANT_ID}`)) {
      await this.gotoProductPageWithRetry(
        page,
        `https://www.amazon.fr/dp/${asin}?m=${AMAZON_FR_MERCHANT_ID}`
      );
      if (/\/ap\/signin|\/ap\/cvf/.test(page.url())) {
        return { status: 'login', message: 'Connexion Amazon requise pour ce compte.' };
      }
      const forced = await this.clickInviteButton(page, dryRun, '(offre Amazon)');
      if (forced) return forced;
      const amazonBuybox = await this.readBuybox(page);
      // Amazon's offer first: this is the decisive one, and the message is
      // truncated — leading with the marketplace buybox would hide it.
      const message = `offre Amazon: ${amazonBuybox} | buybox: ${buybox}`
        .replace(/\s+/g, ' ')
        .slice(0, 160);
      // We're on Amazon's own offer (forced via `?m=`), and it takes an
      // add-to-cart with no invite button: the invitation was **accepted** and
      // the item can be ordered now. Only trustworthy in this forced context —
      // in the default buybox an add-to-cart may belong to a marketplace seller.
      // Checked before the "invitation" text test, since an accepted offer still
      // mentions the invitation ("Vous avez été invité à acheter…").
      if ((await page.locator(ADD_TO_CART_SELECTOR).count()) > 0) {
        return { status: 'orderable', message };
      }
      if (/invitation/i.test(amazonBuybox)) return { status: 'already', message };
      return { status: 'unavailable', message };
    }

    return { status: 'unavailable', message: buybox.replace(/\s+/g, ' ').slice(0, 160) };
  }

  /**
   * For a chosen account, walk every enabled catalogue item and request its buy
   * invitation. Re-runnable: items already requested (no button) are skipped,
   * and items whose invitation has reset (button back) are requested again.
   *
   * `refreshDisabled` also visits **disabled** items, but detect-only (never
   * clicked, whatever `dryRun` says — disabled means "don't request"). Without
   * it a disabled item is never re-checked, so its verdict is frozen: an item
   * flagged `no` and then switched off (e.g. by "Désactiver les indispo") could
   * never come back to `yes`, since a catalogue re-import refreshes `inStore`
   * but never the run-based availability.
   */
  async runInvitations(
    accountId: string,
    dryRun = false,
    proxyIdOverride?: string,
    refreshDisabled = false
  ): Promise<void> {
    // Guard failures are reported over the WS (not thrown): this runs
    // fire-and-forget, so the UI needs the signal to clear its pending state.
    const can = this.canStartInvitations(accountId);
    if (!can.ok) {
      this.emit({ type: 'invitation.error', accountId, message: can.reason ?? 'impossible' });
      return;
    }
    const account = accountsStore.get(accountId)!;
    // Disabled items are only worth re-checking while they're still in the store —
    // an out-of-store item reads `no` from `inStore`, which the import refreshes.
    const items = amazonItemsStore
      .list()
      .filter((i) => i.enabled || (refreshDisabled && i.inStore !== false));
    if (items.length === 0) {
      this.emit({ type: 'invitation.error', accountId, message: 'Aucun item activé dans le catalogue.' });
      return;
    }

    // Reserve the per-account lock now so duplicates are rejected even while this
    // run only sits in the concurrency queue.
    this.invitationRuns.add(accountId);
    this.setInvitationProgress(accountId, {
      status: 'queued',
      done: 0,
      total: items.length,
      dryRun,
      counts: undefined,
      message: undefined,
      lastStatus: undefined,
      startedAt: Date.now(),
    });
    this.emit({ type: 'invitation.queued', accountId, total: items.length, dryRun });

    // Wait for a free concurrency slot (cap) before touching a browser.
    await this.acquireInvitationSlot();

    let launched: Awaited<ReturnType<SessionManager['launchContextAndPage']>> | undefined;
    const counts: Record<string, number> = {};
    const cleanup = async () => {
      if (!launched) return;
      await launched.context.close().catch(() => {});
      if (launched.localProxyUrl) await closeAnonymizedProxy(launched.localProxyUrl, true).catch(() => {});
    };
    try {
      launched = await this.launchContextAndPage({
        accountId,
        // A proxy-group action overrides the account's own proxy for this run.
        proxyId: proxyIdOverride ?? account.proxyId,
        headless: true,
        // **No resource blocking.** Proven 2026-09-18: blocking images alone is
        // enough to stop the invite click from firing its request — Amazon's
        // `data-action="invite-button"` handler never runs, the POST to
        // `/custom/highdemandproductcontracts/request-invite/<id>` never leaves,
        // and the page silently keeps offering the button. Blocking CSS on top
        // made it worse: both branches of the widget ship in the DOM (the button
        // *and* "Invitation demandée, merci !"), so without stylesheets every
        // `innerText` check reads both states at once and detection is garbage.
        // Bandwidth is not worth a run that requests nothing.
      });
      // Using the account (any run path) bumps lastUsedAt so the Carnet reflects it.
      accountsStore.touch(accountId);
      this.emit({ type: 'account.updated', id: accountId });
      const page = launched.page;
      const gotoItem = (item: (typeof items)[number]) =>
        this.gotoProductPageWithRetry(page, item.productUrl || `https://www.amazon.fr/dp/${item.asin}`);
      // Tracked across items so we attempt the login once, then stop retrying
      // if the credentials are rejected or an OTP/captcha challenge blocks us.
      let loginState: 'unknown' | 'ok' | 'failed' | 'otp' = 'unknown';

      // Log in up front: the "Demander une invitation" button only renders when
      // authenticated, so a logged-out run would mark everything `unavailable`
      // without ever hitting an /ap/signin redirect. Headless here, so OTP is
      // resolved from the shared Gmail inbox (otpMailbox).
      await page.goto('https://www.amazon.fr/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.settleAmazonPage(page);
      await this.acceptCookieBanner(page);
      if (!(await this.isLoggedIn(page))) {
        const login = await this.loginViaSigninLink(page, account);
        if (login.ok) {
          loginState = 'ok';
        } else {
          const message = `Connexion impossible: ${login.message}`;
          this.setInvitationProgress(accountId, { status: 'error', message });
          this.emit({ type: 'invitation.error', accountId, message });
          return;
        }
      } else {
        loginState = 'ok';
      }

      this.setInvitationProgress(accountId, { status: 'running', done: 0, total: items.length });
      this.emit({ type: 'invitation.started', accountId, total: items.length, dryRun });
      let done = 0;
      // A run that keeps failing has lost its connection (dead proxy, network
      // blip, Amazon cutting us off). Walking the rest of the catalogue then
      // just stamps `error` on every item in a second or two and still reports
      // "terminé" — so bail out loudly instead and leave the untouched items
      // untouched, for a re-run to pick up.
      let consecutiveErrors = 0;
      const failed: typeof items = [];
      for (const item of items) {
        done++;
        // A disabled item is only being re-checked to refresh its verdict —
        // never request it, even outside dryRun.
        const detectOnly = dryRun || !item.enabled;
        let result: { status: InvitationStatus; message?: string };
        try {
          await gotoItem(item);
          result = await this.processInvitation(page, detectOnly, item.asin);
          if (result.status === 'login' && loginState !== 'failed' && loginState !== 'otp') {
            const login = await this.attemptLogin(page, account);
            if (login.ok) {
              loginState = 'ok';
              await gotoItem(item);
              result = await this.processInvitation(page, detectOnly, item.asin);
            } else {
              loginState = login.otp ? 'otp' : 'failed';
              result = { status: login.status, message: login.message };
            }
          }
        } catch (err) {
          result = { status: 'error', message: (err as Error).message.slice(0, 160) };
        }
        if (result.status === 'error') {
          consecutiveErrors++;
          failed.push(item);
        } else {
          consecutiveErrors = 0;
        }
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        const prev = invitationsStore.get(accountId, item.asin);
        invitationsStore.upsert({
          accountId,
          asin: item.asin,
          status: result.status,
          message: result.message,
          requestedAt:
            result.status === 'requested' && !detectOnly ? Date.now() : prev?.requestedAt,
          lastCheckedAt: Date.now(),
        });
        this.setInvitationProgress(accountId, {
          status: 'running',
          done,
          total: items.length,
          lastStatus: result.status,
          counts,
        });
        this.emit({
          type: 'invitation.item',
          accountId,
          asin: item.asin,
          status: result.status,
          done,
          total: items.length,
        });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          const left = items.length - done;
          const message = `Connexion perdue après ${consecutiveErrors} échecs d'affilée — run interrompu, ${left} item(s) non traité(s). Vérifiez le proxy puis relancez.`;
          this.setInvitationProgress(accountId, { status: 'error', done, counts, message });
          this.emit({ type: 'invitation.error', accountId, message });
          return;
        }
      }

      // Second pass over the items that errored: most failures here are
      // transient, and an item left in `error` was never actually checked.
      if (failed.length > 0 && failed.length < items.length) {
        for (const item of failed) {
          const detectOnly = dryRun || !item.enabled;
          let result: { status: InvitationStatus; message?: string };
          try {
            await gotoItem(item);
            result = await this.processInvitation(page, detectOnly, item.asin);
          } catch (err) {
            result = { status: 'error', message: (err as Error).message.slice(0, 160) };
          }
          if (result.status === 'error') continue; // keep the first-pass record
          if (counts.error) counts.error--;
          if (!counts.error) delete counts.error;
          counts[result.status] = (counts[result.status] ?? 0) + 1;
          const prev = invitationsStore.get(accountId, item.asin);
          invitationsStore.upsert({
            accountId,
            asin: item.asin,
            status: result.status,
            message: result.message,
            requestedAt:
              result.status === 'requested' && !detectOnly ? Date.now() : prev?.requestedAt,
            lastCheckedAt: Date.now(),
          });
          this.setInvitationProgress(accountId, { status: 'running', lastStatus: result.status, counts });
          this.emit({
            type: 'invitation.item',
            accountId,
            asin: item.asin,
            status: result.status,
            done: items.length,
            total: items.length,
          });
        }
      }

      this.setInvitationProgress(accountId, {
        status: 'done',
        done: items.length,
        total: items.length,
        counts,
      });
      this.emit({ type: 'invitation.done', accountId, total: items.length, counts });
    } catch (err) {
      const message = (err as Error).message;
      this.setInvitationProgress(accountId, { status: 'error', message });
      this.emit({ type: 'invitation.error', accountId, message });
    } finally {
      await cleanup();
      this.releaseInvitationSlot();
      this.invitationRuns.delete(accountId);
    }
  }

  private orderSyncs = new Set<string>();
  private orderSyncProgress = new Map<string, OrderSyncProgress>();

  orderSyncProgressList(): OrderSyncProgress[] {
    return Array.from(this.orderSyncProgress.values());
  }

  private setOrderSyncProgress(accountId: string, patch: Partial<OrderSyncProgress>): void {
    const prev = this.orderSyncProgress.get(accountId);
    const next: OrderSyncProgress = {
      accountId,
      status: 'queued',
      startedAt: Date.now(),
      ...prev,
      ...patch,
      updatedAt: Date.now(),
    };
    this.orderSyncProgress.set(accountId, next);
    this.emit({ type: 'orders.progress', progress: next });
  }

  /** Whether an order-history sync can start right now for this account. It
   *  opens the same persistent profile as a session or an invitation run. */
  canStartOrderSync(accountId: string): { ok: boolean; reason?: string } {
    if (this.orderSyncs.has(accountId)) return { ok: false, reason: 'déjà en cours' };
    if (this.invitationRuns.has(accountId)) return { ok: false, reason: 'run invitations en cours' };
    if (this.accountSessions.has(accountId)) return { ok: false, reason: 'session ouverte' };
    if (!accountsStore.get(accountId)) return { ok: false, reason: 'compte inconnu' };
    return { ok: true };
  }

  /**
   * Read the account's Amazon order history ("Vos commandes", every year,
   * paginated) and store it in `ordersStore`. Read-only: nothing is clicked
   * beyond the login. Headless, account profile + own proxy (or the override),
   * and it shares the invitation concurrency cap — same weight on the host.
   * Fire-and-forget: progress goes out as `orders.progress`.
   */
  async syncOrders(accountId: string, proxyIdOverride?: string): Promise<void> {
    const can = this.canStartOrderSync(accountId);
    if (!can.ok) {
      this.setOrderSyncProgress(accountId, { status: 'error', message: can.reason ?? 'impossible' });
      return;
    }
    const account = accountsStore.get(accountId)!;
    this.orderSyncs.add(accountId);
    this.setOrderSyncProgress(accountId, {
      status: 'queued',
      message: undefined,
      orders: undefined,
      startedAt: Date.now(),
    });
    await this.acquireInvitationSlot();

    let launched: Awaited<ReturnType<SessionManager['launchContextAndPage']>> | undefined;
    const fail = (message: string) => {
      ordersStore.saveError(accountId, message);
      this.setOrderSyncProgress(accountId, { status: 'error', message });
      this.emit({ type: 'orders.synced', accountId });
    };
    try {
      this.setOrderSyncProgress(accountId, { status: 'running', message: 'connexion…' });
      launched = await this.launchContextAndPage({
        accountId,
        proxyId: proxyIdOverride ?? account.proxyId,
        headless: true,
      });
      accountsStore.touch(accountId);
      this.emit({ type: 'account.updated', id: accountId });
      const page = launched.page;

      await page.goto('https://www.amazon.fr/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.settleAmazonPage(page);
      await this.acceptCookieBanner(page);
      if (!(await this.isLoggedIn(page))) {
        const login = await this.loginViaSigninLink(page, account);
        if (!login.ok) return fail(`Connexion impossible: ${login.message}`);
      }

      const onProgress = (message: string) => this.setOrderSyncProgress(accountId, { message });
      let result: Awaited<ReturnType<typeof scrapeOrderHistory>>;
      try {
        result = await scrapeOrderHistory(page, onProgress);
      } catch (err) {
        if (!(err instanceof OrdersLoginRequired)) throw err;
        // Order history is a "sensitive" page: Amazon may ask for the password
        // again even on a logged-in profile. One re-login, then give up.
        const login = await this.attemptLogin(page, account);
        if (!login.ok) return fail(`Connexion impossible: ${login.message}`);
        result = await scrapeOrderHistory(page, onProgress);
      }
      ordersStore.saveSuccess(accountId, result.orders, result.years);
      const n = result.orders.length;
      this.setOrderSyncProgress(accountId, {
        status: 'done',
        orders: n,
        message: n === 0 ? 'aucune commande' : `${n} commande${n > 1 ? 's' : ''}`,
      });
      this.emit({ type: 'orders.synced', accountId });
    } catch (err) {
      fail(((err as Error).message ?? String(err)).split('\n')[0].slice(0, 200));
    } finally {
      if (launched) {
        await launched.context.close().catch(() => {});
        if (launched.localProxyUrl) await closeAnonymizedProxy(launched.localProxyUrl, true).catch(() => {});
      }
      this.releaseInvitationSlot();
      this.orderSyncs.delete(accountId);
    }
  }

  attachClient(socket: WebSocket) {
    this.clients.add(socket);
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: this.list(),
        invitations: this.invitationProgressList(),
        orders: this.orderSyncProgressList(),
      })
    );
    socket.on('close', () => this.clients.delete(socket));
  }

  emit(event: Event) {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }
}

export const sessionManager = new SessionManager();
