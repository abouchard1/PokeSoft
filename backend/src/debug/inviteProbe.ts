/**
 * One-item, headed probe of the "Demander une invitation" click.
 * Launches exactly like an invitation run (same profile, proxy, fingerprint,
 * resource blocking) but stops on a single ASIN and traces every request the
 * click fires, so we can see what Amazon actually receives.
 *
 * Usage: npx tsx inviteProbe.ts <asin> [--click] [--no-block]
 */
import '../env.js';
import { chromium } from 'playwright';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountsStore } from '../accounts.js';
import { proxyStore } from '../proxies.js';
import { FINGERPRINT_INIT_SCRIPT } from '../fingerprint.js';

const ASIN = process.argv[2] ?? 'B0GSSW2HQJ';
const DO_CLICK = process.argv.includes('--click');
const NO_BLOCK = process.argv.includes('--no-block');
const INVITE = 'input[name="submit.inviteButton"]';

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function main() {
  const account = accountsStore.list().find((a) => a.prenom === 'Emilie')!;
  log('compte', account.prenom, account.nom, '| proxy', account.proxyId);

  const proxy = account.proxyId ? proxyStore.get(account.proxyId) : undefined;
  let localProxyUrl: string | undefined;
  if (proxy) {
    localProxyUrl = await anonymizeProxy(
      `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`
    );
    log('proxy local', localProxyUrl, '->', proxy.host);
  }

  const dir =
    process.env.PROFILES_DIR
      ? resolve(process.env.PROFILES_DIR, account.id)
      : resolve(process.cwd(), '..', 'data', 'playwright-profiles', account.id);
  mkdirSync(dir, { recursive: true });
  const fp = account.fingerprint;
  const context = await chromium.launchPersistentContext(dir, {
    headless: process.argv.includes("--headless"),
    proxy: localProxyUrl ? { server: localProxyUrl } : undefined,
    userAgent: fp?.userAgent,
    viewport: fp?.viewport,
    deviceScaleFactor: fp?.deviceScaleFactor,
    locale: fp?.locale,
    timezoneId: fp?.timezoneId,
  });
  if (fp) {
    await context.addInitScript({
      content: `window.__POKESOFT_FP__ = ${JSON.stringify(fp)};\n${FINGERPRINT_INIT_SCRIPT}`,
    });
  }
  const KEEP_CSS = process.argv.includes('--css');
  if (!NO_BLOCK) {
    const only = process.argv.find((a) => a.startsWith('--only='));
    const blocked = only
      ? new Set(only.slice(7).split(','))
      : KEEP_CSS
        ? new Set(['image', 'font', 'media'])
        : new Set(['image', 'stylesheet', 'font', 'media']);
    log('CSS', KEEP_CSS ? 'CONSERVÉ' : 'bloqué');
    await context.route('**/*', (route) =>
      blocked.has(route.request().resourceType())
        ? route.abort().catch(() => {})
        : route.continue().catch(() => {})
    );
    log('resource blocking: aggressive (comme un run)');
  } else {
    log('resource blocking: AUCUN');
  }

  const page = context.pages()[0] ?? (await context.newPage());

  // Trace everything that is not a plain asset.
  page.on('request', (r) => {
    if (['document', 'xhr', 'fetch'].includes(r.resourceType()))
      log('→', r.method(), r.resourceType(), r.url().slice(0, 140));
  });
  page.on('response', (r) => {
    if (['document', 'xhr', 'fetch'].includes(r.request().resourceType()))
      log('←', r.status(), r.url().slice(0, 140));
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) log('   NAV', f.url().slice(0, 140));
  });
  page.on('console', (m) => {
    if (m.type() === 'error') log('   console.error', m.text().slice(0, 400));
  });
  page.on('requestfailed', (r) => {
    if (r.resourceType() === 'script') log('   !! SCRIPT ÉCHOUÉ', r.url().slice(0, 120));
  });

  const url = `https://www.amazon.fr/dp/${ASIN}`;
  log('goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page
    .waitForFunction(() => !!document.body && document.body.innerText.length > 200, { timeout: 20000 })
    .catch(() => log('!! body resté vide'));

  const loggedIn = await page
    .locator('#nav-link-accountList-nav-line-1')
    .innerText()
    .catch(() => '?');
  log('compte nav:', JSON.stringify(loggedIn.trim()));

  const count = await page.locator(INVITE).count();
  log('boutons invitation trouvés:', count);
  // Where does the "invitation demandée" wording actually appear, if anywhere?
  const ackProbe = await page.evaluate(() => {
    const hits: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walk.nextNode())) {
      const t = node.textContent ?? '';
      if (/invitation demand/i.test(t)) {
        const el = node.parentElement;
        hits.push(`${el?.tagName}#${el?.id || ''}.${(el?.className || '').toString().slice(0, 40)} :: ${t.trim().slice(0, 120)}`);
      }
    }
    return hits.slice(0, 6);
  });
  log('occurrences de "invitation demand":', ackProbe.length);
  for (const h of ackProbe) console.log('   ', h);
  if (count === 0) {
    const bb = await page
      .locator('#buybox, #desktop_buybox, #rightCol, #centerCol')
      .first()
      .innerText()
      .catch(() => '');
    log('buybox:', bb.replace(/\s+/g, ' ').slice(0, 300));
    await finish();
    return;
  }

  // Dump everything about the button and its form.
  const info = await page.locator(INVITE).first().evaluate((el) => {
    const input = el as HTMLInputElement;
    const form = input.closest('form');
    const r = input.getBoundingClientRect();
    return {
      outerHTML: input.outerHTML.slice(0, 400),
      type: input.type,
      disabled: input.disabled,
      rect: { w: r.width, h: r.height, top: r.top },
      visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
      form: form
        ? {
            action: form.getAttribute('action'),
            method: form.getAttribute('method'),
            id: form.id,
            fields: Array.from(form.querySelectorAll('input,select')).map((f) => {
              const i = f as HTMLInputElement;
              return `${i.name}=${(i.value ?? '').slice(0, 40)}`;
            }),
          }
        : null,
    };
  });
  log('BOUTON', JSON.stringify(info, null, 2));

  // No <form> around a type="submit" means Amazon wires this up in JS. Dump the
  // ancestor chain and anything that looks like an action target.
  const tree = await page.locator(INVITE).first().evaluate((el) => {
    const chain: string[] = [];
    let n: Element | null = el;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      const attrs = Array.from(n.attributes)
        .map((a) => `${a.name}="${a.value.slice(0, 80)}"`)
        .join(' ');
      chain.push(`${'  '.repeat(i)}<${n.tagName.toLowerCase()} ${attrs}>`);
    }
    const forms = Array.from(document.querySelectorAll('form')).map((f) => ({
      id: f.id,
      name: f.getAttribute('name'),
      action: f.getAttribute('action'),
      inviteInside: !!f.querySelector('input[name="submit.inviteButton"]'),
    }));
    const container = el.closest('[id]');
    return { chain, forms: forms.filter((f) => /invite|buybox|addToCart|hdp/i.test(`${f.id}${f.name}${f.action}`)).slice(0, 10), formCount: forms.length, containerId: container?.id, containerHTML: container?.outerHTML.slice(0, 1200) };
  });
  log('ANCETRES:');
  for (const line of tree.chain) console.log(line);
  log('formulaires sur la page:', tree.formCount, '| pertinents:', JSON.stringify(tree.forms, null, 2));
  log('conteneur', tree.containerId);
  console.log(tree.containerHTML);

  if (!DO_CLICK) {
    log('--- pas de clic (ajoute --click) ---');
    await finish();
    return;
  }

  log('=== CLIC ===');
  const t0 = Date.now();
  await page
    .locator(INVITE)
    .first()
    .click({ timeout: 8000 })
    .catch(async (e) => {
      log('!! click playwright a échoué:', (e as Error).message.slice(0, 120));
      await page.locator(INVITE).first().evaluate((el) => (el as HTMLElement).click());
      log('   fallback DOM .click() envoyé');
    });

  // Watch the button for 30 s, logging every second.
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const n = await page.locator(INVITE).count().catch(() => -1);
    const txt = await page
      .locator('#buybox, #desktop_buybox, #rightCol, #centerCol')
      .first()
      .innerText()
      .catch(() => '');
    const ack = /invitation demand/i.test(txt);
    if (i === 0 || i === 4) {
      const vis = await page.evaluate(`(() => {
        var btn = document.querySelector('input[name="submit.inviteButton"]');
        var ackEl = null;
        var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var n;
        while ((n = walk.nextNode())) {
          if (/invitation demand/i.test(n.textContent || '')) { ackEl = n.parentElement; break; }
        }
        return {
          btnPresent: !!btn,
          btnVisible: !!btn && !!btn.getClientRects().length,
          ackPresent: !!ackEl,
          ackVisible: !!ackEl && !!ackEl.getClientRects().length,
          bodyText: (document.querySelector('#hdpInviteButton_feature_div') || {}).innerText || ''
        };
      })()`);
      log('   visibilité réelle:', JSON.stringify(vis));
    }
    if (i % 3 === 0 || n === 0 || ack)
      log(`  +${i + 1}s boutons=${n} ack=${ack} url=${page.url().slice(0, 80)}`);
    if (n === 0 || ack) {
      log(`>>> ACQUITTÉ après ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      break;
    }
  }
  const finalTxt = await page
    .locator('#buybox, #desktop_buybox, #rightCol, #centerCol')
    .first()
    .innerText()
    .catch(() => '');
  log('buybox finale:', finalTxt.replace(/\s+/g, ' ').slice(0, 300));

  async function keepOpen() {
    log('--- fenêtre laissée ouverte 60 s pour inspection ---');
    await page.waitForTimeout(60000);
  }
  await keepOpen();
  await finish();

  async function finish() {
    await context.close().catch(() => {});
    if (localProxyUrl) await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    log('fini');
  }
}

main().catch((e) => {
  console.error('PROBE ERROR', e);
  process.exit(1);
});
