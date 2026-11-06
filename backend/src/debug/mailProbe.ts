/** Inventory of Amazon mails in the shared inbox: senders + subject shapes,
 *  so Gmail filters can be written against what actually arrives. */
import '../env.js';
import { gmail, gmailConfigured } from '../amazon/gmailClient.js';

const DAYS = Number(process.argv[2] ?? 30);

async function main() {
  if (!gmailConfigured()) return console.log('Gmail non configuré');
  const since = new Date(Date.now() - DAYS * 86400_000);
  await gmail.withInbox(async (client) => {
    const uids = (await client.search({ since }, { uid: true })) || [];
    console.log(`${uids.length} mails depuis ${since.toISOString().slice(0, 10)}`);
    const bySubject = new Map<string, { n: number; from: string; last: string }>();
    for await (const msg of client.fetch(
      { uid: uids.join(',') },
      { uid: true, envelope: true, internalDate: true },
      { uid: true }
    )) {
      const from = (msg.envelope?.from ?? []).map((t: any) => t.address).join(',');
      // Collapse product names so the recurring shapes group together.
      const subj = (msg.envelope?.subject ?? '')
        .replace(/Pok[ée]mon.*$/i, '<produit>')
        .replace(/\d{3,}/g, '<n>')
        .trim()
        .slice(0, 70);
      const k = `${from} :: ${subj}`;
      const prev = bySubject.get(k);
      const d = new Date(msg.internalDate as any).toISOString().slice(0, 16);
      bySubject.set(k, { n: (prev?.n ?? 0) + 1, from, last: d });
    }
    console.log('\nexpéditeur :: sujet (regroupé)                                    nb   dernier');
    [...bySubject.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .forEach(([k, v]) => console.log(k.padEnd(86), String(v.n).padStart(3), ' ', v.last));
  });
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
