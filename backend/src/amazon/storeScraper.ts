import { chromium, type BrowserContext, type Page } from 'playwright';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxyStore } from '../proxies.js';
import { generateFingerprint, FINGERPRINT_INIT_SCRIPT } from '../fingerprint.js';
import type { ScrapedItem } from './itemsStore.js';

// JCC Pokémon brand store. Any page works as entry point — the nav listing all
// sub-pages is identical across the whole store.
const STORE_ENTRY =
  'https://www.amazon.fr/stores/page/446B2018-237F-4E11-BB2C-5362C9BF5B63?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln';

// A page is an "extension" when its breadcrumb sits under this section.
const EXTENSION_SECTION = 'acheter par extension';

function storePageUrl(id: string): string {
  return `https://www.amazon.fr/stores/page/${id}?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln`;
}

export interface ImportProgress {
  (msg: string): void;
}

async function settle(page: Page, scroll: boolean) {
  await page
    .waitForFunction(() => !!document.body && document.body.innerText.length > 200, { timeout: 20000 })
    .catch(() => {});
  if (scroll) {
    await page.evaluate(async () => {
      await new Promise<void>((res) => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 700);
          total += 700;
          if (total >= document.body.scrollHeight + 1500) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            res();
          }
        }, 110);
      });
    });
    await page.waitForTimeout(1200);
  } else {
    await page.waitForTimeout(800);
  }
}

/** All store sub-page ids reachable from the nav. */
async function listStorePageIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids = new Set<string>();
    document.querySelectorAll('a[href*="/stores/page/"]').forEach((a) => {
      const m = (a as HTMLAnchorElement).href.match(/\/stores\/page\/([A-F0-9-]{36})/i);
      if (m) ids.add(m[1].toUpperCase());
    });
    return Array.from(ids);
  });
}

/** Breadcrumb trail, e.g. ["JCC Pokémon", "Acheter Par Extension", "Chaos Ascendant"]. */
async function readBreadcrumb(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const items: string[] = [];
    document.querySelectorAll('[aria-label$="breadcrumb"] a').forEach((a) => {
      const t = (a as HTMLElement).innerText.trim();
      if (t) items.push(t);
    });
    if (items.length === 0) {
      document.querySelectorAll('[aria-label$="breadcrumb"]').forEach((el) => {
        const lbl = el.getAttribute('aria-label')?.replace(/\s*breadcrumb$/i, '').trim();
        if (lbl) items.push(lbl);
      });
    }
    return items;
  });
}

/** Product tiles on the current store page. */
async function extractProducts(page: Page): Promise<{ asin: string; title: string; imageUrl: string; productUrl: string }[]> {
  return page.evaluate(() => {
    const out: { asin: string; title: string; imageUrl: string; productUrl: string }[] = [];
    document.querySelectorAll('li[data-testid="product-grid-item"]').forEach((li) => {
      const idAttr = li.getAttribute('data-csa-c-item-id') || '';
      const asin = idAttr.replace('amzn1.asin.', '');
      if (!/^[A-Z0-9]{10}$/.test(asin)) return;
      const a = li.querySelector('a[title]') as HTMLAnchorElement | null;
      const img = li.querySelector('img') as HTMLImageElement | null;
      const title = (a?.getAttribute('title') || img?.alt || '').replace(/^Image of /i, '').trim();
      let imageUrl = '';
      if (img) {
        if (img.srcset) {
          let best = '';
          let bestW = 0;
          for (const part of img.srcset.split(',')) {
            const seg = part.trim().split(/\s+/);
            const width = parseInt(seg[1]) || 0;
            if (width >= bestW) {
              bestW = width;
              best = seg[0];
            }
          }
          imageUrl = best;
        }
        if (!imageUrl) imageUrl = img.src || '';
      }
      const productUrl = a ? a.href : `https://www.amazon.fr/dp/${asin}`;
      out.push({ asin, title, imageUrl, productUrl });
    });
    return out;
  });
}

async function makeContext(proxyId?: string): Promise<{ context: BrowserContext; cleanup: () => Promise<void> }> {
  let localProxyUrl: string | undefined;
  if (proxyId) {
    const p = proxyStore.get(proxyId);
    if (!p) throw new Error(`Proxy inconnu : ${proxyId}`);
    localProxyUrl = await anonymizeProxy(
      `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}`
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'pokesoft-store-'));
  const fp = generateFingerprint();
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    proxy: localProxyUrl ? { server: localProxyUrl } : undefined,
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    deviceScaleFactor: fp.deviceScaleFactor,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
  });
  await context.addInitScript({
    content: `window.__POKESOFT_FP__ = ${JSON.stringify(fp)};\n${FINGERPRINT_INIT_SCRIPT}`,
  });
  await context.setExtraHTTPHeaders({
    'Accept-Language': `${fp.locale},${fp.locale.split('-')[0]};q=0.9`,
  });
  return {
    context,
    cleanup: async () => {
      await context.close().catch(() => {});
      if (localProxyUrl) await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export interface ScrapeResult {
  items: ScrapedItem[];
  extensions: string[];
}

/**
 * Walk the JCC Pokémon brand store: enumerate sub-pages, keep the ones whose
 * breadcrumb places them under "Acheter Par Extension", and collect their
 * product tiles. New extensions are picked up automatically.
 */
export async function scrapeBrandStore(
  opts: { proxyId?: string; entryUrl?: string; onProgress?: ImportProgress } = {}
): Promise<ScrapeResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const { context, cleanup } = await makeContext(opts.proxyId);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    onProgress('Chargement du store…');
    await page.goto(opts.entryUrl ?? STORE_ENTRY, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page, false);

    const pageIds = await listStorePageIds(page);
    onProgress(`${pageIds.length} pages détectées, classification…`);

    const items: ScrapedItem[] = [];
    const extensions: string[] = [];
    for (const id of pageIds) {
      await page.goto(storePageUrl(id), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await settle(page, false);
      const crumbs = await readBreadcrumb(page);
      const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2] : '';
      if (parent.toLowerCase() !== EXTENSION_SECTION) continue;

      const name = crumbs[crumbs.length - 1] || (await page.title()).split(':').pop()?.trim() || id;
      onProgress(`Extension « ${name} »…`);
      // re-settle with scroll so lazy-loaded tiles/images are present
      await settle(page, true);
      const products = await extractProducts(page);
      for (const p of products) items.push({ ...p, extension: name });
      extensions.push(name);
    }
    onProgress(`Terminé : ${items.length} items dans ${extensions.length} extensions.`);
    return { items, extensions };
  } finally {
    await cleanup();
  }
}
