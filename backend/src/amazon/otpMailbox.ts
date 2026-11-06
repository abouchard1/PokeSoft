import { type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { gmail, gmailConfigured } from './gmailClient.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether Gmail IMAP credentials are present (see backend/.env). */
export function otpMailboxConfigured(): boolean {
  return gmailConfigured();
}

/**
 * Single shared Gmail IMAP connection that hands out Amazon OTP codes per alias.
 *
 * Every Amazon account registers a `fifa10081994+xxx@gmail.com` alias, so all
 * OTP mails land in this one inbox. With up to ~15 logins running at once we must
 * (a) NOT open 15 IMAP connections — Gmail caps simultaneous connections — so a
 * single client is reused and access serialised via a mailbox lock; and (b) hand
 * each login the code addressed to *its* alias. Gmail's IMAP search ignores
 * plus-addressing, so the search is only a coarse prefilter — we then re-check the
 * actual `To`/`Delivered-To` header for an exact alias match before accepting a
 * code, and dedupe by UID so a code is never served twice.
 */
class OtpMailbox {
  private consumed = new Set<string>();

  /**
   * Poll the inbox until an Amazon OTP addressed to `alias` and received at/after
   * `since` shows up, or `timeoutMs` elapses. Returns the 6-digit code or null.
   */
  async fetchOtp(alias: string, since: Date, timeoutMs = 90_000): Promise<string | null> {
    if (!otpMailboxConfigured() || !alias) return null;
    const aliasLc = alias.toLowerCase();
    // IMAP SEARCH SINCE is date-granular; refine by timestamp after fetch, with a
    // small skew buffer so a mail stamped just before `since` is not missed. Keep
    // it tight (25 s) so we don't pick up a stale code from an earlier attempt —
    // combined with newest-first selection this targets the current challenge.
    const minTime = since.getTime() - 25_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const code = await this.scanOnce(aliasLc, minTime).catch(() => null);
      if (code) return code;
      await sleep(3000);
    }
    return null;
  }

  private async scanOnce(aliasLc: string, minTime: number): Promise<string | null> {
    return gmail.withInbox(async (client) => {
      const found = await client.search(
        { since: new Date(minTime), from: 'amazon' },
        { uid: true }
      );
      if (!found || found.length === 0) return null;
      // Newest first; cap how many we decode per pass.
      const uids = [...found].sort((a, b) => b - a).slice(0, 30);
      for await (const msg of client.fetch(
        uids.join(','),
        { uid: true, internalDate: true, source: true },
        { uid: true }
      )) {
        const received = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
        if (received && received < minTime) continue;
        const key = `${aliasLc}:${msg.uid}`;
        if (this.consumed.has(key)) continue;
        const src = (msg as FetchMessageObject).source;
        if (!src) continue;
        const parsed: ParsedMail = await simpleParser(src);
        if (!recipientMatches(parsed, aliasLc)) continue;
        const code = extractCode(parsed);
        if (code) {
          this.consumed.add(key);
          return code;
        }
      }
      return null;
    });
  }
}

/** True when one of the message's recipient headers contains the exact alias. */
function recipientMatches(parsed: ParsedMail, aliasLc: string): boolean {
  const fields: string[] = [];
  const addr = (a: ParsedMail['to']) => {
    if (!a) return;
    for (const x of Array.isArray(a) ? a : [a]) if (x?.text) fields.push(x.text);
  };
  addr(parsed.to);
  addr(parsed.cc);
  addr(parsed.bcc);
  for (const h of ['delivered-to', 'x-original-to', 'x-forwarded-to']) {
    const v = parsed.headers.get(h);
    if (typeof v === 'string') fields.push(v);
    else if (Array.isArray(v)) fields.push(...v.map(String));
  }
  return fields.join(' ').toLowerCase().includes(aliasLc);
}

/** Pull a 6-digit OTP out of the subject/body, preferring one near a keyword. */
function extractCode(parsed: ParsedMail): string | null {
  const html = typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '';
  const text = [parsed.subject || '', parsed.text || '', html].join('\n');
  const near = text.match(
    /(?:code|otp|mot de passe|password|v[eé]rification|verification|usage unique|one[- ]?time)\D{0,40}(\d{6})/i
  );
  if (near) return near[1];
  const any = text.match(/\b(\d{6})\b/);
  return any ? any[1] : null;
}

export const otpMailbox = new OtpMailbox();
