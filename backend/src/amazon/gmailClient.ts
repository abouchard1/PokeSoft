import { ImapFlow } from 'imapflow';

const HOST = process.env.GMAIL_IMAP_HOST || 'imap.gmail.com';
const PORT = Number(process.env.GMAIL_IMAP_PORT || 993);
const USER = process.env.GMAIL_USER || '';
const PASS = process.env.GMAIL_APP_PASSWORD || '';
/**
 * Which mailbox the readers search. `INBOX` (default) only sees mail still in
 * the inbox — a Gmail filter with "Ignorer la boîte de réception" would hide
 * Amazon's mail from the OTP and acceptance readers and silently break both.
 * Set `GMAIL_MAILBOX=ALL` to search Gmail's "Tous les messages" instead, which
 * holds every labelled/archived message whatever the filters do. Any literal
 * IMAP path also works (e.g. a single label).
 */
const MAILBOX = process.env.GMAIL_MAILBOX || 'INBOX';

/** Whether Gmail IMAP credentials are present (see backend/.env). */
export function gmailConfigured(): boolean {
  return Boolean(USER && PASS);
}

/**
 * Single shared Gmail IMAP connection, scoped to `GMAIL_MAILBOX`.
 *
 * Gmail caps simultaneous IMAP connections, so the whole backend must reuse one
 * client — both the OTP reader (`otpMailbox`) and the invitation-acceptance
 * reader (`invitationMailbox`) go through this. Per-operation INBOX access is
 * serialised with `withInbox`, which holds the mailbox lock for the callback.
 */
class GmailConnection {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private allMailPath: string | null = null;

  /** The mailbox to lock: `MAILBOX`, or Gmail's `\All` folder when it is `ALL`
   *  (its name is localised — "[Gmail]/Tous les messages" here — so resolve it
   *  from the special-use flag rather than hardcoding a path). */
  private async mailboxPath(client: ImapFlow): Promise<string> {
    if (MAILBOX.toUpperCase() !== 'ALL') return MAILBOX;
    if (this.allMailPath) return this.allMailPath;
    for (const box of await client.list()) {
      if (box.specialUse === '\\All') {
        this.allMailPath = box.path;
        return box.path;
      }
    }
    return 'INBOX';
  }

  async getClient(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new ImapFlow({
        host: HOST,
        port: PORT,
        secure: true,
        auth: { user: USER, pass: PASS },
        logger: false,
      });
      client.on('error', () => {});
      client.on('close', () => {
        if (this.client === client) this.client = null;
      });
      await client.connect();
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Run `fn` while holding the configured mailbox's lock on the shared connection. */
  async withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    const lock = await client.getMailboxLock(await this.mailboxPath(client));
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  }
}

export const gmail = new GmailConnection();
