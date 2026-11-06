/**
 * Step-by-step, traced probe of the Amazon sign-in flow for one account.
 * Launches exactly like a session (same profile, proxy, fingerprint, no
 * resource blocking) and walks email → continue → password → submit, logging
 * at every step the URL, the candidate submit buttons (count / visible) and a
 * screenshot, so a step that "fills but never validates" shows which click
 * missed. Stops at an OTP page (no code is fetched or submitted).
 *
 * Usage (from backend/): npx tsx src/debug/loginProbe.ts <prénom|email> [--fresh] [--headless] [--out=<dir>]
 */
import '../env.js';
import { chromium, type Page } from 'playwright';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { accountsStore } from '../accounts.js';
import { proxyStore } from '../proxies.js';
import { FINGERPRINT_INIT_SCRIPT, NO_PASSKEY_INIT_SCRIPT } from '../fingerprint.js';

const WHO = (process.argv[2] ?? '').toLowerCase();
const HEADLESS = process.argv.includes('--headless');
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? resolve(process.cwd(), 'login-probe');

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

const PROBES = [
  'input#ap_email',
  'input#ap_email_login',
  'input[name="email"]',
  'input#continue',
  '#continue',
  'input#ap_password',
  'input[name="password"]',
  'input#signInSubmit',
  '#signInSubmit',
  'input#auth-signin-button',
  'input[name="rememberMe"]',
  'input[type="submit"]',
  'button[type="submit"]',
  '#sp-cc-accept',
  'input#cvf-input-code',
  'input[name="code"]',
  'input[name="otpCode"]',
  'input#auth-mfa-otpcode',
  'iframe[src*="arkoselabs"]',
  '#auth-captcha-guess',
];

let step = 0;
async function dump(page: Page, label: string) {
  step++;
  log(`--- [${step}] ${label} — ${page.url()}`);
  log('    titre:', await page.title().catch(() => '?'));
  for (const sel of PROBES) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    const vis: string[] = [];
    for (let i = 0; i < Math.min(n, 4); i++) {
      const el = loc.nth(i);
      const v = await el.isVisible().catch(() => false);
      const info = await el
        .evaluate((e) => {
          const h = e as HTMLInputElement;
          return `${e.tagName.toLowerCase()}${h.id ? '#' + h.id : ''} val="${(h.value ?? '').slice(0, 30)}" aria-labelledby=${e.getAttribute('aria-labelledby') ?? ''}`;
        })
        .catch(() => '');
      vis.push(`${v ? 'VISIBLE' : 'caché'} ${info}`);
    }
    log(`    ${sel} ×${n}: ${vis.join(' | ')}`);
  }
  const alerts = await page
    .locator('.a-alert-content, #auth-error-message-box, #auth-warning-message-box, .a-alert-heading')
    .allInnerTexts()
    .catch(() => []);
  const txt = alerts.map((t) => t.trim()).filter(Boolean);
  if (txt.length) log('    alertes:', JSON.stringify(txt).slice(0, 400));
  await page.screenshot({ path: resolve(OUT, `${String(step).padStart(2, '0')}-${label.replace(/\W+/g, '_')}.png`) }).catch(() => {});
}

async function main() {
  const account = accountsStore
    .list()
    .find((a) => a.prenom?.toLowerCase() === WHO || a.email?.toLowerCase() === WHO);
  if (!account) throw new Error(`compte « ${WHO} » introuvable`);
  log('compte', account.prenom, account.nom, account.email, '| proxy', account.proxyId);
  mkdirSync(OUT, { recursive: true });

  const proxy = account.proxyId ? proxyStore.get(account.proxyId) : undefined;
  let localProxyUrl: string | undefined;
  if (proxy) {
    localProxyUrl = await anonymizeProxy(
      `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
    );
    log('proxy', proxy.host, '→', localProxyUrl);
  }
  // --fresh: throwaway empty profile (same proxy + fingerprint) to force a full
  // login without touching the account's real profile.
  const dir = process.argv.includes('--fresh')
    ? mkdtempSync(join(tmpdir(), 'login-probe-'))
    : process.env.PROFILES_DIR
      ? resolve(process.env.PROFILES_DIR, account.id)
      : resolve(process.cwd(), '..', 'data', 'playwright-profiles', account.id);
  log('profil', dir);
  const fp = account.fingerprint;
  const context = await chromium.launchPersistentContext(dir, {
    headless: HEADLESS,
    proxy: localProxyUrl ? { server: localProxyUrl } : undefined,
    userAgent: fp?.userAgent,
    viewport: fp?.viewport,
    deviceScaleFactor: fp?.deviceScaleFactor,
    locale: fp?.locale,
    timezoneId: fp?.timezoneId,
  });
  await context.addInitScript({ content: NO_PASSKEY_INIT_SCRIPT });
  if (fp) {
    await context.addInitScript({
      content: `window.__POKESOFT_FP__ = ${JSON.stringify(fp)};\n${FINGERPRINT_INIT_SCRIPT}`,
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => m.type() === 'error' && log('    [console]', m.text().slice(0, 200)));
  page.on('pageerror', (e) => log('    [pageerror]', e.message.slice(0, 200)));
  page.on('request', (r) => {
    if (r.method() === 'POST' && /amazon\.fr\/(ap|ax)\//.test(r.url())) log('    → POST', r.url().slice(0, 140));
  });
  page.on('framenavigated', (f) => f === page.mainFrame() && log('    ⇢ nav', f.url().slice(0, 140)));

  try {
    await page.goto('https://www.amazon.fr/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.title.length > 0 && document.body?.innerText.length > 0, null, { timeout: 30000 }).catch(() => {});
    await dump(page, 'accueil');
    log(
      '    passkeys bloquées ?',
      await page
        .evaluate(async () => !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()))
        .catch((e) => 'erreur ' + e.message)
    );
    // "Cliquez sur le bouton ci-dessous pour continuer vos achats" bot interstitial.
    if (/continuer vos achats/i.test(await page.locator('body').innerText().catch(() => ''))) {
      log('    interstitiel « Continuer les achats » → clic');
      await page.locator('button[type="submit"]').first().click().catch((e) => log('    !! KO', e.message.split('\n')[0]));
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2000);
      await dump(page, 'après interstitiel');
    }
    const greeting = await page.locator('#nav-link-accountList-nav-line-1').first().innerText({ timeout: 5000 }).catch(() => '');
    log('    salutation:', JSON.stringify(greeting));
    const cookie = page.locator('#sp-cc-accept').first();
    if (await cookie.count()) await cookie.click().catch((e) => log('    cookie click KO', e.message));
    if (greeting && !/identifiez-vous|sign\s*in/i.test(greeting)) {
      // "Bonjour <prénom>" can be a merely *recognised* profile: protected pages
      // still ask for the password. Open one to reach that form.
      log("    salutation connectée → ouverture de l'historique des commandes");
      await page
        .goto('https://www.amazon.fr/your-orders/orders', { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => {});
    } else {
      await page.locator('#nav-link-accountList').first().click().catch((e) => log('    lien compte KO', e.message));
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    await dump(page, 'page connexion');

    const email = page.locator('input#ap_email, input#ap_email_login, input[name="email"]').first();
    if (await email.isVisible().catch(() => false)) {
      await email.fill(account.email);
      await dump(page, 'email rempli');
      const cont = page.locator('input#continue, #continue').first();
      log('    clic Continuer…');
      await cont.click({ timeout: 8000 }).catch((e) => log('    !! clic Continuer KO:', e.message.split('\n').slice(0, 3).join(' / ')));
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(3000);
      await dump(page, 'après Continuer');
    }

    const pw = page.locator('input#ap_password, input[name="password"]').first();
    await pw.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill(account.password);
      await page.locator('input[name="rememberMe"]').first().check({ timeout: 2000, force: true }).catch(() => log('    (pas de case rememberMe)'));
      await dump(page, 'mot de passe rempli');
      log('    clic Se connecter…');
      await page
        .locator('input#signInSubmit, #signInSubmit, input#auth-signin-button')
        .first()
        .click({ timeout: 8000 })
        .catch((e) => log('    !! clic Se connecter KO:', e.message.split('\n').slice(0, 3).join(' / ')));
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(4000);
      await dump(page, 'après Se connecter');
    } else {
      log('!! champ mot de passe jamais visible');
    }
    log('FIN — fenêtre laissée ouverte 20 s');
    if (!HEADLESS) await page.waitForTimeout(20000);
  } finally {
    await context.close().catch(() => {});
    if (localProxyUrl) await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
