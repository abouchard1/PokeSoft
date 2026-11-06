export interface Fingerprint {
  preset: string;
  os: 'Windows' | 'macOS';
  osVersion: string;
  browser: string;
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  canvasSeed: number;
}

interface Preset {
  id: string;
  os: 'Windows' | 'macOS';
  osVersion: string;
  browser: string;
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
}

/** Headed sessions open the real window at the fingerprint's viewport size, so
 *  presets are kept small enough to fit an operator's screen (and existing
 *  fingerprints are clamped to this on load — see accounts.ts). All viewports
 *  below stay ≤ this. */
export const MAX_VIEWPORT = { width: 1440, height: 810 };

const PRESETS: Preset[] = [
  {
    id: 'win11-chrome-1440-nvidia',
    os: 'Windows',
    osVersion: '11',
    browser: 'Chrome 122',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    hardwareConcurrency: 8,
    deviceMemory: 16,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer:
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win10-chrome-1366-intel',
    os: 'Windows',
    osVersion: '10',
    browser: 'Chrome 122',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    hardwareConcurrency: 4,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer:
      'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win11-chrome-1280-amd',
    os: 'Windows',
    osVersion: '11',
    browser: 'Chrome 122',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    hardwareConcurrency: 12,
    deviceMemory: 16,
    webglVendor: 'Google Inc. (AMD)',
    webglRenderer:
      'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'win11-chrome-1360-iris',
    os: 'Windows',
    osVersion: '11',
    browser: 'Chrome 122',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Win32',
    viewport: { width: 1360, height: 768 },
    deviceScaleFactor: 1,
    hardwareConcurrency: 8,
    deviceMemory: 16,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer:
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'mac-m1-chrome-1280',
    os: 'macOS',
    osVersion: 'Sonoma',
    browser: 'Chrome 122',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  },
  {
    id: 'mac-m2pro-chrome-1440',
    os: 'macOS',
    osVersion: 'Sonoma',
    browser: 'Chrome 122',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    hardwareConcurrency: 12,
    deviceMemory: 16,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer:
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
  },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateFingerprint(): Fingerprint {
  const preset = pick(PRESETS);
  return {
    preset: preset.id,
    os: preset.os,
    osVersion: preset.osVersion,
    browser: preset.browser,
    userAgent: preset.userAgent,
    platform: preset.platform,
    viewport: { ...preset.viewport },
    deviceScaleFactor: preset.deviceScaleFactor,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    hardwareConcurrency: preset.hardwareConcurrency,
    deviceMemory: preset.deviceMemory,
    webglVendor: preset.webglVendor,
    webglRenderer: preset.webglRenderer,
    canvasSeed: Math.floor(Math.random() * 1_000_000),
  };
}

export function fingerprintSummary(fp: Fingerprint): string {
  return `${fp.os} ${fp.osVersion} · ${fp.browser} · ${fp.viewport.width}×${fp.viewport.height}`;
}

export const FINGERPRINT_INIT_SCRIPT = `(() => {
  const fp = window.__POKESOFT_FP__;
  if (!fp) return;

  const define = (target, prop, value) => {
    try {
      Object.defineProperty(target, prop, { get: () => value, configurable: true });
    } catch (_) {}
  };

  define(navigator, 'hardwareConcurrency', fp.hardwareConcurrency);
  define(navigator, 'deviceMemory', fp.deviceMemory);
  define(navigator, 'platform', fp.platform);
  define(navigator, 'webdriver', false);

  const patchWebGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === 37445) return fp.webglVendor;
      if (param === 37446) return fp.webglRenderer;
      return orig.apply(this, arguments);
    };
  };
  patchWebGL(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null);
  patchWebGL(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null);

  const seed = fp.canvasSeed >>> 0;
  const tweak = (data) => {
    const pixels = data.data;
    let s = seed || 1;
    for (let i = 0; i < pixels.length; i += 997) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      pixels[i] = (pixels[i] + (s & 1)) & 0xff;
    }
  };

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const data = ctx.getImageData(0, 0, this.width, this.height);
        tweak(data);
        ctx.putImageData(data, 0, 0);
      }
    } catch (_) {}
    return origToDataURL.apply(this, args);
  };

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const data = origGetImageData.apply(this, args);
    try { tweak(data); } catch (_) {}
    return data;
  };
})();`;
