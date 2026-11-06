import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface AmazonOrderItem {
  asin?: string;
  title: string;
  imageUrl?: string;
}

/** One card of the account's "Vos commandes" page. */
export interface AmazonOrder {
  orderId: string;
  /** Raw French date as shown by Amazon ("10 avril 2025"). */
  date: string;
  /** `date` parsed to a timestamp (local midnight), 0 when unparseable. */
  placedAt: number;
  /** Raw total ("35,94 €") — absent on a cancelled order, which Amazon never billed. */
  total?: string;
  totalCents?: number;
  recipient?: string;
  /** Shipment line ("Livré le 12 avril", "Annulé(s)"…). */
  status?: string;
  cancelled: boolean;
  detailsUrl?: string;
  items: AmazonOrderItem[];
}

/** Last order-history sync of one account. */
export interface AccountOrders {
  accountId: string;
  /** Last *successful* sync — `orders` is what it saw. */
  syncedAt?: number;
  /** Last attempt, successful or not. */
  attemptedAt: number;
  status: 'ok' | 'error';
  message?: string;
  /** Years the order-history filter offered (= years since account creation). */
  years: string[];
  orders: AmazonOrder[];
}

const DEFAULT_PATH = resolve(process.cwd(), '..', 'data', 'amazon-orders.json');

class OrdersStore {
  private path = process.env.AMAZON_ORDERS_FILE ?? DEFAULT_PATH;
  private byAccount = new Map<string, AccountOrders>();

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as AccountOrders[];
      if (Array.isArray(parsed)) for (const r of parsed) this.byAccount.set(r.accountId, r);
    } catch {
      // ignore corrupt state
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Array.from(this.byAccount.values()), null, 2), 'utf8');
  }

  list(): AccountOrders[] {
    return Array.from(this.byAccount.values());
  }

  get(accountId: string): AccountOrders | undefined {
    return this.byAccount.get(accountId);
  }

  saveSuccess(accountId: string, orders: AmazonOrder[], years: string[]): AccountOrders {
    const now = Date.now();
    const rec: AccountOrders = { accountId, syncedAt: now, attemptedAt: now, status: 'ok', years, orders };
    this.byAccount.set(accountId, rec);
    this.persist();
    return rec;
  }

  /** A failed sync keeps the orders of the last good one — a dead proxy must not
   *  make an account look brand new. */
  saveError(accountId: string, message: string): AccountOrders {
    const prev = this.byAccount.get(accountId);
    const rec: AccountOrders = {
      accountId,
      syncedAt: prev?.syncedAt,
      attemptedAt: Date.now(),
      status: 'error',
      message,
      years: prev?.years ?? [],
      orders: prev?.orders ?? [],
    };
    this.byAccount.set(accountId, rec);
    this.persist();
    return rec;
  }

  delete(accountId: string) {
    if (this.byAccount.delete(accountId)) this.persist();
  }
}

export const ordersStore = new OrdersStore();
