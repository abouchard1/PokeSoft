import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * `available` = the "Demander une invitation" button is **there and was not
 * clicked**: either a detect-only pass, or a click that Amazon never registered.
 * It must never be recorded as `requested` — a detection that reads "demandées"
 * is how a run came to claim 80 requests that were never made (2026-09-18).
 *
 * `orderable` = Amazon **accepted** the invitation: its own offer now shows a
 * plain add-to-cart instead of the invite button, so the item can be bought.
 * Detected on the page because the acceptance e-mail is not always sent.
 */
export type InvitationStatus =
  | 'requested'
  | 'available'
  | 'already'
  | 'orderable'
  | 'unavailable'
  | 'login'
  | 'error';

export interface InvitationRecord {
  accountId: string;
  asin: string;
  status: InvitationStatus;
  message?: string;
  requestedAt?: number;
  /** `orderable` only: when the invitation lapses, from the page's "Vous avez
   *  N heures M minutes avant l'expiration de votre invitation". */
  expiresAt?: number;
  lastCheckedAt: number;
}

/** Per-ASIN rollup of invitation availability across accounts. */
export interface AsinAvailability {
  available: 'yes' | 'no' | 'unknown';
  unavailable: number;
  gotInvite: number;
  checkedAccounts: number;
  lastCheckedAt: number;
  /** Newest check per camp — these decide the verdict (freshest wins). */
  lastInviteAt: number;
  lastUnavailableAt: number;
}

const DEFAULT_PATH = resolve(process.cwd(), '..', 'data', 'amazon-invitations.json');
const key = (accountId: string, asin: string) => `${accountId}:${asin}`;

class InvitationsStore {
  private path = process.env.AMAZON_INVITATIONS_FILE ?? DEFAULT_PATH;
  private records = new Map<string, InvitationRecord>();

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as InvitationRecord[];
      if (Array.isArray(parsed)) {
        for (const r of parsed) this.records.set(key(r.accountId, r.asin), r);
      }
    } catch {
      // ignore corrupt state
    }
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Array.from(this.records.values()), null, 2), 'utf8');
  }

  get(accountId: string, asin: string): InvitationRecord | undefined {
    return this.records.get(key(accountId, asin));
  }

  list(accountId?: string): InvitationRecord[] {
    const all = Array.from(this.records.values());
    return accountId ? all.filter((r) => r.accountId === accountId) : all;
  }

  /**
   * Aggregate, per ASIN, whether the item still appears open to invitation —
   * derived from every account's latest result. Only item-side statuses count
   * (`requested`/`available`/`already`/`orderable` = the invitation exists for
   * this item → available; `unavailable` = it didn't). Account-side outcomes (`login`/
   * `error`) are ignored.
   *
   * **The freshest observation wins**, not the majority. Availability is a
   * property of the item, so the most recent check describes it best: a stale
   * `requested` can't keep an item alive once newer runs see no invite button
   * (invitation closed), and — symmetrically — stale `unavailable` results can't
   * outvote a newer `requested` (which is what happened when a detection bug was
   * fixed: 9 old wrong `unavailable` were burying 1 fresh correct verdict).
   */
  availabilityByAsin(): Record<string, AsinAvailability> {
    const agg: Record<
      string,
      {
        unavailable: number;
        gotInvite: number;
        checkedAccounts: number;
        lastCheckedAt: number;
        lastInviteAt: number;
        lastUnavailableAt: number;
      }
    > = {};
    for (const r of this.records.values()) {
      if (
        r.status !== 'requested' &&
        r.status !== 'available' &&
        r.status !== 'already' &&
        r.status !== 'orderable' &&
        r.status !== 'unavailable'
      )
        continue;
      const a = (agg[r.asin] ??= {
        unavailable: 0,
        gotInvite: 0,
        checkedAccounts: 0,
        lastCheckedAt: 0,
        lastInviteAt: 0,
        lastUnavailableAt: 0,
      });
      const at = r.lastCheckedAt || 0;
      a.checkedAccounts++;
      if (r.status === 'unavailable') {
        a.unavailable++;
        a.lastUnavailableAt = Math.max(a.lastUnavailableAt, at);
      } else {
        a.gotInvite++;
        a.lastInviteAt = Math.max(a.lastInviteAt, at);
      }
      a.lastCheckedAt = Math.max(a.lastCheckedAt, at);
    }
    const out: Record<string, AsinAvailability> = {};
    for (const [asin, a] of Object.entries(agg)) {
      let available: AsinAvailability['available'];
      if (a.gotInvite === 0 && a.unavailable === 0) available = 'unknown';
      else if (a.unavailable === 0) available = 'yes';
      else if (a.gotInvite === 0) available = 'no';
      else if (a.lastInviteAt !== a.lastUnavailableAt)
        available = a.lastInviteAt > a.lastUnavailableAt ? 'yes' : 'no';
      // Checked in the same batch (identical timestamps): fall back to majority.
      else available = a.gotInvite >= a.unavailable ? 'yes' : 'no';
      out[asin] = { ...a, available };
    }
    return out;
  }

  upsert(record: InvitationRecord): InvitationRecord {
    const existing = this.records.get(key(record.accountId, record.asin));
    const merged: InvitationRecord = {
      ...existing,
      ...record,
      // preserve the original request timestamp unless a new request happened
      requestedAt: record.requestedAt ?? existing?.requestedAt,
    };
    this.records.set(key(record.accountId, record.asin), merged);
    this.persist();
    return merged;
  }
}

export const invitationsStore = new InvitationsStore();
