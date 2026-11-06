import { ProxyAgent, fetch as ufetch } from 'undici';
import { proxyStore } from '../proxies.js';

const KEY = process.env.ANTICAPTCHA_API_KEY || '';
const HOST = process.env.ANTICAPTCHA_BASE || 'https://api.anti-captcha.com';
// Our network can't reach anti-captcha.com directly — route API calls through a
// Webshare proxy (default the reserved proxy #1, never assigned to an account).
const PROXY_ID = process.env.ANTICAPTCHA_PROXY_ID || '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function captchaSolverConfigured(): boolean {
  return Boolean(KEY);
}

function agent(): ProxyAgent | undefined {
  const p = proxyStore.get(PROXY_ID);
  if (!p) return undefined;
  return new ProxyAgent({
    uri: `http://${p.host}:${p.port}`,
    token: 'Basic ' + Buffer.from(`${p.username}:${p.password}`).toString('base64'),
  });
}

async function api(path: string, payload: Record<string, unknown>): Promise<any> {
  const r = await ufetch(HOST + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientKey: KEY, ...payload }),
    dispatcher: agent(),
  });
  return r.json();
}

export interface FunCaptchaParams {
  websiteURL: string;
  websitePublicKey: string;
  funcaptchaApiJSSubdomain?: string;
  /** Arkose "blob" — JSON string like {"blob":"..."}; extracted from the iframe. */
  data?: string;
  userAgent?: string;
}

/** Solve an Arkose FunCaptcha via Anti-Captcha. Returns the token or null. */
export async function solveFunCaptcha(
  params: FunCaptchaParams,
  onLog?: (m: string) => void,
  timeoutMs = 180_000
): Promise<string | null> {
  const create = await api('/createTask', {
    task: { type: 'FunCaptchaTaskProxyless', ...params },
    softId: 0,
  }).catch((e) => ({ errorId: -1, errorDescription: String(e) }));
  if (create.errorId !== 0) {
    onLog?.(`anti-captcha createTask échec: ${create.errorCode ?? ''} ${create.errorDescription ?? ''}`);
    return null;
  }
  const taskId = create.taskId;
  onLog?.(`anti-captcha task ${taskId} créée — résolution…`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(6000);
    const res = await api('/getTaskResult', { taskId }).catch(() => null);
    if (!res) continue;
    if (res.errorId !== 0) {
      onLog?.(`anti-captcha getTaskResult échec: ${res.errorCode ?? ''}`);
      return null;
    }
    if (res.status === 'ready') return res.solution?.token ?? null;
  }
  onLog?.('anti-captcha: délai dépassé');
  return null;
}

export async function captchaBalance(): Promise<number | null> {
  const r = await api('/getBalance', {}).catch(() => null);
  return r && r.errorId === 0 ? r.balance : null;
}
