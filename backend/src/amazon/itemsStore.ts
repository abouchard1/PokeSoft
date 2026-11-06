import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AmazonItem {
  id: string;
  asin: string;
  title: string;
  imageUrl: string;
  productUrl: string;
  extension: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Present in the latest brand-store scrape. An item that vanished from the
   *  store is treated as "no invitation" (same meaning for the user). */
  inStore: boolean;
  lastSeenAt?: number;
}

/** Shape produced by the scraper before persistence. */
export interface ScrapedItem {
  asin: string;
  title: string;
  imageUrl: string;
  productUrl: string;
  extension: string;
}

const DEFAULT_PATH = resolve(process.cwd(), '..', 'data', 'amazon-items.json');

class AmazonItemsStore {
  private path = process.env.AMAZON_ITEMS_FILE ?? DEFAULT_PATH;
  private items: AmazonItem[] = [];

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) {
      this.items = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.items = [];
    }
    // Items saved before `inStore` existed: assume present until the next import
    // re-evaluates them, so old data isn't falsely flagged as absent.
    for (const it of this.items) if (typeof it.inStore !== 'boolean') it.inStore = true;
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.items, null, 2), 'utf8');
  }

  list(): AmazonItem[] {
    return [...this.items].sort((a, b) =>
      a.extension === b.extension
        ? a.title.localeCompare(b.title)
        : a.extension.localeCompare(b.extension)
    );
  }

  /**
   * Merge scraped items by ASIN: refresh title/image/extension/url, but keep
   * the existing `enabled` toggle and id so the user's selection survives a
   * re-import. Returns counts for reporting.
   */
  upsertMany(scraped: ScrapedItem[]): { added: number; updated: number; absent: number; total: number } {
    const now = Date.now();
    let added = 0;
    let updated = 0;
    const scrapedAsins = new Set<string>();
    for (const s of scraped) {
      if (!s.asin) continue;
      scrapedAsins.add(s.asin);
      const existing = this.items.find((i) => i.asin === s.asin);
      if (existing) {
        existing.title = s.title || existing.title;
        existing.imageUrl = s.imageUrl || existing.imageUrl;
        existing.productUrl = s.productUrl || existing.productUrl;
        existing.extension = s.extension || existing.extension;
        existing.inStore = true;
        existing.lastSeenAt = now;
        existing.updatedAt = now;
        updated++;
      } else {
        this.items.push({
          id: randomUUID(),
          asin: s.asin,
          title: s.title,
          imageUrl: s.imageUrl,
          productUrl: s.productUrl,
          extension: s.extension,
          enabled: false,
          inStore: true,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });
        added++;
      }
    }
    // Items no longer in the store → mark absent (= no invitation). Guard against
    // an empty/failed scrape wiping every flag: only do this if we got products.
    let absent = 0;
    if (scrapedAsins.size > 0) {
      for (const it of this.items) {
        if (!scrapedAsins.has(it.asin) && it.inStore !== false) {
          it.inStore = false;
          it.updatedAt = now;
          absent++;
        }
      }
    }
    this.persist();
    return { added, updated, absent, total: this.items.length };
  }

  setEnabled(id: string, enabled: boolean): AmazonItem | undefined {
    const item = this.items.find((i) => i.id === id);
    if (!item) return undefined;
    item.enabled = enabled;
    item.updatedAt = Date.now();
    this.persist();
    return item;
  }

  delete(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }
}

export const amazonItemsStore = new AmazonItemsStore();
