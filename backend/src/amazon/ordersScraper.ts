import type { Page } from 'playwright';
import type { AmazonOrder } from './ordersStore.js';

const ORDERS_URL = 'https://www.amazon.fr/your-orders/orders';
/** Amazon lists 10 orders per page; a safety cap on pages per year filter. */
const PAGE_SIZE = 10;
const MAX_PAGES_PER_YEAR = 30;

const MONTHS: Record<string, number> = {
  janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6,
  août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11,
};

/** "10 avril 2025" → timestamp (0 when unparseable). */
export function parseFrenchDate(s: string): number {
  const m = s.trim().toLowerCase().match(/(\d{1,2})\s+([a-zéèûô]+)\s+(\d{4})/);
  if (!m || MONTHS[m[2]] === undefined) return 0;
  return new Date(Number(m[3]), MONTHS[m[2]], Number(m[1])).getTime();
}

/** "1 234,56 €" → 123456 (undefined when unparseable). */
function parseEuroCents(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/[\s  ]/g, '').match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return undefined;
  return Math.round(parseFloat(m[1].replace(',', '.')) * 100);
}

export class OrdersLoginRequired extends Error {}

/** Load an order-history page; `domcontentloaded` alone lands on the AWS WAF
 *  challenge, so wait for real content (same trick as the product pages). */
async function gotoOrders(page: Page, url: string) {
  let last: Error | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (/\/ap\/signin/.test(page.url())) throw new OrdersLoginRequired('connexion requise');
      await page.waitForFunction(() => !!document.body && document.body.innerText.length > 200, {
        timeout: 20000,
      });
      if (/\/ap\/signin/.test(page.url())) throw new OrdersLoginRequired('connexion requise');
      // The cards are decrypted client-side (SiegeClientSideDecryption) — give
      // them a moment to render before reading the DOM.
      await page
        .waitForSelector('.js-order-card, #time-filter', { timeout: 8000 })
        .catch(() => {});
      return;
    } catch (err) {
      if (err instanceof OrdersLoginRequired) throw err;
      last = err as Error;
      if (i < 2) await page.waitForTimeout(2000 * (i + 1));
    }
  }
  throw new Error(`page commandes inaccessible: ${last?.message.split('\n')[0] ?? '?'}`);
}

interface RawOrder {
  orderId: string;
  date: string;
  total?: string;
  recipient?: string;
  status?: string;
  cancelled: boolean;
  detailsUrl?: string;
  items: { asin?: string; title: string; imageUrl?: string }[];
}

/**
 * Read every order card on the current page (rendered DOM, not raw HTML — the
 * cards are decrypted client-side). Kept as a plain string: tsx's `keepNames`
 * would wrap inner helpers in `__name(...)`, which doesn't exist in the page.
 */
const READ_CARDS_SCRIPT = String.raw`(() => {
  const txt = (el) => ((el && el.innerText) || '').trim();
  const orders = Array.from(document.querySelectorAll('.js-order-card')).map((card) => {
    let date = '';
    let total;
    let recipient;
    for (const li of Array.from(card.querySelectorAll('.order-header__header-list-item'))) {
      const lines = txt(li).split('\n').map((l) => l.trim()).filter(Boolean);
      const label = (lines[0] || '').toLowerCase();
      if (label.startsWith('commande effectu')) date = lines[1] || '';
      else if (label.startsWith('total')) total = lines[1];
      else if (label.startsWith('livraison')) recipient = lines[1];
    }
    const orderId = (txt(card.querySelector('.yohtmlc-order-id')).match(/\d{3}-\d{7}-\d{7}/) || [''])[0];
    const primary = Array.from(card.querySelectorAll('.yohtmlc-shipment-status-primaryText'))
      .map((e) => txt(e))
      .filter(Boolean);
    const cancelled =
      /annul[ée]/i.test(primary.join(' ')) || /commande a été annulée/i.test(txt(card));
    const items = [];
    const seen = new Set();
    for (const box of Array.from(card.querySelectorAll('.item-box'))) {
      const link = box.querySelector('.yohtmlc-product-title a, a[href*="/dp/"], a[href*="/gp/product/"]');
      const href = (link && link.getAttribute('href')) || '';
      const asin = (href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1];
      const title = txt(box.querySelector('.yohtmlc-product-title')) || txt(link);
      const img = box.querySelector('.product-image img, img');
      const k = asin || title;
      if (!title || seen.has(k)) continue;
      seen.add(k);
      items.push({ asin, title, imageUrl: (img && img.src) || undefined });
    }
    const details = card.querySelector('a[href*="order-details"]');
    const detailsHref = details && details.getAttribute('href');
    return {
      orderId,
      date,
      total,
      recipient,
      status: primary[0],
      cancelled,
      detailsUrl: detailsHref ? new URL(detailsHref, location.origin).href : undefined,
      items,
    };
  });
  const next = document.querySelector('.a-pagination li.a-last');
  const hasNext = !!next && !next.classList.contains('a-disabled') && !!next.querySelector('a');
  return { orders, hasNext };
})()`;

async function readCards(page: Page): Promise<{ orders: RawOrder[]; hasNext: boolean }> {
  return page.evaluate(READ_CARDS_SCRIPT) as Promise<{ orders: RawOrder[]; hasNext: boolean }>;
}

/**
 * Walk the whole order history of the logged-in account on `page`: every year
 * the time filter offers (Amazon only lists years since the account exists),
 * paginated. Throws `OrdersLoginRequired` when Amazon asks to sign in again.
 */
export async function scrapeOrderHistory(
  page: Page,
  onProgress?: (message: string) => void
): Promise<{ orders: AmazonOrder[]; years: string[] }> {
  await gotoOrders(page, ORDERS_URL);
  if ((await page.locator('#time-filter').count()) === 0) {
    throw new Error("page commandes non reconnue (filtre d'année absent)");
  }
  const years = await page.$$eval('#time-filter option', (opts) =>
    opts.map((o) => (o as HTMLOptionElement).value).filter((v) => /^year-\d{4}$/.test(v))
  );
  const byId = new Map<string, AmazonOrder>();
  for (const year of years) {
    for (let p = 0; p < MAX_PAGES_PER_YEAR; p++) {
      onProgress?.(`${year.slice(5)} — page ${p + 1}`);
      const url = `${ORDERS_URL}?timeFilter=${year}${p > 0 ? `&startIndex=${p * PAGE_SIZE}` : ''}`;
      await gotoOrders(page, url);
      const { orders, hasNext } = await readCards(page);
      for (const o of orders) {
        if (!o.orderId) continue;
        byId.set(o.orderId, {
          ...o,
          placedAt: parseFrenchDate(o.date),
          totalCents: o.cancelled ? undefined : parseEuroCents(o.total),
        });
      }
      if (!hasNext || orders.length < PAGE_SIZE) break;
    }
  }
  const orders = Array.from(byId.values()).sort((a, b) => b.placedAt - a.placedAt);
  return { orders, years: years.map((y) => y.slice(5)) };
}
