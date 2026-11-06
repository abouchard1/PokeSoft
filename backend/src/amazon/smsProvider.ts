const KEY = process.env.SMSPOOL_API_KEY || '';
const BASE = process.env.SMSPOOL_BASE || 'https://api.smspool.net';
const COUNTRY = process.env.SMSPOOL_COUNTRY_ID || '23'; // France
const SERVICE = process.env.SMSPOOL_SERVICE_ID || '39'; // Amazon / AWS

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether an smspool API key is configured (see backend/.env). */
export function smsProviderConfigured(): boolean {
  return Boolean(KEY);
}

async function post(path: string, extra: Record<string, string> = {}): Promise<any> {
  const body = new URLSearchParams({ key: KEY, ...extra });
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

export interface SmsOrder {
  orderId: string;
  phone: string; // national number, no country code (what Amazon's FR field expects)
  full: string; // full number incl. country code
}

/** Order a France/Amazon number. Returns null if none available / error.
 *  Cost is auto-refunded by smspool if no SMS arrives before expiry, so failed
 *  attempts are effectively free — retry freely. */
export async function orderNumber(): Promise<SmsOrder | null> {
  const res = await post('/purchase/sms', { country: COUNTRY, service: SERVICE });
  if (res && (res.success === 1 || res.order_id)) {
    return {
      orderId: String(res.order_id ?? res.orderid),
      phone: String(res.phonenumber ?? res.number),
      full: String(res.number ?? res.phonenumber),
    };
  }
  return null;
}

/** Poll for the SMS code. Returns the code, or null on timeout / expiry / refund. */
export async function pollSms(orderId: string, timeoutMs = 150_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await post('/sms/check', { orderid: orderId });
    if (r) {
      if (r.sms) return String(r.sms).replace(/\D/g, '') || String(r.sms);
      // status 6 = expired/refunded/cancelled
      if (r.status === 6 || /expired|refund|cancel/i.test(JSON.stringify(r))) return null;
    }
    await sleep(5000);
  }
  return null;
}

/** Try to cancel an order (smspool blocks cancel for a few minutes; an unused
 *  number auto-refunds at expiry anyway). Best-effort. */
export async function cancelNumber(orderId: string): Promise<void> {
  await post('/sms/cancel', { orderid: orderId }).catch(() => {});
}

export async function balance(): Promise<string | null> {
  const r = await post('/request/balance');
  return r?.balance ?? null;
}
