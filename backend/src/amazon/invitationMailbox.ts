import { type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { gmail, gmailConfigured } from './gmailClient.js';

/** Amazon grants this many hours from the acceptance e-mail to place the order. */
export const INVITATION_VALIDITY_HOURS = 72;

/** A still-valid "you may now order" invitation, parsed from the inbox. */
export interface OrderableInvitation {
  asin: string | null;
  productName: string;
  price?: string;
  /** Recipient alias the mail was addressed to (maps to an account). */
  email: string;
  receivedAt: number;
  expiresAt: number;
  productUrl?: string;
}

export function invitationMailboxConfigured(): boolean {
  return gmailConfigured();
}

// Subject of the acceptance mail: "Félicitations, vous êtes invité à passer commande!"
const ACCEPT_SUBJECT_RE = /vous [êe]tes invit[ée] [àa] passer commande/i;
// Subject of the expiry mail: "Invitation à acheter <produit> expiré" — captures the product.
const EXPIRE_SUBJECT_RE = /^invitation [àa] acheter\s+(.+?)\s+expir/i;

/** Lowercased, accent-stripped, punctuation-collapsed key for fuzzy product match. */
function normalizeProduct(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/^pok[ée]?mon\s*:?\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sameProduct(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function bodyText(parsed: ParsedMail): string {
  const html = typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '';
  return `${parsed.subject || ''}\n${parsed.text || ''}\n${html}`;
}

function recipientAddress(parsed: ParsedMail): string {
  const to = parsed.to;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  for (const a of list) {
    const addr = a?.value?.[0]?.address;
    if (addr) return addr;
    if (a?.text) return a.text;
  }
  return '';
}

/**
 * Scan the shared Gmail inbox for Amazon "you may now order" invitations that are
 * still inside their 72 h window. An acceptance is dropped when a later "invitation
 * … expiré" mail for the same product reached the same recipient. Result is deduped
 * to the newest acceptance per (recipient, ASIN/product).
 */
export async function listOrderableInvitations(
  windowHours = INVITATION_VALIDITY_HOURS
): Promise<OrderableInvitation[]> {
  if (!gmailConfigured()) return [];
  const now = Date.now();
  const windowMs = windowHours * 3_600_000;
  // Search a couple of days wider than the window so expiry mails (which arrive
  // ~72 h after acceptance) are visible to supersede a stale acceptance.
  const sinceMs = now - windowMs - 2 * 24 * 3_600_000;

  return gmail.withInbox(async (client) => {
    const found = await client.search({ since: new Date(sinceMs), from: 'amazon' }, { uid: true });
    if (!found || found.length === 0) return [];
    const uids = [...found].sort((a, b) => b - a).slice(0, 200);

    const accepts: OrderableInvitation[] = [];
    const expiries: { product: string; at: number; email: string }[] = [];

    for await (const msg of client.fetch(
      uids.join(','),
      { uid: true, internalDate: true, source: true },
      { uid: true }
    )) {
      const src = (msg as FetchMessageObject).source;
      if (!src) continue;
      const parsed = await simpleParser(src);
      const subject = parsed.subject || '';
      const at = parsed.date
        ? parsed.date.getTime()
        : msg.internalDate
          ? new Date(msg.internalDate).getTime()
          : 0;
      if (!at) continue;
      const email = recipientAddress(parsed);

      const exp = subject.match(EXPIRE_SUBJECT_RE);
      if (exp) {
        expiries.push({ product: normalizeProduct(exp[1]), at, email: email.toLowerCase() });
        continue;
      }
      if (!ACCEPT_SUBJECT_RE.test(subject)) continue;

      const body = bodyText(parsed);
      const asin = body.match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})/)?.[1] ?? null;
      const productName = (
        body.match(/vous pouvez maintenant acheter\s+([\s\S]+?)\s*\.\s*vous disposez/i)?.[1] ?? subject
      )
        .replace(/\s+/g, ' ')
        .trim();
      const price = body.match(/(\d{1,4}[.,]\d{2})\s*€/)?.[1];
      accepts.push({
        asin,
        productName,
        price,
        email,
        receivedAt: at,
        expiresAt: at + windowMs,
        productUrl: asin ? `https://www.amazon.fr/dp/${asin}` : undefined,
      });
    }

    // Keep acceptances still inside the window and not superseded by a later
    // expiry mail for the same product + recipient.
    const fresh = accepts.filter((a) => now - a.receivedAt < windowMs && a.expiresAt > now);
    const live = fresh.filter((a) => {
      const key = normalizeProduct(a.productName);
      const mail = a.email.toLowerCase();
      return !expiries.some(
        (e) => e.at > a.receivedAt && e.email === mail && sameProduct(e.product, key)
      );
    });

    // Dedup: newest acceptance per recipient + (ASIN or product name).
    const byKey = new Map<string, OrderableInvitation>();
    for (const a of live.sort((x, y) => y.receivedAt - x.receivedAt)) {
      const k = `${a.email.toLowerCase()}|${a.asin ?? normalizeProduct(a.productName)}`;
      if (!byKey.has(k)) byKey.set(k, a);
    }
    return [...byKey.values()];
  });
}
