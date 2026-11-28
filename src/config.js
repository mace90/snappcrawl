import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DISMISS } from './interrupts.js';
import { CONFIG_FILE, DATA_DIR, HOME, LEGACY_CONFIG_FILE, LEGACY_DATA_DIR, LEGACY_HOME, env, envValue, pick } from './legacy.js';

export const GLOBAL_FILE = path.join(HOME, 'config.json');
export const LOCAL_FILE = CONFIG_FILE;
// read the old global config while the new one does not exist
const globalFile = () => pick(GLOBAL_FILE, path.join(LEGACY_HOME, 'config.json'));

export const DEFAULTS = {
  app: { bundleId: '' },
  device: { platform: 'ios-sim', udid: 'booted', wdaUrl: 'http://127.0.0.1:8100' }, // platform: ios-sim | ios-device
  auth: {
    username: '',
    password: '',
    mfa: 'none', // none | totp | prompt | manual
    totpSecret: '',
    pin: '', // a PIN the app asks for (4, 6, 8 digits …): tapped on its number pad or typed
    fallbackManual: true,
  },
  crawl: {
    maxDepth: 8,
    maxScreens: 200,
    timeLimitMin: 20,
    settleMs: 900,
    launchMs: 2500,
    matchThreshold: 0.8, // 0…1 · how similar two views must be to count as the same screen
    prepare: false, // pause after launch so you can bring the app to the start screen
    webLinks: 'skip', // skip | tap  links in web content usually leave the app
    systemAlerts: 'dismiss', // dismiss | accept | pause  permission prompts (notifications, location, tracking)
    dismiss: DEFAULT_DISMISS, // buttons that close onboarding sheets and hints
    follow: true, // with a baseline: its screens first, in its order, a tap that lands elsewhere tried once more
    intro: '', // keep | skip | fresh · screens an app shows only on its first start; empty: like the baseline, else keep
    reinstall: '', // with intro fresh: a .app to uninstall and install before each run
    prefer: [], // labels tapped before everything else, e.g. ["Konto", "Einstellungen"]
    maxPerList: 0, // only the first n cells of each list (0 = all)
    scroll: false, // scroll long screens page by page: their actions, texts and one tall picture
    maxScrollPages: 5, // with scroll: at most this many pages below the first
    against: '', // bundle id of another app whose baseline this run is compared with (a second build)
    blocklist: [
      'log out', 'logout', 'sign out', 'abmelden',
      'delete account', 'konto löschen',
      'buy', 'kaufen', 'purchase', 'pay now', 'jetzt zahlen', 'kauf abschließen',
    ],
  },
  diff: {
    threshold: 0.05, // per-pixel color tolerance (pixelmatch); 0.1 misses a white card on the light gray iOS background
    minChangedRatio: 0.0005, // below this share of changed pixels a screen counts as unchanged
    ignoreStatusBar: true,
    ignoreHomeIndicator: true, // the bar at the bottom, tinted by iOS after the screen before
    ignore: [], // areas left out of the comparison: { screen: "Aktionstaste", x, y, w, h } in points
  },
  ai: {
    provider: 'none', // none | anthropic | openai | ollama
    model: '',
    apiKey: '',
    baseUrl: '',
  },
  outDir: '.snappcrawl',
};

export const AI_DEFAULT_MODEL = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4.1-mini',
  ollama: 'llava',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function merge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(over) || typeof over !== 'object') return over;
  const out = { ...(base || {}) };
  for (const k of Object.keys(over)) out[k] = merge(base?.[k], over[k]);
  return out;
}

// "env:NAME" values are read from the environment, so secrets never live in the config file.
function resolveEnv(v) {
  if (typeof v === 'string' && v.startsWith('env:')) return envValue(v.slice(4)) || '';
  if (Array.isArray(v)) return v.map(resolveEnv);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveEnv(x)]));
  return v;
}

export function loadConfig(file) {
  const local = path.resolve(file || pick(LOCAL_FILE, LEGACY_CONFIG_FILE));
  let cfg = merge(DEFAULTS, readJson(globalFile()));
  cfg = merge(cfg, readJson(local));
  cfg = resolveEnv(cfg);

  cfg.auth.username ||= env('USERNAME') || '';
  cfg.auth.password ||= env('PASSWORD') || '';
  cfg.auth.totpSecret ||= env('TOTP_SECRET') || '';
  cfg.auth.pin = String(cfg.auth.pin || env('PIN') || ''); // a string: "0815" keeps its zero
  if (!cfg.ai.apiKey) {
    if (cfg.ai.provider === 'anthropic') cfg.ai.apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (cfg.ai.provider === 'openai') cfg.ai.apiKey = process.env.OPENAI_API_KEY || '';
  }
  // the default data folder: the old one while only it exists
  if (cfg.outDir === DATA_DIR) cfg.outDir = pick(DATA_DIR, LEGACY_DATA_DIR);
  cfg.ai.model ||= AI_DEFAULT_MODEL[cfg.ai.provider] || '';
  cfg._file = fs.existsSync(local) ? local : null;
  return cfg;
}

export function getGlobal() {
  return readJson(globalFile()) || {};
}

// settings that hold a list: `config set crawl.prefer "Konto, Einstellungen"`
const LIST_KEYS = ['crawl.prefer', 'crawl.blocklist', 'crawl.dismiss'];

export function setGlobal(key, value) {
  const data = getGlobal();
  const parts = key.split('.');
  let node = data;
  for (const p of parts.slice(0, -1)) node = node[p] = node[p] && typeof node[p] === 'object' ? node[p] : {};
  let v = value;
  if (LIST_KEYS.includes(key)) v = Array.isArray(v) ? v : String(v).split(',').map((x) => x.trim()).filter(Boolean);
  else if (v === 'true' || v === 'false') v = v === 'true';
  else if (v !== '' && !Number.isNaN(Number(v))) v = Number(v);
  node[parts.at(-1)] = v;
  fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(GLOBAL_FILE, 0o600); // also when the file existed before with other rights
  return data;
}

export const TEMPLATE = {
  app: { bundleId: 'com.example.myapp' },
  device: { platform: 'ios-sim', udid: 'booted' },
  auth: {
    username: 'env:SNAPPCRAWL_USERNAME',
    password: 'env:SNAPPCRAWL_PASSWORD',
    mfa: 'none',
    totpSecret: 'env:SNAPPCRAWL_TOTP_SECRET',
    pin: 'env:SNAPPCRAWL_PIN',
    fallbackManual: true,
  },
  crawl: { maxDepth: 8, maxScreens: 200, timeLimitMin: 20, blocklist: DEFAULTS.crawl.blocklist },
  diff: { threshold: 0.05, minChangedRatio: 0.0005, ignoreStatusBar: true },
};
