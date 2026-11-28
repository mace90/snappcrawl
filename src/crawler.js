import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signature, similarity, tabsOf } from './signature.js';
import { DEFAULT_DISMISS, alertFromElements, consentAccept, dismissButton, introButtons, isConsent, isPermissionAlert, isWebLink, pickButton } from './interrupts.js';
import { totp } from './totp.js';
import { describeMove, pairActions } from './pairing.js';
import { fileHasScrollBar } from './scrollbar.js';
import { EDGE, contentBottom, fixedOverlays, floatingTop, mayScroll, shiftBetween, stitch } from './scroll.js';
import { comparePng } from './diff.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAPPABLE = /^(button|cell|link|tab|tabbarbutton|menuitem|checkbox)$/i;
const BACK = /^(back|zurück|close|schließen|cancel|abbrechen|done|fertig)$/i;
const SUBMIT = /^(log ?in|sign ?in|anmelden|einloggen|continue|weiter|next|submit|verify|bestätigen|ok)$/i;
const OTP = /(code|otp|2fa|one[- ]?time|verification|bestätigung)/i;
const PIN = /\b(pin|passcode|geheimzahl|zugangscode|sicherheitscode|entsperrcode|app[- ]?code)\b/i;
const DIGIT = /^\s*(\d)(\s+[a-z+]*)?\s*$/i; // "5", or "5 JKL" on a phone-style keypad

const isText = (e) => /statictext/i.test(e.type);
const isField = (e) => /textfield|textview|searchfield/i.test(e.type);
const isSecure = (e) => /securetextfield/i.test(e.type);
const norm = (s) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const center = (e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
const clip = (s, n = 32) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * A screen's identity: the structure of its accessibility tree, not its pixels.
 * Numbers are masked so clocks, counters and prices do not create "new" screens.
 * Web content (ad banners, embedded pages) is left out: it rotates while the screen stays the same.
 * Only a screen that is nothing but web content is identified by it.
 */
export function fingerprint(els) {
  const tabs = tabsOf(els); // by place, like in the signature
  const part = (e) => (e.tab ? `Tab:#${tabs.indexOf(e) + 1}` : isText(e) ? 't:' + norm(e.label).slice(0, 40) : `${e.type}:${e.id || norm(e.label)}`);
  const relevant = els.filter((e) => !/^(application|window|other|webview)$/i.test(e.type));
  const own = relevant.filter((e) => !e.web);
  const parts = (own.length ? own : relevant).map(part);
  return crypto.createHash('sha1').update(parts.sort().join('|')).digest('hex').slice(0, 12);
}

function screenSize(els) {
  const app = els.find((e) => /application/i.test(e.type));
  return { w: app?.w || 393, h: app?.h || 852 };
}

/**
 * A readable screen name, ignoring web content:
 * navigation bar title → a heading at the top → selected tab → first large text near the top → the action that led here.
 */
export function nameOf(els, size, via) {
  const own = els.filter((e) => !e.web);
  const nav = own.find((e) => /navigationbar/i.test(e.type) && (e.label || e.id));
  if (nav) return clip(nav.label || nav.id);
  // iOS 26 lists a SwiftUI navigation title as a heading, not inside a navigation bar
  const heading = own.find((e) => /^heading$/i.test(e.type) && !e.tab && e.label.length > 1 && e.label.length <= 40 && e.y < size.h * 0.25);
  if (heading) return clip(heading.label);
  const tab = own.find((e) => e.tab && e.selected && e.label);
  if (tab) return clip(tab.label);
  const texts = own
    .filter((e) => (isText(e) || /^(heading|header)$/i.test(e.type)) && !e.tab && e.label.length > 1 && e.label.length <= 40 && e.y < size.h * 0.35)
    .sort((a, b) => (b.header === true) - (a.header === true) || a.y - b.y);
  const big = texts.find((e) => e.header || e.h >= 20);
  if (big) return clip(big.label);
  if (via) return clip(via);
  return texts[0] ? clip(texts[0].label) : 'Start';
}

// "Profil", "Profil (2)", "Profil (3)" within one run.
export function uniqueName(seen, name) {
  const n = (seen.get(name) || 0) + 1;
  seen.set(name, n);
  return n === 1 ? name : `${name} (${n})`;
}

// What is tapped first. Navigation shows the main areas of an app, so it comes before
// everything else; list cells come last because a list usually leads to one kind of screen.
//   prefer  labels from crawl.prefer, in the order given
//   nav     tab bar, navigation bar, toolbar, segmented control, menu buttons
//   button  every other button
//   item    list cells and links
export const TIERS = ['prefer', 'nav', 'button', 'item'];
const MENU = /^(menu|menü|more|mehr|☰|≡)$/i;
const MENU_ID = /menu|hamburger|sidebar|drawer/i;
const LISTS = /^(table|collectionview)$/i;
const BAR_TYPES = { navigationbar: 'nav', tabbar: 'tab', toolbar: 'tool', segmentedcontrol: 'segment' };
const barOf = (e) => e.bar || BAR_TYPES[String(e.type).toLowerCase()] || null;
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
// most of e lies in r (a row that only slides under a toolbar is not part of it)
const within = (e, r) => {
  const w = Math.min(e.x + e.w, r.x + r.w) - Math.max(e.x, r.x);
  const h = Math.min(e.y + e.h, r.y + r.h) - Math.max(e.y, r.y);
  return w > 0 && h > 0 && (w * h) / (e.w * e.h) >= 0.75;
};
const isBack = (e) => !!e.back || BACK.test(e.label);
// One key per tab across the whole run: the tab bar looks the same on every screen.
const tabKey = (a) => `tab:${a.id || norm(a.label) || Math.round(a.x)}`;

function actionsOf(els, size, blocklist, { webLinks = 'skip', prefer = [], maxPerList = 0 } = {}) {
  const seen = new Set();
  const actions = [];
  const blocked = [];
  const web = [];
  const bars = els.filter(barOf);
  const lists = els.filter((e) => LISTS.test(e.type)).sort((a, b) => a.w * a.h - b.w * b.h); // innermost first
  const wanted = prefer.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  for (const e of els) {
    if (!TAPPABLE.test(e.type) || !e.enabled || e.w < 8 || e.h < 8) continue;
    const c = center(e);
    if (c.x < 0 || c.y < 0 || c.x > size.w || c.y > size.h) continue;
    if (webLinks !== 'tap' && isWebLink(e)) {
      web.push(e.label || e.id || 'link');
      continue;
    }
    const label = e.label.toLowerCase();
    if (label && blocklist.some((b) => label.includes(b.toLowerCase()))) {
      blocked.push(e.label);
      continue;
    }
    if (isBack(e)) continue;
    const key = `${e.type}:${e.id || norm(e.label) || `${Math.round(c.x)},${Math.round(c.y)}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bar = barOf(bars.find((b) => b !== e && within(e, b)) || {});
    const tab = !!e.tab || /^(tab|tabbarbutton)$/i.test(e.type) || bar === 'tab';
    const nav = tab || !!bar || MENU.test(e.label) || MENU_ID.test(e.id);
    const text = `${e.label} ${e.id}`.toLowerCase();
    const rank = wanted.findIndex((w) => text.includes(w));
    const cell = /^cell$/i.test(e.type) || !!e.cell;
    const tier = rank >= 0 ? 'prefer' : nav ? 'nav' : cell || /^link$/i.test(e.type) ? 'item' : 'button';
    const list = cell && tier === 'item' ? (() => {
      const i = lists.findIndex((l) => l !== e && inside(c, l));
      return i >= 0 ? `list${i}` : `col${Math.round(e.x)}:${Math.round(e.w)}`; // no list container: same column and width
    })() : null;
    actions.push({ type: e.type, label: e.label, id: e.id, x: c.x, y: c.y, tier, ...(tab ? { tab: true } : {}), _rank: rank, _list: list });
  }
  actions.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a._rank - b._rank || a.y - b.y || a.x - b.x);
  // crawl.maxPerList: only the first n cells of each list
  const perList = new Map();
  let limited = 0;
  const kept = actions.filter((a) => {
    if (!maxPerList || !a._list) return true;
    const n = (perList.get(a._list) || 0) + 1;
    perList.set(a._list, n);
    if (n <= maxPerList) return true;
    limited++;
    return false;
  });
  for (const a of kept) {
    delete a._rank;
    delete a._list;
  }
  return { actions: kept, blocked, web: [...new Set(web)], limited };
}

const appLabel = (els) => els.find((e) => /^application$/i.test(e.type))?.label || '';

// Find the element an earlier action pointed at; fall back to its old coordinates.
function locate(els, ref) {
  const m = (ref.id && els.find((e) => e.id === ref.id)) || els.find((e) => e.type === ref.type && e.label && e.label === ref.label);
  return m ? center(m) : { x: ref.x, y: ref.y };
}

// "~4 min", "<1 min", "estimating" for an estimate in milliseconds.
export const formatEta = (ms) => (ms == null ? 'estimating' : ms < 60_000 ? '<1 min' : `~${Math.round(ms / 60_000)} min`);

const refOf = (a) => ({ type: a.type, label: a.label, id: a.id, x: a.x, y: a.y, ...(a.page ? { page: a.page } : {}) });

/**
 * Breadth-first exploration of an app: level by level, navigation first (see TIERS).
 *
 * io: { log(level, msg), ask(kind, prompt) -> Promise<string>, event(type, data), aborted() }
 * Returns the atlas (also written to <outDir>/runs/<id>/atlas.json while crawling).
 */
export async function crawl({ driver, cfg, store, io, label = '' }) {
  const c = cfg.crawl;
  const auth = cfg.auth;
  const log = (lvl, msg) => io.log(lvl, msg);
  const event = (type, data) => io.event?.(type, data);
  const settle = (f = 1) => sleep(c.settleMs * f);
  // Every call that can change what is on screen counts as a move. A read with no move since
  // needs no second read (each idb or WebDriverAgent call costs a few hundred ms).
  let moves = 0;
  let lastObs = null;
  const MOVES = new Set(['tap', 'swipe', 'launch', 'type', 'alertAction', 'activate', 'resetData', 'reinstall']);
  const raw = driver;
  driver = new Proxy(raw, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== 'function') return v;
      return MOVES.has(k) ? (...a) => (moves++, v.apply(t, a)) : v.bind(t);
    },
  });

  const runId = store.newRunId(label);
  const dir = store.runDir(runId);
  fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });

  const started = Date.now();
  const deadline = started + c.timeLimitMin * 60_000;
  const atlas = {
    version: 1,
    meta: { id: runId, label, created: new Date(started).toISOString(), app: cfg.app.bundleId, device: null, status: 'running', limits: { maxDepth: c.maxDepth, maxScreens: c.maxScreens, timeLimitMin: c.timeLimitMin, maxPerList: c.maxPerList || 0, prefer: c.prefer || [], ...(c.scroll ? { scroll: true, maxScrollPages: Number(c.maxScrollPages) || 5 } : {}) } },
    screens: [],
    edges: [],
  };
  const save = () => store.writeRun(runId, atlas);

  // Progress is an estimate: nobody knows how many screens an app has until they are found.
  // done/total counts taps tried against taps known so far. The time left is whichever ends
  // the crawl first: the known taps at the pace so far, the screen limit, or the time limit.
  // pct = elapsed / (elapsed + time left), so the percentage and the time left always agree.
  const prog = { done: 0, total: 0, t0: null };
  function progress(final = false) {
    const now = Date.now();
    const elapsed = prog.t0 ? now - prog.t0 : 0;
    const screens = atlas.screens.filter((x) => !x.crash).length;
    let eta = final ? 0 : null;
    let bound = 'taps';
    if (!final && prog.done > 0) {
      const options = [['taps', (prog.total - prog.done) * (elapsed / prog.done)], ['time', deadline - now]];
      if (screens > 1) options.push(['screens', (c.maxScreens - screens) * (elapsed / (screens - 1))]);
      [bound, eta] = options.reduce((a, b) => (b[1] < a[1] ? b : a));
      eta = Math.max(0, Math.round(eta));
    }
    const pct = final ? 100 : eta == null || elapsed + eta === 0 ? 0 : Math.min(99, Math.round((100 * elapsed) / (elapsed + eta)));
    const p = { pct, done: prog.done, total: prog.total, screens, maxScreens: c.maxScreens, elapsedMs: elapsed, etaMs: eta, bound };
    atlas.meta.progress = p;
    event('progress', p);
    return p;
  }
  const byFp = new Map();
  const byId = new Map();
  const names = new Map();
  const dismissWords = c.dismiss || DEFAULT_DISMISS;
  const alertMode = c.systemAlerts || 'dismiss'; // dismiss | accept | pause
  atlas.meta.warnings = [];
  const warn = (msg) => {
    atlas.meta.warnings.push(msg);
    log('WARN', msg);
  };
  let root = null;
  let entry = null; // where the app opens: the root, or a later "launch screen" once the root was one-time
  let rootApp = ''; // Application label of the app, to notice when another app is in front
  const threshold = c.matchThreshold ?? 0.8;
  // crawl.against: this run is compared with the baseline of another app (a second build
  // installed under its own bundle id), else with the baseline of this app
  const compareApp = c.against || cfg.app.bundleId;

  // How well what is on screen matches a known screen: 1 for the same fingerprint, else the
  // similarity of their signatures (stable parts only, see signature.js).
  // a screen scrolled down (crawl.scroll) is still that screen: its pages count too
  const score = (o, s) => (!s || s.crash ? 0 : o.fp === s.fp || s.pages?.some((p) => p.fp === o.fp) ? 1 : Math.max(similarity(o.sig, s.sig), ...(s.pages || []).map((p) => similarity(o.sig, p.sig))));
  const is = (o, s) => score(o, s) >= threshold;
  function known(o) {
    const exact = byFp.get(o.fp);
    if (exact && !exact.crash) return exact;
    let best = null;
    let top = threshold;
    for (const s of atlas.screens) {
      const v = score(o, s);
      if (v >= top) [best, top] = [s, v];
    }
    return best;
  }

  // Answer a permission prompt as configured. WDA has alert endpoints; on the simulator the
  // prompt is in the accessibility tree.
  async function answerAlert(a) {
    if (alertMode === 'pause') {
      await manual(`System alert "${clip(a.text.replace(/\s+/g, ' '), 80)}". Answer it on the device, then continue.`, 'alert');
      return;
    }
    const button = pickButton(a.buttons, alertMode);
    log('INFO', `alert "${clip(a.text.replace(/\s+/g, ' '), 60)}" → ${alertMode}${button ? ` "${button}"` : ''}`);
    if (a.els) {
      const el = a.els.find((e) => e.label === button) || (alertMode === 'accept' ? a.els.at(-1) : a.els[0]);
      await tapEl(el);
    } else await driver.alertAction(alertMode === 'accept' ? 'accept' : 'dismiss', button);
    await settle();
  }

  const observe = async () => {
    for (let i = 0; ; i++) {
      if (driver.alert && i < 3) {
        const a = await driver.alert().catch(() => null);
        if (a && isPermissionAlert(a.buttons)) {
          await answerAlert(a);
          continue;
        }
      }
      const els = await driver.elements();
      const a = !driver.alert && i < 3 ? alertFromElements(els) : null;
      if (a) {
        await answerAlert(a);
        continue;
      }
      const o = { els, fp: fingerprint(els), sig: signature(els) };
      lastObs = { o, moves };
      return o;
    }
  };
  // what is on screen: the last read when nothing was tapped since, else a new one
  const current = () => (lastObs && lastObs.moves === moves ? lastObs.o : observe());

  // After a tap or a launch the screen may still be moving (during a push animation the old and
  // the new list are both on screen) or loading (nearly empty). Read until two reads in a row
  // agree and the screen is not empty, at most 5 more reads.
  // Same structure is not enough: mid-animation two reads list the same elements at other
  // places. So the layout is compared: type, position and size of every element (2 pt grid),
  // without texts, so a changing feed text or clock does not count as movement.
  const layout = (els) => els.map((e) => `${e.type}@${Math.round(e.x / 2)},${Math.round(e.y / 2)},${Math.round(e.w / 2)},${Math.round(e.h / 2)}`).sort().join('|');
  async function observeSettled() {
    let o = await observe();
    for (let i = 0; i < 5; i++) {
      await sleep(c.settleMs / 3);
      const n = await observe();
      const still = layout(n.els) === layout(o.els);
      o = n;
      if (still && o.els.length > 2) return o;
      if (still && rootApp && appLabel(o.els) && appLabel(o.els) !== rootApp) return o; // another app in front (a crash: the home screen)
    }
    return o;
  }
  // After a tap: a short wait, then reads until the layout stands still. Most taps start their
  // transition at once, so this is done after about half of settleMs. Only while the screen still
  // looks as before the tap is the full settleMs waited for, so a transition that starts late
  // (the app asks its server first) is not taken for a tap that did nothing.
  async function afterTap(before) {
    const t0 = Date.now();
    await sleep(c.settleMs / 3);
    let n = await observeSettled();
    const left = c.settleMs - (Date.now() - t0);
    if (left > 0 && before && layout(n.els) === layout(before.els)) {
      await sleep(left);
      n = await observeSettled();
    }
    return n;
  }

  // Tap away onboarding sheets and hints until a wanted screen (predicate) is on screen, or
  // nothing is left to dismiss. Cookie and privacy screens are never touched.
  async function dismissInterstitials(o, want, why) {
    for (let i = 0; i < 3; i++) {
      if (want && want(o)) return o;
      if (isConsent(o.els)) return o;
      const b = dismissButton(o.els, dismissWords);
      if (!b) return o;
      log('INFO', `dismiss "${b.label}" (${why})`);
      await tapEl(b);
      await settle(1.5);
      o = await observeSettled();
    }
    return o;
  }

  const tapEl = async (e) => {
    const p = center(e);
    await driver.tap(p.x, p.y);
  };

  const submit = async (els) => {
    const buttons = els.filter((e) => /button/i.test(e.type) && e.enabled);
    const b = buttons.find((e) => SUBMIT.test(e.label)) || buttons.at(-1);
    if (b) await tapEl(b);
  };

  // A PIN prompt: the app's own number pad (buttons 0–9) or the system number pad (keys 0–9),
  // or a field, on a screen that says PIN (passcode, Geheimzahl, …), or a number pad next to a
  // secure field. A form with a user name and a password is a login, not a PIN.
  const keypadOf = (els) => {
    const pad = new Map();
    for (const e of els) {
      const d = /^(button|key)$/i.test(e.type) && e.enabled ? DIGIT.exec(e.label)?.[1] : null;
      if (d && !pad.has(d)) pad.set(d, e);
    }
    return pad.size === 10 ? pad : null;
  };
  const pinField = (els) => els.find((e) => isSecure(e) || (isField(e) && PIN.test(`${e.label} ${e.value} ${e.id}`)));
  const isPin = (els) => {
    if (els.some(isSecure) && els.some((e) => isField(e) && !isSecure(e))) return false;
    const says = els.some((e) => PIN.test(`${e.label} ${e.value || ''} ${e.id || ''}`));
    const pad = keypadOf(els);
    return says ? !!(pad || pinField(els)) : !!pad && els.some(isSecure);
  };
  const isLogin = (els) => els.some(isSecure) && !isPin(els);
  const isOtp = (els) => !isLogin(els) && !isPin(els) && els.some((e) => isField(e) && OTP.test(`${e.label} ${e.value} ${e.id}`));

  async function manual(prompt, kind = 'manual') {
    log('WAIT', prompt);
    event('ask', { kind, prompt });
    await io.ask(kind, prompt);
    await settle(1.5);
  }

  async function login(els) {
    if (auth.mfa === 'manual' || !auth.username || !auth.password) {
      await manual('Login screen detected. Log in on the device, then continue.');
      return;
    }
    log('AUTH', 'login form detected · filling credentials');
    const user = els.find((e) => isField(e) && !isSecure(e));
    const pass = els.find(isSecure);
    if (user) {
      await tapEl(user);
      await driver.type(auth.username);
    }
    await tapEl(pass);
    await driver.type(auth.password);
    await submit((await observe()).els);
    await settle(2);

    let o = await observe();
    if (isOtp(o.els)) {
      let code;
      if (auth.mfa === 'totp' && auth.totpSecret) {
        code = totp(auth.totpSecret);
        log('AUTH', '2fa · totp code generated');
      } else {
        log('WAIT', '2fa · code required');
        event('ask', { kind: 'code', prompt: 'Enter the 2FA code you received.' });
        code = String(await io.ask('code', 'Enter the 2FA code you received.')).trim();
      }
      const field = o.els.find(isField);
      if (field) await tapEl(field);
      await driver.type(code);
      await submit((await observe()).els);
      await settle(2);
      o = await observe();
    }

    if (isLogin(o.els) || isOtp(o.els)) {
      if (!auth.fallbackManual) throw new Error('Automatic login failed and manual fallback is disabled.');
      log('WARN', 'auto-login failed · falling back to manual login');
      await manual('Automatic login failed. Log in on the device, then continue.');
    } else {
      log('AUTH', 'logged in · session kept for the rest of the run');
    }
  }

  // auth.pin: typed into a field, or tapped digit by digit on a number pad. Never retried with
  // the same PIN on the same prompt (a wrong PIN may lock the account); a second prompt that
  // looks different ("confirm your PIN") gets it once more.
  async function enterPin(o) {
    const pin = String(auth.pin ?? '').trim();
    if (!pin) {
      await manual('PIN screen detected. Enter the PIN on the device (or set auth.pin / SNAPPCRAWL_PIN), then continue.');
      return observeSettled();
    }
    const seen = new Set();
    for (let round = 0; round < 2 && isPin(o.els) && !seen.has(o.fp); round++) {
      seen.add(o.fp);
      const pad = keypadOf(o.els);
      const field = pinField(o.els);
      if (pad && /^\d+$/.test(pin)) {
        log('AUTH', `pin screen · tapping ${pin.length} digits on the number pad`);
        for (const d of pin) {
          await tapEl(pad.get(d));
          await settle(0.3);
        }
      } else if (field) {
        log('AUTH', `pin screen · typing ${pin.length} characters`);
        await tapEl(field);
        await settle(0.3);
        await driver.type(pin);
      } else break;
      await settle(1.5);
      o = await observeSettled();
      // no automatic submit on this screen: a button like "OK" or "Weiter"
      const ok = isPin(o.els) ? o.els.find((e) => /button/i.test(e.type) && e.enabled && SUBMIT.test(e.label)) : null;
      if (ok) {
        await tapEl(ok);
        await settle(1.5);
        o = await observeSettled();
      }
    }
    if (isPin(o.els)) {
      if (!auth.fallbackManual) throw new Error('The PIN was not accepted and manual fallback is disabled.');
      warn('the PIN was not accepted · not tried again (a wrong PIN may lock the account) · enter it on the device');
      await manual('Enter the PIN on the device, then continue.');
      o = await observeSettled();
    } else log('AUTH', 'pin accepted');
    return o;
  }

  // a login, a PIN, or a login followed by a PIN
  async function ensureAuth(o) {
    for (let i = 0; i < 3; i++) {
      if (isPin(o.els)) o = await enterPin(o);
      else if (isLogin(o.els)) {
        await login(o.els);
        o = await observeSettled();
      } else break;
    }
    return o;
  }

  /* ---------- the app intro: screens an app shows only on its first start ----------
   * keep   as it comes: an intro on a fresh app is crawled and marked one-time
   * skip   a warm-up first: tap through the intro, allow permission prompts, accept cookie
   *        banners, restart; repeated until the app opens the same way twice. Then the crawl.
   * fresh  reset the app first (simulator: its data and permissions; --reinstall: uninstall and
   *        install the given build; else you are asked to), so every run starts with the intro
   * Not set: the mode of the app's baseline, so a comparison run starts the same way. */
  function introMode() {
    if (c.intro && !['keep', 'skip', 'fresh'].includes(c.intro)) throw new Error(`intro must be keep, skip or fresh, not "${c.intro}"`);
    if (c.intro) return { mode: c.intro, inherited: false };
    const base = store.baselineFor?.(compareApp);
    let mode = null;
    try {
      mode = base ? store.readRun(base).meta.intro : null;
    } catch {}
    return { mode: mode || 'keep', inherited: !!mode && mode !== 'keep' };
  }

  async function resetApp() {
    const name = atlas.meta.appName || cfg.app.bundleId;
    if (c.reinstall) {
      if (!driver.reinstall) throw new Error('this device cannot install apps · leave out --reinstall');
      log('INFO', `intro.fresh reinstalling ${name} from ${path.basename(c.reinstall)}`);
      await driver.reinstall(c.reinstall);
    } else if (driver.resetData) {
      log('INFO', `intro.fresh resetting ${name} · documents, settings, caches, permissions`);
      await driver.resetData();
    } else {
      await manual(`Delete ${name} on the iPhone and install it again, so it starts like the first time (or crawl with --reinstall <App.app>). Then continue.`, 'prepare');
    }
  }

  const autoConsent = () => atlas.meta.intro === 'skip' || atlas.meta.intro === 'fresh';
  const hasTabBar = (els) => els.some((e) => e.tab || barOf(e) === 'tab');

  // Start the app and wait until it is in front. For a moment after a launch the simulator still
  // shows what was in front before (another app, or the home screen, whose label is empty), on a
  // cold start for several seconds; taken for the app's first screen, every tap after it would
  // look like a crash. Later launches wait for the app's own label.
  async function launchApp() {
    const before = c.launchMs ? appLabel((await observe()).els) : '';
    // the app itself in front before: the same label afterwards is the app, started again
    const itself = c.launchMs && !rootApp && before && (await driver.isRunning?.().catch(() => false));
    await driver.launch();
    await sleep(c.launchMs);
    if (!c.launchMs) return;
    const inFront = (l) => (rootApp ? l === rootApp : !!l && (l !== before || itself || l === atlas.meta.appName));
    const wait = Math.max(15_000, c.launchMs * 6);
    const until = Date.now() + wait;
    let label = appLabel((await observe()).els);
    if (!inFront(label)) log('INFO', `waiting for ${atlas.meta.appName || cfg.app.bundleId} to come to the front (${label || 'home screen'} still showing)`);
    while (!inFront(label) && Date.now() < until) {
      await sleep(500);
      label = appLabel((await observe()).els);
    }
    if (!inFront(label)) throw new Error(`${atlas.meta.appName || cfg.app.bundleId} did not come to the front within ${Math.round(wait / 1000)} s after the launch (${label || 'the home screen'} is showing) · does it start when you open it by hand in this simulator?`);
  }

  // One launch: tap through what is in the way until the app's own screens (a tab bar, a
  // login, nothing left to tap). Returns the number of taps and the first screen's fingerprint.
  async function throughIntro() {
    await launchApp();
    const tried = new Set();
    let taps = 0;
    let first = null;
    for (let i = 0; i < 25; i++) {
      if (driver.alert) {
        const a = await driver.alert().catch(() => null);
        if (a && isPermissionAlert(a.buttons)) {
          const b = pickButton(a.buttons, 'accept');
          log('INFO', `intro.skip alert "${clip(a.text.replace(/\s+/g, ' '), 50)}" → allow${b ? ` "${b}"` : ''}`);
          await driver.alertAction('accept', b);
          await settle();
          taps++;
          continue;
        }
      }
      const els = await driver.elements();
      const a = driver.alert ? null : alertFromElements(els);
      if (a) {
        const b = a.els.find((e) => e.label === pickButton(a.buttons, 'accept')) || a.els.at(-1);
        log('INFO', `intro.skip alert "${clip(a.text.replace(/\s+/g, ' '), 50)}" → allow "${b.label}"`);
        await tapEl(b);
        await settle();
        taps++;
        continue;
      }
      const fp = fingerprint(els);
      first ??= fp;
      if (isLogin(els) || isPin(els)) break; // the login and the PIN are handled by the crawl
      const consent = consentAccept(els);
      const b = consent || (hasTabBar(els) ? null : introButtons(els, { dismiss: dismissWords, blocklist: c.blocklist }).find((x) => !tried.has(`${fp}:${x.label}`)));
      if (!b) break;
      tried.add(`${fp}:${b.label}`);
      log('INFO', `intro.skip tap "${clip(b.label)}"${consent ? ' (cookie banner · accept)' : ''}`);
      await tapEl(b);
      await settle(1.5);
      taps++;
    }
    return { taps, first };
  }

  async function skipIntro() {
    let prev = null;
    let total = 0;
    for (let round = 1; round <= 4; round++) {
      const { taps, first } = await throughIntro();
      total += taps;
      if (taps === 0 || first === prev) break; // opens the same way as last time: nothing left
      prev = first;
    }
    log('INFO', `intro.skip done · ${total} tap${total === 1 ? '' : 's'} · restarting the app for the crawl`);
    atlas.meta.introTaps = total;
  }

  // First start: optional manual preparation, otherwise dismiss whatever covers the start screen.
  async function start() {
    const { mode, inherited } = introMode();
    atlas.meta.intro = mode;
    if (inherited) log('INFO', `intro ${mode} · like the baseline of this app`);
    if (mode === 'fresh') await resetApp();
    if (mode === 'skip') await skipIntro();
    await launchApp();
    let o = await ensureAuth(await observeSettled());
    if (c.prepare) {
      await manual('Bring the app to the screen where the crawl should start, then continue.', 'prepare');
      o = await ensureAuth(await observeSettled());
    } else if (atlas.meta.intro !== 'fresh') o = await dismissInterstitials(o, null, 'start'); // fresh: the intro is what you want to see
    rootApp = appLabel(o.els);
    return o;
  }

  // Later starts should reach one of `targets` (the screens of the path being replayed):
  // dismiss what is in the way, leave privacy decisions to the user.
  async function relaunch(targets) {
    await launchApp();
    let o = await ensureAuth(await observeSettled());
    const hit = (x) => targets.some((t) => is(x, t));
    if (hit(o)) return o;
    // Apps that remember where they were (iOS Settings) open on that screen again: a screen
    // with a back button. Back to the path, rather than taking it for a new launch screen
    // (an intro shown once ends on a screen without a back button).
    for (let i = 0; i < 4 && !hit(o) && !is(o, entry); i++) {
      const k = known(o);
      const back = !k?.oneTime && o.els.find((e) => /button/i.test(e.type) && (e.back || /^(back|zurück)$/i.test(e.label)));
      if (!back) break;
      if (i === 0) log('INFO', `opened on ${k ? `${k.id} "${clip(k.name, 40)}"` : `"${clip(nameOf(o.els, screenSize(o.els)), 40)}"`} · it remembers where it was · going back`);
      const before = o;
      await tapEl(back);
      await settle();
      o = await observeSettled();
      if (o.fp === before.fp) break;
    }
    if (hit(o)) return o;
    o = await dismissInterstitials(o, hit, 'after launch');
    if (!hit(o) && isConsent(o.els)) {
      if (c.prepare) {
        await manual('A cookie or privacy screen appeared. Decide on the device, bring the app back to the start screen, then continue.', 'prepare');
        o = await ensureAuth(await observeSettled());
      } else warn('cookie or privacy screen after launch · not decided automatically (decide once on the device, or use --prepare)');
    }
    return o;
  }

  /* ---------- following the baseline ----------
   * With a baseline for this app (and crawl.follow not false), a run repeats the baseline:
   * its screens first, in its order, each with its actions in its order; a tap that lands
   * somewhere else than in the baseline is tried once more after a fresh start. Only then the
   * rest is explored. Each screen keeps the baseline screen it matches (s.base), the diff uses it. */
  let follow = null;
  const akey = (a) => `${a.type}:${a.label}`;
  const pathKeyOf = (refs) => refs.map((r) => `${r.type}:${r.id || r.label}`).join(' > ');
  const usedBase = new Set();
  // per screen: its action (by akey) → the baseline action it is, by label or by place
  const pairOf = new Map();
  const pairFor = (s, act) => pairOf.get(s.id)?.get(akey(act)) || null;
  function loadFollow() {
    if (c.follow === false) return;
    const id = store.baselineFor?.(compareApp);
    if (!id) return;
    let b;
    try {
      b = store.readRun(id);
    } catch {
      return;
    }
    const screens = (b.screens || []).filter((x) => !x.crash);
    if (!screens.length) return;
    // the order in which the baseline explored its screens (meta.order), else the order it found them
    const explored = b.meta?.order || [];
    const index = new Map(screens.map((x, i) => [x.id, explored.includes(x.id) ? explored.indexOf(x.id) : explored.length + i]));
    follow = { id, screens, byId: new Map(screens.map((x) => [x.id, x])), index, edges: b.edges || [] };
    atlas.meta.followed = id;
    log('INFO', `follow baseline ${id} · its ${screens.length} screens first, in its order`);
  }
  // Where the baseline went with this action from this screen.
  function expected(s, act) {
    if (!follow || !s?.base) return null;
    const was = pairFor(s, act)?.base || act; // a renamed button: where its old label led
    const e = follow.edges.find((x) => x.from === s.base && akey(x.action) === akey(was));
    return e ? follow.byId.get(e.to) || null : null;
  }
  // The baseline screen o is: where the baseline's tap led, the same path, or the most similar.
  function matchBase(o, pathRefs, parent, act) {
    if (!follow) return null;
    const free = (b) => b && !usedBase.has(b.id);
    const exp = parent && act ? expected(parent, act) : null;
    // where the baseline's tap led, possibly changed: the same tolerance as for a second try
    if (free(exp) && score(o, exp) >= threshold * 0.75) return exp;
    const pk = pathKeyOf(pathRefs);
    const byPath = follow.screens.find((b) => free(b) && !b.oneTime && pathKeyOf(b.path || []) === pk && score(o, b) > 0);
    if (byPath) return byPath;
    let best = null;
    let top = threshold;
    for (const b of follow.screens) {
      if (!free(b)) continue;
      const v = score(o, b);
      if (v >= top) [best, top] = [b, v];
    }
    return best;
  }

  // A picture that differs between runs only by timing is noise in every comparison. It is kept
  // once a second picture a moment later agrees with it and it shows no scroll bar (iOS shows a
  // list's scroll bar for a moment when the list appears or grows). This also waits out the
  // last points of a sheet sliding in and system colors fading. A screen that never stands
  // still (an animation) keeps its last picture, after about 3 s.
  async function steadyShot(shot, size) {
    await driver.screenshot(shot);
    for (let i = 0; i < 6 && c.settleMs > 0; i++) {
      const bar = fileHasScrollBar(shot, size?.w);
      await sleep(bar ? 500 : 200);
      const again = `${shot}.next.png`;
      await driver.screenshot(again);
      const still = !bar && comparePng(shot, again, null, { threshold: cfg.diff.threshold, minChangedRatio: Infinity }).ratio < cfg.diff.minChangedRatio;
      fs.renameSync(again, shot);
      if (still) break;
    }
  }

  /* ---------- scrolling (crawl.scroll) ----------
   * A slow swipe over 30 % of the height (a fast one flings the list so far that nothing is on
   * both reads). How far the content really moved is measured on the elements both reads have.
   * Pages end when nothing moves any more, at crawl.maxScrollPages, or when no element is on
   * both reads (then the pictures cannot be joined). Afterwards the screen is scrolled back up. */
  const SCROLL = c.scroll ? Math.max(1, Number(c.maxScrollPages) || 5) : 0;
  const swipeUp = (size) => driver.swipe(size.w / 2, size.h * 0.7, size.w / 2, size.h * 0.4, { duration: 1 });
  const swipeDown = (size) => driver.swipe(size.w / 2, size.h * 0.4, size.w / 2, size.h * 0.7, { duration: 1 });
  async function scrollPages(o, size, shot) {
    // how far down: a fixed length (crawl.maxScrollPages half screens), not a number of swipes,
    // whose reach varies with the momentum; what lies beyond is cut off in every run alike
    const reach = SCROLL * size.h * 0.5;
    const pages = [];
    let prev = o;
    let offset = 0;
    for (let p = 1; p <= SCROLL * 3 && offset < reach; p++) {
      await swipeUp(size);
      const n = await observeSettled();
      if (appLabel(n.els) !== appLabel(o.els)) break; // the swipe left the screen (a sheet closed)
      if (p === 1) {
        const top = floatingTop(o.els, n.els, size);
        if (top) pages.bottom = Math.min(contentBottom(o.els, size), top);
        pages.overlays = fixedOverlays(o.els, n.els).filter((r) => !top || r.y < top);
      }
      const moved = shiftBetween(prev.els, n.els);
      if (moved == null) break; // too far to join
      if (moved < 4) {
        pages.ended = true; // the end of the content
        break;
      }
      const file = `${shot}.p${p}.png`;
      await steadyShot(file, size);
      // measured again after the picture: the last points of the deceleration would put the seam
      // a pixel or two off
      const m = await observe();
      const d = shiftBetween(prev.els, m.els) ?? shiftBetween(prev.els, n.els);
      offset += d;
      pages.push({ els: m.els, fp: m.fp, sig: m.sig, offset, file });
      prev = m;
    }
    // back up (a little more than down: the list bounces at the top)
    for (let i = 0; i <= pages.length; i++) await swipeDown(size);
    await observeSettled();
    if (pages.length) {
      const scale = await pngScale(shot, size);
      const bottom = pages.bottom || contentBottom(o.els, size);
      // something at the bottom that is not content (a search field, a toolbar): it changes while
      // scrolling, so nothing of the lower pages near it is used
      const busy = !!pages.bottom || o.els.some((e) => /^(searchfield|textfield|toolbar)$/i.test(e.type) && e.y + e.h / 2 > size.h * 0.75);
      const ok = stitch([{ file: shot, offset: 0 }, ...pages], { scale, bottom, out: shot, limit: bottom + reach, overlays: pages.overlays || [], ended: !!pages.ended, keepEnd: !busy });
      pages.calm = bottom - EDGE; // on the lower pages, only what lies above this line counts
      pages.endsCalm = !!pages.ended && !busy; // except on the last one at the end of a list without a floating bar
      pages.limit = bottom + reach; // the content ends here (points), for actions and texts too
      if (!ok) log('WARN', `pages of different sizes · only the first one is kept as the picture`);
    }
    for (const p of pages) fs.rmSync(p.file, { force: true });
    return pages;
  }
  const pngScale = async (file, size) => {
    const b = fs.readFileSync(file);
    return b.readUInt32BE(16) / size.w; // PNG width from the IHDR chunk
  };

  // Bring an action of a page below into view: scroll toward its page until it is visible.
  const findEl = (els, a) => (a.id && els.find((e) => e.id === a.id)) || els.find((e) => e.type === a.type && e.label && e.label === a.label);
  const pageOf = (o, s) => {
    let best = 0;
    let top = score({ ...o, fp: '' }, { ...s, pages: [] });
    for (const [i, p] of (s.pages || []).entries()) {
      const v = o.fp === p.fp ? 1 : similarity(o.sig, p.sig);
      if (v > top) [best, top] = [i + 1, v];
    }
    return best;
  };
  // Before a tap: the element must be in the open part of the screen, not under a bar or a
  // floating search field. Scroll toward it: by its place when it is listed, else toward its page.
  async function seek(o, a, s) {
    if (!SCROLL || !s) return o;
    const size = s.size || screenSize(o.els);
    const top = size.h * 0.12;
    const bottom = () => Math.min(s.bottom || Infinity, contentBottom(o.els, size)) - 8;
    for (let i = 0; i < ((s.pages?.length || 0) + 1) * 2; i++) {
      const e = findEl(o.els, a);
      const y = e && e.y + e.h / 2;
      if (e && y > top && y < bottom()) return o;
      if (!e && !a.page) return o; // not listed and on the first page: nothing to scroll to
      if (!s.pages && !(e && y >= bottom())) return o;
      const up = e ? y >= bottom() : pageOf(o, s) < a.page;
      await (up ? swipeUp(size) : swipeDown(size));
      const n = await observeSettled();
      if (n.fp === o.fp) return n; // nothing moved: as far as it goes
      o = n;
    }
    return o;
  }


  async function register(o, depth, pathRefs, via, parent = null, base = null) {
    const size = screenSize(o.els);
    const id = `s${String(atlas.screens.length).padStart(3, '0')}`;
    const file = `screens/${id}.png`;
    const shot = path.join(dir, file);
    await steadyShot(shot, size);
    // crawl.scroll: the pages below, their actions and texts, one tall picture
    const pages = SCROLL && !isConsent(o.els) && mayScroll(o.els, size) ? await scrollPages(o, size, shot) : [];
    const consent = isConsent(o.els);
    // with --intro skip or fresh you asked for cookie banners to be accepted: the banner is
    // kept as a screen whose only action is accepting it
    const yes = consent && autoConsent() ? consentAccept(o.els) : null;
    const { actions, blocked, web, limited } = yes ? { actions: [{ type: yes.type, label: yes.label, id: yes.id, x: center(yes).x, y: center(yes).y, tier: 'nav' }], blocked: [], web: [], limited: 0 } : consent ? { actions: [], blocked: [], web: [], limited: 0 } : actionsOf(o.els, size, c.blocklist, { webLinks: c.webLinks, prefer: [].concat(c.prefer || []), maxPerList: Number(c.maxPerList) || 0 });
    if (depth < c.maxDepth) prog.total += actions.length;
    let paired = null;
    if (base) {
      // each action is paired with the baseline's by label or by place (renamed, moved);
      // the baseline's order first, actions it did not have after them
      paired = pairActions(actions, size, base.actions || [], base.size);
      const byKey = new Map(paired.pairs.map((p) => [akey(p.cur), p]));
      const order = new Map((base.actions || []).map((a, i) => [a, i]));
      const rank = (a) => order.get(byKey.get(akey(a))?.base) ?? 1e9;
      actions.sort((a, b) => rank(a) - rank(b));
      pairOf.set(id, byKey);
    }
    // what the screen says, for comparisons in words (what an agent reads instead of pixels)
    // a page's elements up to the cut of the tall picture (see scrollPages)
    const upTo = (p) => p.els.filter((e) => (!pages.limit || e.y + e.h / 2 + p.offset <= pages.limit) && (!pages.calm || e.y + e.h / 2 <= pages.calm || (pages.endsCalm && p === pages.at(-1) && e.y + e.h / 2 <= pages.calm + EDGE)));
    const allEls = [o.els, ...pages.map(upTo)].flat();
    const texts = [...new Set(allEls.filter((e) => !e.web && !/^(application|window|other)$/i.test(e.type)).map((e) => clip(String(e.label || e.value || '').replace(/\s+/g, ' ').trim(), 80)).filter(Boolean))].slice(0, 200);
    // the actions of the pages below, with their page and their place on the whole page
    if (pages.length && !consent) {
      const seen = new Set(actions.map(akey));
      for (const [i, p] of pages.entries()) {
        for (const a of actionsOf(upTo(p), size, c.blocklist, { webLinks: c.webLinks, prefer: [].concat(c.prefer || []), maxPerList: Number(c.maxPerList) || 0 }).actions) {
          if (a.tab || seen.has(akey(a))) continue;
          seen.add(akey(a));
          actions.push({ ...a, y: a.y + p.offset, page: i + 1 });
          if (depth < c.maxDepth) prog.total++;
        }
      }
    }
    const s = { id, name: uniqueName(names, nameOf(o.els, size, via)), fp: o.fp, sig: o.sig, depth, path: pathRefs, parent, screenshot: file, elements: o.els.length, size, actions, blocked, texts };
    if (pages.length) s.pages = pages.map((p) => ({ offset: Math.round(p.offset), fp: p.fp, sig: p.sig }));
    if (pages.bottom) s.bottom = Math.round(pages.bottom); // where a floating bar covers the content
    if (base) {
      s.base = base.id;
      usedBase.add(base.id);
    }
    if (consent) s.consent = true;
    if (limited) s.limited = limited;
    atlas.screens.push(s);
    byFp.set(o.fp, s);
    for (const p of s.pages || []) if (!byFp.has(p.fp)) byFp.set(p.fp, s);
    byId.set(id, s);
    save();
    log('INFO', `screen.new ${id} "${s.name}" · ${o.els.length} elements · ${actions.length} actions · depth ${depth}${pages.length ? ` · ${pages.length + 1} pages, ${Math.round(pages.at(-1).offset + size.h)} pt` : ''}`);
    for (const b of blocked) log('WARN', `action.skip "${b}" (blocklist)`);
    for (const w of web) log('STEP', `action.skip "${clip(w)}" (web link)`);
    if (limited) log('STEP', `action.skip ${limited} more list item${limited === 1 ? '' : 's'} (max ${c.maxPerList} per list)`);
    for (const p of paired?.pairs.filter((x) => x.hint) || []) {
      if (p.kind === 'renamed') log('INFO', `follow ${id} "${clip(p.base.label)}" is now "${clip(p.cur.label)}" · same place · tapped as in the baseline`);
      else log('INFO', `follow ${id} "${clip(p.cur.label)}" moved · ${describeMove({ dx: Math.round(p.cur.x - p.base.x), dy: Math.round(p.cur.y - p.base.y) })} · tapped as in the baseline`);
    }
    event('screen', { id, name: s.name, depth, screenshot: file, elements: s.elements });
    return s;
  }

  function addEdge(from, to, act) {
    if (atlas.edges.some((e) => e.from === from.id && e.to === to.id)) return;
    const edge = { from: from.id, to: to.id, action: { type: act.type, label: act.label }, label: `tap ${clip(act.label || act.type, 18)}` };
    atlas.edges.push(edge);
    event('edge', edge);
  }

  // Screens from the entry point to s, following the screen each one was discovered from.
  const chain = (s) => {
    const out = [];
    for (let x = s; x; x = x === entry ? null : x.parent ? byId.get(x.parent) : null) out.unshift(x);
    return out;
  };
  const ancestry = (s) => {
    const ids = [];
    for (let x = s; x; x = x.parent ? byId.get(x.parent) : null) ids.push(x.id);
    return ids;
  };

  // The app no longer opens on the entry screen, twice in a row on the same other screen
  // (typically an onboarding that is shown once): that screen becomes the launch screen and
  // everything only reachable through the old entry is one-time. Not a warning.
  let miss = null;
  async function checkEntry(o) {
    if (is(o, entry) || isConsent(o.els)) {
      miss = null;
      return;
    }
    const k = known(o);
    if (k?.oneTime) return;
    const key = k ? k.id : `new:${o.fp}`;
    miss = miss?.key === key ? { key, n: miss.n + 1 } : { key, n: 1 };
    if (miss.n < 2) return;
    miss = null;
    const next = k || (await register(o, 0, [], null, null, matchBase(o, [], null, null)));
    const cut = next.path.length;
    let n = 0;
    for (const s of atlas.screens) {
      if (ancestry(s).includes(next.id)) s.path = s.path.slice(cut); // paths relative to the launch screen
      else if (!s.oneTime) {
        s.oneTime = true;
        n++;
      }
    }
    next.launch = true;
    next.parent = null;
    entry = next;
    log('INFO', `launch screen is now ${next.id} "${next.name}" · ${n} one-time screen${n === 1 ? '' : 's'} before it`);
    event('launch', { id: next.id });
    save();
  }

  // From screens[k] (on screen now) along the taps to the last of screens. Every step is
  // checked by similarity; a step that lands elsewhere gets the dismiss treatment.
  async function replayFrom(o, steps, k) {
    for (let i = k + 1; i < steps.length; i++) {
      o = await seek(o, steps[i].path.at(-1), steps[i - 1]);
      const p = locate(o.els, steps[i].path.at(-1));
      await driver.tap(p.x, p.y);
      await settle();
      o = await ensureAuth(await observeSettled());
      if (!is(o, steps[i])) o = await dismissInterstitials(o, (x) => is(x, steps[i]), 'replay');
      if (!is(o, steps[i])) return { o, ok: false };
    }
    return { o, ok: true };
  }
  const deepest = (o, steps) => {
    for (let j = steps.length - 1; j >= 0; j--) if (is(o, steps[j])) return j;
    return -1;
  };

  // Bring the app to screen s. Without a restart first: stay, or from the screen that is
  // showing, or after going back up to 3 times, follow the path from a screen on it (the
  // screens from the entry point to s). Else relaunch and replay the path from the deepest
  // screen of it that is showing; a failed replay is retried once from a fresh start.
  // fresh: always restart (a second try of a tap that led elsewhere).
  async function goTo(s, { fresh = false } = {}) {
    if (s.oneTime) return null;
    const steps = chain(s);
    let o = await current();
    if (!fresh) {
      if (is(o, s)) return o;
      for (let backs = 0; backs <= 3; backs++) {
        const k = deepest(o, steps);
        if (k >= 0) {
          const r = await replayFrom(o, steps, k);
          if (r.ok) {
            log('STEP', `replay ${s.id} ok · from ${steps[k].id} without a restart`);
            return r.o;
          }
          break; // off the path: restart
        }
        const back = backs < 3 && o.els.find((e) => /button/i.test(e.type) && isBack(e));
        if (!back) break;
        const before = o;
        await tapEl(back);
        await settle();
        o = await observeSettled();
        if (is(o, s)) return o;
        if (o.fp === before.fp) break; // going back did nothing: restart
      }
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      o = await relaunch(steps);
      await checkEntry(o);
      if (s.oneTime) return null;
      const path = chain(s); // the entry point may have moved
      const k = deepest(o, path);
      if (k >= 0) o = (await replayFrom(o, path, k)).o;
      const m = score(o, s);
      if (m >= threshold) {
        log('STEP', `replay ${s.id} ok · match ${m.toFixed(2)}`);
        return o;
      }
      if (attempt === 1) log('INFO', `replay to ${s.id} landed elsewhere (match ${m.toFixed(2)}) · starting the app once more`);
    }
    warn(`replay to ${s.id} "${s.name}" failed twice · skipping its remaining actions`);
    return null;
  }

  // 4 = in front. Drivers without app state: running or not, plus who owns the screen.
  const appState = async () => (driver.appState ? Number(await driver.appState()) : (await driver.isRunning()) ? 4 : 1);

  try {
    await driver.resolve();
    atlas.meta.device = { platform: driver.platform, name: driver.name, runtime: driver.runtime, udid: driver.udid };
    if (driver.statusBar) atlas.meta.device.statusBar = driver.statusBar; // points, used to mask it in diffs
    log('INFO', `device ${driver.name} · ${driver.runtime} · ${driver.udid}`);
    try {
      atlas.meta.appName = (await driver.listApps()).find((a) => a.bundleId === cfg.app.bundleId)?.name || '';
    } catch {}
    log('INFO', `app.launch ${atlas.meta.appName ? atlas.meta.appName + ' · ' : ''}${cfg.app.bundleId}`);
    event('run', { id: runId, device: atlas.meta.device });
    if (c.against) {
      const id = store.baselineFor?.(c.against);
      if (!id) throw new Error(`no baseline for ${c.against} · crawl it first (or both at once: crawl --bundle ${c.against} --then ${cfg.app.bundleId})`);
      Object.assign(atlas.meta, { against: c.against, baseline: id });
      log('INFO', `compared with the baseline of ${c.against} · ${id}`);
    }

    loadFollow();
    const first = await start();
    root = await register(first, 0, [], null, null, matchBase(first, [], null, null));
    entry = root;
    if (root.consent && !root.actions.length) warn(`the start screen asks for a cookie or privacy decision · not decided automatically. Decide once on the device, or crawl with --prepare`);
    // Level by level (breadth-first). Within a level, screens reached through navigation are
    // explored before those reached through buttons, and those before list items.
    const queue = [root];
    const reachedBy = new Map(); // screen id → tier of the action that found it
    const rankOf = (x) => TIERS.indexOf(reachedBy.get(x.id) || 'nav');
    // following a baseline: its screens first, in its order; then the rest
    const order = (x) => (x.base && follow ? [0, follow.index.get(x.base)] : [1, x.depth, rankOf(x)]);
    const before = (a, b) => {
      const [x, y] = [order(a), order(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
      return false;
    };
    const next = () => {
      let b = 0;
      for (let i = 1; i < queue.length; i++) if (before(queue[i], queue[b])) b = i;
      return queue.splice(b, 1)[0];
    };
    // Tabs are tapped once per run: the first time shows where each one leads, after that
    // the same tab on another screen only gets the known transition, without a tap.
    const tabs = new Map(); // tabKey → id of the screen it leads to, or null
    let tabsSaved = 0;
    // The screen limit: following a baseline, its screens are always visited; the limit
    // applies to everything new.
    const full = () => atlas.screens.length >= c.maxScreens;
    const over = () => Date.now() > deadline || io.aborted?.();
    let skippedNew = 0;

    outer: while (queue.length) {
      const s = next();
      if (s.depth >= c.maxDepth) continue;
      (atlas.meta.order ||= []).push(s.id); // the exploration order, for a run that follows this one
      if (full() && !(follow && s.base)) {
        log('WARN', 'limit reached · stopping');
        atlas.meta.stopped = 'screens';
        break;
      }
      if (s.oneTime) {
        prog.done += s.actions.length; // never shown again, nothing left to try
        progress();
        continue;
      }
      for (const [i, act] of s.actions.entries()) {
        if (over() || (full() && !follow)) {
          log('WARN', 'limit reached · stopping');
          atlas.meta.stopped = over() ? 'time' : 'screens';
          break outer;
        }
        if (full() && !expected(s, act)) {
          prog.done++; // screen limit: only the baseline's way on
          continue;
        }
        prog.t0 ??= Date.now();
        if (act.tab && tabs.has(tabKey(act))) {
          const to = byId.get(tabs.get(tabKey(act)));
          if (to && to !== s) addEdge(s, to, act);
          tabsSaved++;
          prog.done++;
          progress();
          continue;
        }
        const o = await goTo(s);
        if (!o) {
          prog.done += s.actions.length - i; // the rest of this screen is given up
          progress();
          break;
        }
        prog.done++;
        progress();
        const at = await seek(o, act, s);
        const p = locate(at.els, act);
        log('STEP', `tap "${clip(act.label || act.type, 60)}" on ${s.id}`);
        if (act.tab) tabs.set(tabKey(act), null);
        event('tap', { screen: s.id, x: p.x, y: p.y, size: s.size });
        await driver.tap(p.x, p.y);

        // still the app's own screen: neither crashed nor left, no need to ask for the app state
        let n = await afterTap(at);
        const state = rootApp && appLabel(n.els) === rootApp ? 4 : await appState();
        if (state !== 4 && state > 1) {
          // Safari or another app came to the front: note it, go back, register nothing
          warn(`left app after tap "${clip(act.label || act.type, 60)}" on ${s.id} · returning`);
          await (driver.activate ? driver.activate() : driver.launch());
          await settle();
          continue;
        }
        if (state <= 1) {
          const fp = `crash:${s.id}:${act.label}`;
          let cs = byFp.get(fp);
          if (!cs) {
            cs = { id: `x${String(atlas.screens.length).padStart(3, '0')}`, name: 'Crash', crash: true, fp, depth: s.depth + 1, path: [...s.path, refOf(act)], parent: s.id, screenshot: null, elements: 0, actions: [], blocked: [] };
            byId.set(cs.id, cs);
            atlas.screens.push(cs);
            byFp.set(fp, cs);
            event('screen', { id: cs.id, name: cs.name, depth: cs.depth, crash: true });
          }
          addEdge(s, cs, act);
          log('ERROR', `app.crash after tap "${clip(act.label || act.type, 60)}" on ${s.id}`);
          save();
          continue;
        }

        n = await ensureAuth(n);
        // the baseline went somewhere else with this tap: once more, after a fresh start
        const exp = expected(s, act);
        const hitsExp = (x) => {
          const k = known(x);
          // the expected screen, possibly changed (a new button, other texts): no second try
          return k ? k.base === exp.id : score(x, exp) >= threshold * 0.75;
        };
        // a button that only shares the place with the baseline's (renamed) may well be another
        // button: where it leads is kept as it is, no second try
        const renamed = pairFor(s, act)?.kind === 'renamed';
        if (exp && renamed) log('INFO', hitsExp(n) ? `"${clip(act.label)}" on ${s.id} leads where "${clip(pairFor(s, act).base.label)}" led · the same button, renamed` : `"${clip(act.label)}" on ${s.id} leads elsewhere than "${clip(pairFor(s, act).base.label)}" did · another button at the same place`);
        // the baseline's screen may only be slow to come (the app asks its server first): a while
        // longer before calling it a different place
        for (const t0 = Date.now(); exp && !renamed && exp.id !== s.base && !hitsExp(n) && Date.now() - t0 < c.settleMs * 2.5; ) {
          await sleep(c.settleMs / 3);
          n = await ensureAuth(await observeSettled());
        }
        if (exp && !renamed && exp.id !== s.base && !hitsExp(n)) {
          log('INFO', `tap "${clip(act.label || act.type)}" on ${s.id} led elsewhere than in the baseline ("${exp.name}") · once more after a fresh start`);
          const o2 = await goTo(s, { fresh: true });
          if (o2) {
            const o3 = await seek(o2, act, s);
            const p2 = locate(o3.els, act);
            await driver.tap(p2.x, p2.y);
            const n2 = await afterTap(o3);
            if ((rootApp && appLabel(n2.els) === rootApp) || (await appState()) === 4) {
              n = await ensureAuth(n2);
              log('INFO', hitsExp(n) ? `retry on ${s.id} · as in the baseline` : `retry on ${s.id} · different again, kept as it is`);
            }
          }
        }
        if (rootApp && appLabel(n.els) && appLabel(n.els) !== rootApp) {
          warn(`left app after tap "${clip(act.label || act.type, 60)}" on ${s.id} (${appLabel(n.els)} in front) · returning`);
          await (driver.activate ? driver.activate() : driver.launch());
          await settle();
          continue;
        }
        if (is(n, s)) {
          if (act.tab) tabs.set(tabKey(act), s.id); // the tab of this screen
          continue; // tap did not navigate (or only changed content)
        }
        let t = known(n);
        if (!t && isConsent(n.els) && !(autoConsent() && consentAccept(n.els))) {
          warn(`cookie or privacy screen after tap "${clip(act.label || act.type, 60)}" on ${s.id} · skipped, not decided automatically`);
          continue;
        }
        if (!t) {
          const refs = [...s.path, refOf(act)];
          const base = matchBase(n, refs, s, act);
          if (follow && !base && full()) {
            skippedNew++; // a new screen, but the limit is reached: the baseline's screens first
            continue;
          }
          t = await register(n, s.depth + 1, refs, act.label, s.id, base);
          reachedBy.set(t.id, act.tier);
          queue.push(t);
        }
        if (act.tab) tabs.set(tabKey(act), t.id);
        addEdge(s, t, act);
      }
    }
    if (skippedNew) log('INFO', `${skippedNew} new screen${skippedNew === 1 ? '' : 's'} not kept · screen limit reached, the baseline's screens came first`);
    if (follow) {
      const missing = follow.screens.filter((b) => !usedBase.has(b.id) && !b.oneTime).length;
      log('INFO', `baseline followed · ${usedBase.size} of ${follow.screens.length} screens found again${missing ? ` · ${missing} not reached` : ''}`);
    }
    if (tabsSaved) log('INFO', `tabs tapped once each · ${tabsSaved} repeated tab tap${tabsSaved === 1 ? '' : 's'} saved`);
    atlas.meta.status = 'done';
    progress(true);
  } catch (e) {
    atlas.meta.status = 'failed';
    atlas.meta.error = e.message;
    log('ERROR', e.message);
  } finally {
    atlas.meta.finished = new Date().toISOString();
    atlas.meta.durationMs = Date.now() - started;
    save();
  }
  const once = atlas.screens.filter((s) => s.oneTime).length;
  if (once && atlas.meta.intro === 'keep') log('INFO', `${once} one-time screen${once === 1 ? '' : 's'} (app intro) · a later run will not see ${once === 1 ? 'it' : 'them'} · --intro fresh shows the intro in every run, --intro skip leaves it out`);
  const crashes = atlas.screens.filter((s) => s.crash).length;
  if (atlas.meta.status === 'done') log('DONE', `crawl.done ${atlas.screens.length - crashes} screens · ${atlas.edges.length} transitions · ${crashes} crashes · run ${runId}`);
  event('done', { id: runId, status: atlas.meta.status });
  return atlas;
}
