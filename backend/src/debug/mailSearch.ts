/** Show recipient + date for mails whose subject matches a pattern. */
import '../env.js';
import { gmail, gmailConfigured } from '../amazon/gmailClient.js';
const RE = new RegExp(process.argv[2] ?? 'suspen', 'i');
const DAYS = Number(process.argv[3] ?? 400);
async function main() {
  if (!gmailConfigured()) return console.log('Gmail non configuré');
  await gmail.withInbox(async (client) => {
    const uids = (await client.search({ since: new Date(Date.now() - DAYS * 86400_000), from: 'amazon' }, { uid: true })) || [];
    for await (const msg of client.fetch({ uid: uids.join(',') }, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
      const subject = msg.envelope?.subject ?? '';
      if (!RE.test(subject)) continue;
      const to = (msg.envelope?.to ?? []).map((t: any) => t.address).join(',');
      console.log(new Date(msg.internalDate as any).toISOString().slice(0, 16), '|', to.padEnd(34), '|', subject.slice(0, 70));
    }
  });
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
